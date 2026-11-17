import type { Db } from './pool.js';

export interface VideoState {
  contentHash: string;
  documentHash: string;
  retrievalHash: string;
  derivationVersion: string;
}

export async function getVideoState(
  client: Db,
  videoId: string,
): Promise<VideoState | null> {
  const { rows } = await client.query<{
    content_hash: string;
    document_hash: string;
    retrieval_hash: string;
    derivation_version: string;
  }>(
    `SELECT content_hash, document_hash, retrieval_hash, derivation_version
     FROM videos WHERE video_id = $1`,
    [videoId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    contentHash: row.content_hash,
    documentHash: row.document_hash,
    retrievalHash: row.retrieval_hash,
    derivationVersion: row.derivation_version,
  };
}

export interface VideoRow {
  videoId: string;
  title: string;
  url: string;
  channel: string | null;
  publishedAt: string | null;
  durationS: number | null;
  effectiveDurationS: number;
  views: number | null;
  comments: number | null;
  description: string;
  descriptionBlocks: unknown;
  provenance: unknown;
  quality: unknown;
  contentHash: string;
  documentHash: string;
  contentHashVersion: string;
  retrievalHash: string;
  derivationVersion: string;
  reviewRequired: boolean;
  generatorModel: string;
  promptVersion: string;
  generatedAt: string;
}

export async function upsertVideo(client: Db, video: VideoRow): Promise<void> {
  await client.query(
    `INSERT INTO videos (
       video_id, title, url, channel, published_at, duration_s, effective_duration_s,
       views, comments, description, description_blocks, provenance, quality,
       content_hash, document_hash, content_hash_version, retrieval_hash, derivation_version,
       review_required, generator_model, prompt_version, generated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb,
       $14, $15, $16, $17, $18, $19, $20, $21, $22
     )
     ON CONFLICT (video_id) DO UPDATE SET
       title = EXCLUDED.title,
       url = EXCLUDED.url,
       channel = EXCLUDED.channel,
       published_at = EXCLUDED.published_at,
       duration_s = EXCLUDED.duration_s,
       effective_duration_s = EXCLUDED.effective_duration_s,
       views = EXCLUDED.views,
       comments = EXCLUDED.comments,
       description = EXCLUDED.description,
       description_blocks = EXCLUDED.description_blocks,
       provenance = EXCLUDED.provenance,
       quality = EXCLUDED.quality,
       content_hash = EXCLUDED.content_hash,
       document_hash = EXCLUDED.document_hash,
       content_hash_version = EXCLUDED.content_hash_version,
       retrieval_hash = EXCLUDED.retrieval_hash,
       derivation_version = EXCLUDED.derivation_version,
       review_required = EXCLUDED.review_required,
       generator_model = EXCLUDED.generator_model,
       prompt_version = EXCLUDED.prompt_version,
       generated_at = EXCLUDED.generated_at,
       -- Vecteur de la vidéo : à refaire dès que son contenu dérivé change (titre, description, plans).
       embedding = CASE WHEN videos.retrieval_hash = EXCLUDED.retrieval_hash THEN videos.embedding END,
       embedding_hash = CASE WHEN videos.retrieval_hash = EXCLUDED.retrieval_hash THEN videos.embedding_hash END,
       ingested_at = now()`,
    [
      video.videoId,
      video.title,
      video.url,
      video.channel,
      video.publishedAt,
      video.durationS,
      video.effectiveDurationS,
      video.views,
      video.comments,
      video.description,
      JSON.stringify(video.descriptionBlocks),
      JSON.stringify(video.provenance),
      JSON.stringify(video.quality),
      video.contentHash,
      video.documentHash,
      video.contentHashVersion,
      video.retrievalHash,
      video.derivationVersion,
      video.reviewRequired,
      video.generatorModel,
      video.promptVersion,
      video.generatedAt,
    ],
  );
}

export async function updateVideoStats(
  client: Db,
  input: {
    videoId: string;
    views: number | null;
    comments: number | null;
    contentHash: string;
    documentHash: string;
    generatedAt: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE videos SET
       views = $2, comments = $3, content_hash = $4, document_hash = $5,
       generated_at = $6, ingested_at = now()
     WHERE video_id = $1`,
    [input.videoId, input.views, input.comments, input.contentHash, input.documentHash, input.generatedAt],
  );
}
