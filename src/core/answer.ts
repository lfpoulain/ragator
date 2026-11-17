import type { Pool } from 'pg';
import { classify, type Route, type RoutedQuery } from './classify.js';
import { MAX_HISTORY_TURNS, resolveFollowUp, type Turn } from './followup.js';
import { chercher, type SearchResult } from './search.js';
import { rankByVideo } from './video-rank.js';
import { analyzeQuestion, type QuestionAnalysis } from './analyze.js';
import { buildPassages, CorpusChangedError, evidenceBudgetChars } from './passages.js';
import { chercherPlan } from './search-plans.js';
import { chercherInfosVideo } from './video-info.js';
import { expandQuery, type ExpansionResult } from './expansion.js';
import { validateClaims, type AnswerMode, type Claim } from './citations.js';
import { answerCredits, creditQuestion } from './credits.js';
import { answerExhaustive } from './exhaustive.js';
import { answerByVideo } from './general.js';
import { scanChronologically, type FirstTimeResult } from './first-time.js';
import { corpusLine } from './collections.js';
import { readSeries } from './series.js';
import { judgeFromConfig, type RelevanceJudge } from '../providers/judge.js';
import { entrySource, extractiveAnswer, groupSources, sourceOf, type AnswerSource } from './sources.js';
import { llmFromConfig, type LlmClient } from '../providers/llm.js';
import { embeddingFromConfig, type EmbeddingClient } from '../providers/embedding.js';
import { buildUserPrompt, PROMPT_VERSION, REFUSAL, SYSTEM_PROMPT, SYSTEM_PROMPT_PROOF, answerSchema, type IdOf, type PromptItem, type PromptWindow } from '../prompts/answer.js';
import type { Kind, Scope } from './page.js';
import { getConfig } from '../config.js';

export type { AnswerMode, AnswerSource, Claim };

/**
 * Comment les preuves ont été trouvées, affiché sous la réponse : `vecteurs`, recherche classée (mots et
 * vecteurs) ; `mots`, recherche classée par mots seuls (plans, descriptions, ou vecteurs indisponibles) ;
 * `corpus`, lecture exhaustive du corpus (décompte exact, première / dernière mention) ; `chronologique`,
 * lecture du corpus puis juge moment par moment (« la première / dernière fois qu'ils… ») ; `série`, les
 * vidéos d'une série nommée par la question (« les vidéos de la régie ») lues en entier.
 */
export type Retrieval = 'vecteurs' | 'mots' | 'corpus' | 'chronologique' | 'série';

export interface AnswerResult {
  question: string;
  /** Question effectivement traitée, après résolution d'une relance. */
  resolvedQuestion: string;
  route: Route;
  mode: AnswerMode;
  /** Analyse de la question par LLM, quand elle a eu lieu : mots-clés gardés, repli ou écarts. */
  analysis: {
    source: 'llm' | 'règles';
    keywords: string[];
    note: string | null;
    /** Marques ou modèles imposés, et objet d'une « première / dernière fois » (parcours chronologique). */
    required: string[];
    subject: string | null;
    /** Série nommée par la question et ses vidéos (filtre de la recherche). */
    series: { terms: string[]; videoIds: string[] } | null;
  } | null;
  answer: string;
  refused: boolean;
  /**
   * Affirmations validées, chacune appuyée sur au moins une source fournie ;
   * `relevance` : probabilité de pertinence de la vidéo selon JEV (questions générales).
   */
  claims: Claim[];
  citedSourceIds: string[];
  invalidCitations: string[];
  sources: AnswerSource[];
  /** Vidéos dont des passages ont été transmis au LLM (ou listés), dans l'ordre de pertinence. */
  consideredVideoIds: string[];
  /** Comment les preuves ont été trouvées ; `null` sans recherche (demande de précision). */
  retrieval: Retrieval | null;
  /** Décompte exact de la route `lister`, rendu par le code. */
  exhaustive: { term: string; scope: Scope; totalVideos: number; totalEntries: number; listedVideos: number } | null;
  expansion: ExpansionResult | null;
  degraded: boolean;
  degradedReason: string | null;
  model: string | null;
  promptVersion: string;
  corpusVersion: string;
  indexVersion: string;
  timings: { searchMs: number; llmMs: number; totalMs: number };
}

export interface AnswerInput {
  question: string;
  /** `extractif` : aucune génération, les preuves sont rendues telles quelles. */
  mode?: AnswerMode;
  /** Fenêtres candidates demandées à la recherche (défaut 50, 100 pour une question générale) ; le budget décide des passages transmis. */
  maxEvidence?: number;
  /** Expansion de requête autorisée (défaut vrai, toujours faux en extractif). */
  expand?: boolean;
  /** Échanges précédents du même fil (voir `turnOf`), 5 au plus : références seulement, jamais preuves. */
  history?: Turn[];
  /** Collection (créateur de contenu) à laquelle se limiter ; absente : toutes. */
  collection?: string;
}

