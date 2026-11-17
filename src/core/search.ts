import type { Pool } from 'pg';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import { timestampedLink } from '../links.js';
import { readSnapshot, type Db } from '../db/pool.js';
import { getMetaString } from '../db/meta.js';
import { embeddingFromConfig, vectorLiteral, type EmbeddingClient } from '../providers/embedding.js';
import { escapeRegexTerm, lexique, nearestWords, wordPatterns } from './resolve.js';
import { collectionSql, dateRangeSql, timeRangeSql, videoIdSql, videoIdsSql } from './filters.js';
import { clampLimit, cursorKey, pageOf, pageOffset, type DateRange, type Kind, type Page, type PageInput } from './page.js';

export interface Evidence {
  sourceId: string;
  kind: Kind;
  startS: number;
  endS: number | null;
  text: string;
  uncertainties: string[];
}

export interface SearchResult {
  windowId: number;
  videoId: string;
  title: string;
  publishedAt: string | null;
  startS: number;
  endS: number;
  /** Lien horodaté vers la meilleure preuve. */
  link: string;
  /** Entrées de la fenêtre qui justifient le classement (lexical ou sémantique). */
  evidence: Evidence[];
  /**
   * Poids de chaque preuve, dans l'ordre de `evidence` : nombre de mots de la question qu'elle porte, plus
   * sa proximité par le sens (0 à 1). Sert à choisir la tranche d'un passage (`passages.ts`).
   */
  evidenceWeights?: number[];
  bestEntry: Evidence;
  /** Texte fusionné de la fenêtre, prêt pour le LLM ; vide si la recherche l'a écarté (`SearchOptions.windowText`). */
  windowText: string;
  /** Score RRF : classement relatif, jamais une confiance. */
  score: number;
}

export interface SearchData {
  results: SearchResult[];
  /** Vrai si la recherche n'a pas pu être hybride complète. */
  degraded: boolean;
  degradedReason: string | null;
  embeddingCoverage: { ready: number; total: number };
  candidates: { lexical: number; semantic: number; variants: number };
  /**
   * Distance cosinus de l'entrée la plus proche de la question (0 = identique),
   * `null` sans recherche sémantique. Signal de pertinence, pas une preuve.
   */
  bestDistance: number | null;
}

export interface SearchInput extends PageInput {
  query: string;
  limit?: number;
  kind?: Kind;
  videoId?: string;
  /** Vidéos d'une série nommée par la question (`series.ts`) : la recherche ne sort pas de cet ensemble. */
  videoIds?: string[];
  timeRange?: { fromS: number; toS: number };
  dateRange?: DateRange;
  /** Reformulations issues de l'expansion : élargissent les candidats, jamais les preuves. */
  variants?: string[];
  /**
   * Extrait hypothétique (HyDE) écrit par le LLM : encodé, il cherche les blocs
   * de 30 s qui lui ressemblent (liste de fusion en plus). Jamais une preuve :
   * les preuves restent classées par leur distance à la vraie question.
   */
  hypothetical?: string;
}

export interface SearchOptions {
  /** Encodeur des questions ; par défaut celui de la configuration. `null` force le lexical. */
  embedder?: EmbeddingClient | null;
  /**
   * Recherche profonde (usage interne, questions générales) : jusqu'à
   * `DEEP_LIMIT` fenêtres et des listes de candidats plus longues. Les outils
   * publics (MCP, CLI) restent limités à 100 fenêtres par page.
   */
  deep?: boolean;
  /**
   * Liste BM25 sur l'enrichissement des blocs (défaut : oui). `repondre` ne
   * l'active que pour les questions générales : sur une question précise, une
   * fenêtre trouvée par la seule phrase de contexte d'un bloc n'a pas de ligne
   * proche de la question, et l'extrait tombe à côté (mesuré).
   */
  enrichment?: boolean;
  /**
   * Texte complet de chaque fenêtre (`windowText`, défaut : oui). `repondre` s'en passe : il relit les
   * lignes des passages qu'il transmet, et 1 000 fenêtres de 8 000 caractères pèsent 8 Mo pour rien.
   */
  windowText?: boolean;
}

