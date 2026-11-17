import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { PROJECT_ROOT } from '../config.js';

export const MIGRATIONS_DIR = join(PROJECT_ROOT, 'migrations');

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Applique dans l'ordre les `migrations/NNNN_*.sql` absentes de `__migrations`. */
export async function migrate(pool: Pool, migrationsDir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS __migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ name: string }>('SELECT name FROM __migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = readdirSync(migrationsDir)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort();
    const result: MigrateResult = { applied: [], alreadyApplied: [] };
    for (const name of files) {
      if (done.has(name)) {
        result.alreadyApplied.push(name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(migrationsDir, name), 'utf8'));
        await client.query('INSERT INTO __migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        result.applied.push(name);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${name} échouée : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  } finally {
    client.release();
  }
}
