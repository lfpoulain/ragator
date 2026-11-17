import { getConfig } from '../config.js';
import type { Pool } from 'pg';
import { readSnapshot, type Db } from '../db/pool.js';
import { mapSpeaker } from '../norm/speakers.js';
import type { FormatEntry } from '../windows/format.js';
import { renderPassage } from '../prompts/answer.js';
import type { SearchResult } from './search.js';

/**
 * Passages transmis au LLM : au lieu de fenêtres entières de 2 min
 * (~5 500 caractères, ~2 200 tokens), un extrait centré sur les preuves de
 * chaque résultat — complet pour les 3 meilleurs, court ensuite. Les extraits
 * voisins d'une même vidéo sont fusionnés ; le budget accueille ainsi bien plus
 * de vidéos distinctes, et le LLM trie.
 */

/** Contexte avant la première preuve et après la dernière. */
const CONTEXT_BEFORE_S = 15;
const CONTEXT_AFTER_S = 30;
/** Au-delà, l'extrait est recentré sur la meilleure preuve. */
const MAX_PASSAGE_S = 90;
/** Deux extraits d'une même vidéo séparés de moins de 20 s n'en font qu'un. */
const MERGE_GAP_S = 20;
/** Extraits au plus par vidéo, pour laisser la place à d'autres vidéos. */
const MAX_PASSAGES_PER_VIDEO = 3;
/**
 * Les meilleurs résultats reçoivent un passage complet (contexte d'une réponse
 * précise) ; les suivants un extrait court autour de la meilleure preuve, pour
 * faire entrer beaucoup plus de vidéos dans le budget (questions générales).
 */
const FULL_PASSAGES = 3;
/**
 * Questions générales jugées : chaque vidéo est un appel séparé au juge, le budget global ne compte
 * pas. Tous les extraits sont alors complets : 13 s autour d'une seule ligne laissaient le juge sans la
 * phrase qui répond (« je déteste le placoplâtre » 25 s avant la ligne choisie, « placo » nommé).
 */
export type PassageWidth = 'mixte' | 'complet';
/** Extrait court : mesuré avec l'élagage des plans, −8/+20 s transmet autant de lignes attendues que −3/+10 s, avec plus de contexte. */
const SHORT_BEFORE_S = 8;
const SHORT_AFTER_S = 20;
/**
 * Question précise : un plan (description d'image, ~350 caractères) n'est transmis que s'il pèse comme preuve,
 * c'est-à-dire s'il est la meilleure preuve d'un résultat ou atteint cette part du poids le plus fort de son
 * passage. Tous transmis, les plans occupaient 62 % du prompt (presque tous comptent comme « preuve » par un
 * mot ou par le sens) et le budget ne laissait entrer que 7 passages de 5 vidéos. Élagués : 11 passages de
 * 8 vidéos, ligne attendue transmise pour 146 questions générées sur 150 au lieu de 139 (plans : 24/25 au lieu
 * de 22), autant qu'avec un budget de 35 000 caractères.
 */
const PLAN_WEIGHT_SHARE = 0.5;

/** Caractères par token, mesuré sur le corpus (2,55), arrondi par prudence. */
const CHARS_PER_TOKEN = 2.4;
/** Contexte d'une requête sans LLM configuré (tests, réponses extractives) : celui d'OpenRouter. */
const DEFAULT_CONTEXT_TOKENS = 32_768;
/** Identifiant court fictif pour mesurer un passage avant la numérotation finale. */
const PLACEHOLDER_ID = () => 's000';
/** Prompt système (~470 tokens), question, consignes et marge. */
const PROMPT_OVERHEAD_TOKENS = 900;

/** Contexte disponible pour UNE requête (`llm.contextTokens`, voir config.ts). */
export function requestContextTokens(): number {
  return getConfig().llm?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
}

/** Caractères de preuves que le contexte du modèle peut recevoir en plus du prompt et de la réponse. */
export function evidenceBudgetChars(outputTokens: number, contextTokens = requestContextTokens()): number {
  return Math.max(4_000, Math.floor((contextTokens - PROMPT_OVERHEAD_TOKENS - outputTokens) * CHARS_PER_TOKEN));
}

