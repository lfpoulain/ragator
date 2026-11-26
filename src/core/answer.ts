import type { Pool } from 'pg';
import { classify, type Route, type RoutedQuery } from './classify.js';
import { MAX_HISTORY_TURNS, inventoryBrand, inventoryFollowUp, resolveFollowUp, sceneRefs, type SceneRef, type Turn } from './followup.js';
import { answerFromScenes } from './scene-memory.js';
import { chercher, type SearchResult } from './search.js';
import { rankByVideo } from './video-rank.js';
import { questionOperation } from './operation.js';
import { sharedToolTargets } from './tool-functions.js';
import { mentionsActionTargets } from './requirements.js';
import { timestampedLink } from '../links.js';
import { analyzeQuestion, knownBrands, type QuestionAnalysis } from './analyze.js';
import { buildPassages, CorpusChangedError, evidenceBudgetChars } from './passages.js';
import { chercherPlan } from './search-plans.js';
import { chercherInfosVideo } from './video-info.js';
import { expandQuery, type ExpansionResult } from './expansion.js';
import { extractParsedCitations, renderClaims, validateClaims, type AnswerMode, type Claim } from './citations.js';
import { answerCredits, creditQuestion } from './credits.js';
import { answerExhaustive } from './exhaustive.js';
import { inventoryOfModels, inventoryText, recallInventory, rememberInventory } from './inventory.js';
import { answerByVideo, retrievedClues } from './general.js';
import { ACTION_SYSTEM_PROMPT, SPECULATIVE_SYSTEM_PROMPT, actionNeighborhood, asksAboutAction, assessAction, corroboratedAlternative, uncertainAction } from './action-proof.js';
import { chronologicalRequirements, reviewOccurrence, scanChronologically, type FirstTimeResult } from './first-time.js';
import { corpusLine } from './collections.js';
import { namedProjectVideos } from './projects.js';
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
export type Retrieval = 'vecteurs' | 'mots' | 'corpus' | 'chronologique' | 'série' | 'scènes citées' | 'inventaire';

export interface AnswerResult {
  question: string;
  /** Question effectivement traitée, après résolution d'une relance. */
  resolvedQuestion: string;
  route: Route;
  mode: AnswerMode;
  /** Analyse de la question par LLM, quand elle a eu lieu : mots-clés gardés, repli ou écarts. */
  analysis: {
    source: 'llm' | 'règles';
    action: boolean;
    keywords: string[];
    note: string | null;
    /** Marques ou modèles imposés, et objet d'une « première / dernière fois » (parcours chronologique). */
    required: string[];
    actionTargets: string[][];
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
  /** Scènes auxquelles répond une relance. Une parole voisine peut fournir sa preuve. */
  sceneAnchors?: SceneRef[];
  /** Une relance peut accepter de consulter les autres épisodes du projet. */
  offeredEpisodeSearch?: boolean;
  inventoryId?: string;
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
  | { étape: 'catalogue' | 'lecture'; vidéos: number }
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
  /** Lignes classées par la recherche, en excluant les lignes voisines ajoutées pour le contexte. */
  rankedIds?: ReadonlySet<string>;
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
      ? await expandQuery(pool, question, llm, routed.collection)
      : null;
  const wide = routed.general && input.wide && input.maxEvidence === undefined;
  const toolUse = wide && routed.scope !== 'ecran' && sharedToolTargets(question) ? questionOperation(question) : null;
  const focusToolScene = toolUse ? (window: SearchResult): SearchResult | undefined => {
    // Les descriptions complètes et leurs titres seront relus dans le même état du corpus.
    // Une entrée qui établit déjà le geste dans son propre texte peut guider le cadrage des 90 s.
    const entry = window.evidence.find((e) =>
      e.kind === (routed.scope === 'paroles' ? 'parole' : 'visuel') &&
      e.startS >= window.startS && toolUse.shown(e.text) &&
      mentionsActionTargets(analysis?.actionTargets ?? [], [e.text]));
    if (entry) return { ...window, bestEntry: entry, link: timestampedLink(window.videoId, entry.startS) };
  } : undefined;
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
      results = rankByVideo(page.data.results, wide ? BY_VIDEO.judged : BY_VIDEO.extractive, focusToolScene);
    } else {
      page = await chercher(pool, searchInput, searchOptions);
      results = page.data.results;
      if (kind === 'visuel' && analysis?.observed && routed.scope === 'tout' && !results.length) {
        return gatherSearch(pool, question, routed, input, llm, embedder, undefined, analysis);
      }
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
    rankedIds: evidenceIds,
    corpusVersion: page.corpusVersion,
    indexVersion: page.indexVersion,
    degradedReason: [page.data.degraded ? page.data.degradedReason : null, changedNote].filter(Boolean).join(' ; ') || null,
    note: null,
    expansion,
    retrieval: page.data.candidates.semantic > 0 ? 'vecteurs' : 'mots',
  };
}

