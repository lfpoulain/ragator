import type { Pool } from 'pg';
import { getMetaString } from '../db/meta.js';
import { readSnapshot, type Db } from '../db/pool.js';
import { vectorLiteral, type EmbeddingClient } from '../providers/embedding.js';
import type { RelevanceJudge } from '../providers/judge.js';
import { OCCURRENCE_PROMPT, promptLine, renderPassage } from '../prompts/answer.js';
import type { LlmClient } from '../providers/llm.js';
import type { RequiredTerm } from './analyze.js';
import { evidenceBudgetChars, passagesForSpans, type Passage, type PassageSpan } from './passages.js';
import { wordPatterns } from './resolve.js';
import { sortByDate } from './video-rank.js';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import { missingRequiredGroups, requiredGroups } from './requirements.js';
import type { Claim } from './citations.js';
import { entrySource, type AnswerSource } from './sources.js';

/**
 * « La première / dernière fois qu'ils… » : parcours chronologique. Le chemin des questions générales
 * (juger 150 à 300 vidéos sur deux courts passages, puis trier par date) fait reposer la réponse sur une
 * seule décision prise sur des extraits choisis pour autre chose : le juge voyait le déballage d'une scie
 * et son prix, jamais la découpe. Ici :
 * 1. candidates exactes, triées par date : les vidéos qui citent le sujet (paroles, plans ou écran) et,
 *    s'il y en a, une exigence (marque, modèle) ; s'y ajoutent quelques vidéos trouvées par le sens (le
 *    geste ou l'idée dits avec d'autres mots), parmi les plus proches de la question ;
 * 2. chaque moment où le sujet apparaît, élargi (l'usage suit souvent l'annonce), est jugé séparément :
 *    une introduction bavarde ne cache plus la scène d'usage ;
 * 3. les candidates sont examinées dans l'ordre du temps, par petites vagues ; la première dont un
 *    moment est retenu répond.
 */

/** Autour d'un moment où le sujet apparaît : un peu avant, plus après (l'usage suit l'annonce). */
const BEFORE_S = 20;
const AFTER_S = 90;
/** Un intervalle jugé ne dépasse pas 2 min 30 : au-delà, il est coupé en plusieurs. */
const MAX_SPAN_S = 150;
/** Moments jugés au plus par vidéo, ceux qui réunissent sujet et exigence d'abord. */
const MAX_MOMENTS = 12;
/** Vidéos examinées par vague, et au plus en tout avant de revenir au chemin général. */
const WAVE = 4;
const MAX_EXAMINED = 24;
/**
 * Candidates par le sens : les vidéos des phrases et des blocs les plus proches de la question et de
 * l'extrait hypothétique (HyDE). Parmi les `SENSE_POOL` plus proches, les `MAX_SENSE` plus anciennes (ou
 * récentes) rejoignent les candidates exactes, avec leurs `SENSE_MOMENTS` meilleurs moments.
 */
const SENSE_NEIGHBOURS = 100;
const SENSE_POOL = 24;
const MAX_SENSE = 8;
const SENSE_MOMENTS = 3;
/** Rang lissé de la fusion des listes de voisins (RRF). */
const SENSE_RRF_K = 60;
/**
 * Une vidéo qui ne cite pas le sujet est une preuve plus faible : le juge doit en être sûr. Mesuré sur 17
 * questions : les bonnes réponses trouvées ainsi reçoivent 0,88-0,91, les fausses (une gravure à la
 * fraiseuse CNC pour « au laser », une imprimante utilisée par un hôte) 0,38-0,61.
 */
const SENSE_THRESHOLD = 0.7;

export interface ChronologicalVideo {
  videoId: string;
  /** Contexte éditorial et introduction, utiles pour identifier un hôte ou un projet annoncé. */
  context: string;
  /** Moments retenus de la vidéo, dans l'ordre du film. */
  passages: Passage[];
  /** Meilleure probabilité parmi ces moments. */
  relevance: number;
  /** Affirmation et preuve relues dans cette vidéo, avec les identifiants du corpus. */
  claim?: Claim;
}

