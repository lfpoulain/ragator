import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ingestPaths } from '../../src/core/ingest.js';
import { enrichPending } from '../../src/core/enrich.js';
import { chercher } from '../../src/core/search.js';
import { closePool } from '../../src/db/pool.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

/** LLM simulé : chaque bloc reçoit un contexte et un mot-clé absent du corpus (« zorglubage »). */
function enricher(): LlmClient & { calls: number } {
  const client = {
    model: 'enrichisseur-simule',
    calls: 0,
    async available() {
      return true;
    },
    async chat(_system: string, user: string) {
      client.calls += 1;
      const ids = [...user.matchAll(/<bloc id="(b\d+)"/g)].map((m) => m[1]!);
      return JSON.stringify({ blocs: ids.map((id) => ({ id, contexte: `Passage ${id} de la vidéo.`, motsCles: ['zorglubage', 'atelier'] })) });
    },
  };
  return client;
}

(dbAvailable ? describe : describe.skip)('enrichissement des blocs de 30 s (npm run enrich)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('une réponse tronquée ou illisible est un échec compté, jamais un succès silencieux', async () => {
    const cut: LlmClient = {
      model: 'tronque',
      async available() {
        return true;
      },
      async chat(_system, _user, options) {
        // Assez de place pour le JSON d'un bloc : la marge fixe est bien demandée.
        expect(options?.maxTokens ?? 0).toBeGreaterThanOrEqual(280);
        return '{"blocs":[{"id":"b1","contexte":"Passage coup';
      },
    };
    const result = await enrichPending(pool, cut, { maxVideos: 1 });
    expect(result).toMatchObject({ chunks: 0 });
    expect(result.failedGroups).toBeGreaterThan(0);
  });

  it('enrichit chaque bloc en un appel par vidéo, et le vecteur est à recalculer', async () => {
    const llm = enricher();
    const result = await enrichPending(pool, llm);
    expect(result).toMatchObject({ videos: 2, failedGroups: 0, pendingChunks: 0 });
    expect(llm.calls).toBe(2);
    const { rows } = await pool.query<{ enrichment: string; embedding: string | null }>(
      `SELECT enrichment, embedding FROM chunks WHERE video_id = 'Gu8bnHQaG5s' ORDER BY start_s LIMIT 1`,
    );
    expect(rows[0]!.enrichment).toBe('Passage b1 de la vidéo.\nMots-clés : zorglubage, atelier');
    expect(rows[0]!.embedding).toBeNull();
  });

  it('un mot présent seulement dans l’enrichissement trouve le passage', async () => {
    const page = await chercher(pool, { query: 'zorglubage', limit: 5 }, { embedder: null });
    expect(page.data.results.length).toBeGreaterThan(0);
  });

  it('une réingestion identique garde l’enrichissement ; une relance n’a plus rien à faire', async () => {
    await ingestPaths(pool, [FIXTURES_DIR]);
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM chunks WHERE enrichment IS NULL`);
    expect(Number(rows[0]!.n)).toBe(0);
    const again = enricher();
    expect((await enrichPending(pool, again)).videos).toBe(0);
    expect(again.calls).toBe(0);
  });
});
