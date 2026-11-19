import type { Pool } from 'pg';
import type { AnswerInput, AnswerResult } from '../core/answer.js';
import { LEXICAL_WITHOUT_ENCODER } from '../core/search.js';

/**
 * Journal des questions posées (migration 0009) : interface web et ligne de commande.
 * Sert à repérer les vrais échecs (`npm run journal`).
 */
export type QuestionOrigin = 'web' | 'cli';

/**
 * Durée de conservation : au-delà, les questions sont effacées à chaque écriture (rapide : index sur
 * `asked_at`). Six mois suffisent pour repérer les échecs.
 */
export const QUESTION_LOG_DAYS = 180;

export interface LoggedQuestion {
  id: number;
  askedAt: string;
  origin: QuestionOrigin;
  question: string;
  resolved: string | null;
  collection: string | null;
  route: string | null;
  refused: boolean | null;
  citedVideos: string[];
  considered: number | null;
  degradedReason: string | null;
  error: string | null;
  totalMs: number | null;
}

/**
 * Écrit une question et son issue (réponse ou erreur), puis efface celles de plus de
 * `QUESTION_LOG_DAYS` jours. Ne lève jamais : un journal en panne (table
 * absente, base saturée) ne doit pas faire échouer la réponse.
 */
export async function logQuestion(pool: Pool, origin: QuestionOrigin, input: AnswerInput, outcome: { result: AnswerResult } | { error: unknown }): Promise<void> {
  const result = 'result' in outcome ? outcome.result : null;
  const error = 'error' in outcome ? (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)) : null;
  try {
    await pool.query(
      `INSERT INTO question_log (origin, question, resolved, collection, mode, route, refused, cited_videos, considered, degraded_reason, error, total_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        origin,
        input.question,
        result && result.resolvedQuestion !== result.question ? result.resolvedQuestion : null,
        input.collection ?? null,
        input.mode ?? null,
        result?.route ?? null,
        result?.refused ?? null,
        result ? [...new Set(result.sources.map((s) => s.videoId))] : [],
        result?.consideredVideoIds.length ?? null,
        result?.degradedReason ?? null,
        error,
        result?.timings.totalMs ?? null,
      ],
    );
    await pool.query(`DELETE FROM question_log WHERE asked_at < now() - make_interval(days => $1)`, [QUESTION_LOG_DAYS]);
  } catch {
    // Journal facultatif.
  }
}

/**
 * Questions journalisées, les plus récentes d'abord. `failures` : seulement les échecs probables —
 * refus, aucune vidéo citée (hors demande de reformulation), erreur ou réponse dégradée.
 */
export async function readQuestionLog(pool: Pool, options: { days?: number; failures?: boolean; limit?: number } = {}): Promise<LoggedQuestion[]> {
  const { rows } = await pool.query<{
    id: string;
    asked_at: string;
    origin: QuestionOrigin;
    question: string;
    resolved: string | null;
    collection: string | null;
    route: string | null;
    refused: boolean | null;
    cited_videos: string[];
    considered: number | null;
    degraded_reason: string | null;
    error: string | null;
    total_ms: number | null;
  }>(
    `SELECT id, asked_at::text, origin, question, resolved, collection, route, refused, cited_videos, considered, degraded_reason, error, total_ms
     FROM question_log
     WHERE asked_at > now() - make_interval(days => $1)
       AND (NOT $2 OR refused OR error IS NOT NULL
            OR (degraded_reason IS NOT NULL AND (mode IS DISTINCT FROM 'extractif' OR degraded_reason <> $4))
            OR (cardinality(cited_videos) = 0 AND route IS DISTINCT FROM 'clarifier' AND route IS DISTINCT FROM 'lister'))
     ORDER BY asked_at DESC
     LIMIT $3`,
    [options.days ?? 30, options.failures ?? false, options.limit ?? 200, LEXICAL_WITHOUT_ENCODER],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    askedAt: r.asked_at,
    origin: r.origin,
    question: r.question,
    resolved: r.resolved,
    collection: r.collection,
    route: r.route,
    refused: r.refused,
    citedVideos: r.cited_videos,
    considered: r.considered,
    degradedReason: r.degraded_reason,
    error: r.error,
    totalMs: r.total_ms,
  }));
}
