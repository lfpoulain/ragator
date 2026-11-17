import pg, { type Pool, type PoolClient } from 'pg';
import { getConfig } from '../config.js';

/** Tout ce qui sait exécuter une requête : pool ou client de transaction. */
export type Db = Pick<PoolClient, 'query'>;

/**
 * `hnsw.iterative_scan` est un paramètre de session : il doit être posé
 * sur chaque connexion qui exécute une recherche vectorielle filtrée.
 */
const SESSION_OPTIONS = '-c hnsw.iterative_scan=strict_order';

const pools = new Map<string, Pool>();

export function getPool(connectionString?: string): Pool {
  const cs = connectionString ?? getConfig().databaseUrl;
  let pool = pools.get(cs);
  if (!pool) {
    pool = new pg.Pool({ connectionString: cs, options: SESSION_OPTIONS, max: 10 });
    pool.on('error', (err) => {
      console.error('[pool] erreur client PostgreSQL inattendue :', err.message);
    });
    pools.set(cs, pool);
  }
  return pool;
}

/** Ferme le pool et l'oublie, pour qu'un prochain `getPool` en recrée un. */
export async function closePool(pool: Pool): Promise<void> {
  for (const [key, value] of pools) {
    if (value === pool) pools.delete(key);
  }
  await pool.end();
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  begin = 'BEGIN',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface Versions {
  corpusVersion: string;
  indexVersion: string;
}

/**
 * Lecture cohérente : données, comptes et versions lus dans un même
 * instantané, transaction courte en lecture seule. Aucun appel modèle dedans.
 */
export function readSnapshot<T>(
  pool: Pool,
  work: (client: PoolClient, versions: Versions) => Promise<T>,
): Promise<T> {
  return withTransaction(
    pool,
    async (client) => {
      const { rows } = await client.query<{ key: string; value: string | null }>(
        `SELECT key, value #>> '{}' AS value FROM corpus_meta
         WHERE key IN ('corpus_version', 'index_version')`,
      );
      const byKey = new Map(rows.map((r) => [r.key, r.value ?? '']));
      return work(client, {
        corpusVersion: byKey.get('corpus_version') ?? '',
        indexVersion: byKey.get('index_version') ?? '',
      });
    },
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  );
}

export async function canConnect(connectionString?: string, timeoutMs = 3000): Promise<boolean> {
  const client = new pg.Client({
    connectionString: connectionString ?? getConfig().databaseUrl,
    connectionTimeoutMillis: timeoutMs,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