export interface PassageEntry {
  sourceId: string;
  kind: 'parole' | 'visuel';
  startS: number;
  endS: number | null;
  text: string;
}

export interface Passage {
  videoId: string;
  title: string;
  publishedAt: string | null;
  startS: number;
  endS: number;
  /** Rang du meilleur résultat de recherche qui a produit l'extrait. */
  rank: number;
  /** Entrées complètes, rendues au moment du prompt (identifiants courts). */
  entries: Array<FormatEntry & PassageEntry>;
}

interface Span {
  videoId: string;
  title: string;
  publishedAt: string | null;
  startS: number;
  endS: number;
  rank: number;
}

function shortSpanOf(result: SearchResult, rank: number): Span {
  const startS = Math.max(result.startS, result.bestEntry.startS - SHORT_BEFORE_S);
  const endS = Math.min(result.endS, Math.max(result.bestEntry.endS ?? result.bestEntry.startS, result.bestEntry.startS) + SHORT_AFTER_S);
  return { videoId: result.videoId, title: result.title, publishedAt: result.publishedAt, startS, endS, rank };
}

/**
 * Extrait complet d'un résultat : de sa première à sa dernière preuve, avec leur contexte. Au-delà de
 * `MAX_PASSAGE_S`, il est ramené à une tranche de 90 s qui contient la meilleure preuve et, parmi ces
 * tranches, celle qui couvre le plus de preuves (pondérées, voir `SearchResult.evidenceWeights`). La
 * « meilleure » preuve est la ligne qui porte le plus de mots de la question, souvent celle qui nomme le
 * sujet ; la ligne qui répond est une autre preuve de la même fenêtre, 40 à 75 s avant ou après. Centrée
 * d'office sur la meilleure preuve (30 s avant, 60 s après), la tranche la coupait (mesuré : 8 questions
 * générées sur 150, alors que leur fenêtre était dans les trois premières).
 */
function spanOf(result: SearchResult, rank: number): Span {
  const starts = result.evidence.map((e) => e.startS);
  const ends = result.evidence.map((e) => Math.max(e.endS ?? e.startS, e.startS));
  let startS = Math.min(...starts) - CONTEXT_BEFORE_S;
  let endS = Math.max(...ends) + CONTEXT_AFTER_S;
  if (endS - startS > MAX_PASSAGE_S) {
    const best = result.bestEntry.startS;
    const weights = result.evidenceWeights ?? [];
    const covered = (from: number): number =>
      result.evidence.reduce((sum, e, i) => (e.startS >= from + CONTEXT_BEFORE_S / 2 && e.startS <= from + MAX_PASSAGE_S - CONTEXT_AFTER_S / 2 ? sum + (weights[i] ?? 1) : sum), 0);
    // Débuts possibles : un peu avant chaque preuve, tant que la meilleure preuve reste dans la tranche.
    const centered = best - CONTEXT_BEFORE_S * 2;
    const candidates = [centered, ...starts.map((s) => s - CONTEXT_BEFORE_S)].filter(
      (from) => from <= best - CONTEXT_BEFORE_S / 2 && best <= from + MAX_PASSAGE_S - CONTEXT_AFTER_S / 2,
    );
    // À couverture égale, la tranche centrée d'origine, puis la plus proche d'elle.
    startS = candidates.reduce((chosen, from) => {
      const gain = covered(from) - covered(chosen);
      return gain > 1e-9 || (Math.abs(gain) <= 1e-9 && Math.abs(from - centered) < Math.abs(chosen - centered)) ? from : chosen;
    }, centered);
    endS = startS + MAX_PASSAGE_S;
  }
  return {
    videoId: result.videoId,
    title: result.title,
    publishedAt: result.publishedAt,
    startS: Math.max(result.startS, startS),
    endS: Math.min(result.endS, endS),
    rank,
  };
}