/** Fenêtres au plus en recherche profonde, et candidats par liste. */
export const DEEP_LIMIT = 1000;
const DEEP_CANDIDATES = 1000;

/** Fusion RRF : poids mesurés sur un jeu de questions de référence. */
const RRF_K = 60;
const LEXICAL_WEIGHT = 40;
const SEMANTIC_WEIGHT = 60;
const VARIANT_WEIGHT = 40;
/** Liste HyDE (blocs proches de l'extrait hypothétique) : poids d'une liste sémantique partagée. */
const HYPOTHETICAL_WEIGHT = 30;
/** Liste BM25 sur l'enrichissement des blocs (`npm run enrich`) ; vide sans enrichissement. */
const ENRICHMENT_WEIGHT = 30;
const LEXICAL_CANDIDATES = 200;
const SEMANTIC_CANDIDATES = 200;
/** Mots signifiants distincts au moins pour qu'une parole sans mot de la question soit une meilleure preuve (voir `assemble`). */
const MIN_INFORMATIVE_TOKENS = 3;
/** Tolérance de la correction orthographique des mots absents du corpus. */
const FUZZY_MAX_DISTANCE = 2;

/**
 * Couverture des vecteurs (entrées et blocs encodés), gardée pour la version d'index courante : la
 * compter parcourt les deux tables (~100 ms sur 190 000 extraits), et `index_version` change à chaque
 * vecteur écrit.
 */
interface Coverage {
  entries: { ready: number; total: number };
  chunks: { ready: number; total: number };
}
let coverageCache: { key: string; coverage: Coverage } | null = null;

async function embeddingCoverage(db: Db, versions: { corpusVersion: string; indexVersion: string }): Promise<Coverage> {
  const key = `${versions.corpusVersion}|${versions.indexVersion}`;
  if (coverageCache?.key === key) return coverageCache.coverage;
  const { rows } = await db.query<{ table: string; ready: string; total: string }>(
    `SELECT 'entries' AS table, count(*) FILTER (WHERE embedding IS NOT NULL) AS ready, count(*) AS total FROM entries
     UNION ALL
     SELECT 'chunks', count(*) FILTER (WHERE embedding IS NOT NULL), count(*) FROM chunks`,
  );
  const byTable = new Map(rows.map((r) => [r.table, { ready: Number(r.ready), total: Number(r.total) }]));
  const coverage = { entries: byTable.get('entries') ?? { ready: 0, total: 0 }, chunks: byTable.get('chunks') ?? { ready: 0, total: 0 } };
  coverageCache = { key, coverage };
  return coverage;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Remplace chaque mot absent du corpus par ses plus proches voisins (distance ≤ 2). */
async function correctTokens(db: Db, tokens: string[], corpusVersion: string): Promise<string[]> {
  const words = await lexique(db, 'tout', corpusVersion);
  const known = new Set(words);
  const corrected: string[] = [];
  for (const token of tokens) {
    if (known.has(token)) {
      corrected.push(token);
      continue;
    }
    const candidates = nearestWords(token, words, FUZZY_MAX_DISTANCE);
    const best = candidates[0];
    corrected.push(...(best ? candidates.filter((c) => c.distance === best.distance).map((c) => c.word) : [token]));
  }
  return unique(corrected);
}

/**
 * Mots soudés : deux mots voisins de la question dont la forme collée existe dans le corpus
 * (« placo plâtre » → `placoplatre`, 5 lettres au moins). La transcription écrit l’un, la question
 * l'autre : sans eux, la phrase qui répond n'est ni candidate par les mots ni preuve. Rend la question
 * réécrite avec les formes collées (une liste lexicale de plus) et les formes collées seules (preuves).
 */
export function joinedWords(tokens: string[], known: Set<string>): { rewritten: string[]; joined: string[] } {
  const rewritten: string[] = [];
  const joined: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const pair = i + 1 < tokens.length ? `${tokens[i]}${tokens[i + 1]}` : '';
    if (pair.length >= 5 && known.has(pair)) {
      rewritten.push(pair);
      joined.push(pair);
      i++;
    } else {
      rewritten.push(tokens[i]!);
    }
  }
  return { rewritten: joined.length > 0 ? unique(rewritten) : [], joined: unique(joined) };
}

