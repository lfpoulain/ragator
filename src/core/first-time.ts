import type { Pool } from 'pg';
import { getMetaString } from '../db/meta.js';
import { readSnapshot, type Db } from '../db/pool.js';
import { vectorLiteral, type EmbeddingClient } from '../providers/embedding.js';
import type { RelevanceJudge } from '../providers/judge.js';
import { renderPassage } from '../prompts/answer.js';
import type { RequiredTerm } from './analyze.js';
import { passagesForSpans, type Passage, type PassageSpan } from './passages.js';
import { wordPatterns } from './resolve.js';
import { sortByDate } from './video-rank.js';
import { tokenizeText } from '../norm/normalize.js';

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

export interface FirstTimeResult {
  /** Moments retenus de la vidéo, dans l'ordre du film. */
  passages: Passage[];
  /** Meilleure probabilité rendue par le juge pour cette vidéo. */
  relevance: number;
  /**
   * Vidéos plus anciennes (ou récentes) retenues par le juge, mais où l'exigence n'est jamais sur la même
   * ligne que le sujet (« Ryobi » sur un cloueur, une scie circulaire à côté) : signalées, pas retenues.
   */
  earlier: Array<{ videoId: string; passages: Passage[] }>;
  /** Vidéos examinées avant de conclure, et candidates au total. */
  examined: number;
  candidates: number;
  corpusVersion: string;
  indexVersion: string;
}

interface Candidate {
  videoId: string;
  title: string;
  moments: Passage[];
  /** Le sujet et une exigence sont sur une même ligne (même plan, même phrase, même texte à l'écran), ou le titre cite l'exigence. */
  linked: boolean;
  /** Trouvée par le sens : elle ne cite pas le sujet. */
  bySense: boolean;
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

function titleCites(title: string, required: RequiredTerm[]): boolean {
  const norm = ` ${tokenizeText(title).norm} `;
  return required.some((r) => r.forms.some((form) => norm.includes(` ${form} `)));
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
  order: 'premiere' | 'derniere',
  collection: string | null,
  /** Vecteurs de la question et de l'extrait hypothétique ; vide : candidates exactes seules. */
  vectors: number[][],
): Promise<{ total: number; list: Candidate[] }> {
  const subjectPatterns = wordPatterns(subject.forms);
  const requiredPatterns = wordPatterns(required.flatMap((r) => r.forms));
  const { rows: videos } = await db.query<{ video_id: string; title: string; published_at: string | null; linked: boolean }>(
    `SELECT v.video_id, v.title, v.published_at::text AS published_at,
            cardinality($2::text[]) = 0
              OR EXISTS (SELECT 1 FROM entries e WHERE e.video_id = v.video_id
                           AND e.norm_text ~* ANY($1::text[]) AND e.norm_text ~* ANY($2::text[])) AS linked
     FROM videos v
     WHERE EXISTS (SELECT 1 FROM entries e WHERE e.video_id = v.video_id AND e.norm_text ~* ANY($1::text[]))
       AND (cardinality($2::text[]) = 0
            OR EXISTS (SELECT 1 FROM entries e WHERE e.video_id = v.video_id AND e.norm_text ~* ANY($2::text[])))
       AND ($3::text IS NULL OR v.collection = $3)
     ORDER BY v.published_at ${order === 'premiere' ? 'ASC' : 'DESC'} NULLS LAST, v.video_id`,
    [subjectPatterns, requiredPatterns, collection],
  );
  // Sans candidate exacte, le chemin général (vecteurs et juge sur 150 vidéos et plus) prend le relais.
  if (videos.length === 0) return { total: 0, list: [] };

  // Par le sens : des vidéos proches qui ne citent pas le sujet, mais citent l'exigence s'il y en a une.
  const exactIds = new Set(videos.map((v) => v.video_id));
  const picked = vectors.length > 0 ? pickBySense(await senseHits(db, vectors, collection), exactIds, order) : [];
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
    [...videos, ...senseVideos.map((v) => ({ ...v, linked: false }))].map((v) => ({ ...v, publishedAt: v.published_at })),
    order,
  ).slice(0, MAX_EXAMINED);

