import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function loadDotEnv(): void {
  const path = join(PROJECT_ROOT, '.env');
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

/** Dimensions de la colonne `entries.embedding` (migration 0001) : celles de pplx-embed-v1-4b. */
export const EMBEDDING_COLUMN_DIMS = 2560;

/** API d'OpenRouter : embeddings, LLM et juge JEV passent tous par elle, avec une seule clé. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Encodeur : pplx-embed-v1-4b, par l'API d'OpenRouter. Le nom est enregistré avec les vecteurs ; en
 * changer impose une réindexation complète et un modèle de 2 560 dimensions.
 */
export const EMBEDDING_MODEL = 'perplexity/pplx-embed-v1-4b';

/** Un modèle derrière l'API d'OpenRouter (compatible OpenAI). */
export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface LlmSettings extends Endpoint {
  /** Requêtes envoyées à la fois (lots de rédaction des questions générales). */
  parallel: number;
  /** Contexte disponible pour UNE requête, en tokens : les budgets de passages en découlent. */
  contextTokens: number;
  /**
   * Petit modèle : chaque affirmation commence par sa preuve recopiée mot pour mot, et le rédacteur
   * revérifie chaque vidéo retenue par le juge (champ « répond »). Mesuré avec Qwen 3.5 9B : précision
   * des questions générales 46 → 64 %. Avec les modèles par défaut, aucun gain : désactivé.
   */
  proof: boolean;
  /** Tokens de sortie par bloc de 30 s à enrichir (phrase + mots-clés). */
  enrichTokensPerBlock: number;
  /** Modèle de l'enrichissement des blocs (`npm run enrich`, `update`) ; par défaut, `model`. */
  enrichModel: string;
  /**
   * Réponse précise lancée en même temps que l'analyse de la question (`repondre`) : la recherche et la
   * rédaction n'attendent plus l'analyse, et leur résultat est gardé si elle confirme une question précise
   * (mesuré avec luna : 4,4 s → 2,5 s par question précise). Sinon l'appel est perdu (~0,001 $) : réservé
   * à une API rapide.
   */
  speculate: boolean;
}

export interface EmbeddingSettings extends Endpoint {
  /** Textes par appel, et appels à la fois. */
  batchSize: number;
  parallel: number;
}

export interface JudgeSettings {
  /** Nom affiché sous les réponses (« vidéos jugées par … »). */
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Décisions à la fois. */
  parallel: number;
  /** Probabilité minimale d'une vidéo retenue (`JUDGE_THRESHOLD`). */
  threshold: number;
}

/**
 * Réglages enregistrés depuis l'interface (onglet Réglages, table `corpus_meta`). Ils priment sur
 * `.env` et les variables d'environnement, qui restent possibles pour la ligne de commande.
 */
export interface StoredSettings {
  openrouterKey?: string;
  llmModel?: string;
  password?: string;
}

/**
 * Configuration : réglages enregistrés, sinon `.env` (voir `.env.example`). Sans clé OpenRouter,
 * `llm`, `embedding` et `judge` valent `null` : l'outil reste utilisable (recherche lexicale seule,
 * réponses extractives).
 */
export interface Config {
  databaseUrl: string;
  corpusDir: string;
  llm: LlmSettings | null;
  embedding: EmbeddingSettings | null;
  judge: JudgeSettings | null;
  web: {
    /** Noms de domaine acceptés en plus de l'hôte local et des adresses IP (`RAGATOR_HOSTS`). */
    hosts: string[];
    /** Mot de passe de l'interface ; `null` : aucun. */
    password: string | null;
  };
}

function probabilityFromEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} invalide : ${value} (nombre entre 0 et 1 attendu)`);
  return parsed;
}

/** Modèle des réponses par défaut. */
export const DEFAULT_LLM_MODEL = 'openai/gpt-6-luna';

type Models = Pick<Config, 'llm' | 'embedding' | 'judge'>;

/** Une clé OpenRouter pour les trois modèles ; sans clé, aucun. */
function openRouterModels(env: NodeJS.ProcessEnv, stored: StoredSettings): Models {
  const apiKey = stored.openrouterKey || env.OPENROUTER_API_KEY;
  if (!apiKey) return { llm: null, embedding: null, judge: null };
  // L'enrichissement, appelé une fois par bloc, peut passer par un autre modèle (`OPENROUTER_ENRICH_MODEL`).
  const model = stored.llmModel?.trim() || env.OPENROUTER_LLM_MODEL?.trim() || DEFAULT_LLM_MODEL;
  return {
    llm: {
      baseUrl: OPENROUTER_BASE_URL,
      apiKey,
      model,
      enrichModel: env.OPENROUTER_ENRICH_MODEL?.trim() || model,
      timeoutMs: 90_000,
      // Au-delà de 16 lots de rédaction à la fois, aucun gain mesuré.
      parallel: 16,
      // Le modèle en accepte bien plus : valeur qui borne coût et latence.
      contextTokens: 32_768,
      proof: false,
      enrichTokensPerBlock: 80,
      speculate: true,
    },
    // API distante (~1 s par lot) : plusieurs gros lots à la fois.
    embedding: { baseUrl: OPENROUTER_BASE_URL, apiKey, model: EMBEDDING_MODEL, timeoutMs: 30_000, batchSize: 64, parallel: 4 },
    // 32 décisions à la fois : au-delà, aucun gain mesuré.
    judge: { label: 'JEV', baseUrl: 'https://openrouter.ai/api', apiKey, model: 'typesafe/jev-1.13', parallel: 32, threshold: probabilityFromEnv('JUDGE_THRESHOLD', env.JUDGE_THRESHOLD, 0.3) },
  };
}

let stored: StoredSettings = {};
let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: StoredSettings = stored): Config {
  return {
    databaseUrl: env.DATABASE_URL || 'postgres://ragator:ragator@127.0.0.1:15432/ragator',
    corpusDir: env.CORPUS_DIR || './corpus',
    ...openRouterModels(env, settings),
    // Mesure seulement : RAGATOR_SANS_VECTEURS=1 coupe les vecteurs (recherche par mots seuls).
    ...(env.RAGATOR_SANS_VECTEURS === '1' ? { embedding: null } : {}),
    web: {
      hosts: (env.RAGATOR_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
      password: settings.password || env.RAGATOR_PASSWORD || null,
    },
  };
}

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Remplace les réglages enregistrés (lus dans la base) : la configuration est recalculée. */
export function setStoredSettings(settings: StoredSettings): void {
  stored = { ...settings };
  cached = undefined;
}

export function getStoredSettings(): StoredSettings {
  return { ...stored };
}