/** Fusionne les extraits qui se recouvrent ou se touchent, par vidéo, en gardant le meilleur rang. */
function mergeSpans(spans: Span[]): Span[] {
  const byVideo = new Map<string, Span[]>();
  for (const span of spans) byVideo.set(span.videoId, [...(byVideo.get(span.videoId) ?? []), span]);
  const merged: Span[] = [];
  for (const list of byVideo.values()) {
    const sorted = [...list].sort((a, b) => a.startS - b.startS);
    let current = { ...sorted[0]! };
    for (const span of sorted.slice(1)) {
      if (span.startS <= current.endS + MERGE_GAP_S) {
        current.endS = Math.max(current.endS, span.endS);
        current.rank = Math.min(current.rank, span.rank);
      } else {
        merged.push(current);
        current = { ...span };
      }
    }
    merged.push(current);
  }
  return merged.sort((a, b) => a.rank - b.rank || a.startS - b.startS);
}

async function entriesOf(
  pool: Db,
  spans: Span[],
): Promise<Map<Span, Array<FormatEntry & { endS: number | null }>>> {
  const result = new Map<Span, Array<FormatEntry & { endS: number | null }>>();
  if (spans.length === 0) return result;
  const { rows } = await pool.query<{
    span: number;
    source_id: string;
    kind: 'parole' | 'visuel';
    start_s: number;
    end_s: number | null;
    text: string;
    speaker: string | null;
    speaker_raw: string | null;
    speaker_is_named: boolean;
    plan_title: string | null;
    screen_text: string[] | null;
    uncertainties: string[] | null;
  }>(
    `SELECT s.span, e.source_id, e.kind, e.start_s, e.end_s, e.text, e.speaker, e.speaker_raw,
            e.speaker_is_named, e.plan_title, e.screen_text, e.uncertainties
     FROM unnest($1::text[], $2::int[], $3::int[]) WITH ORDINALITY AS s(video_id, from_s, to_s, span)
     JOIN entries e
       ON e.video_id = s.video_id
      AND e.start_s <= s.to_s
      AND GREATEST(COALESCE(e.end_s, e.start_s), e.start_s + 1) > s.from_s
     ORDER BY s.span, e.start_s, e.source_id`,
    [spans.map((s) => s.videoId), spans.map((s) => s.startS), spans.map((s) => s.endS)],
  );
  for (const row of rows) {
    const span = spans[Number(row.span) - 1]!;
    const list = result.get(span) ?? [];
    list.push({
      sourceId: row.source_id,
      kind: row.kind,
      startS: row.start_s,
      endS: row.end_s,
      text: row.text,
      speaker: row.speaker,
      isVoiceOver: row.speaker_raw !== null && mapSpeaker(row.speaker_raw).isVoiceOver,
      speakerIsNamed: row.speaker_is_named,
      planTitle: row.plan_title,
      screenText: row.screen_text,
      uncertainties: row.uncertainties ?? [],
    });
    result.set(span, list);
  }
  return result;
}

/**
 * Extraits à transmettre, par ordre de pertinence, jusqu'au budget : au plus
 * 3 par vidéo, jamais deux fois la même séquence.
 */
/** Le corpus a changé entre la recherche et la lecture des passages (ingestion concurrente). */
export class CorpusChangedError extends Error {
  constructor() {
    super('corpus modifié pendant la réponse');
  }
}

/**
 * Passages des résultats, lus dans un instantané cohérent. `corpusVersion` :
 * celle de la recherche ; si le corpus a changé depuis (ingestion pendant la
 * réponse), `CorpusChangedError` — l'appelant relance la recherche plutôt que
 * de mélanger deux états du corpus.
 */
export async function buildPassages(
  pool: Pool,
  results: SearchResult[],
  budgetChars: number,
  corpusVersion?: string,
  width: PassageWidth = 'mixte',
  /** Recherche limitée aux plans (« à quel moment voit-on… ») : aucun plan n'est élagué. */
  allPlans = false,
): Promise<Passage[]> {
  return readSnapshot(pool, async (db, versions) => {
    if (corpusVersion !== undefined && versions.corpusVersion !== corpusVersion) throw new CorpusChangedError();
    return passagesOf(db, results, budgetChars, width, allPlans);
  });
}

