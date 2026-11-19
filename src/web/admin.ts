import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { getConfig } from '../config.js';
import { CORPUS_FILENAME } from '../core/ingest.js';
import { updateCorpus, type UpdateReport } from '../core/update.js';
import { parseCorpusJson, validateCorpusDocument } from '../core/validate.js';
import { enrichLlmFromConfig } from '../providers/llm.js';

/**
 * Administration du corpus depuis l'interface web : dépôt de nouveaux fichiers
 * `video--<id>.json` (validés contre le schéma avant d'être écrits), mise à jour
 * en tâche de fond (ingestion, enrichissement, vecteurs) avec son journal, et
 * état de chaque vidéo. Une seule mise à jour à la fois.
 */

export interface UpdateJob {
  state: 'idle' | 'running' | UpdateReport['state'];
  startedAt: string | null;
  finishedAt: string | null;
  /** Dernières lignes du journal de la mise à jour en cours ou passée. */
  log: string[];
  summary: string | null;
  /** Refus du compte qui a mis la dernière mise à jour en échec (crédit épuisé, clé refusée). */
  refused: 'credit' | 'key' | null;
}

export interface UploadResult {
  name: string;
  ok: boolean;
  videoId?: string;
  title?: string;
  /** `nouvelle` : fichier ajouté ; `modifiée` : remplace une version différente ; `identique` : déjà présent. */
  status?: 'nouvelle' | 'modifiée' | 'identique';
  issues?: string[];
}

export interface AdminVideo {
  videoId: string;
  title: string;
  /** Collection (chaîne YouTube) de la vidéo. */
  collection: string;
  publishedAt: string | null;
  durationS: number | null;
  entries: number;
  chunks: number;
  enriched: number;
  /** Vecteurs manquants : entrées, blocs et celui de la vidéo. */
  pendingVectors: number;
}