/** « Ils versent X dans un Y » impose aussi la destination du geste ; une vidéo ou un épisode
 * désigne plutôt la portée de la recherche. Les autres formulations restent évaluées par le relecteur. */
export function chronologicalRequirements(question: string, required: RequiredTerm[]): RequiredTerm[] {
  const target = /\bdans (?:un|une|des) ([\p{L}-]+)\s*[?.!]*$/iu.exec(question)?.[1];
  if (!target) return required;
  const noun = tokenizeText(target).norm;
  if (/^(?:video|episode|extrait|passage|chaine)s?$/.test(noun) || required.some((term) => term.forms.includes(noun))) return required;
  const forms = new Set([noun]);
  if (noun.endsWith('al')) forms.add(noun.slice(0, -2) + 'aux');
  else if (noun.endsWith('aux')) forms.add(noun.slice(0, -3) + 'al').add(noun.slice(0, -1));
  else if (/(?:eau|eu)$/.test(noun)) forms.add(noun + 'x');
  else if (/[sx]$/.test(noun)) forms.add(noun.slice(0, -1));
  else if (!noun.endsWith('z')) forms.add(noun + 's');
  return [...required, { term: target, forms: [...forms] }];
}

/** Le modèle choisit la ligne qui montre le geste. Le verdict et l'affichage utilisent exactement
 * cette ligne du corpus, sans recopier du texte libre ni extrapoler une date. */
export async function reviewOccurrence(
  video: ChronologicalVideo, question: string, required: RequiredTerm[], llm: LlmClient, subject?: RequiredTerm,
): Promise<Claim | null> {
  const sources = new Map<string, AnswerSource>();
  const seen = new Set<string>();
  const details = required.map((r) => r.term).join(', ');
  const lines = [`Question : ${question}\nVidéo : ${video.passages[0]!.title}\nObjet du geste : ${subject?.term ?? ''}. Détails à rattacher à cet objet : ${details}.\nContexte pour identifier les personnes et l’épisode (non citable) :\n${video.context}\n\nPassages à vérifier :`];
  const asksUse = /(?<!\p{L})(?:utilis|emplo|servent|sert|testent|essaient)\p{L}*/iu.test(question) && !/déball|emball/iu.test(question);
  const groups = requiredGroups(question, required);
  let screenClue: AnswerSource | undefined;
  let remaining = evidenceBudgetChars(100) - lines[0]!.length;
  for (const passage of video.passages) {
    for (const entry of passage.entries) {
      if (seen.has(entry.sourceId)) continue;
      seen.add(entry.sourceId);
      // La présentation du carton permet d'identifier l'objet. Pour une question d'usage,
      // garder ce plan comme contexte et proposer comme citation le geste qui suit.
      const unboxing = asksUse && /^(?:déballage|ouverture (?:du|de la) (?:carton|bo[iî]te)|présentation du carton)/iu.test(entry.planTitle ?? '') &&
        !/essai|test|utilisation/iu.test(entry.planTitle ?? '');
      const alias = unboxing ? 'contexte' : `s${sources.size + 1}`;
      const line = promptLine(entry, () => alias);
      // Schéma fermé : réserver une valeur pour « aucun » dans la limite de 1 000 du fournisseur.
      if (line.length + 1 > remaining || sources.size >= 999) continue;
      remaining -= line.length + 1;
      if (!unboxing) {
        const source = entrySource(entry, passage);
        sources.set(alias, source);
        if (!screenClue && subject && groups.length && entry.kind === 'visuel' && entry.screenText?.length) {
          const scene = tokenizeText([entry.planTitle, entry.text].join(' ')).norm;
          if (!missingRequiredGroups([[subject]], scene).length && missingRequiredGroups(groups, scene).length &&
              !missingRequiredGroups(groups, tokenizeText(source.excerpt).norm).length) screenClue = source;
        }
      }
      lines.push(line);
    }
  }
  const raw = await llm.chat(OCCURRENCE_PROMPT, lines.join('\n'), {
    maxTokens: 80, temperature: 0, jsonSchema: { name: 'occurrence', schema: {
      type: 'object', properties: {
        statut: { type: 'string', enum: ['observe', 'indice', 'absent'] },
        sourceId: { type: 'string', enum: ['aucun', ...sources.keys()] },
      }, required: ['statut', 'sourceId'], additionalProperties: false,
    } },
  });
  let verdict: { statut?: string; sourceId?: string } | null;
  try { verdict = JSON.parse(raw); } catch { return null; }
  const selected = (verdict?.statut === 'observe' || verdict?.statut === 'indice') ? sources.get(verdict.sourceId ?? '') : undefined;
  // Un plan citant l'objet avec la seule marque à l'écran reste une piste datée, même si le
  // relecteur n'y voit pas une démonstration complète. Le texte exact indique ce qui est visible.
  const source = selected ?? screenClue;
  if (!source) return null;
  const missing = missingRequiredGroups(groups, tokenizeText(source.excerpt).norm);
  // Un logo à l'écran peut appartenir à un autre outil du même plan.
  const description = source.excerpt.split(' | ÉCRAN :')[0]!;
  const onlyOnScreen = source.kind === 'visuel' && description !== source.excerpt &&
    missingRequiredGroups(groups, tokenizeText(description).norm).length > missing.length;
  const uncertain = !selected || verdict?.statut === 'indice' || missing.length > 0 || onlyOnScreen;
  return {
    sourceIds: [source.sourceId], preuve: source.excerpt, text: `« ${source.excerpt} »`, relevance: video.relevance,
    ...(uncertain ? { missing: onlyOnScreen ? 'le texte à l’écran ne permet pas d’attribuer avec certitude ce détail à l’objet utilisé' : 'le geste ou son lien avec le détail demandé reste à confirmer dans cet extrait' } : {}),
  };
}

