import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { repondre } from '../../src/core/answer.js';
import { logQuestion, readQuestionLog } from '../../src/db/question-log.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

(dbAvailable ? describe : describe.skip)('journal des questions', () => {
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

  it('garde la réponse, les erreurs, et ne rend que les échecs avec --echecs', async () => {
    const found = { question: 'NordVPN', mode: 'extractif' as const };
    await logQuestion(pool, 'web', found, { result: await repondre(pool, found, { embedder: null, analyzer: null, judge: null }) });
    const nothing = { question: 'zzzqqqxx introuvable', mode: 'extractif' as const };
    await logQuestion(pool, 'cli', nothing, { result: await repondre(pool, nothing, { embedder: null, analyzer: null, judge: null }) });
    await logQuestion(pool, 'web', { question: 'en panne' }, { error: new Error('LLM HTTP 500') });

    const all = await readQuestionLog(pool);
    expect(all.map((q) => q.question)).toEqual(['en panne', 'zzzqqqxx introuvable', 'NordVPN']);
    expect(all[2]!.citedVideos.length).toBeGreaterThan(0);
    expect(all[0]!.error).toBe('LLM HTTP 500');

    const failures = await readQuestionLog(pool, { failures: true });
    expect(failures.map((q) => q.question)).toEqual(['en panne', 'zzzqqqxx introuvable']);
  });

  it('efface les questions de plus de six mois', async () => {
    await pool.query(`INSERT INTO question_log (origin, question, asked_at) VALUES ('web', 'ancienne', now() - interval '200 days')`);
    await logQuestion(pool, 'web', { question: 'récente' }, { error: 'x' });
    const { rows } = await pool.query(`SELECT question FROM question_log WHERE question IN ('ancienne', 'récente')`);
    expect(rows.map((r) => r.question)).toEqual(['récente']);
  });

  it('un journal absent ne fait pas échouer la réponse', async () => {
    await pool.query('ALTER TABLE question_log RENAME TO question_log_cachee');
    try {
      await expect(logQuestion(pool, 'web', { question: 'x' }, { error: 'y' })).resolves.toBeUndefined();
    } finally {
      await pool.query('ALTER TABLE question_log_cachee RENAME TO question_log');
    }
  });
});
