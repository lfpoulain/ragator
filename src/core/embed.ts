import type { Pool } from 'pg';
import { EMBEDDING_COLUMN_DIMS, getConfig } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { getMetaString, refreshIndexVersion, setMeta } from '../db/meta.js';
import { finishJobs, setJobsProgress, startJobs } from '../db/jobs.js';
import { ensureVectorIndex, prewarmVectorIndexes } from '../db/vector-index.js';
import { mapConcurrent } from './concurrent.js';
import { textHash } from './hashes.js';
import { videoTexts } from './video-text.js';
import { embeddingFromConfig, vectorLiteral, type EmbeddingClient } from '../providers/embedding.js';

export interface EmbedOptions {
  batchSize?: number;
  /** Lots encodés simultanément (défaut 4). */
  parallel?: number;
  maxBatches?: number;
  embedder?: EmbeddingClient;
  onProgress?: (done: number, total: number) => void;
}

export interface EmbedResult {
  model: string;
  embedded: number;
  pending: number;
  complete: boolean;
  vectorIndexCreated: boolean;
  indexVersion: string;
}

const LOCK = "hashtext('ragator:embed')";

/** Tables encodées, dans l'ordre : les entrées, puis les blocs de 30 s ; les vidéos ensuite (`embedVideos`). */
const TARGETS = [
  { table: 'entries', text: 'search_text', order: 'video_id, source_id' },
  // Un bloc enrichi (`npm run enrich`) est encodé avec sa phrase de contexte et ses mots-clés.
  { table: 'chunks', text: "text || coalesce(E'\\n' || enrichment, '')", order: 'video_id, start_s' },
] as const;

async function counts(pool: Pool): Promise<{ pending: number; total: number }> {
  const { rows } = await pool.query<{ pending: string; total: string }>(
    `SELECT sum(pending) AS pending, sum(total) AS total FROM (
       SELECT count(*) FILTER (WHERE embedding IS NULL) AS pending, count(*) AS total FROM entries
       UNION ALL
       SELECT count(*) FILTER (WHERE embedding IS NULL), count(*) FROM chunks
       UNION ALL
       SELECT count(*) FILTER (WHERE embedding IS NULL), count(*) FROM videos
     ) t`,
  );
  return { pending: Number(rows[0]?.pending ?? 0), total: Number(rows[0]?.total ?? 0) };
}

/**
 * Enregistre le modèle d'embedding avant la première écriture de vecteurs.
 * Un seul espace vectoriel par colonne : un autre modèle est refusé.
 */
async function claimModel(pool: Pool, model: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const published = await getMetaString(client, 'embedding_model');
    if (published !== null && published !== model) {
      throw new Error(
        `modèle d'embedding indexé « ${published} » ≠ configuré « ${model} » : lancer « npm run embed -- --reset » pour réindexer`,
      );
    }
    if (published === null) {
      await setMeta(client, 'embedding_model', model);
      await setMeta(client, 'embedding_dims', EMBEDDING_COLUMN_DIMS);
    }
  });
}

interface VideoToEmbed {
  id: string;
  retrievalHash: string;
  text: string;
  hash: string;
}

/**
 * Vidéos dont le vecteur manque ou ne correspond plus à leur texte (`videoTexts`). Le gabarit des
 * descriptions se mesure sur tout le corpus : chaque passage relit donc toutes les vidéos (quelques
 * centaines de lignes), puis ne garde que celles à encoder.
 */
