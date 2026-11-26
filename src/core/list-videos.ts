import type { Pool } from 'pg';
import { timestampedLink } from '../links.js';
import { readSnapshot } from '../db/pool.js';
import { resolveTerm, scopeColumn, scopeKindSql, wordPatterns } from './resolve.js';
import { cursorKey, pageOf, pageOffset, type DateRange, type Kind, type Page, type PageInput, type Scope } from './page.js';
import { collectionSql, dateRangeSql, videoIdSql, videoIdsSql } from './filters.js';

const PAGE_SIZE = 20;
const EXCERPTS_PER_VIDEO = 3;
/** Extraits d'une vidéo espacés d'au moins 30 s : trois moments distincts, pas trois lignes d'une même séquence. */
const EXCERPT_SPACING_S = 30;
/** Extraits lus par vidéo pour en choisir trois espacés. */
const EXCERPT_CANDIDATES = 40;

export interface ListerVideoResult {
  videoId: string;
  title: string;
  publishedAt: string | null;
  occurrences: { total: number; speech: number; visual: number; screen: number };
  firstMentionS: number;
  link: string;
  reviewRequired: boolean;
  excerpts: Array<{ sourceId: string; startS: number; kind: Kind; text: string }>;
}

export interface ListerVideosData {
  term: string;
  scope: Scope;
  /** Résolution du premier terme résolu. */
  resolved: { canonical: string; fuzzy: boolean; aliases: string[] } | null;
  /** Toutes les formes comptées (termes, alternatives et alias validés), réunies par union d'entrées. */
  forms: string[];
  status: 'resolved' | 'not_found' | 'ambiguous';
  suggestions: string[];
  totalVideos: number;
  totalEntries: number;
  videos: ListerVideoResult[];
}

export interface ListerVideosInput extends PageInput {
  term: string;
  /** Formulations alternatives explicites (« X ou Y ») : union des entrées, jamais une somme. */
  alternatives?: string[];
  scope?: Scope;
  dateRange?: DateRange;
  /** Restreint le décompte à une vidéo (question qui la cite, relance « dans cette vidéo »). */
  videoId?: string;
  /** Vidéos d'une série nommée par la question (`series.ts`). */
  videoIds?: string[];
}

/**
 * Seul outil exhaustif : décompte lexical exact des entrées contenant
 * le terme entier, agrégé par vidéo. Aucun score, aucune limite au décompte ;
 * le flou sert à résoudre le terme, jamais à compter.
 */