  const { rows: moments } = await db.query<{ video_id: string; start_s: number; subject: boolean; required: boolean }>(
    `SELECT e.video_id, e.start_s,
            e.norm_text ~* ANY($2::text[]) AS subject,
            cardinality($3::text[]) > 0 AND e.norm_text ~* ANY($3::text[]) AS required
     FROM entries e
     WHERE e.video_id = ANY($1::text[]) AND e.norm_text ~* ANY($2::text[])
     ORDER BY e.video_id, e.start_s`,
    [examined.filter((v) => exactIds.has(v.video_id)).map((v) => v.video_id), subjectPatterns, requiredPatterns],
  );
  const spans = examined.flatMap((video) =>
    exactIds.has(video.video_id)
      ? spansOf(video, moments.filter((m) => m.video_id === video.video_id))
      : spansOf(video, (senseMoments.get(video.video_id) ?? []).map((startS) => ({ start_s: startS, subject: true, required: false }))),
  );
  const passages = await passagesForSpans(db, spans);
  return {
    total: videos.length + senseVideos.length,
    list: examined.map((video) => ({
      videoId: video.video_id,
      title: video.title,
      moments: passages.filter((p) => p.videoId === video.video_id),
      // Ou le titre cite l'exigence : la vidéo porte sur elle (« La Bambu Lab X1 Carbon… »). Une vidéo trouvée
      // par le sens n'a aucune ligne qui réunisse sujet et exigence : seul son titre peut la lier.
      linked: video.linked || required.length === 0 || titleCites(video.title, required),
      bySense: !exactIds.has(video.video_id),
    })),
  };
}

/**
 * Première (ou dernière) vidéo dont un moment est retenu par le juge, en partant de la plus ancienne (ou
 * récente) ; `null` si aucune candidate ou aucune retenue parmi les `MAX_EXAMINED` premières : l'appelant
 * revient alors au chemin général.
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
): Promise<FirstTimeResult | null> {
  const vectors = await senseVectors(pool, question, sense);
  const { candidates, corpusVersion, indexVersion } = await readSnapshot(pool, async (db, versions) => ({
    candidates: await candidatesOf(db, subject, required, order, collection, vectors),
    ...versions,
  }));
  const usable = candidates.list.filter((c) => c.moments.length > 0);
  const earlier: FirstTimeResult['earlier'] = [];
  const answer = (passages: Passage[], relevance: number, examined: number): FirstTimeResult => ({
    passages,
    relevance,
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
    const moments = wave.flatMap((c, video) => c.moments.map((passage) => ({ video, passage, title: c.title })));
    const probabilities = await judge.judge(question, moments.map((m) => ({ title: m.title, text: renderPassage(m.passage, (id) => id, false) })));
    for (let video = 0; video < wave.length; video++) {
      const own = moments.map((m, i) => ({ ...m, p: probabilities[i] ?? 0 })).filter((m) => m.video === video);
      const best = Math.max(0, ...own.map((m) => m.p));
      const needed = wave[video]!.bySense ? Math.max(threshold, SENSE_THRESHOLD) : threshold;
      if (best < needed) continue;
      const passages = own.filter((m) => m.p >= needed).map((m) => m.passage);
      // Exigence jamais sur la même ligne que le sujet : signalée, et le parcours continue.
      if (!wave[video]!.linked && earlier.length < MAX_EARLIER) {
        earlier.push({ videoId: wave[video]!.videoId, passages });
        continue;
      }
      return answer(passages, best, start + video + 1);
    }
  }
  // Aucune vidéo où l'exigence accompagne le sujet : la première retenue répond, sans autre signalement.
  const first = earlier.shift();
  return first ? answer(first.passages, threshold, usable.length) : null;
}
