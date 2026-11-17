import type { Pool } from 'pg';
import { withTransaction, type Db } from './pool.js';

/** Index HNSW des espaces encodés : entrées, blocs de 30 s et vidéos (migration 0008). */
const INDEXES = [
  { name: 'entries_embedding_idx', table: 'entries' },
  { name: 'chunks_embedding_idx', table: 'chunks' },
  { name: 'videos_embedding_idx', table: 'videos' },
] as const;

export async function hasVectorIndex(db: Db, name: string = INDEXES[0].name): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [name],
  );
  return rows[0]?.exists === true;
}

/** Tables lues par chaque recherche vectorielle : lignes (visibilité, instants) et vecteurs (stockage TOAST). */
const SEARCH_TABLES = ['entries', 'chunks'] as const;

/**
 * Charge en mémoire ce que lit une recherche vectorielle (pg_prewarm, migration 0010) : les index HNSW
 * présents, puis les tables `entries` et `chunks` avec leurs vecteurs. Après un redémarrage, tout est sur
 * le disque, et chaque recherche y lit des centaines de pages une à une (mesuré sur un disque dur : 550 ms
 * pour les entrées et 260 ms pour les blocs, contre 14 et 42 ms en mémoire). Les index seuls ne suffisent
 * pas : la recherche par blocs relit le vecteur de chaque entrée des blocs trouvés (0,93 s par question
 * index seuls, 0,6 s avec les tables). ~3 Go en tout pour 190 000 extraits. Sans l'extension, ne fait
 * rien. Rend ce qui a été chargé.
 */
export async function prewarmVectorIndexes(pool: Pool): Promise<string[]> {
  const loaded: string[] = [];
  for (const { name } of INDEXES) {
    try {
      if (!(await hasVectorIndex(pool, name))) continue;
      await pool.query('SELECT pg_prewarm($1::regclass)', [name]);
      loaded.push(name);
    } catch {
      // Extension absente ou base occupée : la recherche reste juste, seulement plus lente à froid.
    }
  }
  // Sans index vectoriel, la recherche est lexicale : rien d'autre à charger.
  if (loaded.length === 0) return loaded;
  for (const table of SEARCH_TABLES) {
    try {
      await pool.query(
        `SELECT pg_prewarm(c.oid::regclass), CASE WHEN c.reltoastrelid <> 0 THEN pg_prewarm(c.reltoastrelid::regclass) END
         FROM pg_class c WHERE c.oid = $1::regclass`,
        [table],
      );
      loaded.push(table);
    } catch {
      // Même repli que pour les index.
    }
  }
  return loaded;
}

/**
 * Construit les index HNSW manquants. Appelé après l'encodage : les
 * construire après chargement est moins coûteux. La mémoire partagée Docker
 * étant limitée, la construction est séquentielle avec 256 Mo de travail.
 * Renvoie vrai si au moins un index a été créé.
 */
export async function ensureVectorIndex(pool: Pool): Promise<boolean> {
  let created = false;
  for (const { name, table } of INDEXES) {
    if (await hasVectorIndex(pool, name)) continue;
    await withTransaction(pool, async (client) => {
      await client.query(`SET LOCAL maintenance_work_mem = '256MB'`);
      await client.query('SET LOCAL max_parallel_maintenance_workers = 0');
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${name} ON ${table}
         USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)`,
      );
    });
    created = true;
  }
  return created;
}