export interface AnswerOptions {
  /** Fournisseur de discussion ; `null` force le repli extractif. Défaut : configuration. */
  llm?: LlmClient | null;
  /** Encodeur des questions pour `chercher` ; `null` force le lexical. Défaut : configuration. */
  embedder?: EmbeddingClient | null;
  /** LLM de l'analyse de la question ; défaut : celui de la réponse, jamais en mode extractif. `null` force les règles. */
  analyzer?: LlmClient | null;
  /** Juge de pertinence des questions générales ; défaut : JEV si `OPENROUTER_API_KEY`. */
  judge?: RelevanceJudge | null;
  /** Seuil de probabilité du juge ; défaut : `JUDGE_THRESHOLD`. */
  judgeThreshold?: number;
  /** Progression, pour un affichage au fil de l'eau (interface web) ; la réponse finale reste celle rendue. */
  onProgress?: (progress: AnswerProgress) => void;
}

/**
 * Étapes d'une réponse en cours. `lignes` : affirmations d'un lot de rédaction déjà validées (questions
 * générales), dans l'ordre où les lots finissent ; la réponse finale les reprend dans l'ordre définitif.
 */
export type AnswerProgress =
  | { étape: 'analyse' }
  | { étape: 'recherche' }
  | { étape: 'jugement'; vidéos: number }
  | { étape: 'rédaction'; lots: number }
  | { étape: 'réponse' }
  | { étape: 'lignes'; answer: string; sources: AnswerSource[] };

/**
 * Fenêtres candidates demandées à la recherche ; le budget du modèle décide
 * des passages transmis, le LLM trie. Question précise : 50, un contexte
 * ciblé. Question générale : 100, pour ne perdre aucune vidéo (92 % des vidéos
 * attendues sont dans les 100 premières fenêtres, 82 % dans les 50).
 */
const FOCUSED_CANDIDATES = 50;
/** Budget de preuves d'une question précise (≈ contexte de 12 288 tokens) : 84-86 % de citations précises dès ce budget. */
const FOCUSED_BUDGET_CHARS = 25_000;
const GENERAL_CANDIDATES = 100;
/**
 * Questions générales : 1 000 fenêtres de la recherche profonde (~1 s), puis
 * vidéos classées par score cumulé (`rankByVideo`). Avec JEV : 2 fenêtres par
 * vidéo (le juge a besoin de contexte), toutes les vidéos candidates, jugées par
 * vagues (`JUDGE_WAVES`). En extractif : 1 fenêtre par vidéo, le budget tranche.
 */
const BY_VIDEO_DEPTH = 1000;
/** Essais de recherche quand le corpus change pendant la réponse (ingestion concurrente). */
const MAX_SEARCH_ATTEMPTS = 3;
const BY_VIDEO = {
  extractive: { perVideo: 1, maxVideos: 150 },
  judged: { perVideo: 2, maxVideos: Number.POSITIVE_INFINITY },
} as const;

/** Tokens réservés à la réponse : une question générale liste une affirmation par vidéo. */
function outputTokens(mode: AnswerMode, general: boolean): number {
  if (general) return 2000;
  const tokens = mode === 'court' ? 400 : 1000;
  // Petit modèle (`llm.proof`) : chaque affirmation porte aussi sa preuve recopiée (mesuré : sortie la plus
  // longue au ras des 400 tokens du mode court).
  return getConfig().llm?.proof ? Math.round(tokens * 1.5) : tokens;
}

interface Gathered {
  items: PromptItem[];
  windows: PromptWindow[];
  /** Sources citables, les plus pertinentes d'abord. */
  sources: Map<string, AnswerSource>;
  corpusVersion: string;
  indexVersion: string;
  degradedReason: string | null;
  note: string | null;
  expansion: ExpansionResult | null;
  retrieval: Retrieval;
}

// ---------------------------------------------------------------------------
// Collecte des preuves, une fonction par route
// ---------------------------------------------------------------------------

