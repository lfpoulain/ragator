import type { Pool } from 'pg';
import { readSnapshot } from '../db/pool.js';
import { getMetaNumber, getMetaString } from '../db/meta.js';
import { hasVectorIndex } from '../db/vector-index.js';
import { collectionSql } from './filters.js';
import type { Page } from './page.js';

export interface StatsData {
  /** Collection (chaîne) à laquelle les comptes se limitent ; `null` : tout le corpus. */
  collection: string | null;
  videos: number;
  /** Somme des durées effectives (déclarées, sinon estimées). */
  totalDurationS: number;
  entries: { parole: number; visuel: number };
  dateRange: { from: string | null; to: string | null };
  unknownPublicationDates: number;
  estimatedDurations: number;
  /** Taille sur disque des tables et index : vidéos, entrées, fenêtres et blocs de 30 s (tout le corpus, même limité à une collection). */
  indexedBytes: number;
  /** Blocs de 30 s : unité de la recherche sémantique « par sujet », enrichis par le LLM. */
  chunks: { total: number; enriched: number; pendingEnrichment: number };
  embeddings: {
    model: string | null;
    dims: number | null;
    /** Vecteurs faits et en attente, entrées, blocs et vidéos réunis (détail ci-dessous). */
    done: number;
    pending: number;
    entries: { done: number; pending: number };
    chunks: { done: number; pending: number };
    /** Un vecteur par vidéo (titre, description, plans : migration 0008). */
    videos: { done: number; pending: number };
    vectorIndex: boolean;
    lastAt: string | null;
  };
  /** Tâches de l'index : communes à tout le corpus. */
  jobs: Array<{ type: string; state: string; count: number }>;
}

