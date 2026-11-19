import { getConfig, OPENROUTER_BASE_URL } from '../config.js';
import { openAiUrl } from './embedding.js';
import { accountRefusal, fetchRetrying } from './retry.js';
import { configuredFetch, type ModelFetch } from './configured-fetch.js';
import type { Pool } from 'pg';

export interface ChatOptions {
  /** Tokens de réponse au plus. */
  maxTokens?: number;
  /** Sortie JSON contrainte par un schéma (structured output). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Température ; absente : celle du modèle. 0 pour une décision stable (aiguillage). */
  temperature?: number;
}

/** Tokens consommés depuis la création du client (champ `usage` des réponses). */
export interface LlmUsage {
  calls: number;
  input: number;
  /** Entrée relue depuis le cache du fournisseur. */
  cachedInput: number;
  output: number;
  /** Coût facturé en dollars (champ `usage.cost` d'OpenRouter). */
  cost: number;
}

export interface LlmClient {
  readonly model: string;
  chat(system: string, user: string, options?: ChatOptions): Promise<string>;
  available(): Promise<boolean>;
  /** Consommation cumulée, quand le fournisseur la rapporte. */
  readonly usage?: LlmUsage;
}

const TIMEOUT_MS = 90_000;
/**
 * Nouvelles tentatives sur 429 et 5xx, courtes : une réponse attend derrière,
 * et au-delà de ~4 s le repli extractif sert mieux que l'attente.
 */
const RETRY_DELAYS_MS = [1_000, 3_000];
/** Durée pendant laquelle un modèle trouvé disponible n'est pas revérifié (un aller-retour de moins par réponse). */
const AVAILABLE_TTL_MS = 5 * 60_000;

/**
 * Corps de requête `chat/completions` (OpenRouter, format OpenAI). Raisonnement
 * coupé : sur gpt-6-luna, `none` donne la même qualité que `default`, deux fois
 * plus vite. Cache de prompt explicite (transmis tel quel à OpenAI) : les
 * passages changent à chaque question, et le mode implicite écrirait tout le
 * prompt en cache (facturé 1,25 ×) sans le relire.
 */
export function chatBody(model: string, system: string, user: string, options: ChatOptions, reasoningEffort: 'none' | 'minimal' = 'none'): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: options.maxTokens ?? 800,
    reasoning_effort: reasoningEffort,
    prompt_cache_options: { mode: 'explicit' },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: options.jsonSchema.name, strict: true, schema: options.jsonSchema.schema },
    };
  }
  return body;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cost?: number;
  };
}

/** Client de discussion (OpenRouter, ou toute API compatible OpenAI). */
export function createLlmClient(
  model: string,
  apiKey: string,
  baseUrl = OPENROUTER_BASE_URL,
  options: { retryDelaysMs?: number[]; timeoutMs?: number; request?: ModelFetch } = {},
): LlmClient {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const usage: LlmUsage = { calls: 0, input: 0, cachedInput: 0, output: 0, cost: 0 };
  let availableUntil = 0;
  // Raisonnement coupé ; un modèle qui l'impose (MiniMax M3.1 : « Reasoning is mandatory ») passe en
  // `minimal`, mesuré sans aucun token de raisonnement, et le client s'en souvient.
  let reasoningEffort: 'none' | 'minimal' = 'none';
  const post = (system: string, user: string, chatOptions: ChatOptions) =>
    fetchRetrying(
      openAiUrl(baseUrl, 'chat/completions'),
      () => ({
        method: 'POST',
        headers,
        body: JSON.stringify(chatBody(model, system, user, chatOptions, reasoningEffort)),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      }),
      options.retryDelaysMs ?? RETRY_DELAYS_MS,
      options.request,
    );
  return {
    model,
    usage,
    async chat(system, user, chatOptions = {}) {
      let response = await post(system, user, chatOptions);
      if (response.status === 400 && reasoningEffort === 'none') {
        const detail = await response.clone().text().catch(() => '');
        if (/reasoning is mandatory/i.test(detail)) {
          reasoningEffort = 'minimal';
          response = await post(system, user, chatOptions);
        }
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw accountRefusal(response.status, baseUrl, detail) ?? new Error(`LLM HTTP ${response.status} : ${detail.slice(0, 200)}`);
      }
      const json = (await response.json()) as ChatResponse;
      usage.calls += 1;
      usage.input += json.usage?.prompt_tokens ?? 0;
      usage.cachedInput += json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      usage.output += json.usage?.completion_tokens ?? 0;
      usage.cost += json.usage?.cost ?? 0;
      const message = json.choices?.[0]?.message;
      // Refus de sécurité : hors schéma, signalé à part (guide « Structured outputs »).
      if (message?.refusal) throw new Error(`LLM : refus du modèle (${message.refusal.slice(0, 120)})`);
      if (typeof message?.content !== 'string') throw new Error('LLM : réponse sans contenu texte');
      return message.content.trim();
    },
    async available() {
      if (Date.now() < availableUntil) return true;
      try {
        const probe = await (options.request ?? fetch)(openAiUrl(baseUrl, 'models'), { headers, signal: AbortSignal.timeout(5000) });
        if (!probe.ok) return false;
        const json = (await probe.json()) as { data?: Array<{ id: string }> };
        const found = json.data?.some((m) => m.id === model) ?? false;
        if (found) availableUntil = Date.now() + AVAILABLE_TTL_MS;
        return found;
      } catch {
        return false;
      }
    },
  };
}

type CachedLlm = { key: string; pool: Pool | undefined; client: LlmClient };
let shared: CachedLlm | null = null;

/**
 * Client configuré (`config.llm`), ou `null` sans clé OpenRouter (réponses extractives). Une seule
 * instance par configuration : sa vérification de disponibilité et ses compteurs de tokens servent à
 * toutes les réponses du processus. llama-server accepte le même corps de requête (raisonnement coupé
 * compris) et ignore la clé.
 */
export function llmFromConfig(pool?: Pool): LlmClient | null {
  const config = getConfig();
  const { llm } = config;
  if (!llm) return null;
  const key = JSON.stringify([config.mode, llm]);
  if (shared?.key !== key || shared.pool !== pool) {
    const request = configuredFetch('llm', config, pool);
    shared = { key, pool, client: createLlmClient(llm.model, llm.apiKey, llm.baseUrl, { timeoutMs: llm.timeoutMs, request }) };
  }
  return shared.client;
}

let sharedEnrich: CachedLlm | null = null;

/**
 * Client de l'enrichissement des blocs (`config.llm.enrichModel`), ou `null` sans clé. Le même que
 * `llmFromConfig` quand les deux modèles sont identiques.
 */
export function enrichLlmFromConfig(pool?: Pool): LlmClient | null {
  const config = getConfig();
  const { llm } = config;
  if (!llm) return null;
  if (llm.enrichModel === llm.model) return llmFromConfig(pool);
  const key = JSON.stringify([config.mode, llm]);
  if (sharedEnrich?.key !== key || sharedEnrich.pool !== pool) {
    const request = configuredFetch('llm', config, pool);
    sharedEnrich = { key, pool, client: createLlmClient(llm.enrichModel, llm.apiKey, llm.baseUrl, { timeoutMs: llm.timeoutMs, request }) };
  }
  return sharedEnrich.client;
}
