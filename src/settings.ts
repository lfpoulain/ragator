import { DEFAULT_LLM_MODEL, getConfig, getStoredSettings, OPENROUTER_BASE_URL, setStoredSettings, type StoredSettings } from './config.js';
import { getMeta, setMeta } from './db/meta.js';
import type { Db } from './db/pool.js';

/**
 * Réglages modifiables depuis l'interface (onglet Réglages) : clé OpenRouter, modèle des réponses,
 * mot de passe. Enregistrés dans la base (`corpus_meta`, clé `settings`) : rien à passer en variable
 * d'environnement, et la ligne de commande lit les mêmes.
 */
const META_KEY = 'settings';

function clean(raw: unknown): StoredSettings {
  if (!raw || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const out: StoredSettings = {};
  for (const key of ['openrouterKey', 'llmModel', 'password'] as const) {
    const v = value[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  return out;
}

/** Charge les réglages enregistrés et les applique à la configuration du processus. */
export async function applyStoredSettings(db: Db): Promise<StoredSettings> {
  // Base pas encore migrée : aucun réglage enregistré.
  const settings = clean(await getMeta(db, META_KEY).catch(() => null));
  setStoredSettings(settings);
  return settings;
}

/** Modifie les réglages : une chaîne vide efface la valeur, une valeur absente la garde. */
export async function saveSettings(db: Db, patch: Partial<Record<keyof StoredSettings, string>>): Promise<StoredSettings> {
  const next: Record<string, string> = { ...getStoredSettings() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value.trim()) next[key] = value.trim();
    else delete next[key];
  }
  const settings = clean(next);
  await setMeta(db, META_KEY, settings);
  setStoredSettings(settings);
  return settings;
}

/** Fin de clé seulement : la clé elle-même ne quitte jamais le serveur. */
const hint = (key: string) => `…${key.slice(-4)}`;

/** Ce que la page affiche des réglages : jamais la clé ni le mot de passe. */
export function publicSettings() {
  const stored = getStoredSettings();
  const config = getConfig();
  const key = config.llm?.apiKey ?? null;
  return {
    openrouterKey: key ? { set: true, hint: hint(key), source: stored.openrouterKey ? 'interface' : 'environnement' } : { set: false },
    llmModel: config.llm?.model ?? stored.llmModel ?? DEFAULT_LLM_MODEL,
    defaultLlmModel: DEFAULT_LLM_MODEL,
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