export interface FirstTimeResult {
  /** Première candidate avec un passage qui répond et qui relie sujet et exigence. */
  confirmed: ChronologicalVideo | null;
  /**
   * Pistes plus anciennes (ou récentes) dont les moments retenus ne relient pas l'exigence au sujet
   * (« Ryobi » sur un cloueur, une scie circulaire à côté).
   */
  earlier: ChronologicalVideo[];
  /** Vidéos examinées avant de conclure, et candidates au total. */
  examined: number;
  candidates: number;
  corpusVersion: string;
  indexVersion: string;
}

interface Candidate {
  videoId: string;
  title: string;
  context: string;
  /** Le passage contient une ligne reliant sujet et exigence, ou aucune exigence n'est imposée. */
  moments: Array<{ passage: Passage; linked: boolean }>;
  /** Trouvée par le sens ou par les mots répartis dans une fenêtre, sans mention exacte du sujet. */
  indirect: boolean;
}

/** Vidéos faiblement prouvées gardées au plus avant la réponse, en « éventuellement ». */
const MAX_EARLIER = 3;

/** Intervalles d'une vidéo autour des moments où le sujet (ou l'exigence) apparaît, fusionnés puis coupés. */
function spansOf(
  video: { video_id: string; title: string; published_at: string | null },
  moments: Array<{ start_s: number; subject: boolean; required: boolean }>,
): PassageSpan[] {
  const merged: Array<{ startS: number; endS: number; score: number }> = [];
  for (const m of moments) {
    const startS = Math.max(0, m.start_s - BEFORE_S);
    const endS = m.start_s + AFTER_S;
    const score = (m.subject ? 2 : 0) + (m.required ? 1 : 0);
    const last = merged.at(-1);
    if (last && startS <= last.endS && endS - last.startS <= MAX_SPAN_S) {
      last.endS = endS;
      last.score = Math.max(last.score, score);
    } else merged.push({ startS, endS: Math.min(endS, startS + MAX_SPAN_S), score });
  }
  return merged
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => b.score - a.score || a.startS - b.startS)
    .slice(0, MAX_MOMENTS)
    .sort((a, b) => a.startS - b.startS)
    .map((m) => ({ videoId: video.video_id, title: video.title, publishedAt: video.published_at, startS: m.startS, endS: m.endS, rank: m.i }));
}

