import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestDocument, ingestPaths } from '../../src/core/ingest.js';
import {
  checksum,
  dbAvailable,
  FIXTURES_DIR,
  getTestPool,
  readFixture,
  resetDatabase,
  setupDatabase,
} from './helpers.js';

(dbAvailable ? describe : describe.skip)('idempotence et reprise.6', () => {
  let pool: Pool;
  let tempDir: string;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    tempDir = mkdtempSync(join(tmpdir(), 'ragator-test-'));
  });

  afterAll(async () => {
    rmSync(tempDir, { recursive: true, force: true });
    await closePool(pool);
  });

  it('une première ingestion publie la vidéo', async () => {
    const result = await ingestDocument(pool, 'glacière', readFixture('Gu8bnHQaG5s'));
    expect(result.status).toBe('ingested');
    expect(result.entries).toBe(320);
    expect(result.windows).toBe(9);
  });

  it('une réingestion identique n’écrit rien', async () => {
    const before = await checksum(pool, 'Gu8bnHQaG5s');
    const result = await ingestDocument(pool, 'glacière', readFixture('Gu8bnHQaG5s'));
    expect(result.status).toBe('unchanged');
    const after = await checksum(pool, 'Gu8bnHQaG5s');
    expect(after).toEqual(before);
  });

  it('une modification des seules statistiques ne réécrit ni entrées, ni fenêtres, ni version', async () => {
    const doc = JSON.parse(readFixture('Gu8bnHQaG5s')) as {
      publicStats: { views: number; comments: number };
    };
    doc.publicStats.views += 1;
    doc.publicStats.comments += 1;
    const statsFile = join(tempDir, 'video--Gu8bnHQaG5s-stats.json');
    writeFileSync(statsFile, JSON.stringify(doc), 'utf8');

    const before = await checksum(pool, 'Gu8bnHQaG5s');
    const report = await ingestPaths(pool, [statsFile]);
    expect(report.failures).toEqual([]);
    expect(report.results[0]?.status).toBe('stats_only');

    const after = await checksum(pool, 'Gu8bnHQaG5s');
    expect(after.entriesChecksum).toBe(before.entriesChecksum);
    expect(after.entriesCount).toBe(before.entriesCount);
    expect(after.windowsChecksum).toBe(before.windowsChecksum);
    expect(after.corpusVersion).toBe(before.corpusVersion);

    const stats = await pool.query<{ views: string; comments: string }>(
      `SELECT views, comments FROM videos WHERE video_id = 'Gu8bnHQaG5s'`,
    );
    expect(Number(stats.rows[0]!.views)).toBe(126705);
    expect(Number(stats.rows[0]!.comments)).toBe(205);
  });

  it('une réingestion après retour aux statistiques d’origine ne réécrit rien', async () => {
    const result = await ingestDocument(pool, 'glacière', readFixture('Gu8bnHQaG5s'));
    expect(result.status).toBe('stats_only');
    const result2 = await ingestDocument(pool, 'glacière', readFixture('Gu8bnHQaG5s'));
    expect(result2.status).toBe('unchanged');
  });
});