/** Intervalle d'une vidéo à lire en entier (parcours chronologique, `first-time.ts`). */
export type PassageSpan = Span;

/** Passages de ces intervalles, dans l'ordre donné ; un intervalle sans entrée est omis. */
export async function passagesForSpans(pool: Db, spans: PassageSpan[]): Promise<Passage[]> {
  const entries = await entriesOf(pool, spans);
  return spans.flatMap((span) => {
    const list = entries.get(span) ?? [];
    return list.length === 0 ? [] : [{ ...span, entries: list }];
  });
}

async function passagesOf(pool: Db, results: SearchResult[], budgetChars: number, width: PassageWidth, allPlans: boolean): Promise<Passage[]> {
  const usable = results.filter((r) => r.evidence.length > 0);
  // Les passages complets d'abord : un extrait court voisin s'y fond au lieu de le doublonner.
  const full = (rank: number) => width === 'complet' || rank < FULL_PASSAGES;
  const spans = mergeSpans(usable.map((r, rank) => (full(rank) ? spanOf(r, rank) : shortSpanOf(r, rank))));
  const perVideo = new Map<string, number>();
  const kept = spans.filter((span) => {
    const count = perVideo.get(span.videoId) ?? 0;
    perVideo.set(span.videoId, count + 1);
    return count < MAX_PASSAGES_PER_VIDEO;
  });
  const entries = await entriesOf(pool, kept);
  // Poids de chaque preuve (le plus fort d'un résultat à l'autre) et meilleures preuves, pour élaguer les plans.
  const weightOf = new Map<string, number>();
  const bestIds = new Set<string>();
  for (const r of usable) {
    bestIds.add(r.bestEntry.sourceId);
    r.evidence.forEach((e, i) => weightOf.set(e.sourceId, Math.max(weightOf.get(e.sourceId) ?? 0, r.evidenceWeights?.[i] ?? 0)));
  }
  const strongPlans = <E extends { sourceId: string; kind: string }>(list: E[]): E[] => {
    const top = Math.max(0, ...list.map((e) => weightOf.get(e.sourceId) ?? 0));
    // Sans poids connu (recherche sans preuves pondérées), rien n'est retiré.
    if (top === 0) return list;
    return list.filter((e) => e.kind !== 'visuel' || bestIds.has(e.sourceId) || (weightOf.get(e.sourceId) ?? 0) >= PLAN_WEIGHT_SHARE * top);
  };
  const passages: Passage[] = [];
  let used = 0;
  for (const span of kept) {
    // Questions générales jugées (`complet`) : le juge voit tout, comme avant.
    const list = width === 'mixte' && !allPlans ? strongPlans(entries.get(span) ?? []) : (entries.get(span) ?? []);
    if (list.length === 0) continue;
    let passage: Passage = { ...span, entries: list };
    let size = renderPassage(passage, PLACEHOLDER_ID).length;
    if (passages.length > 0 && used + size > budgetChars) {
      // Un passage complet qui ne tient plus (texte dense, extraits voisins fusionnés) n'est pas abandonné :
      // il est réduit à l'extrait court autour de sa meilleure preuve. Sinon un des trois meilleurs résultats
      // disparaissait du prompt (mesuré : prompts de 2 à 5 passages, la bonne fenêtre écartée).
      const result = span.rank < FULL_PASSAGES && width === 'mixte' ? usable[span.rank] : undefined;
      if (!result) continue;
      const short = shortSpanOf(result, span.rank);
      const within = list.filter((e) => e.startS <= short.endS && Math.max(e.endS ?? e.startS, e.startS + 1) > short.startS);
      if (within.length === 0) continue;
      passage = { ...short, entries: within };
      size = renderPassage(passage, PLACEHOLDER_ID).length;
      if (used + size > budgetChars) continue;
    }
    used += size;
    passages.push(passage);
  }
  return passages;
}