/** État du corpus indexé, ou d'une seule collection (chaîne YouTube). */
export function stats(pool: Pool, options: { collection?: string | null } = {}): Promise<Page<StatsData>> {
  const collection = options.collection || null;
  return readSnapshot(pool, async (db, versions) => {
    const params: unknown[] = [];
    const only = collectionSql(collection, params);
    // Alias `x` toujours : `videos` a aussi une colonne `embedding` (migration 0008), ambiguë dans la jointure.
    const ofVideo = (table: string) => (only ? `${table} x JOIN videos v USING (video_id) WHERE true ${only}` : `${table} x`);
    const { rows: videoRows } = await db.query<{
      videos: string;
      total_duration: string | null;
      from: string | null;
      to: string | null;
      unknown_dates: string;
      estimated: string;
      vectors: string;
    }>(
      `SELECT count(*) AS videos,
              sum(effective_duration_s) AS total_duration,
              min(published_at)::text AS from,
              max(published_at)::text AS to,
              count(*) FILTER (WHERE published_at IS NULL) AS unknown_dates,
              count(*) FILTER (WHERE duration_s IS NULL) AS estimated,
              count(*) FILTER (WHERE embedding IS NOT NULL) AS vectors
       FROM videos v WHERE true ${only}`,
      params,
    );
    const { rows: entryRows } = await db.query<{ parole: string; visuel: string; done: string; pending: string }>(
      `SELECT count(*) FILTER (WHERE x.kind = 'parole') AS parole,
              count(*) FILTER (WHERE x.kind = 'visuel') AS visuel,
              count(*) FILTER (WHERE x.embedding IS NOT NULL) AS done,
              count(*) FILTER (WHERE x.embedding IS NULL) AS pending
       FROM ${ofVideo('entries')}`,
      params,
    );
    const { rows: sizeRows } = await db.query<{ bytes: string }>(
      `SELECT pg_total_relation_size('entries') + pg_total_relation_size('windows')
              + pg_total_relation_size('videos') + pg_total_relation_size('chunks') AS bytes`,
    );
    const { rows: jobRows } = await db.query<{ type: string; state: string; count: string }>(
      `SELECT type, state, count(*) AS count FROM corpus_jobs GROUP BY type, state ORDER BY type, state`,
    );
    const { rows: lastRows } = await db.query<{ last_at: string | null }>(
      `SELECT max(finished_at)::text AS last_at FROM corpus_jobs WHERE type = 'embed' AND state = 'done'`,
    );
    const { rows: chunkRows } = await db.query<{ total: string; enriched: string; done: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE x.enrichment IS NOT NULL) AS enriched,
              count(*) FILTER (WHERE x.embedding IS NOT NULL) AS done
       FROM ${ofVideo('chunks')}`,
      params,
    );
    const video = videoRows[0];
    const entry = entryRows[0];
    const chunk = { total: Number(chunkRows[0]?.total ?? 0), enriched: Number(chunkRows[0]?.enriched ?? 0), done: Number(chunkRows[0]?.done ?? 0) };
    const entryVectors = { done: Number(entry?.done ?? 0), pending: Number(entry?.pending ?? 0) };
    const chunkVectors = { done: chunk.done, pending: chunk.total - chunk.done };
    const videoVectors = { done: Number(video?.vectors ?? 0), pending: Number(video?.videos ?? 0) - Number(video?.vectors ?? 0) };
    const data: StatsData = {
      collection,
      videos: Number(video?.videos ?? 0),
      totalDurationS: Number(video?.total_duration ?? 0),
      entries: { parole: Number(entry?.parole ?? 0), visuel: Number(entry?.visuel ?? 0) },
      dateRange: { from: video?.from ?? null, to: video?.to ?? null },
      unknownPublicationDates: Number(video?.unknown_dates ?? 0),
      estimatedDurations: Number(video?.estimated ?? 0),
      indexedBytes: Number(sizeRows[0]?.bytes ?? 0),
      chunks: { total: chunk.total, enriched: chunk.enriched, pendingEnrichment: chunk.total - chunk.enriched },
      embeddings: {
        model: await getMetaString(db, 'embedding_model'),
        dims: await getMetaNumber(db, 'embedding_dims'),
        done: entryVectors.done + chunkVectors.done + videoVectors.done,
        pending: entryVectors.pending + chunkVectors.pending + videoVectors.pending,
        entries: entryVectors,
        chunks: chunkVectors,
        videos: videoVectors,
        vectorIndex: await hasVectorIndex(db),
        lastAt: lastRows[0]?.last_at ?? null,
      },
      jobs: jobRows.map((r) => ({ type: r.type, state: r.state, count: Number(r.count) })),
    };
    return { data, ...versions, truncated: false, nextCursor: null };
  });
}

export interface ChannelStats {
  /** Identifiant de la collection (« les-freres-poulain »). */
  key: string;
  name: string;
  /** Chaîne telle que l'écrit le système d'ingestion, accroche comprise. */
  channel: string;
  videos: number;
  totalDurationS: number;
  dateRange: { from: string | null; to: string | null };
  entries: number;
  chunks: { total: number; enriched: number };
  /** Vecteurs manquants, entrées, blocs et vidéos réunis. */
  pendingVectors: number;
}

/** Un bilan par chaîne YouTube, la plus fournie d'abord : de quoi comparer les collections d'un coup d'œil. */
export async function channelStats(pool: Pool): Promise<ChannelStats[]> {
  const { rows } = await pool.query<{
    key: string;
    name: string;
    channel: string | null;
    videos: string;
    total_duration: string | null;
    from: string | null;
    to: string | null;
    entries: string;
    entries_pending: string;
    chunks: string;
    enriched: string;
    chunks_pending: string;
    videos_pending: string;
  }>(
    `WITH e AS (SELECT v.collection, count(*) AS n, count(*) FILTER (WHERE x.embedding IS NULL) AS pending
                FROM entries x JOIN videos v USING (video_id) GROUP BY v.collection),
          c AS (SELECT v.collection, count(*) AS n, count(*) FILTER (WHERE x.enrichment IS NOT NULL) AS enriched,
                       count(*) FILTER (WHERE x.embedding IS NULL) AS pending
                FROM chunks x JOIN videos v USING (video_id) GROUP BY v.collection),
          vv AS (SELECT collection, ragator_collection_name(mode() WITHIN GROUP (ORDER BY channel)) AS name,
                        mode() WITHIN GROUP (ORDER BY channel) AS channel, count(*) AS videos,
                        sum(effective_duration_s) AS total_duration,
                        min(published_at)::text AS from, max(published_at)::text AS to,
                        count(*) FILTER (WHERE embedding IS NULL) AS videos_pending
                 FROM videos GROUP BY collection)
     SELECT vv.collection AS key, vv.name, vv.channel, vv.videos, vv.total_duration, vv.from, vv.to, vv.videos_pending,
            coalesce(e.n, 0) AS entries, coalesce(e.pending, 0) AS entries_pending,
            coalesce(c.n, 0) AS chunks, coalesce(c.enriched, 0) AS enriched, coalesce(c.pending, 0) AS chunks_pending
     FROM vv LEFT JOIN e USING (collection) LEFT JOIN c USING (collection)
     ORDER BY vv.videos DESC, vv.collection`,
  );
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    channel: r.channel ?? r.name,
    videos: Number(r.videos),
    totalDurationS: Number(r.total_duration ?? 0),
    dateRange: { from: r.from, to: r.to },
    entries: Number(r.entries),
    chunks: { total: Number(r.chunks), enriched: Number(r.enriched) },
    pendingVectors: Number(r.entries_pending) + Number(r.chunks_pending) + Number(r.videos_pending),
  }));
}