/** Un voisin de la question : une phrase ou un bloc de 30 s, et son rang dans sa liste (0 : le plus proche). */
export interface SenseHit {
  videoId: string;
  publishedAt: string | null;
  startS: number;
  rank: number;
}

/**
 * Vidéos trouvées par le sens, hors candidates exactes : score RRF de leur meilleur voisin dans chaque
 * liste, les `SENSE_POOL` meilleures, puis les `MAX_SENSE` plus anciennes (ou récentes), chacune avec les
 * débuts de ses `SENSE_MOMENTS` voisins les plus proches et distincts, dans l'ordre du film.
 */
export function pickBySense(
  lists: SenseHit[][],
  exact: ReadonlySet<string>,
  order: 'premiere' | 'derniere',
): Array<{ videoId: string; publishedAt: string | null; moments: number[] }> {
  const byVideo = new Map<string, { videoId: string; publishedAt: string | null; score: number; hits: SenseHit[] }>();
  for (const list of lists) {
    const counted = new Set<string>();
    for (const hit of list) {
      if (exact.has(hit.videoId)) continue;
      let video = byVideo.get(hit.videoId);
      if (!video) byVideo.set(hit.videoId, (video = { videoId: hit.videoId, publishedAt: hit.publishedAt, score: 0, hits: [] }));
      if (!counted.has(hit.videoId)) video.score += 1 / (SENSE_RRF_K + hit.rank + 1);
      counted.add(hit.videoId);
      video.hits.push(hit);
    }
  }
  const nearest = [...byVideo.values()].sort((a, b) => b.score - a.score || a.videoId.localeCompare(b.videoId)).slice(0, SENSE_POOL);
  return sortByDate(nearest, order)
    .slice(0, MAX_SENSE)
    .map((video) => {
      const moments: number[] = [];
      for (const hit of [...video.hits].sort((a, b) => a.rank - b.rank)) {
        // Un voisin déjà couvert par l'intervalle d'un moment retenu n'en ajoute pas.
        if (moments.some((startS) => Math.abs(startS - hit.startS) < AFTER_S)) continue;
        moments.push(hit.startS);
        if (moments.length === SENSE_MOMENTS) break;
      }
      return { videoId: video.videoId, publishedAt: video.publishedAt, moments: moments.sort((a, b) => a - b) };
    });
}

/** Voisins de chaque vecteur parmi les phrases, puis parmi les blocs (HNSW, collection appliquée avant le top-k). */
async function senseHits(db: Db, vectors: number[][], collection: string | null): Promise<SenseHit[][]> {
  const lists: SenseHit[][] = [];
  for (const vector of vectors) {
    for (const table of ['entries', 'chunks'] as const) {
      const { rows } = await db.query<{ video_id: string; published_at: string | null; start_s: number }>(
        `SELECT t.video_id, v.published_at::text AS published_at, t.start_s
         FROM ${table} t JOIN videos v USING (video_id)
         WHERE t.embedding IS NOT NULL AND ($2::text IS NULL OR v.collection = $2)
         ORDER BY t.embedding <=> $1::halfvec
         LIMIT ${SENSE_NEIGHBOURS}`,
        [vectorLiteral(vector), collection],
      );
      lists.push(rows.map((r, rank) => ({ videoId: r.video_id, publishedAt: r.published_at, startS: r.start_s, rank })));
    }
  }
  return lists;
}

