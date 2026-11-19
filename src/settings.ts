import { lookup } from 'node:dns/promises';
import type { Pool } from 'pg';
import { DEFAULT_LLM_MODEL, getConfig, getStoredSettings, LOCAL_DEFAULTS, MODES, OPENROUTER_BASE_URL, setStoredSettings, type Mode, type StoredSettings } from './config.js';
import { setMeta } from './db/meta.js';
import { withTransaction, type Db } from './db/pool.js';

/**
 * Réglages modifiables depuis l'interface (onglet Réglages) : mode (local ou OpenRouter), clé
 * OpenRouter, modèle des réponses, adresses des serveurs locaux, jeton Hugging Face du juge local,
 * mot de passe. Enregistrés dans la base (`corpus_meta`, clé `settings`) : rien à passer en variable
 * d'environnement, et la ligne de commande lit les mêmes.
 */
const META_KEY = 'settings';
const TEXT_KEYS = ['openrouterKey', 'llmModel', 'password', 'localLlmUrl', 'localEmbeddingUrl', 'localJudgeUrl', 'hfToken'] as const;
export type SettingKey = (typeof TEXT_KEYS)[number] | 'mode';

function clean(raw: unknown): StoredSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Réglages enregistrés illisibles.');
  const value = raw as Record<string, unknown>;
  const out: StoredSettings = {};
  for (const key of TEXT_KEYS) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Réglage enregistré invalide : ${key}.`);
    out[key] = v.trim();
  }
  if (value.mode !== undefined) {
    if (!MODES.includes(value.mode as Mode)) throw new Error('Mode enregistré invalide.');
    out.mode = value.mode as Mode;
  }
  return out;
}

export async function readStoredSettings(db: Db): Promise<StoredSettings> {
  const { rows } = await db.query<{ value: unknown }>('SELECT value FROM corpus_meta WHERE key = $1', [META_KEY]);
  return rows.length ? clean(rows[0]!.value) : {};
}

/** Charge les réglages enregistrés et les applique à la configuration du processus. */
export async function applyStoredSettings(db: Db): Promise<StoredSettings> {
  const settings = await readStoredSettings(db);
  setStoredSettings(settings);
  return settings;
}

/** Modifie les réglages : une chaîne vide efface la valeur, une valeur absente la garde. */
export async function saveSettings(pool: Pool, patch: Partial<Record<SettingKey, string>>): Promise<StoredSettings> {
  const settings = await withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ragator:model-settings'))");
    const next: Record<string, string> = { ...(await readStoredSettings(client)) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value.trim()) next[key] = value.trim();
      else delete next[key];
    }
    const result = clean(next);
    await setMeta(client, META_KEY, result);
    return result;
  });
  setStoredSettings(settings);
  return settings;
}

/** Fin de clé seulement : la clé elle-même ne quitte jamais le serveur. */
const hint = (key: string) => `…${key.slice(-4)}`;

function secret(stored: string | undefined, env: string | undefined) {
  const value = stored || env;
  return value ? { set: true, hint: hint(value), source: stored ? 'interface' : 'environnement' } : { set: false };
}

/** Ce que la page affiche des réglages : jamais la clé, le jeton ni le mot de passe. */
export function publicSettings(env: NodeJS.ProcessEnv = process.env) {
  const stored = getStoredSettings();
  const config = getConfig();
  return {
    mode: config.mode,
    openrouterKey: secret(stored.openrouterKey, env.OPENROUTER_API_KEY),
    llmModel: stored.llmModel || env.OPENROUTER_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL,
    defaultLlmModel: DEFAULT_LLM_MODEL,
    local: {
      llmUrl: stored.localLlmUrl || env.LOCAL_LLM_URL || LOCAL_DEFAULTS.llm,
      embeddingUrl: stored.localEmbeddingUrl || env.LOCAL_EMBEDDING_URL || LOCAL_DEFAULTS.embedding,
      judgeUrl: stored.localJudgeUrl || env.LOCAL_JUDGE_URL || LOCAL_DEFAULTS.judge,
      defaults: LOCAL_DEFAULTS,
      hfToken: secret(stored.hfToken, undefined),
    },
    password: { set: config.web.password !== null, source: stored.password ? 'interface' : config.web.password ? 'environnement' : null },
  };
}

/**
 * Vérifie une clé auprès d'OpenRouter (`GET /key`) avant de l'enregistrer : `null` si elle est
 * acceptée, sinon la raison du refus.
 */
export async function checkOpenRouterKey(key: string): Promise<string | null> {
  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return 'clé refusée par OpenRouter';
    if (!response.ok) return `OpenRouter injoignable (HTTP ${response.status})`;
    return null;
  } catch (err) {
    return `OpenRouter injoignable : ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface ServerStatus {
  /** `ready` : prêt ; `loading` : téléchargement ou chargement ; `needs_token` : jeton Hugging Face attendu ; `down` : injoignable ; `error`. */
  state: 'ready' | 'loading' | 'needs_token' | 'down' | 'error';
  message: string;
}