async function gatherSearch(
  pool: Pool,
  question: string,
  routed: RoutedQuery,
  input: { maxEvidence: number | undefined; expand: boolean; mode: AnswerMode; wide: boolean },
  llm: LlmClient | null,
  embedder: EmbeddingClient | null | undefined,
  kind?: Kind,
  analysis: QuestionAnalysis | null = null,
): Promise<Gathered> {
  // Mots-clés et HyDE de l'analyse : questions générales seulement (une question précise est déjà à 98 %
  // au top 5 : des passages voisins font répondre le modèle au lieu de refuser).
  const broaden = routed.general && analysis !== null;
  const keywords = broaden ? analysis.keywords : [];
  const expansion =
    keywords.length === 0 && input.mode !== 'extractif' && input.expand && kind === undefined
      ? await expandQuery(pool, question, llm)
      : null;
  const wide = routed.general && input.wide && input.maxEvidence === undefined;
  const searchInput: Parameters<typeof chercher>[1] = {
    // Série nommée par la question : la recherche porte sur le reste de la question, dans ses vidéos.
    query: (routed.videoIds && analysis?.series?.query) || question,
    limit: input.maxEvidence ?? (routed.general ? GENERAL_CANDIDATES : FOCUSED_CANDIDATES),
  };
  if (routed.videoId) searchInput.videoId = routed.videoId;
  if (routed.videoIds) searchInput.videoIds = routed.videoIds;
  if (routed.collection) searchInput.collection = routed.collection;
  if (kind) searchInput.kind = kind;
  // Tous les mots-clés en UNE liste lexicale (poids 40) : ils élargissent sans noyer la question.
  if (keywords.length > 0) searchInput.variants = [keywords.join(' ')];
  else if (expansion?.triggered) searchInput.variants = expansion.variants;
  if (broaden && analysis.hypothetical) searchInput.hypothetical = analysis.hypothetical;
  // Enrichissement des blocs : questions générales seulement (voir SearchOptions.enrichment).
  // Le texte entier des fenêtres ne sert pas ici : les passages transmis sont relus ligne à ligne.
  const searchOptions = { ...(embedder === undefined ? {} : { embedder }), enrichment: routed.general, windowText: false };
  const byVideo = routed.general && input.maxEvidence === undefined;
  // Question précise : au-delà de ~25 000 caractères, aucun gain mesuré, seulement de la latence.
  // Question générale jugée : aucun budget global, chaque lot de vidéos est un appel séparé.
  const budget = evidenceBudgetChars(outputTokens(input.mode, routed.general));
  const passageBudget = wide ? Number.POSITIVE_INFINITY : routed.general ? budget : Math.min(budget, FOCUSED_BUDGET_CHARS);
  let page: Awaited<ReturnType<typeof chercher>>;
  let results: SearchResult[];
  let passages: Awaited<ReturnType<typeof buildPassages>>;
  let changedNote: string | null = null;
  // Recherche et passages doivent venir du même état du corpus : une ingestion entre les deux relance la
  // recherche ; au troisième essai, les passages sont gardés tels quels et la réponse le signale.
  for (let attempt = 1; ; attempt++) {
    if (byVideo) {
      // Recherche par vidéo : une passe profonde, puis les meilleures fenêtres des meilleures vidéos.
      page = await chercher(pool, { ...searchInput, limit: BY_VIDEO_DEPTH }, { ...searchOptions, deep: true });
      results = rankByVideo(page.data.results, wide ? BY_VIDEO.judged : BY_VIDEO.extractive);
    } else {
      page = await chercher(pool, searchInput, searchOptions);
      results = page.data.results;
    }
    try {
      passages = await buildPassages(
        pool,
        results,
        passageBudget,
        attempt < MAX_SEARCH_ATTEMPTS ? page.corpusVersion : undefined,
        wide ? 'complet' : 'mixte',
        kind === 'visuel',
      );
      if (attempt === MAX_SEARCH_ATTEMPTS) changedNote = 'corpus modifié pendant la réponse (mise à jour en cours)';
      break;
    } catch (err) {
      if (!(err instanceof CorpusChangedError)) throw err;
    }
  }
  const evidenceIds = new Set(results.flatMap((r) => [r.bestEntry.sourceId, ...r.evidence.map((e) => e.sourceId)]));
  const sources = new Map<string, AnswerSource>();
  // Preuves d'abord (par pertinence), puis toute autre ligne transmise, citable elle aussi.
  for (const pass of [true, false]) {
    for (const passage of passages) {
      for (const entry of passage.entries) {
        if (evidenceIds.has(entry.sourceId) === pass && !sources.has(entry.sourceId)) {
          sources.set(entry.sourceId, entrySource(entry, passage));
        }
      }
    }
  }
  return {
    items: [],
    windows: passages.map((p) => ({ videoId: p.videoId, title: p.title, publishedAt: p.publishedAt, startS: p.startS, endS: p.endS, entries: p.entries })),
    sources,
    corpusVersion: page.corpusVersion,
    indexVersion: page.indexVersion,
    degradedReason: [page.data.degraded ? page.data.degradedReason : null, changedNote].filter(Boolean).join(' ; ') || null,
    note: null,
    expansion,
    retrieval: page.data.candidates.semantic > 0 ? 'vecteurs' : 'mots',
  };
}