interface Filters {
  input: SearchInput;
  /** Candidats par liste (lexicale, sémantiques) ; défaut 200, plus en recherche profonde. */
  candidates?: number;
  /** Filtre sur la fenêtre `w` et la vidéo `v` ; complète `params`. */
  windowSql(params: unknown[]): string;
  /** Filtre sur l'entrée `e` et la vidéo `v` ; complète `params`. */
  entrySql(params: unknown[]): string;
}

function buildFilters(input: SearchInput, candidates?: number): Filters {
  const kindSql = (params: unknown[]): string => {
    if (!input.kind) return '';
    params.push(input.kind);
    return `AND e.kind = $${params.length}`;
  };
  return {
    input,
    ...(candidates === undefined ? {} : { candidates }),
    windowSql: (params) =>
      [
        collectionSql(input.collection, params),
        videoIdSql(input.videoId, params),
        videoIdsSql(input.videoIds, params),
        dateRangeSql(input.dateRange, params),
        timeRangeSql(input.timeRange, params, { start: 'w.start_s', end: 'w.end_s' }),
      ].join(' '),
    entrySql: (params) =>
      [
        kindSql(params),
        collectionSql(input.collection, params),
        videoIdSql(input.videoId, params),
        videoIdsSql(input.videoIds, params),
        dateRangeSql(input.dateRange, params),
        timeRangeSql(input.timeRange, params, {
          start: 'e.start_s',
          end: 'GREATEST(COALESCE(e.end_s, e.start_s), e.start_s + 1)',
        }),
      ].join(' '),
  };
}

/**
 * Fenêtres candidates BM25 : celles qui contiennent tous les mots
 * (score de conjonction), complétées par celles qui en contiennent au moins un,
 * classées ensemble par score. Avec un filtre `kind`, la
 * fenêtre doit contenir une entrée de ce type portant un des mots.
 */
