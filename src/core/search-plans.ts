import type { Pool } from 'pg';
import { timestampedLink } from '../links.js';
import { readSnapshot } from '../db/pool.js';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import { wordPatterns } from './resolve.js';
import { collectionSql, dateRangeSql, videoIdSql, videoIdsSql } from './filters.js';
import { clampLimit, cursorKey, pageOf, pageOffset, type DateRange, type Page, type PageInput } from './page.js';

export interface PlanResult {
  sourceId: string;
  videoId: string;
  title: string;
  publishedAt: string | null;
  planTitle: string;
  description: string;
  startS: number;
  endS: number;
  durationS: number;
  screenText: string[];
  uncertainties: string[];
  score: number;
  link: string;
}

export interface PlanData {
  results: PlanResult[];
  totalMatches: number;
}

export interface PlanInput extends PageInput {
  query: string;
  limit?: number;
  /** Durée minimale d'un plan (usage montage) ; 0 par défaut pour garder les apparitions courtes. */
  minDurationS?: number;
  videoId?: string;
  /** Vidéos d'une série nommée par la question (`series.ts`). */
  videoIds?: string[];
  dateRange?: DateRange;
}

/**
 * Plans visuels à réutiliser : entrées `visuel` contenant un des mots
 * (titre, description ou OCR), classées par BM25. Une description reste une
 * annotation automatique, pas une vérification de l'image.
 */
export function chercherPlan(pool: Pool, input: PlanInput): Promise<Page<PlanData>> {
  const limit = clampLimit(input.limit, 10);
  const mains = [...new Set(tokenizeText(input.query).tokens)];
  const tokens = contentTokens(mains).length > 0 ? contentTokens(mains) : mains;

  return readSnapshot(pool, async (db, versions) => {
    const key = cursorKey(
      'plan',
      tokens.join(' '),
      input.minDurationS ?? 0,
      input.videoId ?? '',
      JSON.stringify(input.videoIds ?? []),
      JSON.stringify(input.dateRange ?? null),
      input.collection ?? '',
      versions.corpusVersion,
      versions.indexVersion,
    );
    const offset = pageOffset(key, input.cursor);
    if (tokens.length === 0) {
      return pageOf({ results: [], totalMatches: 0 }, versions, { key, offset, returned: 0, total: 0 });
    }

    const params: unknown[] = [tokens.join(' '), wordPatterns(tokens)];
    const filters = [videoIdSql(input.videoId, params), videoIdsSql(input.videoIds, params), dateRangeSql(input.dateRange, params), collectionSql(input.collection, params)];
    if (input.minDurationS !== undefined && input.minDurationS > 0) {
      params.push(Math.floor(input.minDurationS));
      filters.push(`AND (e.end_s - e.start_s) >= $${params.length}`);
    }
    params.push(limit, offset);

    const { rows } = await db.query<{
      source_id: string;
      video_id: string;
      title: string;
      published_at: string | null;
      plan_title: string;
      text: string;
      start_s: number;
      end_s: number;
      screen_text: string[] | null;
      uncertainties: string[] | null;
      score: number;
      total: string;
    }>(
      `SELECT e.source_id, v.video_id, v.title, v.published_at::text AS published_at,
              e.plan_title, e.text, e.start_s, e.end_s, e.screen_text, e.uncertainties,
              pdb.score(e.id) AS score, count(*) OVER () AS total
       FROM entries e JOIN videos v USING (video_id)
       WHERE e.kind = 'visuel'
         AND e.norm_text ||| $1
         AND e.norm_text ~* ANY($2::text[])
         ${filters.join(' ')}
       ORDER BY score DESC, v.video_id, e.start_s, e.source_id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const total = rows.length > 0 ? Number(rows[0]!.total) : 0;
    const results: PlanResult[] = rows.map((r) => ({
      sourceId: r.source_id,
      videoId: r.video_id,
      title: r.title,
      publishedAt: r.published_at,
      planTitle: r.plan_title,
      description: r.text,
      startS: r.start_s,
      endS: r.end_s,
      durationS: r.end_s - r.start_s,
      screenText: r.screen_text ?? [],
      uncertainties: r.uncertainties ?? [],
      score: Number(r.score),
      link: timestampedLink(r.video_id, r.start_s),
    }));
    return pageOf({ results, totalMatches: total }, versions, { key, offset, returned: results.length, total });
  });
}