/** Preuves d'une « première / dernière fois » trouvée par le parcours chronologique : la vidéo retenue seule. */
function gatheredFromScan(scan: FirstTimeResult): Gathered {
  const sources = new Map<string, AnswerSource>();
  // La vidéo retenue, et les vidéos plus anciennes (ou récentes) signalées en « éventuellement ».
  const passages = [...scan.passages, ...scan.earlier.flatMap((e) => e.passages)];
  for (const passage of passages) {
    for (const entry of passage.entries) if (!sources.has(entry.sourceId)) sources.set(entry.sourceId, entrySource(entry, passage));
  }
  return {
    items: [],
    windows: passages.map((p) => ({ videoId: p.videoId, title: p.title, publishedAt: p.publishedAt, startS: p.startS, endS: p.endS, entries: p.entries })),
    sources,
    corpusVersion: scan.corpusVersion,
    indexVersion: scan.indexVersion,
    degradedReason: null,
    note: null,
    expansion: null,
    retrieval: 'chronologique',
  };
}

/**
 * Série nommée par la question (« quand voit-on une femme dans les vidéos de la régie ? ») : ses vidéos
 * lues en entier, dans la portée de la question (plans seuls pour « on voit », « apparaît »), si elles
 * tiennent dans le contexte du modèle. La réponse peut être n'importe où dans la série, et rien ne la
 * signale à la recherche classée : « femme » ne ramenait pas le plan « … avec une collaboratrice et
 * l'un d'eux » (une vidéo de démonstration), ni par les mots ni par les vecteurs. `null` si le tout dépasse le budget :
 * la recherche classée, limitée à la série, prend le relais.
 */
async function gatherSeries(pool: Pool, routed: RoutedQuery, mode: AnswerMode): Promise<Gathered | null> {
  if (!routed.videoIds) return null;
  const kind: Kind | undefined = routed.scope === 'visuel' || routed.scope === 'ecran' ? 'visuel' : routed.scope === 'paroles' ? 'parole' : undefined;
  // Tout le contexte du modèle, sans le plafond des questions précises : ici, rien n'est classé.
  const read = await readSeries(pool, routed.videoIds, kind, evidenceBudgetChars(outputTokens(mode, false)), routed.collection ?? null);
  if (!read) return null;
  const sources = new Map<string, AnswerSource>();
  for (const passage of read.passages) {
    for (const entry of passage.entries) if (!sources.has(entry.sourceId)) sources.set(entry.sourceId, entrySource(entry, passage));
  }
  return {
    items: [],
    windows: read.passages.map((p) => ({ videoId: p.videoId, title: p.title, publishedAt: p.publishedAt, startS: p.startS, endS: p.endS, entries: p.entries })),
    sources,
    corpusVersion: read.corpusVersion,
    indexVersion: read.indexVersion,
    degradedReason: null,
    note:
      kind === 'visuel'
        ? 'Ces vidéos sont lues en entier, plans seuls ; ce sont des descriptions automatiques de plans : elles ne valent pas vérification de l’image.'
        : 'Ces vidéos sont lues en entier.',
    expansion: null,
    retrieval: 'série',
  };
}

/** Identifiants courts présentés au modèle, et leur correspondance vers les vraies sources. */
interface Aliases {
  idOf: IdOf;
  /** `s12` → identifiant réel de la source. */
  sourceOf: Map<string, string>;
  ids: string[];
}

/** Numérote `s1`, `s2`… les sources dans l'ordre où le modèle les lit (passages, puis extraits isolés). */
function aliasSources(gathered: Pick<Gathered, 'windows' | 'items'>): Aliases {
  const aliasOf = new Map<string, string>();
  const sourceOf = new Map<string, string>();
  const add = (sourceId: string) => {
    if (aliasOf.has(sourceId)) return;
    const alias = `s${aliasOf.size + 1}`;
    aliasOf.set(sourceId, alias);
    sourceOf.set(alias, sourceId);
  };
  for (const window of gathered.windows) for (const entry of window.entries) add(entry.sourceId);
  for (const item of gathered.items) add(item.sourceId);
  return { idOf: (sourceId) => aliasOf.get(sourceId) ?? sourceId, sourceOf, ids: [...sourceOf.keys()] };
}