async function lexicalWindows(db: Db, tokens: string[], filters: Filters): Promise<number[]> {
  if (tokens.length === 0) return [];
  const params: unknown[] = [tokens.join(' ')];
  const filterSql = filters.windowSql(params);
  let kindSql = '';
  if (filters.input.kind) {
    params.push(filters.input.kind, wordPatterns(tokens));
    kindSql = `AND EXISTS (
      SELECT 1 FROM entries e
      WHERE e.video_id = w.video_id AND e.kind = $${params.length - 1}
        AND e.start_s <= w.end_s AND GREATEST(COALESCE(e.end_s, e.start_s), e.start_s + 1) > w.start_s
        AND e.norm_text ~* ANY($${params.length}::text[]))`;
  }
  const { rows } = await db.query<{ id: number }>(
    `WITH strict AS (
       SELECT w.id, pdb.score(w.id) AS score
       FROM windows w JOIN videos v USING (video_id)
       WHERE w.text &&& $1 ${filterSql} ${kindSql}
     ),
     loose AS (
       SELECT w.id, pdb.score(w.id) AS score
       FROM windows w JOIN videos v USING (video_id)
       WHERE w.text ||| $1 ${filterSql} ${kindSql}
         AND w.id NOT IN (SELECT id FROM strict)
     )
     SELECT id FROM (SELECT * FROM strict UNION ALL SELECT * FROM loose) c
     ORDER BY score DESC, id
     LIMIT ${filters.candidates ?? LEXICAL_CANDIDATES}`,
    params,
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Fenêtres dont un bloc de 30 s porte les mots de la question dans son
 * enrichissement (phrase de contexte et mots-clés, `npm run enrich`) : un
 * passage qui ne prononce jamais « blessure » peut ainsi être trouvé. Vide tant
 * qu'aucun bloc n'est enrichi. Filtre `kind` ignoré : un bloc mêle les deux.
 */
async function enrichmentWindows(db: Db, tokens: string[], filters: Filters): Promise<SemanticHits> {
  const none: SemanticHits = { windowIds: [], entriesByWindow: new Map(), bestDistance: null };
  if (tokens.length === 0) return none;
  const params: unknown[] = [tokens.join(' ')];
  const { input } = filters;
  const filterSql = [
    collectionSql(input.collection, params),
    videoIdSql(input.videoId, params),
    videoIdsSql(input.videoIds, params),
    dateRangeSql(input.dateRange, params),
    timeRangeSql(input.timeRange, params, { start: 'c.start_s', end: 'c.end_s' }),
  ].join(' ');
  // Les entrées du bloc deviennent des preuves candidates de la fenêtre (le mot n'y figure pas forcément).
  const { rows } = await db.query<{ window_id: number; entry_id: number; score: number }>(
    `WITH hits AS (
       SELECT c.video_id, c.start_s, c.end_s, pdb.score(c.id) AS score
       FROM chunks c JOIN videos v USING (video_id)
       WHERE c.enrichment ||| $1 ${filterSql}
       ORDER BY score DESC
       LIMIT ${filters.candidates ?? LEXICAL_CANDIDATES}
     )
     SELECT w.id AS window_id, e.id AS entry_id, h.score
     FROM hits h
     JOIN windows w ON w.video_id = h.video_id AND w.start_s < h.end_s AND w.end_s > h.start_s
     JOIN entries e ON e.video_id = h.video_id
      AND e.start_s >= h.start_s AND e.start_s < h.end_s
      AND e.start_s <= w.end_s AND e.start_s + 1 > w.start_s
     ORDER BY h.score DESC, w.id, e.start_s`,
    params,
  );
  const windowIds: number[] = [];
  const entriesByWindow = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const windowId = Number(row.window_id);
    let entries = entriesByWindow.get(windowId);
    if (!entries) {
      entries = new Map();
      entriesByWindow.set(windowId, entries);
      windowIds.push(windowId);
    }
    // Pas de distance à la question : ces preuves passent après celles qui portent les mots ou sont proches.
    entries.set(Number(row.entry_id), Number.POSITIVE_INFINITY);
  }
  return { windowIds, entriesByWindow, bestDistance: null };
}

/**
 * Entrées les plus proches de la question (HNSW, filtres appliqués avant le
 * top-k grâce à `hnsw.iterative_scan`), rattachées aux fenêtres qui les couvrent.
 */
async function semanticWindows(
  db: Db,
  queryVector: number[],
  filters: Filters,
): Promise<{ windowIds: number[]; entriesByWindow: Map<number, Map<number, number>>; bestDistance: number | null }> {
  const params: unknown[] = [vectorLiteral(queryVector)];
  const filterSql = filters.entrySql(params);
  const { rows } = await db.query<{ window_id: number; entry_id: number; distance: number }>(
    `WITH ranked AS (
       SELECT e.id, e.video_id, e.start_s, e.embedding <=> $1::halfvec AS distance
       FROM entries e JOIN videos v USING (video_id)
       WHERE e.embedding IS NOT NULL ${filterSql}
       ORDER BY e.embedding <=> $1::halfvec
       LIMIT ${filters.candidates ?? SEMANTIC_CANDIDATES}
     )
     SELECT w.id AS window_id, r.id AS entry_id, r.distance
     FROM ranked r
     JOIN windows w ON w.video_id = r.video_id AND r.start_s <= w.end_s AND r.start_s + 1 > w.start_s
     ORDER BY r.distance, w.id`,
    params,
  );
  const windowIds: number[] = [];
  const entriesByWindow = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const windowId = Number(row.window_id);
    let entries = entriesByWindow.get(windowId);
    if (!entries) {
      entries = new Map();
      entriesByWindow.set(windowId, entries);
      windowIds.push(windowId);
    }
    entries.set(Number(row.entry_id), row.distance);
  }
  return { windowIds, entriesByWindow, bestDistance: rows[0] ? Number(rows[0].distance) : null };
}

type SemanticHits = Awaited<ReturnType<typeof semanticWindows>>;