/** Preuves du parcours chronologique, suivies des pistes moins certaines. */
function gatheredFromScan(scan: FirstTimeResult): Gathered {
  const sources = new Map<string, AnswerSource>();
  // La vidéo retenue, et les vidéos plus anciennes (ou récentes) signalées en « éventuellement ».
  const passages = [...(scan.confirmed?.passages ?? []), ...scan.earlier.flatMap((e) => e.passages)];
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
    note: scan.confirmed ? null : 'Ces extraits constituent des pistes. Aucun passage examiné ne confirme la relation demandée.',
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

/** Pour un geste matériel, l'incrustation seule ne dit pas ce qui a été appliqué à l'objet.
 * Le rédacteur et la validation lisent la même description, avec son identifiant original. */
function observedEvidence(gathered: Gathered): Gathered {
  const description = (text: string) => text.split(' | ÉCRAN : ')[0]!;
  return { ...gathered,
    windows: gathered.windows.map(w => ({ ...w, entries: w.entries.map(e => e.screenText?.length ? { ...e, screenText: null } : e) })),
    items: gathered.items.map(item => item.kind === 'visuel' ? { ...item, text: description(item.text) } : item),
    sources: new Map([...gathered.sources].map(([id, s]) => [id, s.kind === 'visuel' ? { ...s, excerpt: description(s.excerpt) } : s])),
  };
}

function writeFocused(
  llm: LlmClient,
  mode: 'court' | 'détaillé',
  question: string,
  action: boolean | 'conditional',
  evidence: Pick<Gathered, 'items' | 'windows' | 'note'>,
  aliases: Aliases,
  corpus: string | null,
  observed = false,
) {
  const proof = action || (getConfig().llm?.proof ?? false);
  let system = proof ? SYSTEM_PROMPT_PROOF : SYSTEM_PROMPT;
  if (action === true) system = ACTION_SYSTEM_PROMPT;
  if (action === 'conditional') system = SPECULATIVE_SYSTEM_PROMPT;
  if (observed) system += '\nPrivilégie le plan qui décrit le geste sur l’objet demandé, la personne qui le fait ou la vérification effective de son résultat. Une annonce, une inscription voisine ou un autre objet dans la même vidéo ne démontre pas ce geste.';
  if (/\bcombien\b/iu.test(question)) {
    system += '\nRéponds à la quantité demandée en une affirmation. Choisis en priorité la ligne de bilan qui donne explicitement le total et son unité, en chiffres ou en lettres. Un comptage d’extraits ou un rang dans une succession ne suffit pas à établir ce total. Si aucune ligne ne donne la valeur, signale que le total reste inconnu.';
  }
  return llm.chat(
    system,
    buildUserPrompt({ ...evidence, mode, question, corpus }, aliases.idOf),
    { maxTokens: outputTokens(mode, false), jsonSchema: answerSchema(aliases.ids, proof, action !== false), ...(observed ? { temperature: 0 } : {}) },
  );
}

/** Dans un projet identifié, les plans peuvent montrer en une ligne un geste peu commenté.
 * Si le plan ne l'établit pas, la lecture habituelle reprend avec les paroles et leur contexte. */
async function readDemonstration(llm: LlmClient, mode: 'court' | 'détaillé', question: string,
  evidence: Gathered, aliases: Aliases, corpus: string | null): Promise<string | null> {
  const seen = new Set<string>();
  const windows = evidence.windows.map(w => ({ ...w, entries: w.entries.filter(e => {
    if (e.kind !== 'visuel' || seen.has(e.sourceId)) return false;
    seen.add(e.sourceId);
    return true;
  }) })).filter(w => w.entries.length);
  if (!windows.length || seen.size === evidence.sources.size) return null;
  const visual = { windows, items: [], note: 'Quel plan montre précisément le geste demandé sur le bon objet ? Donne le détail qui répond à la question et recopie sa preuve dans la description du plan. Si seules des préparations ou un autre geste sont visibles, refuse.' };
  const ids = [...seen].map(aliases.idOf);
  const raw = await writeFocused(llm, mode, question, true, visual, { ...aliases, ids }, corpus, true);
  const claims = validateClaims(raw, evidence.sources, mode, aliases.sourceOf);
  return !claims.refused && claims.claims.length && claims.claims.every(c => c.preuve && c.sourceIds.every(id => seen.has(id))) ? raw : null;
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
    rankedIds: new Set(sources.keys()),
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
 * 2,0 s d'analyse puis 1,9 s de rédaction sur 4,4 s). Le prompt accepte une réponse factuelle ou une
 * preuve de geste ; `repondre` ne garde le résultat que si l'analyse confirme une question précise.
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
  const raw = writeFocused(llm, mode, question, 'conditional', gathered, aliasSources(gathered), corpus);
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
export function repondre(pool: Pool, input: AnswerInput, options: AnswerOptions = {}): Promise<AnswerResult> {
  return answerQuestion(pool, input, options);
}

async function answerQuestion(pool: Pool, input: AnswerInput, options: AnswerOptions, otherEpisodes?: string[]): Promise<AnswerResult> {
  const startedAt = Date.now();
  const mode = input.mode ?? 'détaillé';
  const llm = mode === 'extractif' ? null : options.llm !== undefined ? options.llm : llmFromConfig(pool);
  const judge = options.judge !== undefined ? options.judge : judgeFromConfig(pool);
  const settings = {
    mode,
    maxEvidence: input.maxEvidence === undefined ? undefined : Math.max(1, Math.min(input.maxEvidence, 100)),
    expand: mode !== 'extractif' && (input.expand ?? true),
    // Questions générales jugées par JEV : bien plus de candidats que le contexte d'un seul appel.
    wide: llm !== null && judge !== null,
  };
  const history = (input.history ?? []).slice(-MAX_HISTORY_TURNS);
  const progress = options.onProgress ?? (() => {});
  const previous = history.at(-1);
  const inventoryTopic = inventoryFollowUp(input.question, previous);
  if (inventoryTopic && previous?.inventory && llm) {
    const saved = await recallInventory(pool, previous.inventory, previous.question, input.question, inventoryTopic,
      inventoryBrand(input.question), input.collection, mode, llm.model);
    if (saved) return saved;
  }
  const sceneAnswer = inventoryTopic ? null : await answerFromScenes(pool, input.question, mode, history, input.collection ?? null, llm, progress,
    (question, ids) => answerQuestion(pool, { ...input, question, history: [] }, options, ids));
  if (sceneAnswer) return sceneAnswer;
  const followUp = inventoryTopic ? { question: inventoryTopic, videoId: null, clarify: null } : await resolveFollowUp(pool, input.question, history, input.collection ?? null);
  const question = followUp.question;
  // Analyse par LLM (aiguillage, mots-clés, HyDE) ; jamais en mode extractif sauf demande explicite.
  const analyzer = options.analyzer !== undefined ? options.analyzer : llm;
  if (!followUp.clarify && analyzer) progress({ étape: 'analyse' });
  // De quelle(s) chaîne(s) viennent les vidéos : première ligne des prompts (analyse, réponse, rédaction).
  const corpus = await corpusLine(pool, input.collection);
  // Question que les règles voient précise : la réponse part tout de suite, en même temps que l'analyse.
  const rules = classify(question);
  const speculative =
    !otherEpisodes && !followUp.clarify && analyzer && llm && (getConfig().llm?.speculate ?? false) &&
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
  const analysis = followUp.clarify || !analyzer ? null : await analyzeQuestion(pool, question, analyzer, corpus, input.collection);
  const routed: RoutedQuery = followUp.clarify
    ? { ...classify(question), route: 'clarifier', reason: 'référence ambiguë' }
    : (analysis?.routed ?? classify(question));
  if (followUp.videoId) routed.videoId = followUp.videoId;
  if (input.collection) routed.collection = input.collection;
  if (analysis?.series) routed.videoIds = analysis.series.videoIds;
  if (inventoryTopic) Object.assign(routed, { route: 'inventorier', general: true, order: null });
  const comparing = /\bcompar|\bentre (?:les|ces|la|le|l['’])/iu.test(question);
  const projects = analysis?.projects ?? [];
  const projectIds = !otherEpisodes && !routed.videoId && !routed.videoIds && routed.route === 'chercher' && !routed.order &&
    !routed.general && (!comparing || projects.length >= 2)
    ? await namedProjectVideos(pool, projects, input.collection ?? null, analysis?.observed && !comparing ? question : undefined) : null;
  if (projectIds) routed.videoIds = projectIds;
  if (otherEpisodes) Object.assign(routed, { route: 'chercher', general: false, order: null, videoId: null, videoIds: otherEpisodes });
  const base = {
    question: input.question,
    resolvedQuestion: question,
    route: routed.route,
    mode,
    promptVersion: PROMPT_VERSION,
    analysis: analysis
      ? {
          source: analysis.source,
          action: analysis.action,
          keywords: analysis.keywords,
          note: analysis.note,
          required: analysis.required.map((r) => r.term),
          actionTargets: analysis.actionTargets.map((group) => group.map((r) => r.term)),
          subject: analysis.subject?.term ?? null,
          series: analysis.series ? { terms: analysis.series.terms, videoIds: analysis.series.videoIds } : null,
        }
      : null,
  };

  // Qui a monté, cadré, mixé… : crédits des descriptions, lus par le code (ni paroles ni plans ne le disent).
  // Avant « clarifier » : les règles n'y voient aucun terme à compter.
  const credit = followUp.clarify || otherEpisodes ? null : creditQuestion(question);
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
  const requiredForScan = chronologicalRequirements(question, analysis?.required ?? []);
  let reviewMs = 0;
  const scan =
    routed.route === 'chercher' && routed.general && routed.order && subject && llm && judge && settings.wide
      ? await scanChronologically(
          pool,
          question,
          routed.order,
          subject,
          requiredForScan,
          judge,
          threshold,
          routed.collection ?? null,
          // Candidates par le sens : même encodeur que la recherche.
          { embedder: options.embedder === undefined ? embeddingFromConfig(pool) : options.embedder, hypothetical: analysis?.hypothetical ?? null },
          (vidéos) => progress({ étape: 'jugement', vidéos }),
          async (video) => {
            const start = Date.now();
            try {
              return await reviewOccurrence(video, question, requiredForScan, llm, subject);
            } finally {
              reviewMs += Date.now() - start;
            }
          },
        ).catch(() => null)
      : null;
  // Série lue en entier : une seule lecture, rédigée comme une question précise (pas de juge par vidéo).
  const series = !scan && !projectIds && !otherEpisodes && routed.route === 'chercher' && !routed.order ? await gatherSeries(pool, routed, mode) : null;
  if (series) routed.general = false;
  // L'analyse confirme une question précise, sans série ni ordre : la réponse déjà lancée est la bonne.
  const started =
    speculation && !series && !scan && routed.route === 'chercher' && !routed.general && !routed.order && !routed.videoIds
      ? await speculation
      : null;
  const initial = started
    ? started.gathered
    : series
    ? series
    : scan
    ? gatheredFromScan(scan)
    : routed.route === 'infos'
      ? await gatherInfos(pool, question, routed)
      : routed.route === 'plan'
        ? await gatherPlans(pool, question, routed, settings, llm, options.embedder)
        : await gatherSearch(pool, question, routed, settings, llm, options.embedder,
            analysis?.observed && (projectIds || otherEpisodes) ? 'visuel' : undefined, analysis);
  const observed = analysis?.observed === true && !routed.general && !scan && (routed.route === 'chercher' || routed.route === 'plan');
  const gathered = observed ? observedEvidence(initial) : initial;
  const searchMs = started ? started.searchMs : Date.now() - startedAt - reviewMs;
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
    timings: { searchMs, llmMs: reviewMs, totalMs: Date.now() - startedAt },
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

  if (routed.route === 'inventorier') {
    const fields = { retrieval: 'inventaire' as const, refused: true, sources: [] };
    if (!llm || !await llm.available()) return result({ ...fields,
      answer: 'La vérification des modèles nécessite un modèle de discussion disponible en mode court ou détaillé.',
      degraded: mode !== 'extractif', degradedReason: mode === 'extractif' ? null : 'LLM indisponible' });
    const readStart = Date.now();
    try {
      const inventory = await inventoryOfModels(pool, llm, question, routed, gathered.sources, gathered.rankedIds ?? new Set(),
        analysis?.keywords ?? [], gathered.corpusVersion, progress);
      const note = inventory.failed ? 'Certaines lectures ont échoué. La liste peut être incomplète.' : '';
      return rememberInventory(pool, input.collection, result({ ...fields, model: llm.model, refused: !inventory.claims.length, claims: inventory.claims, sources: [...inventory.sources.values()],
        citedSourceIds: [...inventory.sources.keys()], consideredVideoIds: inventory.videoIds,
        answer: [inventoryText(inventory.claims, inventory.sources, input.question, question, inventory.brand), note].filter(Boolean).join('\n'),
        degraded: !!note || !!gathered.degradedReason, degradedReason: [note, gathered.degradedReason].filter(Boolean).join(' · ') || null,
        timings: { searchMs, llmMs: Date.now() - readStart, totalMs: Date.now() - startedAt } }), note);
    } catch (err) {
      return result({ ...fields, model: llm.model, degraded: true, degradedReason: err instanceof Error ? err.message : String(err),
        answer: 'La lecture des essais a été interrompue. La liste des modèles n’a pas pu être vérifiée.' });
    }
  }
  if (all.length === 0) {
    return result({ answer: scan ? 'Aucune occurrence confirmée dans les passages examinés.' : REFUSAL, refused: true, sources: [] });
  }
  if (mode === 'extractif') return extractive(null);
  if (!llm) return extractive('LLM non configuré : réponse extractive');
  if (!(await llm.available())) return extractive('LLM indisponible : réponse extractive');

  const llmStartedAt = started ? started.llmStartedAt : Date.now();
  const action = (routed.route === 'chercher' || routed.route === 'plan') && !routed.general && (analysis?.action ?? asksAboutAction(question));
  const writerFallback = (reason: string, extra: Partial<AnswerResult>): AnswerResult => {
    if (!action || !gathered.rankedIds) return extractive(reason, extra);
    const clues = retrievedClues(gathered.rankedIds, gathered.sources, routed.scope, analysis?.actionTargets ?? [], mode === 'court' ? 3 : 6, question);
    if (!clues.length) return result({ ...extra, answer: REFUSAL, refused: true, sources: [], degraded: true, degradedReason: reason });
    const citedSourceIds = clues.flatMap((clue) => clue.sourceIds);
    return result({
      ...extra, refused: false, claims: clues, citedSourceIds, sources: citedSourceIds.map((id) => gathered.sources.get(id)!),
      answer: [gathered.note, renderClaims(clues, gathered.sources, mode)].filter(Boolean).join('\n'),
      degraded: true, degradedReason: reason,
    });
  };
  const aliases = aliasSources(gathered);
  let raw: string;
  let issue: string | null = null;
  try {
    if (scan) {
      const claims = [...(scan.confirmed ? [scan.confirmed] : []), ...scan.earlier].flatMap((v) => v.claim ? [v.claim] : []);
      raw = JSON.stringify({ refus: claims.length === 0, claims });
      const partial = validateClaims(raw, gathered.sources, mode, aliases.sourceOf, true);
      if (partial.claims.length) {
        const cited = new Set(partial.claims.flatMap((c) => c.sourceIds));
        progress({ étape: 'lignes', answer: partial.answer, sources: groupSources([...cited].map((id) => gathered.sources.get(id)!)) });
      }
    } else if (routed.general && gathered.windows.length > 0) {
      if (!judge) return extractive('question générale sans juge (aucun mode choisi, ou clé absente) : réponse extractive');
      ({ raw, issue } = await answerByVideo(
        llm,
        judge,
        threshold,
        question,
        gathered.windows,
        aliases.idOf,
        {
          order: routed.order,
          required: analysis?.required ?? [],
          actionTargets: analysis?.actionTargets ?? [],
          rankedIds: gathered.rankedIds ?? [],
          scope: routed.scope,
          corpus,
        },
        {
          onJudge: (vidéos) => progress({ étape: 'jugement', vidéos }),
          onWrite: (lots) => progress({ étape: 'rédaction', lots }),
          // Chaque lot rédigé, validé comme la réponse finale, part aussitôt vers l'affichage.
          onBatch: (claims) => {
            const partial = validateClaims(JSON.stringify({ refus: false, claims }), gathered.sources, mode, aliases.sourceOf, routed.order !== null);
            if (partial.claims.length === 0) return;
            const cited = [...new Set(partial.claims.flatMap((c) => c.sourceIds))];
            progress({ étape: 'lignes', answer: partial.answer, sources: groupSources(cited.map((id) => gathered.sources.get(id)!)) });
          },
        },
      ));
    } else {
      progress({ étape: 'réponse' });
      const demonstration = observed && (routed.videoId || routed.videoIds?.length)
        ? await readDemonstration(llm, mode, question, gathered, aliases, corpus).catch(() => null) : null;
      raw = demonstration ?? await ((!observed && started ? started.raw : null) ?? writeFocused(llm, mode, question, action || observed, gathered, aliases, corpus, observed));
    }
  } catch (err) {
    return writerFallback(`erreur LLM : ${err instanceof Error ? err.message : String(err)}`, { model: llm.model });
  }
  let validated = validateClaims(raw, gathered.sources, mode, aliases.sourceOf, routed.general && routed.order !== null);
  if (action || observed || (started?.raw && validated.refused && validated.claims.some((c) => c.preuve))) {
    const required = analysis?.required.length ? analysis.required : knownBrands(question);
    const first = assessAction(validated, gathered.sources, mode, question, required, routed.scope);
    validated = first.validated;
    if (first.clue) {
      validated = uncertainAction(first.validated, first.clue);
      try {
        // Une série déjà lue en entier ne contient aucun nouvel extrait à chercher.
        const scene = gathered.retrieval === 'série' ? null : await actionNeighborhood(
          pool, first.clue.source, gathered.corpusVersion, gathered.sources, routed.scope, evidenceBudgetChars(outputTokens(mode, false)), question, required,
        );
        if (scene) {
          if (observed) scene.entries = scene.entries.map(entry => ({ ...entry, screenText: null }));
          const sources = new Map(scene.entries.map((entry) => [entry.sourceId, entrySource(entry, scene)]));
          const original = first.clue.source;
          const items: PromptItem[] = [];
          if (!sources.has(original.sourceId)) {
            sources.set(original.sourceId, original);
            items.push({ ...original, text: original.excerpt, uncertainties: [] });
          }
          const evidence = { windows: [scene], items, note: 'Compare la piste initiale et la scène. Si la prémisse est contredite, indique ce qui est réellement établi et cite la ligne décisive. Si une parole dépend de la précédente (projet, souhait, négation), cite les deux.' };
          const nearby = aliasSources(evidence);
          const alternative = corroboratedAlternative(first.clue, question, scene, routed.scope);
          if (alternative) {
            validated = { ...validated, refused: false, claims: [alternative], answer: renderClaims([alternative], sources, mode) };
          } else {
            const checked = await writeFocused(llm, mode, question, true, evidence, nearby, corpus, observed);
            const review = assessAction(validateClaims(checked, sources, mode, nearby.sourceOf), sources, mode, question, required, routed.scope);
            if (review.validated.claims.length) validated = review.validated;
            else if (review.clue) validated = uncertainAction(review.validated, review.clue);
          }
          for (const claim of validated.claims) for (const id of claim.sourceIds) gathered.sources.set(id, sources.get(id)!);
        }
      } catch (err) {
        issue = `relecture du passage indisponible : ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  const timings = { searchMs, llmMs: reviewMs + Date.now() - llmStartedAt, totalMs: Date.now() - startedAt };
  const degradedReason = [gathered.degradedReason, issue].filter(Boolean).join(' ; ') || null;
  const common = {
    invalidCitations: validated.invalid,
    model: llm.model,
    timings,
    ...(issue === null ? {} : { degraded: true, degradedReason }),
  };
  if (validated.claims.length === 0) {
    if (validated.refused) return result({ answer: REFUSAL, refused: true, sources: [], ...common });
    if (validated.offSchema) return writerFallback('réponse hors du format imposé : repli extractif', common);
    return extractive('réponse sans citation vérifiable : repli extractif', common);
  }
  const cited = [...new Set(validated.claims.flatMap((c) => c.sourceIds))];
  let answer = validated.answer;
  if (routed.general && routed.order) {
    let heading: string;
    if (validated.claims.every((c) => c.missing !== undefined)) {
      heading = 'Aucune occurrence confirmée dans les passages examinés.';
    } else if (scan?.confirmed?.passages[0]?.publishedAt) {
      heading = `${routed.order === 'premiere' ? 'Première' : 'Dernière'} occurrence confirmée parmi les vidéos indexées examinées, par date de publication.`;
    } else if (scan?.confirmed) {
      heading = 'Occurrence retrouvée dans une vidéo de date inconnue. Son rang chronologique reste indéterminé.';
    } else {
      heading = routed.order === 'premiere' ? 'Passages retrouvés, de la vidéo la plus ancienne à la plus récente.' : 'Passages retrouvés, de la vidéo la plus récente à la plus ancienne.';
    }
    answer = `${heading}\n${answer}`;
  }
  return result({
    answer,
    refused: false,
    claims: validated.claims,
    citedSourceIds: cited,
    sources: groupSources(cited.map((id) => gathered.sources.get(id)!)),
    ...common,
  });
}

/** Échange à conserver dans l'historique d'un fil pour résoudre la relance suivante. */
export function turnOf(result: AnswerResult): Turn {
  // L'affichage peut fusionner les fiches de deux citations voisines. Garder le minutage
  // de chaque référence effectivement imprimée, dans son ordre de lecture.
  const byId = new Map(result.sources.flatMap(s => s.sourceIds.map(id => [id, s] as const)));
  const printed = extractParsedCitations(result.answer).flatMap(({ ref, startS }) => {
    const source = byId.get(ref);
    return source && startS !== null ? [{ videoId: source.videoId, sourceId: ref, startS }] : [];
  });
  const scenes = result.sceneAnchors ?? sceneRefs(printed.length ? printed : result.sources);
  return { question: result.resolvedQuestion, videoIds: [...new Set(result.sources.map((s) => s.videoId))],
    ...(result.inventoryId ? { inventory: result.inventoryId } : {}),
    ...(scenes.length ? { scenes } : {}), ...(result.route === 'clarifier' && scenes.length ? { choosingScene: true } : {}),
    ...(result.offeredEpisodeSearch && scenes.length ? { offeredEpisodeSearch: true } : {}) };
}
