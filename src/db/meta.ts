import { corpusVersionFrom } from '../core/hashes.js';
import { DERIVATION_VERSION } from '../core/versions.js';
import type { Db } from './pool.js';

export async function getMeta(db: Db, key: string): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>(
    'SELECT value FROM corpus_meta WHERE key = $1',
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function getMetaString(db: Db, key: string): Promise<string | null> {
  const value = await getMeta(db, key);
  return typeof value === 'string' ? value : null;
}

export async function getMetaNumber(db: Db, key: string): Promise<number | null> {
  const value = await getMeta(db, key);
  return typeof value === 'number' ? value : null;
}

export async function setMeta(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO corpus_meta (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function recomputeCorpusVersion(db: Db): Promise<string> {
  const { rows } = await db.query<{ retrieval_hash: string }>('SELECT retrieval_hash FROM videos');
  const version = corpusVersionFrom(
    rows.map((r) => r.retrieval_hash),
    DERIVATION_VERSION,
  );
  await setMeta(db, 'corpus_version', version);
  await setMeta(db, 'derivation_version', DERIVATION_VERSION);
  return version;
}

/**
 * `index_version` décrit tout ce qui classe les résultats en plus du texte :
 * les vecteurs des entrées ET des blocs de 30 s, et l'enrichissement des blocs
 * (qui nourrit une liste BM25). `lexical` tant qu'aucun vecteur n'existe,
 * `partiel:<modèle>:<prêts>/<total>:e<enrichis>` pendant l'encodage,
 * `hybride:<modèle>:<corpus>:e<enrichis>` une fois complet. Toute évolution
 * change la version, donc invalide les curseurs de pagination.
 */
export async function refreshIndexVersion(db: Db): Promise<string> {
  const model = await getMetaString(db, 'embedding_model');
  const corpusVersion = (await getMetaString(db, 'corpus_version')) ?? '';
  const { rows } = await db.query<{ ready: string; total: string; enriched: string }>(
    `SELECT (SELECT count(*) FROM entries WHERE embedding IS NOT NULL)
          + (SELECT count(*) FROM chunks WHERE embedding IS NOT NULL) AS ready,
            (SELECT count(*) FROM entries) + (SELECT count(*) FROM chunks) AS total,
            (SELECT count(*) FROM chunks WHERE enrichment IS NOT NULL) AS enriched`,
  );
  const ready = Number(rows[0]?.ready ?? 0);
  const total = Number(rows[0]?.total ?? 0);
  const enriched = `e${Number(rows[0]?.enriched ?? 0)}`;
  const version =
    model === null || ready === 0
      ? 'lexical'
      : ready < total
        ? `partiel:${model}:${ready}/${total}:${enriched}`
        : `hybride:${model}:${corpusVersion.slice(0, 16)}:${enriched}`;
  await setMeta(db, 'index_version', version);
  return version;
}
