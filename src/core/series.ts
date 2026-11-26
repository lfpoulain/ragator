import type { Pool } from 'pg';
import { tokenizeText } from '../norm/normalize.js';
import { readSnapshot, type Db } from '../db/pool.js';
import { renderPassage } from '../prompts/answer.js';
import { passagesForSpans, type Passage } from './passages.js';
import type { Kind } from './page.js';

/**
 * Séries : « dans les vidéos de la régie » désigne un ensemble de vidéos par un nom repris dans leurs
 * titres (« La RÉGIE GAMING ROOM est DINGUE… - EP03 »). Ce nom n'est pas le sujet cherché : laissé dans
 * la requête, ce mot rare prenait toute la place dans la recherche hybride (les extraits parlaient de la
 * régie, pas d'« une femme »). Le code le ramène aux vidéos dont le titre le contient, qui deviennent un
 * filtre (comme une vidéo citée), et la recherche porte sur le reste de la question.
 */

/** Au-delà, le nom désigne un thème courant (« gaming », « atelier »), pas une série : aucun filtre. */
export const MAX_SERIES_VIDEOS = 12;

export interface Series {
  /** Noms proposés par l'analyse et retrouvés dans des titres. */
  terms: string[];
  /** Vidéos dont le titre contient l'un des noms. */
  videoIds: string[];
}

/** Le titre contient la suite de mots du nom, dans l'ordre (formes normalisées). */
export function titleHas(title: string, term: string): boolean {
  const words = tokenizeText(title).tokens;
  const wanted = tokenizeText(term).tokens;
  if (wanted.length === 0) return false;
  for (let i = 0; i + wanted.length <= words.length; i++) {
    if (wanted.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

/**
 * Vidéos de la série : celles dont le titre contient l'un des noms. `null` si aucun nom n'est retrouvé,
 * ou s'ils désignent plus de `MAX_SERIES_VIDEOS` vidéos (un thème, pas une série).
 */
export async function findSeries(db: Db, terms: string[], notes: string[], collection?: string): Promise<Series | null> {
  if (terms.length === 0) return null;
  const { rows } = await db.query<{ video_id: string; title: string }>(
    'SELECT video_id, title FROM videos WHERE $1::text IS NULL OR collection = $1 ORDER BY published_at NULLS LAST, video_id', [collection ?? null]);
  const found: string[] = [];
  const videoIds = new Set<string>();
  for (const term of terms) {
    const matching = rows.filter((r) => titleHas(r.title, term));
    if (matching.length === 0) continue;
    found.push(term);
    for (const r of matching) videoIds.add(r.video_id);
  }
  if (videoIds.size === 0) {
    notes.push(`série « ${terms.join(' / ')} » absente des titres : aucun filtre`);
    return null;
  }
  if (videoIds.size > MAX_SERIES_VIDEOS) {
    notes.push(`série « ${found.join(' / ')} » trop large (${videoIds.size} vidéos) : aucun filtre`);
    return null;
  }
  return { terms: found, videoIds: [...videoIds] };
}

/**
 * La question sans les noms de la série (« … une femme apparaît dans les vidéos de la régie/gaming
 * room ? » → « … une femme apparaît dans les vidéos de la ? ») : ce qui reste est le sujet cherché.
 * Comparaison mot à mot sur les formes normalisées (accents, majuscules).
 */
export function withoutSeries(question: string, terms: string[]): string {
  const words = [...question.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    form: tokenizeText(m[0]).tokens.join(' '),
  }));
  const cuts: Array<[number, number]> = [];
  for (const term of terms) {
    const wanted = tokenizeText(term).tokens;
    if (wanted.length === 0) continue;
    for (let i = 0; i < words.length; i++) {
      let j = i;
      let k = 0;
      // Un mot de la question peut porter plusieurs formes (« gaming-room ») : on avance mot par mot.
      while (j < words.length && k < wanted.length) {
        const form = words[j]!.form.split(' ').filter(Boolean);
        if (form.length === 0 || !form.every((f, n) => wanted[k + n] === f)) break;
        k += form.length;
        j++;
      }
      if (k === wanted.length && j > i) {
        cuts.push([words[i]!.start, words[j - 1]!.end]);
        i = j - 1;
      }
    }
  }
  if (cuts.length === 0) return question;
  let out = '';
  let last = 0;
  for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
    if (start < last) continue;
    out += question.slice(last, start);
    last = end;
  }
  out += question.slice(last);
  // Séparateurs orphelins (« la / ? ») et espaces doubles.
  return out.replace(/\s*[/&+]\s*(?=[/&+?!.\s]|$)/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Les vidéos de la série lues en entier, de la plus ancienne à la plus récente, limitées à `kind` (plans
 * seuls pour « on voit », « apparaît »). `null` si le tout dépasse `budgetChars` : la recherche classée,
 * limitée à la série, choisit alors les passages.
 */
export async function readSeries(
  pool: Pool,
  videoIds: string[],
  kind: Kind | undefined,
  budgetChars: number,
  collection: string | null = null,
): Promise<{ passages: Passage[]; corpusVersion: string; indexVersion: string } | null> {
  return readSnapshot(pool, async (db, versions) => {
    const { rows } = await db.query<{ video_id: string; title: string; published_at: string | null; end_s: number }>(
      `SELECT v.video_id, v.title, v.published_at::text AS published_at,
              max(GREATEST(COALESCE(e.end_s, e.start_s), e.start_s + 1)) AS end_s
       FROM videos v JOIN entries e USING (video_id)
       WHERE v.video_id = ANY($1::text[]) AND ($2::text IS NULL OR v.collection = $2)
       GROUP BY v.video_id, v.title, v.published_at
       ORDER BY v.published_at NULLS LAST, v.video_id`,
      [videoIds, collection],
    );
    const spans = rows.map((r, rank) => ({ videoId: r.video_id, title: r.title, publishedAt: r.published_at, startS: 0, endS: Number(r.end_s), rank }));
    const passages = (await passagesForSpans(db, spans))
      .map((p) => ({ ...p, entries: kind ? p.entries.filter((e) => e.kind === kind) : p.entries }))
      .filter((p) => p.entries.length > 0);
    const size = passages.reduce((sum, p) => sum + renderPassage(p, () => 's000').length, 0);
    if (passages.length === 0 || size > budgetChars) return null;
    return { passages, corpusVersion: versions.corpusVersion, indexVersion: versions.indexVersion };
  });
}
