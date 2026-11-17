import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ingestPaths } from '../../src/core/ingest.js';
import { embedPending } from '../../src/core/embed.js';
import { chercher } from '../../src/core/search.js';
import { hasVectorIndex } from '../../src/db/vector-index.js';
import { nearbyVideos } from '../../src/core/nearby-videos.js';
import { stats } from '../../src/core/stats.js';
import { closePool } from '../../src/db/pool.js';
import { EMBEDDING_COLUMN_DIMS } from '../../src/config.js';
import type { EmbeddingClient } from '../../src/providers/embedding.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

/** Encodeur déterministe sans réseau : sac de mots haché, normalisé. */
function bagOfWords(): EmbeddingClient & { texts: number } {
  const client = {
    model: 'sac-de-mots',
    texts: 0,
    async embed(texts: string[]) {
      client.texts += texts.length;
      return texts.map((text) => {
        const vector = new Array<number>(EMBEDDING_COLUMN_DIMS).fill(0);
        for (const word of text.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
          vector[createHash('md5').update(word).digest().readUInt32BE(0) % EMBEDDING_COLUMN_DIMS]! += 1;
        }
        const norm = Math.hypot(...vector) || 1;
        return norm === 1 && vector.every((v) => v === 0) ? vector.map((_, i) => (i === 0 ? 1 : 0)) : vector.map((v) => v / norm);
      });
    },
  };
  return client;
}

(dbAvailable ? describe : describe.skip)('encodage des entrées et des blocs de 30 s', () => {
  let pool: Pool;
  const embedder = bagOfWords();

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    const report = await ingestPaths(pool, [FIXTURES_DIR]);
    expect(report.failures).toEqual([]);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('l’ingestion produit des blocs titrés, sans vecteur', async () => {
    const { rows } = await pool.query<{ n: string; empty: string; titled: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE embedding IS NULL) AS empty,
              count(*) FILTER (WHERE text LIKE 'Les glacières sur batterie%') AS titled
       FROM chunks WHERE video_id = 'Gu8bnHQaG5s'`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(20);
    expect(rows[0]!.empty).toBe(rows[0]!.n);
    expect(rows[0]!.titled).toBe(rows[0]!.n);
  });

  it('encode entrées puis blocs, construit les deux index HNSW', async () => {
    const result = await embedPending(pool, { embedder, batchSize: 256 });
    expect(result.complete).toBe(true);
    const { rows } = await pool.query<{ pending: string }>(
      `SELECT (SELECT count(*) FROM entries WHERE embedding IS NULL) + (SELECT count(*) FROM chunks WHERE embedding IS NULL) AS pending`,
    );
    expect(Number(rows[0]!.pending)).toBe(0);
    expect(await hasVectorIndex(pool, 'entries_embedding_idx')).toBe(true);
    expect(await hasVectorIndex(pool, 'chunks_embedding_idx')).toBe(true);
  });

  it('un vecteur par vidéo, avec l’empreinte de son texte, compté dans stats', async () => {
    const { rows } = await pool.query<{ n: string; done: string; hashed: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE embedding IS NOT NULL) AS done,
              count(*) FILTER (WHERE embedding_hash IS NOT NULL) AS hashed FROM videos`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
    expect(rows[0]!.done).toBe(rows[0]!.n);
    expect(rows[0]!.hashed).toBe(rows[0]!.n);
    expect(await hasVectorIndex(pool, 'videos_embedding_idx')).toBe(true);
    const page = await stats(pool);
    expect(page.data.embeddings.videos).toEqual({ done: 2, pending: 0 });
  });

  it('vidéos proches : l’autre vidéo du corpus, jamais elle-même ; vidéo inconnue : null', async () => {
    const result = await nearbyVideos(pool, 'Gu8bnHQaG5s');
    expect(result?.ready).toBe(true);
    expect(result!.videos.map((v) => v.videoId)).toEqual(['cKRqOdTi5yE']);
    expect(result!.videos[0]!.similarity).toBeGreaterThan(-1);
    expect(result!.videos[0]!.similarity).toBeLessThanOrEqual(1);
    expect(await nearbyVideos(pool, 'inconnue123')).toBeNull();
  });

  it('une vidéo réingérée avec un autre contenu perd son vecteur, puis le retrouve', async () => {
    await pool.query(`UPDATE videos SET retrieval_hash = 'ancienne' WHERE video_id = 'Gu8bnHQaG5s'`);
    await ingestPaths(pool, [FIXTURES_DIR]);
    const { rows } = await pool.query<{ embedded: boolean }>(`SELECT embedding IS NOT NULL AS embedded FROM videos WHERE video_id = 'Gu8bnHQaG5s'`);
    expect(rows[0]!.embedded).toBe(false);
    const before = embedder.texts;
    const result = await embedPending(pool, { embedder, batchSize: 256 });
    expect(result.complete).toBe(true);
    expect(embedder.texts - before).toBeGreaterThanOrEqual(1);
    expect((await nearbyVideos(pool, 'Gu8bnHQaG5s'))?.ready).toBe(true);
  });

  it('une réingestion identique garde tous les vecteurs', async () => {
    const before = embedder.texts;
    await ingestPaths(pool, [FIXTURES_DIR]);
    const result = await embedPending(pool, { embedder, batchSize: 256 });
    expect(result.embedded).toBe(0);
    expect(embedder.texts).toBe(before);
  });

  it('recherche sémantique (entrées et blocs) : preuves rattachées aux entrées, meilleure preuve dans le bon passage', async () => {
    const page = await chercher(pool, { query: 'module Peltier glacière', limit: 5 }, { embedder });
    expect(page.data.degraded).toBe(false);
    expect(page.data.candidates.semantic).toBeGreaterThan(0);
    const top = page.data.results[0]!;
    expect(top.videoId).toBe('Gu8bnHQaG5s');
    expect(top.bestEntry.sourceId).toMatch(/^Gu8bnHQaG5s:[tv]\d{5}$/);
    expect(top.bestEntry.text.toLowerCase()).toContain('peltier');
    expect(top.evidence.length).toBeGreaterThan(0);
  });
});