/** De quoi chercher par le sens : l'encodeur des questions et l'extrait hypothétique de l'analyse (HyDE). */
export interface SenseQuery {
  embedder: EmbeddingClient | null;
  hypothetical: string | null;
}

/** Vecteurs de la question et de son extrait hypothétique, hors instantané ; vide si l'encodeur manque ou échoue. */
async function senseVectors(pool: Pool, question: string, sense: SenseQuery | null): Promise<number[][]> {
  if (!sense?.embedder || (await getMetaString(pool, 'embedding_model')) !== sense.embedder.model) return [];
  const { embedder, hypothetical } = sense;
  try {
    const [asked, imagined] = await Promise.all([
      embedder.embed([question], 'query'),
      hypothetical ? embedder.embed([hypothetical], 'document') : Promise.resolve([]),
    ]);
    return [...asked, ...imagined];
  } catch {
    return [];
  }
}

/** Candidates triées par date et leurs moments, lus dans un seul instantané. */
async function candidatesOf(
  db: Db,
  subject: RequiredTerm,
  required: RequiredTerm[],
  groups: RequiredTerm[][],
  order: 'premiere' | 'derniere',
  collection: string | null,
  /** Vecteurs de la question et de l'extrait hypothétique ; vide : candidates exactes seules. */
  vectors: number[][],
): Promise<{ total: number; list: Candidate[] }> {
  const subjectPatterns = wordPatterns(subject.forms);
  const requiredPatterns = wordPatterns(required.flatMap((r) => r.forms));
  const { rows: videos } = await db.query<{ video_id: string; title: string; published_at: string | null }>(
    `SELECT v.video_id, v.title, v.published_at::text AS published_at
     FROM videos v
     WHERE EXISTS (SELECT 1 FROM entries e WHERE e.video_id = v.video_id AND e.norm_text ~* ANY($1::text[]))
       AND (cardinality($2::text[]) = 0
            OR EXISTS (SELECT 1 FROM entries e WHERE e.video_id = v.video_id AND e.norm_text ~* ANY($2::text[])))
       AND ($3::text IS NULL OR v.collection = $3)
     ORDER BY v.published_at ${order === 'premiere' ? 'ASC' : 'DESC'} NULLS LAST, v.video_id`,
    [subjectPatterns, requiredPatterns, collection],
  );
  const exactIds = new Set(videos.map((v) => v.video_id));
  // Un sujet composé (« imprimante 3D résine ») peut être décrit en plusieurs lignes.
  // La conjonction BM25 fournit le passage à relire ; son texte indexé ne devient pas une citation.
  // Le tokenizer BM25 porte sur le texte brut des fenêtres : conserver « 3D » tel quel.
  const words = subject.term.split(/\s+/u).filter((word) => contentTokens(tokenizeText(word).tokens).length > 0);
  type WordWindow = { video_id: string; title: string; published_at: string | null; start_s: number; end_s: number; rank: number };
  const wordWindows = words.length < 2 ? [] : (await db.query<WordWindow>(
    `WITH matches AS (
       SELECT w.video_id, v.title, v.published_at::text AS published_at, w.start_s, w.end_s, pdb.score(w.id) AS score
       FROM windows w JOIN videos v USING (video_id)
       WHERE w.text &&& $1 AND ($2::text IS NULL OR v.collection = $2) AND NOT (w.video_id = ANY($3::text[]))
         AND (cardinality($4::text[]) = 0 OR EXISTS (
           SELECT 1 FROM entries e WHERE e.video_id = w.video_id AND e.norm_text ~* ANY($4::text[])))
     ), ranked AS (
       SELECT *, dense_rank() OVER (ORDER BY published_at ${order === 'premiere' ? 'ASC' : 'DESC'} NULLS LAST, video_id) AS video_rank,
              row_number() OVER (PARTITION BY video_id ORDER BY score DESC, start_s)::int AS rank
       FROM matches
     )
     SELECT video_id, title, published_at, start_s, end_s, rank FROM ranked
     WHERE video_rank <= ${MAX_EXAMINED} AND rank <= ${MAX_MOMENTS}
     ORDER BY video_rank, start_s`,
    [words.join(' '), collection, [...exactIds], requiredPatterns],
  )).rows;
  const wordVideos = new Map(wordWindows.map((w) => [w.video_id, w]));
  const lexicalIds = new Set([...exactIds, ...wordVideos.keys()]);
  // Par le sens : des vidéos proches qui ne citent pas le sujet, mais citent l'exigence s'il y en a une.
  const picked = vectors.length > 0 ? pickBySense(await senseHits(db, vectors, collection), lexicalIds, order) : [];
  const { rows: senseVideos } = await db.query<{ video_id: string; title: string; published_at: string | null }>(
    `SELECT v.video_id, v.title, v.published_at::text AS published_at
     FROM videos v
     WHERE v.video_id = ANY($1::text[])
       AND (cardinality($2::text[]) = 0
            OR EXISTS (SELECT 1 FROM entries e WHERE e.video_id = v.video_id AND e.norm_text ~* ANY($2::text[])))`,
    [picked.map((p) => p.videoId), requiredPatterns],
  );
  const senseMoments = new Map(picked.map((p) => [p.videoId, p.moments]));
  const examined = sortByDate(
    [...videos, ...wordVideos.values(), ...senseVideos].map((v) => ({ ...v, publishedAt: v.published_at })),
    order,
  ).slice(0, MAX_EXAMINED);
  const { rows: contexts } = await db.query<{ video_id: string; context: string }>(
    `SELECT v.video_id, concat_ws(E'\n', v.channel, left(split_part(v.description, E'\n\n', 1), 500),
            left((SELECT string_agg(e.text, E'\n' ORDER BY e.start_s, e.source_id) FROM entries e
                  WHERE e.video_id = v.video_id AND e.start_s < 90), 3500)) AS context
     FROM videos v WHERE v.video_id = ANY($1::text[])`, [examined.map((v) => v.video_id)],
  );
  const context = new Map(contexts.map((row) => [row.video_id, row.context]));

  const { rows: moments } = await db.query<{ video_id: string; source_id: string; start_s: number; norm_text: string; subject: boolean; required: boolean }>(
    `SELECT e.video_id, e.source_id, e.start_s, e.norm_text,
            e.norm_text ~* ANY($2::text[]) AS subject,
            cardinality($3::text[]) > 0 AND e.norm_text ~* ANY($3::text[]) AS required
     FROM entries e
     WHERE e.video_id = ANY($1::text[]) AND e.norm_text ~* ANY($2::text[])
     ORDER BY e.video_id, e.start_s`,
    [examined.filter((v) => exactIds.has(v.video_id)).map((v) => v.video_id), subjectPatterns, requiredPatterns],
  );
  const spans = examined.flatMap((video) => {
    if (exactIds.has(video.video_id)) return spansOf(video, moments.filter((m) => m.video_id === video.video_id));
    if (wordVideos.has(video.video_id)) {
      return wordWindows.filter((w) => w.video_id === video.video_id).map((w) => ({
        videoId: w.video_id, title: w.title, publishedAt: w.published_at, startS: w.start_s, endS: w.end_s, rank: w.rank,
      }));
    }
    return spansOf(video, (senseMoments.get(video.video_id) ?? []).map((startS) => ({ start_s: startS, subject: true, required: false })));
  });
  const passages = await passagesForSpans(db, spans);
  return {
    total: lexicalIds.size + senseVideos.length,
    list: examined.map((video) => {
      const links = new Map(moments.filter((m) => m.video_id === video.video_id && m.required).map((m) => [m.source_id, m.norm_text]));
      return {
        videoId: video.video_id,
        title: video.title,
        context: context.get(video.video_id) ?? '',
        moments: passages.filter((p) => p.videoId === video.video_id).map((passage) => ({
          passage,
          linked: required.length === 0 || missingRequiredGroups(groups, passage.entries.map((e) => links.get(e.sourceId) ?? '').join(' | ')).length === 0,
        })),
        indirect: !exactIds.has(video.video_id),
      };
    }),
  };
}