export function listerVideos(pool: Pool, input: ListerVideosInput): Promise<Page<ListerVideosData>> {
  const scope: Scope = input.scope ?? 'tout';
  const terms = [...new Set([input.term, ...(input.alternatives ?? [])])];
  return readSnapshot(pool, async (db, versions) => {
    const resolutions = [];
    for (const term of terms) resolutions.push(await resolveTerm(db, term, scope, versions.corpusVersion, input.collection));
    const ambiguous = resolutions.find((r) => r.status === 'ambiguous');
    const found = resolutions.filter((r) => r.status === 'resolved' && r.canonical !== null);
    const forms = [...new Set(found.flatMap((r) => [r.canonical!, ...r.aliases]))];
    const resolved = found[0] ?? null;
    // Une alternative non résolue n'invalide pas les autres : `forms` dit ce qui est compté.
    const status = resolved ? 'resolved' : ambiguous ? 'ambiguous' : 'not_found';
    const key = cursorKey(
      'lister',
      forms.join(',') || terms.join(','),
      scope,
      JSON.stringify(input.dateRange ?? null),
      input.videoId ?? '',
      JSON.stringify(input.videoIds ?? []),
      input.collection ?? '',
      versions.corpusVersion,
      versions.indexVersion,
    );
    const offset = pageOffset(key, input.cursor);
    const empty: ListerVideosData = {
      term: input.term,
      scope,
      resolved: null,
      forms: [],
      status,
      suggestions: ambiguous?.suggestions ?? [],
      totalVideos: 0,
      totalEntries: 0,
      videos: [],
    };
    if (status !== 'resolved' || resolved === null || resolved.canonical === null) {
      return pageOf(empty, versions, { key, offset, returned: 0, total: 0 });
    }

    const params: unknown[] = [wordPatterns(forms)];
    const matched = `
      SELECT e.id, e.video_id, e.kind, e.start_s, e.source_id, e.text,
             coalesce(e.screen_text_norm ~* ANY($1::text[]), false) AS has_screen
      FROM entries e JOIN videos v USING (video_id)
      WHERE ${scopeKindSql(scope)}
        AND e.${scopeColumn(scope)} ~* ANY($1::text[])
        ${dateRangeSql(input.dateRange, params)}
        ${videoIdSql(input.videoId, params)}
        ${videoIdsSql(input.videoIds, params)}
        ${collectionSql(input.collection, params)}`;

    const { rows } = await db.query<{
      video_id: string;
      title: string;
      published_at: string | null;
      review_required: boolean;
      total: string;
      speech: string;
      visual: string;
      screen: string;
      first_s: number;
    }>(
      `WITH matched AS (${matched})
       SELECT v.video_id, v.title, v.published_at::text AS published_at, v.review_required,
              count(*) AS total,
              count(*) FILTER (WHERE m.kind = 'parole') AS speech,
              count(*) FILTER (WHERE m.kind = 'visuel') AS visual,
              count(*) FILTER (WHERE m.has_screen) AS screen,
              min(m.start_s) AS first_s
       FROM matched m JOIN videos v USING (video_id)
       GROUP BY v.video_id
       ORDER BY v.published_at DESC NULLS LAST, v.video_id`,
      params,
    );
    const totalEntries = rows.reduce((sum, r) => sum + Number(r.total), 0);
    const pageRows = rows.slice(offset, offset + PAGE_SIZE);

    const excerpts = new Map<string, ListerVideoResult['excerpts']>();
    if (pageRows.length > 0) {
      const excerptParams = [...params, pageRows.map((r) => r.video_id), EXCERPT_CANDIDATES];
      const { rows: excerptRows } = await db.query<{
        video_id: string;
        source_id: string;
        start_s: number;
        kind: Kind;
        text: string;
      }>(
        `SELECT video_id, source_id, start_s, kind, text FROM (
           SELECT m.*, row_number() OVER (PARTITION BY m.video_id ORDER BY m.start_s, m.source_id) AS rn
           FROM (${matched}) m
           WHERE m.video_id = ANY($${params.length + 1}::text[])
         ) ranked
         WHERE rn <= $${params.length + 2}
         ORDER BY video_id, start_s, source_id`,
        excerptParams,
      );
      for (const row of excerptRows) {
        const list = excerpts.get(row.video_id) ?? [];
        const last = list.at(-1);
        if (list.length >= EXCERPTS_PER_VIDEO || (last && row.start_s - last.startS < EXCERPT_SPACING_S)) continue;
        list.push({ sourceId: row.source_id, startS: row.start_s, kind: row.kind, text: row.text });
        excerpts.set(row.video_id, list);
      }
    }

    const data: ListerVideosData = {
      ...empty,
      resolved: { canonical: resolved.canonical, fuzzy: resolved.fuzzy, aliases: resolved.aliases },
      forms,
      status: 'resolved',
      totalVideos: rows.length,
      totalEntries,
      videos: pageRows.map((r) => ({
        videoId: r.video_id,
        title: r.title,
        publishedAt: r.published_at,
        occurrences: {
          total: Number(r.total),
          speech: Number(r.speech),
          visual: Number(r.visual),
          screen: Number(r.screen),
        },
        firstMentionS: r.first_s,
        link: timestampedLink(r.video_id, r.first_s),
        reviewRequired: r.review_required,
        excerpts: excerpts.get(r.video_id) ?? [],
      })),
    };
    return pageOf(data, versions, { key, offset, returned: pageRows.length, total: rows.length });
  });
}