const MAX_LOG_LINES = 300;
const LOCAL_RETRY_MINUTES = [1, 2, 4, 8, 16];
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function createAdmin(pool: Pool, options: { corpusDir?: string } = {}) {
  const job: UpdateJob = { state: 'idle', startedAt: null, finishedAt: null, log: [], summary: null, refused: null };
  const corpusDir = resolve(options.corpusDir ?? getConfig().corpusDir);
  let retryTimer: NodeJS.Timeout | undefined;
  let requested = false;
  let closed = false;

  const log = (line: string) => {
    job.log.push(`[${new Date().toLocaleTimeString('fr-FR')}] ${line}`);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  };

  /** Lance la mise à jour en tâche de fond ; `false` si une mise à jour tourne déjà. */
  function startUpdate(attempt = 0): boolean {
    if (closed || job.state === 'running') return false;
    clearTimeout(retryTimer);
    Object.assign(job, { state: 'running', startedAt: new Date().toISOString(), finishedAt: null, log: [], summary: null, refused: null });
    log(`mise à jour de ${corpusDir}`);
    void (async () => {
      try {
        const report = await updateCorpus(pool, { dir: corpusDir, llm: enrichLlmFromConfig(pool), log });
        for (const note of report.notes) log(note);
        const counts =
          `${report.ingested.length} vidéo(s) ingérée(s), ${report.enriched} bloc(s) enrichi(s), ` +
          `${report.embedded} vecteur(s), ${report.failures.length} échec(s)`;
        log(counts);
        // Un refus du compte prime : c'est la cause à corriger, les chiffres restent au journal.
        job.summary = report.refused?.summary ?? (report.state === 'partial' ? report.notes.join(' · ') : counts);
        if (report.refused) log(`ARRÊT : ${report.refused.summary}`);
        job.refused = report.refused?.reason ?? null;
        job.state = report.state;
      } catch (err) {
        job.summary = `mise à jour en échec : ${err instanceof Error ? err.message : String(err)}`;
        log(job.summary);
        job.state = 'error';
      } finally {
        job.finishedAt = new Date().toISOString();
        if (!closed && requested) {
          requested = false;
          startUpdate();
        } else if (!closed && job.state === 'partial' && getConfig().mode === 'local') {
          const minutes = LOCAL_RETRY_MINUTES[attempt];
          if (minutes !== undefined) {
            log(`nouvel essai dans ${minutes} min pendant la préparation des modèles locaux`);
            retryTimer = setTimeout(() => {
              if (getConfig().mode === 'local') startUpdate(attempt + 1);
            }, minutes * 60_000).unref();
          }
        }
      }
    })();
    return true;
  }

  /** Un changement de modèles pendant le travail demande un nouveau passage avec les nouveaux clients. */
  function requestUpdate(): void {
    if (!closed && !startUpdate()) requested = true;
  }

  function close(): void {
    closed = true;
    clearTimeout(retryTimer);
  }

  /** Valide un fichier déposé et l'écrit dans le dossier du corpus, nommé d'après son identifiant. */
  function saveUpload(name: string, content: string): UploadResult {
    const normalized = content.replace(/^\uFEFF/, '');
    let parsed: unknown;
    try {
      parsed = parseCorpusJson(content);
    } catch {
      return { name, ok: false, issues: ['ce n’est pas un JSON lisible'] };
    }
    const validation = validateCorpusDocument(parsed);
    if (!validation.ok) return { name, ok: false, issues: validation.issues.slice(0, 8) };
    const { doc } = validation;
    if (!VIDEO_ID.test(doc.videoId)) return { name, ok: false, issues: [`identifiant de vidéo invalide : ${doc.videoId}`] };
    mkdirSync(corpusDir, { recursive: true });
    const path = join(corpusDir, `video--${doc.videoId}.json`);
    const status = !existsSync(path) ? 'nouvelle' : readFileSync(path, 'utf8').replace(/^\uFEFF/, '') === normalized ? 'identique' : 'modifiée';
    if (status !== 'identique') writeFileSync(path, normalized, 'utf8');
    return { name, ok: true, videoId: doc.videoId, title: doc.source.title, status };
  }

  /** Fichiers du dossier du corpus pas encore dans la base (déposés, à ingérer). */
  async function corpusState(): Promise<{ dir: string; files: number; notIngested: string[] }> {
    const files = existsSync(corpusDir) ? readdirSync(corpusDir).filter((name) => CORPUS_FILENAME.test(name)) : [];
    const ids = files.map((name) => name.slice('video--'.length, -'.json'.length));
    const { rows } = await pool.query<{ video_id: string }>('SELECT video_id FROM videos WHERE video_id = ANY($1::text[])', [ids]);
    const known = new Set(rows.map((r) => r.video_id));
    return { dir: corpusDir, files: ids.length, notIngested: ids.filter((id) => !known.has(id)) };
  }

  /** Vidéos indexées, les plus récentes d'abord, avec l'état de leur enrichissement et de leurs vecteurs. */
  async function listVideos(): Promise<AdminVideo[]> {
    const { rows } = await pool.query<{
      video_id: string;
      title: string;
      collection: string;
      published_at: string | null;
      duration_s: number | null;
      entries: string;
      entries_pending: string;
      chunks: string;
      enriched: string;
      chunks_pending: string;
      video_pending: number;
    }>(
      `WITH e AS (SELECT video_id, count(*) AS n, count(*) FILTER (WHERE embedding IS NULL) AS pending FROM entries GROUP BY video_id),
            c AS (SELECT video_id, count(*) AS n, count(*) FILTER (WHERE enrichment IS NOT NULL) AS enriched,
                         count(*) FILTER (WHERE embedding IS NULL) AS pending FROM chunks GROUP BY video_id)
       SELECT v.video_id, v.title, v.collection, v.published_at::text AS published_at, v.duration_s,
              (v.embedding IS NULL)::int AS video_pending,
              coalesce(e.n, 0) AS entries, coalesce(e.pending, 0) AS entries_pending,
              coalesce(c.n, 0) AS chunks, coalesce(c.enriched, 0) AS enriched, coalesce(c.pending, 0) AS chunks_pending
       FROM videos v LEFT JOIN e USING (video_id) LEFT JOIN c USING (video_id)
       ORDER BY v.published_at DESC NULLS LAST, v.video_id`,
    );
    return rows.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      collection: r.collection,
      publishedAt: r.published_at,
      durationS: r.duration_s,
      entries: Number(r.entries),
      chunks: Number(r.chunks),
      enriched: Number(r.enriched),
      pendingVectors: Number(r.entries_pending) + Number(r.chunks_pending) + Number(r.video_pending),
    }));
  }

  return { job, startUpdate, requestUpdate, close, saveUpload, corpusState, listVideos };
}

export type Admin = ReturnType<typeof createAdmin>;