async function videosToEmbed(pool: Pool): Promise<VideoToEmbed[]> {
  const { rows: videos } = await pool.query<{
    video_id: string;
    title: string;
    description_blocks: Array<{ text: string; chapter?: { label: string } | null }>;
    retrieval_hash: string;
    embedding_hash: string | null;
    embedded: boolean;
  }>(
    `SELECT video_id, title, description_blocks, retrieval_hash, embedding_hash, embedding IS NOT NULL AS embedded
     FROM videos ORDER BY video_id`,
  );
  const { rows: plans } = await pool.query<{ video_id: string; plan_title: string }>(
    `SELECT video_id, plan_title FROM entries
     WHERE kind = 'visuel' AND plan_title IS NOT NULL
     GROUP BY video_id, plan_title
     ORDER BY video_id, min(start_s)`,
  );
  const plansOf = new Map<string, string[]>();
  for (const row of plans) plansOf.set(row.video_id, [...(plansOf.get(row.video_id) ?? []), row.plan_title]);
  const texts = videoTexts(
    videos.map((v) => ({ videoId: v.video_id, title: v.title, descriptionBlocks: v.description_blocks, planTitles: plansOf.get(v.video_id) ?? [] })),
  );
  return videos
    .map((v) => {
      const text = texts.get(v.video_id)!;
      return { id: v.video_id, retrievalHash: v.retrieval_hash, text, hash: textHash(text), embeddedHash: v.embedded ? v.embedding_hash : null };
    })
    .filter((v) => v.embeddedHash !== v.hash)
    .map(({ id, retrievalHash, text, hash }) => ({ id, retrievalHash, text, hash }));
}

/**
 * Encode les entrées sans vecteur. L'état des lignes fait foi :
 * un vecteur n'est écrit que si le texte encodé est toujours celui de l'entrée,
 * et une reprise après interruption repart des lignes restantes. L'appel au
 * modèle se fait hors transaction ; un verrou de session garantit un seul worker.
 */
