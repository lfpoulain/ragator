import type { Pool } from 'pg';
import { videoLink } from '../links.js';
import { collectionSql } from './filters.js';

/**
 * Vidéos proches d'une vidéo : les plus proches par leur vecteur (titre, description sans gabarit,
 * titres des plans : migration 0008). Une piste à explorer, jamais une preuve : rien n'est cité.
 */

export interface NearbyVideo {
  videoId: string;
  title: string;
  collection: string;
  publishedAt: string | null;
  link: string;
  /** Similarité cosinus des deux vecteurs (1 = même texte) : un classement, pas une confiance. */
  similarity: number;
}

export interface NearbyResult {
  videoId: string;
  title: string;
  /** Faux tant que la vidéo n'a pas de vecteur (`npm run embed`) : la liste est alors vide. */
  ready: boolean;
  videos: NearbyVideo[];
}

export const NEARBY_DEFAULT = 8;
const NEARBY_MAX = 30;

/** Vidéos les plus proches de `videoId`, limitées à une collection si demandé ; `null` si la vidéo est inconnue. */
export async function nearbyVideos(
  pool: Pool,
  videoId: string,
  options: { limit?: number; collection?: string | null } = {},
): Promise<NearbyResult | null> {
  const { rows: self } = await pool.query<{ title: string; ready: boolean }>(
    'SELECT title, embedding IS NOT NULL AS ready FROM videos WHERE video_id = $1',
    [videoId],
  );
  const video = self[0];
  if (!video) return null;
  if (!video.ready) return { videoId, title: video.title, ready: false, videos: [] };
  const limit = Math.min(NEARBY_MAX, Math.max(1, Math.floor(options.limit ?? NEARBY_DEFAULT)));
  const params: unknown[] = [videoId];
  const only = collectionSql(options.collection, params);
  const { rows } = await pool.query<{ video_id: string; title: string; collection: string; published_at: string | null; distance: number }>(
    `SELECT v.video_id, v.title, v.collection, v.published_at::text AS published_at,
            v.embedding <=> s.embedding AS distance
     FROM videos v, (SELECT embedding FROM videos WHERE video_id = $1) s
     WHERE v.embedding IS NOT NULL AND v.video_id <> $1 ${only}
     ORDER BY v.embedding <=> s.embedding
     LIMIT ${limit}`,
    params,
  );
  return {
    videoId,
    title: video.title,
    ready: true,
    videos: rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      collection: r.collection,
      publishedAt: r.published_at,
      link: videoLink(r.video_id),
      similarity: Math.round((1 - Number(r.distance)) * 1000) / 1000,
    })),
  };
}
