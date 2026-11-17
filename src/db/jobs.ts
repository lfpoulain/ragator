import type { Db } from './pool.js';

export interface JobKey {
  type: 'ingest' | 'derive' | 'embed';
  scope: string;
  targetHash: string;
  version: string;
}

/**
 * Trace un travail à faire. L'état des lignes fait foi : un job
 * d'embedding est seulement l'indicateur lisible par `stats`.
 */
export async function ensureJob(db: Db, key: JobKey): Promise<void> {
  await db.query(
    `INSERT INTO corpus_jobs (type, scope, target_hash, version, state)
     VALUES ($1, $2, $3, $4, 'queued')
     ON CONFLICT (type, scope, target_hash, version) DO NOTHING`,
    [key.type, key.scope, key.targetHash, key.version],
  );
}

export async function startJobs(db: Db, type: JobKey['type']): Promise<void> {
  await db.query(
    `UPDATE corpus_jobs
     SET state = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, now())
     WHERE type = $1 AND state = 'queued'`,
    [type],
  );
}

export async function setJobsProgress(db: Db, type: JobKey['type'], progress: number): Promise<void> {
  await db.query(
    `UPDATE corpus_jobs SET progress = $2 WHERE type = $1 AND state = 'running'`,
    [type, progress],
  );
}

export async function finishJobs(db: Db, type: JobKey['type']): Promise<void> {
  await db.query(
    `UPDATE corpus_jobs
     SET state = 'done', progress = 100, finished_at = now(), lease_until = NULL
     WHERE type = $1 AND state IN ('queued', 'running')`,
    [type],
  );
}