/**
 * Blocs de 30 s les plus proches de la question, rattachés aux fenêtres
 * qui les recouvrent. Les preuves restent des entrées : chaque entrée du bloc
 * porte sa propre distance, pour que la meilleure preuve soit la phrase la plus
 * proche et non la première du bloc. Filtre `kind` appliqué aux preuves.
 */
async function chunkWindows(db: Db, queryVector: number[], filters: Filters): Promise<SemanticHits> {
  const params: unknown[] = [vectorLiteral(queryVector)];
  const { input } = filters;
  const chunkFilter = [
    collectionSql(input.collection, params),
    videoIdSql(input.videoId, params),
    videoIdsSql(input.videoIds, params),
    dateRangeSql(input.dateRange, params),
    timeRangeSql(input.timeRange, params, { start: 'c.start_s', end: 'c.end_s' }),
  ].join(' ');
  let kindSql = '';
  if (input.kind) {
    params.push(input.kind);
    kindSql = `AND e.kind = $${params.length}`;
  }
  const { rows } = await db.query<{ window_id: number; entry_id: number; chunk_distance: number; distance: number }>(
    `WITH ranked AS (
       SELECT c.id, c.video_id, c.start_s, c.end_s, c.embedding <=> $1::halfvec AS distance
       FROM chunks c JOIN videos v USING (video_id)
       WHERE c.embedding IS NOT NULL ${chunkFilter}
       ORDER BY c.embedding <=> $1::halfvec
       LIMIT ${filters.candidates ?? SEMANTIC_CANDIDATES}
     )
     SELECT w.id AS window_id, e.id AS entry_id, r.distance AS chunk_distance,
            COALESCE(e.embedding <=> $1::halfvec, r.distance) AS distance
     FROM ranked r
     JOIN windows w ON w.video_id = r.video_id AND w.start_s < r.end_s AND w.end_s > r.start_s
     JOIN entries e ON e.video_id = r.video_id
      AND e.start_s >= r.start_s AND e.start_s < r.end_s
      AND e.start_s <= w.end_s AND e.start_s + 1 > w.start_s
      ${kindSql}
     ORDER BY r.distance, w.id`,
    params,
  );
  const windowIds: number[] = [];
  const entriesByWindow = new Map<number, Map<number, number>>();
  for (const row of rows) {
    const windowId = Number(row.window_id);
    let entries = entriesByWindow.get(windowId);
    if (!entries) {
      entries = new Map();
      entriesByWindow.set(windowId, entries);
      windowIds.push(windowId);
    }
    entries.set(Number(row.entry_id), Number(row.distance));
  }
  return { windowIds, entriesByWindow, bestDistance: rows[0] ? Number(rows[0].chunk_distance) : null };
}

/** Réunit les distances par fenêtre de plusieurs recherches sémantiques (la plus faible l'emporte). */
function mergeEntryDistances(...maps: Array<Map<number, Map<number, number>>>): Map<number, Map<number, number>> {
  const merged = new Map<number, Map<number, number>>();
  for (const map of maps) {
    for (const [windowId, entries] of map) {
      const target = merged.get(windowId) ?? new Map<number, number>();
      for (const [entryId, distance] of entries) target.set(entryId, Math.min(target.get(entryId) ?? Infinity, distance));
      merged.set(windowId, target);
    }
  }
  return merged;
}

/** Motifs de preuve : mot entier, ou préfixe de 5 lettres pour les mots longs (flexions). */
function evidencePatterns(tokens: string[]): string[] {
  const patterns = wordPatterns(tokens);
  for (const token of tokens) {
    if (token.length > 5 && /^[a-z]+$/.test(token)) patterns.push(`\\m${escapeRegexTerm(token.slice(0, 5))}`);
  }
  return unique(patterns);
}

