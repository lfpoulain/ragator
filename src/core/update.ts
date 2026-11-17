import type { Pool } from 'pg';
import { getConfig } from '../config.js';
import { embeddingFromConfig, type EmbeddingClient } from '../providers/embedding.js';
import type { LlmClient } from '../providers/llm.js';
import { AccountRefusedError } from '../providers/retry.js';
import { embedPending } from './embed.js';
import { enrichPending } from './enrich.js';
import { ingestPaths } from './ingest.js';

export interface UpdateReport {
  /** Fichiers nouveaux ou modifiés, ingérés. */
  ingested: string[];
  failures: Array<{ file: string; error: string }>;
  /** Blocs de 30 s enrichis (0 sans LLM). */
  enriched: number;
  /** Vecteurs calculés (entrées et blocs). */
  embedded: number;
  /** Étapes sautées ou incomplètes, à relancer. */
  notes: string[];
  /** Premier refus du compte (crédit épuisé, clé refusée) : la mise à jour est en échec tant qu'il dure. */
  refused: AccountRefusedError | null;
}

/**
 * Mise à jour complète du corpus en une commande : ingestion idempotente du
 * dossier (seuls les fichiers nouveaux ou modifiés sont réécrits), puis
 * enrichissement des blocs par le LLM, puis vecteurs manquants. L'ordre évite
 * d'encoder deux fois un bloc : l'enrichissement efface son vecteur. Chaque
 * étape reprend ce qui reste ; une étape indisponible est notée, pas bloquante.
 * Un refus du compte (crédit épuisé, clé refusée) arrête l'étape en cours et
 * remonte dans `refused` : rien ne s'écrira avant une action humaine.
 */
export async function updateCorpus(
  pool: Pool,
  options: {
    dir?: string;
    llm: LlmClient | null;
    /** Encodeur des vecteurs ; défaut : configuration (clé OpenRouter), `null` : étape sautée. */
    embedder?: EmbeddingClient | null;
    log?: (line: string) => void;
  },
): Promise<UpdateReport> {
  const log = options.log ?? (() => {});
  const config = getConfig();
  const report: UpdateReport = { ingested: [], failures: [], enriched: 0, embedded: 0, notes: [], refused: null };

  const ingest = await ingestPaths(pool, [options.dir ?? config.corpusDir]);
  report.ingested = ingest.results.filter((r) => r.status === 'ingested').map((r) => r.videoId);
  report.failures = ingest.failures;
  if (report.ingested.length > 0) log(`ingestion : ${report.ingested.length} vidéo(s) nouvelle(s) ou modifiée(s)`);
  for (const failure of ingest.failures) log(`ÉCHEC ${failure.file} : ${failure.error}`);

  if (options.llm && (await options.llm.available())) {
    const enrich = await enrichPending(pool, options.llm, { onProgress: log });
    report.enriched = enrich.chunks;
    if (enrich.refused) {
      report.refused = enrich.refused;
      report.notes.push(`enrichissement arrêté : ${enrich.refused.message}`);
    }
    if (enrich.failedGroups > 0) report.notes.push(`enrichissement : ${enrich.failedGroups} groupe(s) en échec, repris à la prochaine mise à jour`);
  } else {
    report.notes.push('enrichissement sauté : aucun LLM disponible');
  }

  const embedder = options.embedder === undefined ? embeddingFromConfig() : options.embedder;
  if (embedder) {
    try {
      log('vecteurs : textes manquants, puis index vectoriels s’ils manquent (plusieurs minutes pour un corpus complet)');
      const embed = await embedPending(pool, { embedder });
      report.embedded = embed.embedded;
      if (embed.vectorIndexCreated) log('index vectoriels construits');
      if (!embed.complete) report.notes.push(`vecteurs : ${embed.pending} en attente`);
    } catch (err) {
      if (err instanceof AccountRefusedError) {
        report.refused ??= err;
        report.notes.push(`vecteurs arrêtés : ${err.message}`);
      } else {
        report.notes.push(`vecteurs sautés : ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    report.notes.push('vecteurs sautés : pas de clé OpenRouter');
  }
  return report;
}
