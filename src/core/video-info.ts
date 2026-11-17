import type { Pool } from 'pg';
import { videoLink } from '../links.js';
import { readSnapshot } from '../db/pool.js';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import type { DescriptionBlock } from './description.js';
import { collectionSql, dateRangeSql, videoIdSql, videoIdsSql } from './filters.js';
import { clampLimit, cursorKey, pageOf, pageOffset, type DateRange, type Page, type PageInput } from './page.js';

export interface InfosResult {
  sourceId: string;
  videoId: string;
  title: string;
  publishedAt: string | null;
  kind: 'titre' | 'description';
  text: string;
  section: string | null;
  urls: string[];
  affiliated: boolean;
  /** Lien vers la vidéo, sans instant : un titre ou une description n'a pas d'horodatage. */
  link: string;
  startS: null;
}

export interface InfosData {
  results: InfosResult[];
  totalMatches: number;
}

export interface InfosInput extends PageInput {
  query: string;
  videoId?: string;
  /** Vidéos d'une série nommée par la question (`series.ts`). */
  videoIds?: string[];
  dateRange?: DateRange;
  limit?: number;
}

function wordsOf(text: string): Set<string> {
  return new Set(tokenizeText(text).tokens);
}

/**
 * Titres et blocs de description YouTube : liens, firmwares, matériel.
 * Ces sources citent la vidéo sans instant inventé et ne comptent pas dans
 * les totaux de `listerVideos`.
 */
export function chercherInfosVideo(pool: Pool, input: InfosInput): Promise<Page<InfosData>> {
  const limit = clampLimit(input.limit, 8);
  const mains = [...new Set(tokenizeText(input.query).tokens)];
  const tokens = contentTokens(mains).length > 0 ? contentTokens(mains) : mains;

  return readSnapshot(pool, async (db, versions) => {
    const key = cursorKey(
      'infos',
      tokens.join(' '),
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

    // Présélection des vidéos par l'index BM25 (accents repliés), puis
    // découpage exact par bloc sur la forme normalisée.
    const params: unknown[] = [tokens.join(' ')];
    const filters = `${videoIdSql(input.videoId, params)} ${videoIdsSql(input.videoIds, params)} ${dateRangeSql(input.dateRange, params)} ${collectionSql(input.collection, params)}`;
    const { rows } = await db.query<{
      video_id: string;
      title: string;
      published_at: string | null;
      description_blocks: DescriptionBlock[];
    }>(
      `SELECT v.video_id, v.title, v.published_at::text AS published_at, v.description_blocks
       FROM videos v
       WHERE (v.title ||| $1 OR v.description ||| $1) ${filters}
       ORDER BY v.published_at DESC NULLS LAST, v.video_id`,
      params,
    );

    const matchesQuery = (text: string): boolean => {
      const words = wordsOf(text);
      return tokens.some((token) => words.has(token));
    };
    const all: InfosResult[] = [];
    for (const row of rows) {
      const common = { videoId: row.video_id, title: row.title, publishedAt: row.published_at, link: videoLink(row.video_id), startS: null };
      if (matchesQuery(row.title)) {
        all.push({ ...common, sourceId: `${row.video_id}:titre`, kind: 'titre', text: row.title, section: null, urls: [], affiliated: false });
      }
      for (const block of row.description_blocks) {
        if (!matchesQuery(block.text)) continue;
        all.push({
          ...common,
          sourceId: block.id,
          kind: 'description',
          text: block.text,
          section: block.section,
          urls: block.urls,
          affiliated: block.affiliated,
        });
      }
    }
    const results = all.slice(offset, offset + limit);
    return pageOf({ results, totalMatches: all.length }, versions, {
      key,
      offset,
      returned: results.length,
      total: all.length,
    });
  });
}