async function assemble(
  db: Db,
  windowIds: number[],
  scores: Map<number, number>,
  semanticEntries: Map<number, Map<number, number>>,
  evidenceTokens: string[],
  kind: Kind | undefined,
  withWindowText: boolean,
): Promise<SearchResult[]> {
  if (windowIds.length === 0) return [];
  const semanticIds = [...new Set([...semanticEntries.values()].flatMap((m) => [...m.keys()]))];
  const params: unknown[] = [windowIds, evidencePatterns(evidenceTokens), semanticIds];
  let kindSql = '';
  if (kind) {
    params.push(kind);
    kindSql = `AND e.kind = $${params.length}`;
  }
  const { rows } = await db.query<{
    window_id: number;
    video_id: string;
    w_start: number;
    w_end: number;
    title: string;
    published_at: string | null;
    entry_id: number;
    source_id: string;
    kind: Kind;
    start_s: number;
    end_s: number | null;
    text: string;
    uncertainties: string[];
    norm_text: string;
  }>(
    // Le texte de la fenêtre (~8 000 caractères) est lu à part, une fois par fenêtre : joint ici, il était
    // répété sur chaque ligne de preuve (mesuré : 6 Mo transférés pour 50 fenêtres).
    `SELECT w.id AS window_id, w.video_id, w.start_s AS w_start, w.end_s AS w_end,
            v.title, v.published_at::text AS published_at,
            e.id AS entry_id, e.source_id, e.kind, e.start_s, e.end_s, e.text, e.uncertainties, e.norm_text
     FROM windows w
     JOIN videos v USING (video_id)
     JOIN entries e
       ON e.video_id = w.video_id
      AND e.start_s <= w.end_s
      AND GREATEST(COALESCE(e.end_s, e.start_s), e.start_s + 1) > w.start_s
     WHERE w.id = ANY($1::bigint[])
       AND (e.norm_text ~* ANY($2::text[]) OR e.id = ANY($3::bigint[]))
       ${kindSql}
     ORDER BY w.id, e.start_s, e.source_id`,
    params,
  );

  const windowTexts = new Map<number, string>();
  if (withWindowText) {
    const { rows: texts } = await db.query<{ id: number; text: string }>('SELECT id, text FROM windows WHERE id = ANY($1::bigint[])', [windowIds]);
    for (const row of texts) windowTexts.set(Number(row.id), row.text);
  }

  const exact = wordPatterns(evidenceTokens).map((p) => new RegExp(p.replaceAll('\\m', '\\b').replaceAll('\\M', '\\b'), 'i'));
  type Scored = Evidence & { hits: number; informative: boolean; distance: number };
  const byWindow = new Map<number, { row: (typeof rows)[number]; evidence: Scored[] }>();
  for (const row of rows) {
    const windowId = Number(row.window_id);
    const group = byWindow.get(windowId) ?? { row, evidence: [] };
    group.evidence.push({
      sourceId: row.source_id,
      kind: row.kind,
      startS: row.start_s,
      endS: row.end_s,
      text: row.text,
      uncertainties: row.uncertainties ?? [],
      hits: exact.filter((re) => re.test(row.norm_text)).length,
      informative: row.kind === 'visuel' || new Set(contentTokens(tokenizeText(row.text).tokens)).size >= MIN_INFORMATIVE_TOKENS,
      distance: semanticEntries.get(windowId)?.get(Number(row.entry_id)) ?? Number.POSITIVE_INFINITY,
    });
    byWindow.set(windowId, group);
  }

  const results: SearchResult[] = [];
  for (const windowId of windowIds) {
    const group = byWindow.get(windowId);
    if (!group) continue;
    // Sans mot de la question, une réplique brève (« La fibre. », « Oui. ») n'est jamais la meilleure preuve :
    // son vecteur, presque vide de sens, est proche de toute question courte (mesuré : « femme » limitée à
    // JWkqKP9pWpc choisissait « La fibre. » à 0,74, devant chaque plan de la vidéo).
    const best = [...group.evidence].sort(
      (a, b) =>
        b.hits - a.hits ||
        (a.hits === 0 ? Number(b.informative) - Number(a.informative) : 0) ||
        a.distance - b.distance ||
        a.startS - b.startS,
    )[0]!;
    const strip = ({ hits: _h, informative: _i, distance: _d, ...evidence }: Scored): Evidence => evidence;
    results.push({
      windowId,
      videoId: group.row.video_id,
      title: group.row.title,
      publishedAt: group.row.published_at,
      startS: group.row.w_start,
      endS: group.row.w_end,
      link: timestampedLink(group.row.video_id, best.startS),
      evidence: group.evidence.map(strip),
      evidenceWeights: group.evidence.map((e) => e.hits + (Number.isFinite(e.distance) ? Math.max(0, 1 - e.distance) : 0)),
      bestEntry: strip(best),
      windowText: windowTexts.get(windowId) ?? '',
      score: scores.get(windowId) ?? 0,
    });
  }
  return results;
}