export async function embedPending(pool: Pool, options: EmbedOptions = {}): Promise<EmbedResult> {
  const embedder = options.embedder ?? embeddingFromConfig();
  if (!embedder) throw new Error('aucun encodeur (mode à choisir dans Réglages) : rien à encoder');
  // Taille et nombre de lots à la fois : ceux du mode (`embedding`, voir config.ts).
  const settings = getConfig().embedding;
  const batchSize = options.batchSize ?? settings?.batchSize ?? 64;
  const parallel = options.parallel ?? settings?.parallel ?? 4;

  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${LOCK}) AS locked`);
    if (!rows[0]?.locked) throw new Error('un autre encodage est déjà en cours');

    await claimModel(pool, embedder.model);
    await startJobs(pool, 'embed');

    let embedded = 0;
    let batches = 0;
    const reportProgress = async () => {
      const { pending, total } = await counts(pool);
      await setJobsProgress(pool, 'embed', total === 0 ? 100 : Math.floor(((total - pending) / total) * 100));
      options.onProgress?.(total - pending, total);
    };
    for (const target of TARGETS) {
      for (;;) {
        if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
        const { rows: batch } = await pool.query<{ id: string; text: string; text_hash: string }>(
          `SELECT id, ${target.text} AS text, text_hash FROM ${target.table}
           WHERE embedding IS NULL
           ORDER BY ${target.order}
           LIMIT $1`,
          [batchSize * parallel],
        );
        if (batch.length === 0) break;

        const slices: string[][] = [];
        for (let i = 0; i < batch.length; i += batchSize) slices.push(batch.slice(i, i + batchSize).map((r) => r.text));
        const vectors = (await mapConcurrent(slices, parallel, (texts) => embedder.embed(texts, 'document'))).flat();
        const written = await withTransaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('ragator:publish'))");
          if ((await getMetaString(client, 'embedding_model')) !== embedder.model) {
            throw new Error('le modèle indexé a changé pendant l’encodage');
          }
          const result = await client.query(
            `UPDATE ${target.table} t SET embedding = x.embedding::halfvec
             FROM unnest($1::bigint[], $2::text[], $3::text[]) AS x(id, text_hash, embedding)
             WHERE t.id = x.id AND t.text_hash = x.text_hash AND t.embedding IS NULL`,
            [batch.map((r) => r.id), batch.map((r) => r.text_hash), vectors.map(vectorLiteral)],
          );
          // Les vecteurs et leur version deviennent visibles dans le même commit,
          // même si un lot suivant échoue ou si le processus est interrompu.
          await refreshIndexVersion(client);
          return result.rowCount ?? 0;
        });
        embedded += written;
        batches += 1;

        await reportProgress();
      }
    }

    // Puis un vecteur par vidéo : un texte court chacune, encodé comme un document.
    const videos = options.maxBatches !== undefined && batches >= options.maxBatches ? [] : await videosToEmbed(pool);
    for (let start = 0; start < videos.length; start += batchSize * parallel) {
      if (options.maxBatches !== undefined && batches >= options.maxBatches) break;
      const batch = videos.slice(start, start + batchSize * parallel);
      const slices: string[][] = [];
      for (let i = 0; i < batch.length; i += batchSize) slices.push(batch.slice(i, i + batchSize).map((v) => v.text));
      const vectors = (await mapConcurrent(slices, parallel, (texts) => embedder.embed(texts, 'document'))).flat();
      embedded += await withTransaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('ragator:publish'))");
        if ((await getMetaString(client, 'embedding_model')) !== embedder.model) {
          throw new Error('le modèle indexé a changé pendant l’encodage');
        }
        // Une vidéo réingérée entre-temps (empreinte changée) garde son état : le prochain passage la reprend.
        const result = await client.query(
          `UPDATE videos v SET embedding = x.embedding::halfvec, embedding_hash = x.text_hash
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS x(video_id, retrieval_hash, text_hash, embedding)
           WHERE v.video_id = x.video_id AND v.retrieval_hash = x.retrieval_hash`,
          [batch.map((v) => v.id), batch.map((v) => v.retrievalHash), batch.map((v) => v.hash), vectors.map(vectorLiteral)],
        );
        await refreshIndexVersion(client);
        return result.rowCount ?? 0;
      });
      batches += 1;
      await reportProgress();
    }

    const { pending } = await counts(pool);
    const complete = pending === 0;
    let vectorIndexCreated = false;
    if (complete) {
      await finishJobs(pool, 'embed');
      vectorIndexCreated = await ensureVectorIndex(pool);
      // Un index tout juste construit est sur le disque : le charger évite des premières recherches lentes.
      if (vectorIndexCreated) await prewarmVectorIndexes(pool);
    }
    // Chaque écriture a déjà publié sa version sous le verrou de publication.
    // Relire évite d'écraser une version plus récente publiée par une ingestion.
    const indexVersion = (await getMetaString(pool, 'index_version')) ?? 'lexical';
    return { model: embedder.model, embedded, pending, complete, vectorIndexCreated, indexVersion };
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock(${LOCK})`).catch(() => {});
    lockClient.release();
  }
}

/**
 * Efface tous les vecteurs et l'identité du modèle, pour réindexer avec un
 * autre modèle. Le lexical reste disponible pendant l'encodage.
 */
export async function resetEmbeddings(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(${LOCK}) AS locked`);
    if (!rows[0]?.locked) throw new Error('un encodage est en cours : réinitialisation refusée');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ragator:publish'))");
    await client.query('DROP INDEX IF EXISTS entries_embedding_idx');
    await client.query('DROP INDEX IF EXISTS chunks_embedding_idx');
    await client.query('DROP INDEX IF EXISTS videos_embedding_idx');
    await client.query('UPDATE entries SET embedding = NULL WHERE embedding IS NOT NULL');
    await client.query('UPDATE chunks SET embedding = NULL WHERE embedding IS NOT NULL');
    await client.query('UPDATE videos SET embedding = NULL, embedding_hash = NULL WHERE embedding IS NOT NULL');
    await client.query(`DELETE FROM corpus_meta WHERE key IN ('embedding_model', 'embedding_dims')`);
    await refreshIndexVersion(client);
  });
}