async function gatherPlans(
  pool: Pool,
  question: string,
  routed: RoutedQuery,
  input: { maxEvidence: number | undefined; expand: boolean; mode: AnswerMode; wide: boolean },
  llm: LlmClient | null,
  embedder: EmbeddingClient | null | undefined,
): Promise<Gathered> {
  const planInput: Parameters<typeof chercherPlan>[1] = { query: routed.term ?? question, limit: input.maxEvidence ?? 12 };
  if (routed.collection) planInput.collection = routed.collection;
  if (routed.videoId) planInput.videoId = routed.videoId;
  if (routed.videoIds) planInput.videoIds = routed.videoIds;
  const page = await chercherPlan(pool, planInput);
  if (page.data.results.length === 0) {
    // Aucun plan ne contient le mot : recherche hybride restreinte aux plans.
    return gatherSearch(pool, question, routed, input, llm, embedder, 'visuel');
  }
  const items: PromptItem[] = [];
  const sources = new Map<string, AnswerSource>();
  for (const plan of page.data.results) {
    const screen = plan.screenText.length > 0 ? ` | ÉCRAN : ${plan.screenText.map((t) => `« ${t} »`).join(' | ')}` : '';
    const text = `${plan.planTitle} — ${plan.description}${screen}`;
    const base = { sourceId: plan.sourceId, videoId: plan.videoId, title: plan.title, publishedAt: plan.publishedAt, kind: 'visuel' as const };
    items.push({ ...base, startS: plan.startS, endS: plan.endS, text, uncertainties: plan.uncertainties });
    sources.set(plan.sourceId, sourceOf(base, plan.startS, plan.endS, text));
  }
  return {
    items,
    windows: [],
    sources,
    corpusVersion: page.corpusVersion,
    indexVersion: page.indexVersion,
    degradedReason: null,
    note: 'Ces extraits sont des descriptions automatiques de plans : elles ne valent pas vérification de l’image.',
    expansion: null,
    retrieval: 'mots',
  };
}

async function gatherInfos(pool: Pool, question: string, routed: RoutedQuery): Promise<Gathered> {
  const infosInput: Parameters<typeof chercherInfosVideo>[1] = { query: question, limit: 8 };
  if (routed.collection) infosInput.collection = routed.collection;
  if (routed.videoId) infosInput.videoId = routed.videoId;
  if (routed.videoIds) infosInput.videoIds = routed.videoIds;
  const page = await chercherInfosVideo(pool, infosInput);
  const items: PromptItem[] = [];
  const sources = new Map<string, AnswerSource>();
  for (const info of page.data.results) {
    const text = info.urls.length > 0 && !info.urls.every((u) => info.text.includes(u)) ? `${info.text} — liens : ${info.urls.join(', ')}` : info.text;
    const base = { sourceId: info.sourceId, videoId: info.videoId, title: info.title, publishedAt: info.publishedAt, kind: info.kind };
    items.push({ ...base, startS: null, endS: null, text, uncertainties: [] });
    sources.set(info.sourceId, sourceOf(base, null, null, info.text, info.urls));
  }
  return {
    items,
    windows: [],
    sources,
    corpusVersion: page.corpusVersion,
    indexVersion: page.indexVersion,
    degradedReason: null,
    note: 'Ces sources sont des titres et descriptions YouTube, pas des paroles : elles n’ont pas d’instant.',
    expansion: null,
    retrieval: 'mots',
  };
}

/**
 * Réponse précise commencée sans attendre l'analyse de la question : recherche, passages, puis rédaction.
 * `raw` est l'appel de rédaction en cours, `null` s'il n'a pas lieu (aucune preuve, LLM indisponible).
 */
interface Speculation {
  gathered: Gathered;
  searchMs: number;
  llmStartedAt: number;
  raw: Promise<string> | null;
}

/**
 * Lance la réponse d'une question précise pendant que le LLM analyse la question. Pour une telle question,
 * la recherche ne dépend pas de l'analyse (mots-clés et extrait hypothétique ne servent qu'aux questions
 * générales) : les deux appels au LLM, l'un après l'autre, faisaient l'essentiel de l'attente (mesuré :
 * 2,0 s d'analyse puis 1,9 s de rédaction sur 4,4 s). Même recherche et même prompt que le chemin
 * habituel ; `repondre` ne garde le résultat que si l'analyse confirme une question précise.
 */
