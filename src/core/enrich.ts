import type { Pool } from 'pg';
import { getConfig } from '../config.js';
import { refreshIndexVersion } from '../db/meta.js';
import type { LlmClient } from '../providers/llm.js';
import { AccountRefusedError } from '../providers/retry.js';
import { buildEnrichPrompt, ENRICH_SYSTEM_PROMPT, enrichmentText, enrichSchema, parseEnrichment } from '../prompts/enrich.js';
import { formatTimestamp } from '../windows/format.js';
import { textHash } from './hashes.js';
import { mapConcurrent } from './concurrent.js';
import { evidenceBudgetChars } from './passages.js';

export interface EnrichOptions {
  /** Vidéos traitées au plus (reprise par simple relance). */
  maxVideos?: number;
  /** Vidéos enrichies simultanément. */
  parallel?: number;
  onProgress?: (line: string) => void;
}

export interface EnrichResult {
  videos: number;
  chunks: number;
  failedGroups: number;
  pendingChunks: number;
  /** Refus du compte (crédit épuisé, clé refusée) qui a arrêté l'enrichissement ; `null` sinon. */
  refused: AccountRefusedError | null;
}

const LOCK = "hashtext('ragator:enrich')";
/** Blocs au plus par appel, et tokens de sortie par bloc (phrase + mots-clés). */
const MAX_BLOCKS_PER_CALL = 40;
/** Tokens de sortie par bloc sans LLM configuré (tests) : ceux de luna ; sinon `llm.enrichTokensPerBlock`. */
const TOKENS_PER_BLOCK = 80;
const RESPONSE_OVERHEAD_TOKENS = 200;

/** Texte d'un bloc sans sa première ligne (le titre de la vidéo, donné une fois en tête). */
function body(text: string): string {
  return text.split('\n').slice(1).join('\n').trim() || text;
}

/**
 * Enrichit les blocs de 30 s sans enrichissement : un appel par vidéo,
 * découpée en groupes qui tiennent dans le contexte. Chaque bloc enrichi perd
 * son vecteur (à recalculer par `npm run embed`) ; un bloc dont le texte a
 * changé entre-temps n'est pas écrit. Un groupe en échec est compté et repris
 * à la relance suivante. Un refus du compte (crédit épuisé, clé refusée) arrête
 * tout au premier groupe : les suivants échoueraient de même, chacun pour rien.
 */
export async function enrichPending(pool: Pool, llm: LlmClient, options: EnrichOptions = {}): Promise<EnrichResult> {
  const lockClient = await pool.connect();
  try {
    const { rows: lock } = await lockClient.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${LOCK}) AS locked`);
    if (!lock[0]?.locked) throw new Error('un autre enrichissement est déjà en cours');

    const { rows: videos } = await pool.query<{ video_id: string; title: string; published_at: string | null; channel: string | null }>(
      `SELECT v.video_id, v.title, v.published_at::text AS published_at, v.channel
       FROM videos v
       WHERE EXISTS (SELECT 1 FROM chunks c WHERE c.video_id = v.video_id AND c.enrichment IS NULL)
       ORDER BY v.video_id
       LIMIT $1`,
      [options.maxVideos ?? 100_000],
    );
    const tokensPerBlock = getConfig().llm?.enrichTokensPerBlock ?? TOKENS_PER_BLOCK;
    const budget = evidenceBudgetChars(MAX_BLOCKS_PER_CALL * tokensPerBlock);
    const result: EnrichResult = { videos: 0, chunks: 0, failedGroups: 0, pendingChunks: 0, refused: null };

    // Plusieurs vidéos à la fois (API distante).
    await mapConcurrent(videos, Math.max(1, options.parallel ?? 8), async (video) => {
      if (result.refused) return;
      const { rows: chunks } = await pool.query<{ id: string; start_s: number; text: string }>(
        `SELECT id, start_s, text FROM chunks WHERE video_id = $1 AND enrichment IS NULL ORDER BY start_s`,
        [video.video_id],
      );
      // Groupes : au plus 40 blocs et le budget du contexte.
      const groups: Array<typeof chunks> = [];
      let current: typeof chunks = [];
      let used = 0;
      for (const chunk of chunks) {
        const size = body(chunk.text).length + 40;
        if (current.length > 0 && (current.length >= MAX_BLOCKS_PER_CALL || used + size > budget)) {
          groups.push(current);
          current = [];
          used = 0;
        }
        current.push(chunk);
        used += size;
      }
      if (current.length > 0) groups.push(current);

      for (const group of groups) {
        if (result.refused) return;
        const blocks = group.map((chunk, i) => ({ id: `b${i + 1}`, at: formatTimestamp(chunk.start_s), text: body(chunk.text), chunk }));
        try {
          const raw = await llm.chat(ENRICH_SYSTEM_PROMPT, buildEnrichPrompt({ title: video.title, publishedAt: video.published_at, channel: video.channel }, blocks), {
            // Marge fixe : un groupe d'un ou deux blocs (fin d'une longue vidéo) tronquait sinon le JSON.
            maxTokens: RESPONSE_OVERHEAD_TOKENS + blocks.length * tokensPerBlock,
            jsonSchema: enrichSchema(blocks.map((b) => b.id)),
          });
          const enriched = parseEnrichment(raw);
          // Réponse illisible ou vide : un échec compté, repris à la prochaine mise à jour.
          if (enriched.size === 0) throw new Error('enrichissement illisible');
          for (const block of blocks) {
            const e = enriched.get(block.id);
            if (!e) continue;
            const enrichment = enrichmentText(e);
            const written = await pool.query(
              `UPDATE chunks SET enrichment = $2, enrichment_model = $3, text_hash = $4, embedding = NULL
               WHERE id = $1 AND text = $5 AND enrichment IS NULL`,
              [block.chunk.id, enrichment, llm.model, textHash(`${block.chunk.text}\n${enrichment}`), block.chunk.text],
            );
            result.chunks += written.rowCount ?? 0;
          }
        } catch (err) {
          // Refus du compte : noté une fois, les appels déjà partis en parallèle échouent sans bruit.
          if (err instanceof AccountRefusedError) {
            if (!result.refused) options.onProgress?.(`enrichissement arrêté : ${err.message}`);
            result.refused ??= err;
            return;
          }
          result.failedGroups += 1;
          options.onProgress?.(`échec ${video.video_id} : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      result.videos += 1;
      options.onProgress?.(`${result.videos}/${videos.length} vidéos, ${result.chunks} blocs enrichis`);
    });
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM chunks WHERE enrichment IS NULL`);
    result.pendingChunks = Number(rows[0]?.n ?? 0);
    // L'enrichissement change le classement (liste BM25) et efface des vecteurs : la version de l'index suit.
    if (result.chunks > 0) await refreshIndexVersion(pool);
    return result;
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => {});
    lockClient.release();
  }
}
