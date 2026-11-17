import pg from 'pg';
import { canConnect } from '../src/db/pool.js';

/** Refuse une base non dédiée aux tests avant toute connexion ou opération destructive. */
export function testDatabaseTarget(connectionString: string): { database: string; adminUrl: string } {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(database) || !(database.endsWith('_test') || database.startsWith('test_'))) {
    throw new Error('DATABASE_URL_TEST doit désigner une base dédiée (nom terminé par _test ou commençant par test_)');
  }
  url.pathname = '/postgres';
  return { database, adminUrl: url.toString() };
}

/** Crée d'abord la base demandée ; sans PostgreSQL disponible, les suites sont ignorées. */
export async function ensureTestDatabase(connectionString: string): Promise<boolean> {
  const { database, adminUrl } = testDatabaseTarget(connectionString);
  if (!(await canConnect(adminUrl, 2000))) return false;
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 });
  try {
    await admin.connect();
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if ((rowCount ?? 0) === 0) {
      try {
        await admin.query(`CREATE DATABASE "${database}"`);
      } catch (error) {
        // Deux lancements de tests peuvent tenter de créer la même base.
        if ((error as { code?: string }).code !== '42P04') throw error;
      }
    }
  } finally {
    await admin.end().catch(() => {});
  }
  return canConnect(connectionString, 2000);
}
