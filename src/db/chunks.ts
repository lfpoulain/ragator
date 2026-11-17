import { textHash } from '../core/hashes.js';
import type { Chunk } from '../windows/chunks.js';
import type { Db } from './pool.js';

/**
 * Remplace les blocs d'une vidéo (dans la transaction de publication). Un bloc
 * au texte inchangé garde son vecteur et son enrichissement (dont son empreinte
 * tient compte) ; les autres repartent sans vecteur ni enrichissement.
 */
export async function replaceChunks(client: Db, videoId: string, chunks: Chunk[]): Promise<void> {
  await client.query(
    `INSERT INTO chunks (video_id, start_s, end_s, text, text_hash)
     SELECT $1, x.start_s, x.end_s, x.text, x.text_hash
     FROM unnest($2::int[], $3::int[], $4::text[], $5::text[]) AS x(start_s, end_s, text, text_hash)
     ON CONFLICT (video_id, start_s) DO UPDATE SET
       end_s = EXCLUDED.end_s,
       text_hash = CASE WHEN chunks.text = EXCLUDED.text THEN chunks.text_hash ELSE EXCLUDED.text_hash END,
       embedding = CASE WHEN chunks.text = EXCLUDED.text THEN chunks.embedding ELSE NULL END,
       enrichment = CASE WHEN chunks.text = EXCLUDED.text THEN chunks.enrichment ELSE NULL END,
       enrichment_model = CASE WHEN chunks.text = EXCLUDED.text THEN chunks.enrichment_model ELSE NULL END,
       text = EXCLUDED.text`,
    [
      videoId,
      chunks.map((c) => c.startS),
      chunks.map((c) => c.endS),
      chunks.map((c) => c.text),
      chunks.map((c) => textHash(c.text)),
    ],
  );
  await client.query('DELETE FROM chunks WHERE video_id = $1 AND NOT (start_s = ANY($2::int[]))', [
    videoId,
    chunks.map((c) => c.startS),
  ]);
}
