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
  /** `jev` : JEV par OpenRouter ; `local` : serveur `/v1/systemone` sur la machine (Aplomb 1). */
  kind: 'jev' | 'local';
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
  mode?: Mode;
  openrouterKey?: string;
  llmModel?: string;
  password?: string;
  /** Serveurs du mode local, si ailleurs que dans la pile Docker (autre machine avec la carte graphique). */
  localLlmUrl?: string;
  localEmbeddingUrl?: string;
  localJudgeUrl?: string;
  /** Jeton Hugging Face transmis au juge local : Aplomb est sous licence, téléchargé au premier démarrage. */
  hfToken?: string;
}

/**
 * Deux modes, choisis dans l'onglet Réglages, un seul endroit qui les distingue :
 * - `local` : tout sur la machine, sans clé ni réseau une fois les modèles téléchargés (profil `local`
 *   de compose.yml) : Qwen 3.5 9B et pplx-embed par llama-server, juge Aplomb 1 au format de JEV ;
 * - `openrouter` : tout par l'API d'OpenRouter, avec une clé (gpt-6-luna, JEV, pplx-embed).
 * Même encodeur des deux côtés (pplx-embed-v1-4b, à un cosinus de 0,98-0,99 près) : on passe de l'un
 * à l'autre sans réindexer. Le reste du code lit les réglages ci-dessous et ne teste jamais le mode.
 */
export type Mode = 'local' | 'openrouter';
export const MODES: readonly Mode[] = ['local', 'openrouter'];

/** Adresses des serveurs locaux dans la pile Docker (services `llm`, `embed`, `juge` de compose.yml). */
export const LOCAL_DEFAULTS = {
  llm: 'http://llm:8080/v1',
  embedding: 'http://embed:8080/v1',
  judge: 'http://juge:8000',
} as const;

/** Modèle servi par llama-server en mode local (`--alias` de compose.yml). */
export const LOCAL_LLM_MODEL = 'qwen3.5-9b';

/**
 * Configuration : réglages enregistrés, sinon `.env` (voir `.env.example`). Sans mode choisi (ou
 * mode OpenRouter sans clé), `llm`, `embedding` et `judge` valent `null` : l'outil reste utilisable
 * (recherche lexicale seule, réponses extractives).
 */
export interface Config {
  /** `null` : aucun mode choisi, aucun modèle. */
  mode: Mode | null;
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
    judge: { kind: 'jev', label: 'JEV', baseUrl: 'https://openrouter.ai/api', apiKey, model: 'typesafe/jev-1.13', parallel: 32, threshold: probabilityFromEnv('JUDGE_THRESHOLD', env.JUDGE_THRESHOLD, 0.3) },
  };
}

function positiveIntFromEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} invalide : ${value} (entier positif attendu)`);
  return parsed;
}

/** Mode local : trois serveurs sur la machine (profil `local` de compose.yml), sans clé. */
function localModels(env: NodeJS.ProcessEnv, stored: StoredSettings): Models {
  // Places de llama-server (`-np`) et contexte (`-c`, partagé entre elles), comme dans compose.yml. Au-delà
  // des places, les requêtes attendent dans sa file et expirent (mesuré : 10 lots sur 30 perdus) ; une
  // requête qui dépasse contexte ÷ places est refusée quand les autres places sont pleines (6 sur 10).
  const parallel = positiveIntFromEnv('LOCAL_LLM_PARALLEL', env.LOCAL_LLM_PARALLEL, 8);
  const context = positiveIntFromEnv('LOCAL_LLM_CONTEXT', env.LOCAL_LLM_CONTEXT, 81_920);
  const model = env.LOCAL_LLM_MODEL || LOCAL_LLM_MODEL;
  return {
    llm: {
      baseUrl: stored.localLlmUrl || env.LOCAL_LLM_URL || LOCAL_DEFAULTS.llm,
      apiKey: 'local',
      model,
      enrichModel: model,
      // Carte partagée avec le juge : plus lente qu'une API.
      timeoutMs: 300_000,
      parallel,
      contextTokens: Math.floor(context / parallel),
      proof: true,
      // Les petits modèles écrivent plus long (à 80 tokens, 7 groupes sur 23 étaient tronqués, donc perdus).
      enrichTokensPerBlock: 140,
      // Carte partagée : une rédaction lancée pour rien occuperait une place.
      speculate: false,
    },
    // pplx sur le processeur (~2 textes/s) : des lots à la fois s'y ralentissent tous et expirent
    // (mesuré : 4 lots de 64, tous en échec) ; un petit lot à la fois.
    embedding: {
      baseUrl: stored.localEmbeddingUrl || env.LOCAL_EMBEDDING_URL || LOCAL_DEFAULTS.embedding,
      apiKey: 'local',
      model: EMBEDDING_MODEL,
      timeoutMs: 300_000,
      batchSize: 16,
      parallel: 1,
    },
    // Une décision à la fois : la carte est partagée avec le LLM. Aplomb en 4 bits note environ 0,1 plus
    // haut que JEV : 0,4 chez lui vaut 0,3 chez JEV (mesuré).
    judge: {
      kind: 'local',
      label: 'Aplomb',
      baseUrl: stored.localJudgeUrl || env.LOCAL_JUDGE_URL || LOCAL_DEFAULTS.judge,
      apiKey: 'local',
      model: 'aplomb-1',
      parallel: 1,
      threshold: probabilityFromEnv('JUDGE_THRESHOLD', env.JUDGE_THRESHOLD, 0.4),
    },
  };
}

/** Mode retenu : celui choisi dans Réglages, sinon `RAGATOR_MODE`, sinon OpenRouter si une clé est donnée par `.env`. */
function modeOf(env: NodeJS.ProcessEnv, settings: StoredSettings): Mode | null {
  if (settings.mode) return settings.mode;
  const fromEnv = env.RAGATOR_MODE?.trim();
  if (fromEnv) {
    if (!MODES.includes(fromEnv as Mode)) throw new Error(`RAGATOR_MODE invalide : ${fromEnv} (local ou openrouter)`);
    return fromEnv as Mode;
  }
  return settings.openrouterKey || env.OPENROUTER_API_KEY ? 'openrouter' : null;
}

const NO_MODELS: Models = { llm: null, embedding: null, judge: null };

let stored: StoredSettings = {};
let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: StoredSettings = stored): Config {
  const mode = modeOf(env, settings);
  return {
    mode,
    databaseUrl: env.DATABASE_URL || 'postgres://ragator:ragator@127.0.0.1:15432/ragator',
    corpusDir: env.CORPUS_DIR || './corpus',
    ...(mode === 'local' ? localModels(env, settings) : mode === 'openrouter' ? openRouterModels(env, settings) : NO_MODELS),
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
