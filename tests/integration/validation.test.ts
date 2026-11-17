import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import {
  dbAvailable,
  FIXTURES_DIR,
  getTestPool,
  readFixture,
  resetDatabase,
  setupDatabase,
} from './helpers.js';

(dbAvailable ? describe : describe.skip)('rejet explicite des entrées invalides.6', () => {
  let pool: Pool;
  let tempDir: string;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    tempDir = mkdtempSync(join(tmpdir(), 'ragator-invalid-'));
  });

  afterAll(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    await closePool(pool);
  });

  it('rejette une vidéo invalide sans bloquer les autres fichiers', async () => {
    const doc = JSON.parse(readFixture('Gu8bnHQaG5s')) as {
      source: { publicationDate: string | null };
    };
    doc.source.publicationDate = '2026-13-45';
    const invalidFile = join(tempDir, 'video--dateInvalide.json');
    writeFileSync(invalidFile, JSON.stringify(doc), 'utf8');

    const report = await ingestPaths(pool, [invalidFile, FIXTURES_DIR]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.error).toContain('date de publication invalide');
    expect(report.results).toHaveLength(2);
  });

  it('rejette un JSON illisible avec un bilan explicite', async () => {
    const brokenFile = join(tempDir, 'video--cassé.json');
    writeFileSync(brokenFile, '{ ceci n’est pas du JSON', 'utf8');
    const report = await ingestPaths(pool, [brokenFile]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.error).toContain('JSON illisible');
  });

  it('rejette un videoId hors du format attendu', async () => {
    const doc = JSON.parse(readFixture('cKRqOdTi5yE')) as { videoId: string };
    doc.videoId = 'court';
    const badIdFile = join(tempDir, 'video--mauvaisid.json');
    writeFileSync(badIdFile, JSON.stringify(doc), 'utf8');
    const report = await ingestPaths(pool, [badIdFile]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.error).toContain('videoId');
  });

  it('n’a rien ingéré des fichiers invalides seuls', async () => {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM videos`);
    expect(Number(rows[0]!.count)).toBe(2);
  });
});