function failure(err: unknown): ServerStatus {
  const detail = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
  // Nom de service inconnu : la pile a été lancée sans le profil local.
  if (/ENOTFOUND|EAI_AGAIN/.test(detail)) return { state: 'down', message: 'service absent : lancer avec docker compose --profile local up -d' };
  return { state: 'down', message: /abort|timeout/i.test(detail) ? 'aucune réponse' : detail };
}

/**
 * Nom du serveur résolu d'abord, avec son propre délai : hors de la pile `local`, la résolution des
 * noms de service (`llm`, `juge`…) échoue, mais seulement après plusieurs secondes.
 */
async function missingHost(url: string): Promise<ServerStatus | null> {
  try {
    await lookup(new URL(url).hostname);
    return null;
  } catch (err) {
    return failure(err);
  }
}

/** llama-server : `/health` à la racine (503 pendant le téléchargement et le chargement du modèle). */
async function llamaStatus(baseUrl: string): Promise<ServerStatus> {
  const missing = await missingHost(baseUrl);
  if (missing) return missing;
  try {
    const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(4000) });
    if (response.ok) return { state: 'ready', message: 'prêt' };
    if (response.status === 503) return { state: 'loading', message: 'téléchargement ou chargement du modèle' };
    return { state: 'error', message: `HTTP ${response.status}` };
  } catch (err) {
    return failure(err);
  }
}

/** Juge local : son état ; s'il attend un jeton et qu'un jeton est enregistré, il lui est transmis. */
async function judgeStatus(baseUrl: string, hfToken: string | undefined): Promise<ServerStatus> {
  const base = baseUrl.replace(/\/+$/, '');
  const missing = await missingHost(base);
  if (missing) return missing;
  try {
    let response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    let body = (await response.json()) as Partial<ServerStatus>;
    if (body.state === 'needs_token' && hfToken) {
      response = await fetch(`${base}/v1/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hf_token: hfToken }),
        signal: AbortSignal.timeout(10_000),
      });
      body = (await response.json()) as Partial<ServerStatus>;
    }
    const state = body.state && ['ready', 'loading', 'needs_token', 'error'].includes(body.state) ? body.state : 'error';
    return { state, message: body.message ?? '' };
  } catch (err) {
    return failure(err);
  }
}

/** État des trois serveurs du mode local (adresses réglées, sinon celles de la pile Docker). */
export async function localStatus(env: NodeJS.ProcessEnv = process.env) {
  const { local } = publicSettings(env);
  const [llm, embedding, judge] = await Promise.all([
    llamaStatus(local.llmUrl),
    llamaStatus(local.embeddingUrl),
    judgeStatus(local.judgeUrl, getStoredSettings().hfToken),
  ]);
  return { llm, embedding, judge };
}