/**
 * Première (ou dernière) vidéo dont un moment est retenu par le juge, en partant de la plus ancienne (ou
 * récente). Une recherche avec des pistes insuffisantes les rend avec `confirmed: null`. Si aucun
 * moment n'a franchi le seuil du juge, `null` laisse l'appelant revenir au chemin général.
 */
export async function scanChronologically(
  pool: Pool,
  question: string,
  order: 'premiere' | 'derniere',
  subject: RequiredTerm,
  required: RequiredTerm[],
  judge: RelevanceJudge,
  threshold: number,
  /** Collection (créateur de contenu) à laquelle se limiter ; `null` : toutes. */
  collection: string | null = null,
  /** Candidates par le sens en plus des candidates exactes ; `null` : exactes seules. */
  sense: SenseQuery | null = null,
  onJudge?: (videos: number) => void,
  review?: (video: ChronologicalVideo) => Promise<Claim | null>,
): Promise<FirstTimeResult | null> {
  const vectors = await senseVectors(pool, question, sense);
  const { candidates, corpusVersion, indexVersion } = await readSnapshot(pool, async (db, versions) => ({
    candidates: await candidatesOf(db, subject, required, requiredGroups(question, required), order, collection, vectors),
    ...versions,
  }));
  const usable = candidates.list.filter((c) => c.moments.length > 0);
  const earlier: FirstTimeResult['earlier'] = [];
  let reviewed = false;
  const answer = (confirmed: ChronologicalVideo | null, examined: number): FirstTimeResult => ({
    confirmed,
    earlier,
    examined,
    candidates: candidates.total,
    corpusVersion,
    indexVersion,
  });
  for (let start = 0; start < usable.length; start += WAVE) {
    const wave = usable.slice(start, start + WAVE);
    onJudge?.(start + wave.length);
    // Une décision par moment ; une vidéo vaut son meilleur moment.
    const moments = wave.flatMap((c, video) => c.moments.map((moment) => ({ ...moment, video, title: c.title })));
    const probabilities = await judge.judge(question, moments.map((m) => ({ title: m.title, text: renderPassage(m.passage, (id) => id, false) })));
    const scored = moments.map((m, i) => ({ ...m, relevance: probabilities[i] ?? 0 }));
    for (let video = 0; video < wave.length; video++) {
      const candidate = wave[video]!;
      const needed = candidate.indirect ? Math.max(threshold, SENSE_THRESHOLD) : threshold;
      const retained = scored.filter((m) => m.video === video && m.relevance >= needed);
      if (retained.length === 0) continue;
      const linked = retained.filter((m) => m.linked);
      if (!candidate.indirect && linked.length === 0 && earlier.length >= MAX_EARLIER) continue;
      const selected = linked.length > 0 ? linked : retained;
      const match: ChronologicalVideo = {
        videoId: candidate.videoId,
        context: candidate.context,
        passages: selected.map((m) => m.passage),
        relevance: Math.max(...selected.map((m) => m.relevance)),
      };
      if (review) {
        reviewed = true;
        const claim = await review(match);
        if (!claim) continue;
        // Le relecteur peut reconnaître le sujet reformulé d'une candidate indirecte ; la preuve
        // doit alors porter toutes les exigences dans la ligne choisie (reviewOccurrence).
        if (!candidate.indirect && !linked.length) claim.missing ??= 'les passages retenus ne relient pas clairement les détails demandés au sujet';
        match.claim = claim;
      }
      if ((linked.length > 0 || (candidate.indirect && match.claim)) && !match.claim?.missing) return answer(match, start + video + 1);
      if (earlier.length < MAX_EARLIER) earlier.push(match);
    }
  }
  return earlier.length > 0 || reviewed ? answer(null, usable.length) : null;
}