function rrf(lists: Array<{ weight: number; ids: number[] }>): Array<[number, number]> {
  const fused = new Map<number, number>();
  for (const { weight, ids } of lists) {
    ids.forEach((id, index) => fused.set(id, (fused.get(id) ?? 0) + weight / (RRF_K + index + 1)));
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/**
 * Recherche classée : fenêtres de contexte les plus pertinentes, par
 * fusion RRF du lexical (BM25) et du sémantique (HNSW). Ne prétend jamais être
 * exhaustive. Sans vecteurs utilisables, bascule en lexical et le signale.
 */
export async function chercher(
  pool: Pool,
  input: SearchInput,
  options: SearchOptions = {},
): Promise<Page<SearchData>> {
  // Jusqu'à 100 fenêtres (500 en recherche profonde) : `repondre` en demande beaucoup et laisse le modèle trier.
  const limit = options.deep ? clampLimit(input.limit, 8, DEEP_LIMIT) : clampLimit(input.limit, 8, 100);
  const tokens = unique(tokenizeText(input.query).tokens);
  const evidenceTokens = contentTokens(tokens);
  const filters = buildFilters(input, options.deep ? DEEP_CANDIDATES : undefined);

  // Encodage de la question hors transaction (aucun appel modèle dans l'instantané).
  const embedder = options.embedder === undefined ? embeddingFromConfig() : options.embedder;
  const publishedModel = await getMetaString(pool, 'embedding_model');
  let queryVector: number[] | null = null;
  let hypotheticalVector: number[] | null = null;
  let semanticIssue: string | null = null;
  if (tokens.length === 0) {
    semanticIssue = 'requête vide après normalisation';
  } else if (!embedder) {
    semanticIssue = 'aucun modèle d’embedding configuré : lexical seul';
  } else if (publishedModel === null) {
    semanticIssue = 'aucun embedding publié (lancer npm run embed) : lexical seul';
  } else if (publishedModel !== embedder.model) {
    semanticIssue = `modèle configuré « ${embedder.model} » ≠ modèle indexé « ${publishedModel} » : lexical seul, réindexation requise`;
  } else {
    try {
      // L'extrait hypothétique est encodé comme un document : il imite un passage du corpus.
      const hypothetical = input.hypothetical?.trim();
      queryVector = (await embedder.embed([input.query], 'query'))[0] ?? null;
      if (hypothetical) hypotheticalVector = (await embedder.embed([hypothetical], 'document'))[0] ?? null;
    } catch (err) {
      semanticIssue = `encodeur indisponible (${err instanceof Error ? err.message : String(err)}) : lexical seul`;
    }
  }

  return readSnapshot(pool, async (db, versions) => {
    // Couverture des deux espaces sémantiques : les entrées (phrases) et les blocs de 30 s.
    const { entries: entryCoverage, chunks: chunkCoverage } = await embeddingCoverage(db, versions);
    const coverage = {
      ready: entryCoverage.ready + chunkCoverage.ready,
      total: entryCoverage.total + chunkCoverage.total,
    };
    const key = cursorKey(
      'chercher',
      input.query,
      input.kind ?? '',
      input.videoId ?? '',
      JSON.stringify(input.videoIds ?? []),
      JSON.stringify(input.timeRange ?? null),
      JSON.stringify(input.dateRange ?? null),
      input.collection ?? '',
      JSON.stringify(input.variants ?? []),
      input.hypothetical ?? '',
      versions.corpusVersion,
      versions.indexVersion,
    );
    const offset = pageOffset(key, input.cursor);

    const correctedTokens = tokens.length > 0 ? await correctTokens(db, tokens, versions.corpusVersion) : [];
    const { rewritten: joinedQuery, joined } = joinedWords(
      tokenizeText(input.query).tokens,
      new Set(tokens.length > 0 ? await lexique(db, 'tout', versions.corpusVersion) : []),
    );
    const lexicalIds = await lexicalWindows(db, correctedTokens, filters);
    // L'enrichissement a son propre vocabulaire (catégories, synonymes) : les mots de la question tels quels, et corrigés.
    const enrichmentHits =
      options.enrichment === false
        ? { windowIds: [], entriesByWindow: new Map<number, Map<number, number>>(), bestDistance: null }
        : await enrichmentWindows(db, unique([...tokens, ...correctedTokens]), filters);
    const variantLists: number[][] = [];
    if (joinedQuery.length > 0) variantLists.push(await lexicalWindows(db, joinedQuery, filters));
    for (const variant of input.variants ?? []) {
      const variantTokens = unique(tokenizeText(variant).tokens);
      if (variantTokens.length > 0) variantLists.push(await lexicalWindows(db, variantTokens, filters));
    }
    const none: SemanticHits = { windowIds: [], entriesByWindow: new Map(), bestDistance: null };
    const entryHits =
      queryVector !== null && entryCoverage.ready > 0 ? await semanticWindows(db, queryVector, filters) : none;
    const chunkHits =
      queryVector !== null && chunkCoverage.ready > 0 ? await chunkWindows(db, queryVector, filters) : none;
    // HyDE : seules les fenêtres comptent ; les distances des preuves restent celles de la vraie question.
    const hypotheticalHits =
      hypotheticalVector !== null && chunkCoverage.ready > 0 ? await chunkWindows(db, hypotheticalVector, filters) : none;

    // Les deux espaces se partagent le poids sémantique : l'équilibre avec le lexical ne change pas.
    // Le poids sémantique est partagé entre les entrées et les blocs.
    const semanticWeight = SEMANTIC_WEIGHT / 2;
    const fused = rrf([
      { weight: LEXICAL_WEIGHT, ids: lexicalIds },
      { weight: semanticWeight, ids: entryHits.windowIds },
      { weight: semanticWeight, ids: chunkHits.windowIds },
      { weight: HYPOTHETICAL_WEIGHT, ids: hypotheticalHits.windowIds },
      { weight: ENRICHMENT_WEIGHT, ids: enrichmentHits.windowIds },
      ...variantLists.map((ids) => ({ weight: VARIANT_WEIGHT, ids })),
    ]);
    const pageIds = fused.slice(offset, offset + limit).map(([id]) => id);
    const results = await assemble(
      db,
      pageIds,
      new Map(fused),
      mergeEntryDistances(entryHits.entriesByWindow, chunkHits.entriesByWindow, enrichmentHits.entriesByWindow),
      unique([...(evidenceTokens.length > 0 ? evidenceTokens : tokens), ...joined]),
      input.kind,
      options.windowText !== false,
    );

    const partial = queryVector !== null && coverage.ready < coverage.total;
    const data: SearchData = {
      results,
      degraded: semanticIssue !== null || partial,
      degradedReason:
        semanticIssue ?? (partial ? `embeddings incomplets (${coverage.ready}/${coverage.total}) : couverture sémantique partielle` : null),
      embeddingCoverage: coverage,
      candidates: {
        lexical: lexicalIds.length,
        semantic: new Set([...entryHits.windowIds, ...chunkHits.windowIds]).size,
        variants: variantLists.reduce((sum, ids) => sum + ids.length, 0),
      },
      // Signal de pertinence des entrées quand elles sont interrogées (échelle mesurée), sinon des blocs.
      bestDistance: entryHits.bestDistance ?? chunkHits.bestDistance,
    };
    return pageOf(data, versions, { key, offset, returned: pageIds.length, total: fused.length });
  });
}
