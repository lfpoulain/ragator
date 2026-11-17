import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { getPool } from '../../src/db/pool.js';
import { ensureTestDatabase } from '../test-database.js';
import { migrate } from '../../src/db/migrate.js';
import type { LlmClient } from '../../src/providers/llm.js';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://ragator:ragator@127.0.0.1:15432/ragator_test';

export const dbAvailable = await ensureTestDatabase(TEST_DATABASE_URL);

export function getTestPool(): Pool {
  return getPool(TEST_DATABASE_URL);
}

export async function setupDatabase(pool: Pool): Promise<void> {
  await migrate(pool);
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE videos CASCADE');
  await pool.query('DELETE FROM corpus_jobs');
  await pool.query('DELETE FROM eval_runs');
  await pool.query('DELETE FROM question_log');
  await pool.query('DELETE FROM corpus_meta');
  await pool.query(
    `INSERT INTO corpus_meta (key, value) VALUES
       ('schema_version', '"2.0"'),
       ('index_version', '"lexical"')`,
  );
}

export function readFixture(videoId: string): string {
  return readFileSync(join(FIXTURES_DIR, `video--${videoId}.json`), 'utf8');
}

export interface CountingEntry {
  kind: 'parole' | 'visuel';
  text: string;
  planTitle: string | null;
  screenText: string[] | null;
  startS: number;
  sourceId: string;
}

export function loadEntries(pool: Pool, videoId: string): Promise<CountingEntry[]> {
  return pool
    .query<{
      kind: string;
      text: string;
      plan_title: string | null;
      screen_text: string[] | null;
      start_s: number;
      source_id: string;
    }>(
      `SELECT kind, text, plan_title, screen_text, start_s, source_id
       FROM entries WHERE video_id = $1 ORDER BY start_s, source_id`,
      [videoId],
    )
    .then(({ rows }) =>
      rows.map((r) => ({
        kind: r.kind as 'parole' | 'visuel',
        text: r.text,
        planTitle: r.plan_title,
        screenText: r.screen_text,
        startS: r.start_s,
        sourceId: r.source_id,
      })),
    );
}

const TERM_BOUNDARY = (term: string): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
    'iu',
  );

export function entryMatchesTerm(entry: CountingEntry, term: string): boolean {
  const match = TERM_BOUNDARY(term);
  if (entry.kind === 'parole') return match.test(entry.text);
  return match.test([entry.planTitle ?? '', entry.text, ...(entry.screenText ?? [])].join('\n'));
}

export function countOccurrences(entries: CountingEntry[], term: string): CountingEntry[] {
  return entries.filter((entry) => entryMatchesTerm(entry, term));
}

export function screenMatches(entries: CountingEntry[], term: string): CountingEntry[] {
  const match = TERM_BOUNDARY(term);
  return entries.filter(
    (entry) => entry.kind === 'visuel' && (entry.screenText ?? []).some((t) => match.test(t)),
  );
}

export function listFixtureFiles(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => /^video--.+\.json$/.test(name))
    .sort()
    .map((name) => join(FIXTURES_DIR, name));
}

export interface DatabaseChecksum {
  entriesCount: number;
  entriesChecksum: string | null;
  windowsChecksum: string | null;
  corpusVersion: string | null;
  ingestedAt: string | null;
}

export async function checksum(pool: Pool, videoId: string): Promise<DatabaseChecksum> {
  const entries = await pool.query<{ count: string; sum: string | null }>(
    `SELECT count(*) AS count, sum(hashtext(source_id || '§' || text || '§' || coalesce(norm_text,''))) AS sum
     FROM entries WHERE video_id = $1`,
    [videoId],
  );
  const windows = await pool.query<{ sum: string | null }>(
    `SELECT sum(hashtext(text || '§' || n_entries::text)) AS sum FROM windows WHERE video_id = $1`,
    [videoId],
  );
  const version = await pool.query<{ value: string | null }>(
    `SELECT value #>> '{}' AS value FROM corpus_meta WHERE key = 'corpus_version'`,
  );
  const ingested = await pool.query<{ ingested_at: string | null }>(
    `SELECT ingested_at::text FROM videos WHERE video_id = $1`,
    [videoId],
  );
  return {
    entriesCount: Number(entries.rows[0]?.count ?? 0),
    entriesChecksum: entries.rows[0]?.sum ?? null,
    windowsChecksum: windows.rows[0]?.sum ?? null,
    corpusVersion: version.rows[0]?.value ?? null,
    ingestedAt: ingested.rows[0]?.ingested_at ?? null,
  };
}

/** LLM simulé : rejoue une réponse fixe et compte les appels, aucun réseau. */
export function fakeLlm(content: string | (() => string)): LlmClient & { calls: number } {
  const client = {
    model: 'llm-simule',
    calls: 0,
    async chat() {
      client.calls += 1;
      return typeof content === 'function' ? content() : content;
    },
    async available() {
      return true;
    },
  };
  return client;
}
