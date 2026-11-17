import { EMBEDDING_COLUMN_DIMS, getConfig, OPENROUTER_BASE_URL } from '../config.js';
import { accountRefusal, fetchRetrying } from './retry.js';

export interface EmbeddingClient {
  readonly model: string;
  /** Encode des textes ; `purpose` distingue questions et documents (encodés de la même façon ici). */
  embed(texts: string[], purpose: 'query' | 'document'): Promise<number[][]>;
}

const TIMEOUT_MS = 30_000;
/**
 * Nouvelles tentatives sur 429 (« Model busy ») et erreurs 5xx : un seul
 * fournisseur sert un modèle d'embedding sur OpenRouter, et il sature par moments
 * (Qwen3-Embedding-4B, refusé en continu le 29 septembre 2026).
 */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];

/** Accepte une URL de base avec ou sans `/v1` (API compatible OpenAI). */
export function openAiUrl(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/${path}`;
}

export function createEmbeddingClient(
  model: string,
  apiKey: string,
  options: {
    baseUrl?: string;
    timeoutMs?: number;
    dims?: number;
    retryDelaysMs?: number[];
  } = {},
): EmbeddingClient {
  const url = openAiUrl(options.baseUrl ?? OPENROUTER_BASE_URL, 'embeddings');
  const dims = options.dims ?? EMBEDDING_COLUMN_DIMS;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  return {
    model,
    async embed(texts) {
      const response = await fetchRetrying(
        url,
        () => ({
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          // `dimensions` : modèles à sortie réglable (OpenAI, Gemini) ramenés à la colonne ; sans effet sinon.
          body: JSON.stringify({ model, input: texts, dimensions: dims, encoding_format: 'float' }),
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        }),
        delays,
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw accountRefusal(response.status, url, detail) ?? new Error(`embeddings HTTP ${response.status} : ${detail.slice(0, 200)}`);
      }
      const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
      if (vectors.length !== texts.length) {
        throw new Error(`embeddings : ${vectors.length} vecteurs reçus pour ${texts.length} textes`);
      }
      for (const vector of vectors) {
        if (vector.length !== dims || !vector.every(Number.isFinite)) {
          throw new Error(`embeddings : « ${model} » renvoie ${vector.length} dimensions (attendu ${dims})`);
        }
      }
      return vectors;
    },
  };
}

/** Client configuré (`config.embedding`), ou `null` sans clé OpenRouter (recherche lexicale seule). */
export function embeddingFromConfig(): EmbeddingClient | null {
  const { embedding } = getConfig();
  return embedding ? createEmbeddingClient(embedding.model, embedding.apiKey, { baseUrl: embedding.baseUrl, timeoutMs: embedding.timeoutMs }) : null;
}

/** Littéral pgvector (`[x,y,…]`) à caster en `halfvec`. */
export function vectorLiteral(vector: number[]): string {
  return `[${vector.map((x) => x.toFixed(6)).join(',')}]`;
}