async function speculatePrecise(
  pool: Pool,
  question: string,
  routed: RoutedQuery,
  settings: { maxEvidence: number | undefined; expand: boolean; mode: AnswerMode; wide: boolean },
  llm: LlmClient,
  embedder: EmbeddingClient | null | undefined,
  corpus: string | null,
  startedAt: number,
): Promise<Speculation> {
  const gathered = await gatherSearch(pool, question, routed, settings, llm, embedder);
  const searchMs = Date.now() - startedAt;
  const llmStartedAt = Date.now();
  const mode = settings.mode;
  if (mode === 'extractif' || gathered.sources.size === 0 || !(await llm.available())) return { gathered, searchMs, llmStartedAt, raw: null };
  const proof = getConfig().llm?.proof ?? false;
  const aliases = aliasSources(gathered);
  const raw = llm.chat(
    proof ? SYSTEM_PROMPT_PROOF : SYSTEM_PROMPT,
    buildUserPrompt({ mode, question, items: gathered.items, windows: gathered.windows, note: gathered.note, corpus }, aliases.idOf),
    { maxTokens: outputTokens(mode, false), jsonSchema: answerSchema(aliases.ids, proof) },
  );
  // Si l'analyse écarte ce résultat, personne n'attend cet appel : son échec ne doit rien faire tomber.
  raw.catch(() => {});
  return { gathered, searchMs, llmStartedAt, raw };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Réponse citée : routage déterministe → outil de consultation →
 * expansion conditionnelle → génération → validation des citations. Sans
 * preuve : refus explicite, sans appel au LLM. Sans LLM ou sans citation
 * vérifiable : repli extractif signalé.
 */
export async function repondre(pool: Pool, input: AnswerInput, options: AnswerOptions = {}): Promise<AnswerResult> {
  const startedAt = Date.now();
  const mode = input.mode ?? 'détaillé';
  const llm = mode === 'extractif' ? null : options.llm !== undefined ? options.llm : llmFromConfig();
  const judge = options.judge !== undefined ? options.judge : judgeFromConfig();
  const settings = {
    mode,
    maxEvidence: input.maxEvidence === undefined ? undefined : Math.max(1, Math.min(input.maxEvidence, 100)),
    expand: mode !== 'extractif' && (input.expand ?? true),
    // Questions générales jugées par JEV : bien plus de candidats que le contexte d'un seul appel.
    wide: llm !== null && judge !== null,
  };
  const followUp = await resolveFollowUp(pool, input.question, (input.history ?? []).slice(-MAX_HISTORY_TURNS), input.collection ?? null);
  const question = followUp.question;
  // Analyse par LLM (aiguillage, mots-clés, HyDE) ; jamais en mode extractif sauf demande explicite.
  const analyzer = options.analyzer !== undefined ? options.analyzer : llm;
  const progress = options.onProgress ?? (() => {});
  if (!followUp.clarify && analyzer) progress({ étape: 'analyse' });
  // De quelle(s) chaîne(s) viennent les vidéos : première ligne des prompts (analyse, réponse, rédaction).
  const corpus = await corpusLine(pool, input.collection);
  // Question que les règles voient précise : la réponse part tout de suite, en même temps que l'analyse.
  const rules = classify(question);
  const speculative =
    !followUp.clarify && analyzer && llm && (getConfig().llm?.speculate ?? false) &&
    rules.route === 'chercher' && !rules.general && !rules.order && creditQuestion(question) === null;
  const speculation = speculative
    ? speculatePrecise(
        pool,
        question,
        { ...rules, ...(followUp.videoId ? { videoId: followUp.videoId } : {}), ...(input.collection ? { collection: input.collection } : {}) },
        settings,
        llm,
        options.embedder,
        corpus,
        startedAt,
      )
    : null;
  speculation?.catch(() => {});
  const analysis = followUp.clarify || !analyzer ? null : await analyzeQuestion(pool, question, analyzer, corpus);
  const routed: RoutedQuery = followUp.clarify
    ? { ...classify(question), route: 'clarifier', reason: 'référence ambiguë' }
    : (analysis?.routed ?? classify(question));
  if (followUp.videoId) routed.videoId = followUp.videoId;
  if (input.collection) routed.collection = input.collection;
  if (analysis?.series) routed.videoIds = analysis.series.videoIds;
  const base = {
    question: input.question,
    resolvedQuestion: question,
    route: routed.route,
    mode,
    promptVersion: PROMPT_VERSION,
    analysis: analysis
      ? {
          source: analysis.source,
          keywords: analysis.keywords,
          note: analysis.note,
          required: analysis.required.map((r) => r.term),
          subject: analysis.subject?.term ?? null,
          series: analysis.series ? { terms: analysis.series.terms, videoIds: analysis.series.videoIds } : null,
        }
      : null,
  };

  // Qui a monté, cadré, mixé… : crédits des descriptions, lus par le code (ni paroles ni plans ne le disent).
  // Avant « clarifier » : les règles n'y voient aucun terme à compter.
  const credit = followUp.clarify ? null : creditQuestion(question);
  if (credit) {
    return answerCredits(pool, question, credit, { videoId: routed.videoId ?? null, videoIds: routed.videoIds ?? null, collection: routed.collection ?? null }, base, startedAt);
  }
  if (routed.route === 'clarifier') {
    return {
      ...base,
      retrieval: null,
      answer:
        followUp.clarify ??
        'Précisez un terme : « toutes les vidéos où on parle de X », « dans quelle vidéo on voit Y », ou posez une question factuelle.',
      refused: true,
      claims: [],
      citedSourceIds: [],
      invalidCitations: [],
      sources: [],
      consideredVideoIds: [],
      exhaustive: null,
      expansion: null,
      degraded: false,
      degradedReason: null,
      model: null,
      corpusVersion: '',
      indexVersion: '',
      timings: { searchMs: 0, llmMs: 0, totalMs: Date.now() - startedAt },
    };
  }
  if (routed.route === 'lister' && routed.term !== null) {
    return answerExhaustive(pool, { ...routed, term: routed.term }, base, startedAt);
  }

  progress({ étape: 'recherche' });
  const threshold = options.judgeThreshold ?? getConfig().judge?.threshold ?? 0.3;
  // « La première / dernière fois qu'ils… » : parcours chronologique (first-time.ts) ; s'il ne conclut pas,
  // ou si le juge échoue, le chemin général des questions générales prend le relais.
  // Sans sujet, la première exigence en tient lieu (« la première fois qu'ils utilisent la xTool P2 »).
  const subject = analysis?.subject ?? analysis?.required[0] ?? null;
  const scan =
    routed.route === 'chercher' && routed.general && routed.order && subject && llm && judge && settings.wide
      ? await scanChronologically(
          pool,
          question,
          routed.order,
          subject,
          analysis?.required ?? [],
          judge,
          threshold,
          routed.collection ?? null,
          // Candidates par le sens : même encodeur que la recherche.
          { embedder: options.embedder === undefined ? embeddingFromConfig() : options.embedder, hypothetical: analysis?.hypothetical ?? null },
          (vidéos) => progress({ étape: 'jugement', vidéos }),
        ).catch(() => null)
      : null;
  // Série lue en entier : une seule lecture, rédigée comme une question précise (pas de juge par vidéo).
  const series = !scan && routed.route === 'chercher' && !routed.order ? await gatherSeries(pool, routed, mode) : null;
  if (series) routed.general = false;
  // L'analyse confirme une question précise, sans série ni ordre : la réponse déjà lancée est la bonne.
  const started =
    speculation && !series && !scan && routed.route === 'chercher' && !routed.general && !routed.order && !routed.videoIds
      ? await speculation
      : null;
  const gathered = started
    ? started.gathered
    : series
    ? series
    : scan
    ? gatheredFromScan(scan)
    : routed.route === 'infos'
      ? await gatherInfos(pool, question, routed)
      : routed.route === 'plan'
        ? await gatherPlans(pool, question, routed, settings, llm, options.embedder)
        : await gatherSearch(pool, question, routed, settings, llm, options.embedder, undefined, analysis);
  const searchMs = started ? started.searchMs : Date.now() - startedAt;
  const all = [...gathered.sources.values()];

  const result = (fields: Partial<AnswerResult> & Pick<AnswerResult, 'answer' | 'refused' | 'sources'>): AnswerResult => ({
    ...base,
    claims: [],
    citedSourceIds: [],
    invalidCitations: [],
    consideredVideoIds: [...new Set([...gathered.sources.values()].map((s) => s.videoId))],
    exhaustive: null,
    retrieval: gathered.retrieval,
    expansion: gathered.expansion,
    degraded: gathered.degradedReason !== null,
    degradedReason: gathered.degradedReason,
    model: null,
    corpusVersion: gathered.corpusVersion,
    indexVersion: gathered.indexVersion,
    timings: { searchMs, llmMs: 0, totalMs: Date.now() - startedAt },
    ...fields,
  });
  const extractive = (reason: string | null, extra: Partial<AnswerResult> = {}): AnswerResult => {
    const shown = groupSources(all).slice(0, 6);
    return result({
      answer: extractiveAnswer(shown, gathered.note),
      refused: false,
      sources: shown,
      citedSourceIds: shown.flatMap((s) => s.sourceIds),
      ...(reason === null ? {} : { degraded: true, degradedReason: reason }),
      ...extra,
    });
  };

  if (all.length === 0) {
    return result({ answer: REFUSAL, refused: true, sources: [] });
  }
  if (mode === 'extractif') return extractive(null);
  if (!llm) return extractive('LLM non configuré : réponse extractive');
  if (!(await llm.available())) return extractive('LLM indisponible : réponse extractive');

  const llmStartedAt = started ? started.llmStartedAt : Date.now();
  // Petit modèle : chaque affirmation précédée de sa preuve recopiée (voir SYSTEM_PROMPT_PROOF).
  const proof = getConfig().llm?.proof ?? false;
  const aliases = aliasSources(gathered);
  let raw: string;
  let issue: string | null = null;
  try {
    if (routed.general && gathered.windows.length > 0) {
      if (!judge) return extractive('question générale sans juge JEV (clé OpenRouter absente) : réponse extractive');
      // Vidéo déjà retenue par le parcours chronologique : le juge ne la rejuge pas.
      const decided: RelevanceJudge | null = scan ? { model: judge.model, judge: async (_q, videos) => videos.map(() => scan.relevance) } : null;
      ({ raw, issue } = await answerByVideo(
        llm,
        decided ?? judge,
        threshold,
        question,
        gathered.windows,
        aliases.idOf,
        {
          order: routed.order,
          required: analysis?.required ?? [],
          decided: scan !== null,
          corpus,
          unproven: new Map(
            (scan?.earlier ?? []).map((e) => [
              e.videoId,
              `« ${analysis?.required.map((r) => r.term).join(' » ou « ')} » n’y est jamais sur le même plan que « ${subject?.term} »`,
            ]),
          ),
        },
        {
          onJudge: (vidéos) => progress({ étape: 'jugement', vidéos }),
          onWrite: (lots) => progress({ étape: 'rédaction', lots }),
          // Chaque lot rédigé, validé comme la réponse finale, part aussitôt vers l'affichage.
          onBatch: (claims) => {
            const partial = validateClaims(JSON.stringify({ refus: false, claims }), gathered.sources, mode, aliases.sourceOf);
            if (partial.claims.length === 0) return;
            const cited = [...new Set(partial.claims.flatMap((c) => c.sourceIds))];
            progress({ étape: 'lignes', answer: partial.answer, sources: groupSources(cited.map((id) => gathered.sources.get(id)!)) });
          },
        },
      ));
    } else {
      progress({ étape: 'réponse' });
      raw = await (started?.raw ??
        llm.chat(
        proof ? SYSTEM_PROMPT_PROOF : SYSTEM_PROMPT,
        buildUserPrompt({ mode, question, items: gathered.items, windows: gathered.windows, note: gathered.note, corpus }, aliases.idOf),
        { maxTokens: outputTokens(mode, routed.general), jsonSchema: answerSchema(aliases.ids, proof) },
      ));
    }
  } catch (err) {
    return extractive(`erreur LLM : ${err instanceof Error ? err.message : String(err)}`, { model: llm.model });
  }
  const timings = { searchMs, llmMs: Date.now() - llmStartedAt, totalMs: Date.now() - startedAt };

  const validated = validateClaims(raw, gathered.sources, mode, aliases.sourceOf, routed.general && routed.order !== null);
  const degradedReason = [gathered.degradedReason, issue].filter(Boolean).join(' ; ') || null;
  const common = {
    invalidCitations: validated.invalid,
    model: llm.model,
    timings,
    ...(issue === null ? {} : { degraded: true, degradedReason }),
  };
  if (validated.claims.length === 0) {
    if (validated.refused) return result({ answer: REFUSAL, refused: true, sources: [], ...common });
    if (validated.offSchema) return extractive('réponse hors du format imposé : repli extractif', common);
    return extractive('réponse sans citation vérifiable : repli extractif', common);
  }
  const cited = [...new Set(validated.claims.flatMap((c) => c.sourceIds))];
  return result({
    // Question générale triée par date : dire que la première ligne répond à « la première / dernière fois ».
    answer:
      routed.general && routed.order
        ? validated.claims.some((c) => c.missing === undefined)
          ? `${routed.order === 'premiere' ? 'De la plus ancienne à la plus récente' : 'De la plus récente à la plus ancienne'} (la première ligne répond à la question) :\n${validated.answer}`
          : `Aucune vidéo retenue ne le prouve explicitement.\n${validated.answer}`
        : validated.answer,
    refused: false,
    claims: validated.claims,
    citedSourceIds: cited,
    sources: groupSources(cited.map((id) => gathered.sources.get(id)!)),
    ...common,
  });
}

/** Échange à conserver dans l'historique d'un fil pour résoudre la relance suivante. */
export function turnOf(result: AnswerResult): Turn {
  return { question: result.resolvedQuestion, videoIds: [...new Set(result.sources.map((s) => s.videoId))] };
}
