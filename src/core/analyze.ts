import type { Pool } from 'pg';
import { tokenizeText } from '../norm/normalize.js';
import { STOPWORDS } from '../norm/stopwords.js';
import { getMetaString } from '../db/meta.js';
import type { LlmClient } from '../providers/llm.js';
import { ANALYZE_SCHEMA, ANALYZE_SYSTEM_PROMPT, parseAnalysis } from '../prompts/analyze.js';
import { classify, type RoutedQuery } from './classify.js';
import { asksAboutAction } from './action-proof.js';
import { lexique, resolveTerm } from './resolve.js';
import { aliasCanonical, isCanonicalBrand } from '../norm/brands.js';
import { findSeries, withoutSeries, type Series } from './series.js';
import { mentionsProject } from './projects.js';
import { actionTargetForms, coordinatedTargets } from './requirements.js';
import { sharedToolTargets } from './tool-functions.js';

/** Mots-clés gardés au plus (chacun devient une liste lexicale de la fusion). */
const MAX_KEYWORDS = 6;
/** Exigences gardées au plus : une question nomme rarement plus de deux marques ou modèles. */
const MAX_REQUIRED = 3;

/**
 * Marque, modèle ou nom propre imposé par la question (« une scie circulaire Ryobi »). `forms` : ses
 * écritures normalisées présentes dans le corpus (forme exacte, alias de marque, ou correction
 * orthographique) ; une vidéo qui n'en cite aucune ne prouve pas la réponse.
 */
export interface RequiredTerm {
  term: string;
  forms: string[];
}

export interface QuestionAnalysis {
  projects: string[];
  observed: boolean;
  routed: RoutedQuery;
  /** L'information demandée exige de vérifier une action ou son lien avec un objet. */
  action: boolean;
  /** Mots-clés proposés par le LLM et présents dans le corpus. */
  keywords: string[];
  /** Extrait hypothétique (HyDE), encodé pour la recherche sémantique ; jamais une preuve. */
  hypothetical: string | null;
  source: 'llm' | 'règles';
  /** Raison d'un repli sur les règles, ou mots-clés écartés. */
  note: string | null;
  /** Marques, modèles ou noms propres imposés par la question. */
  required: RequiredTerm[];
  /** Cibles explicites du geste dans les questions générales ; alternatives au sein d'un groupe. */
  actionTargets: RequiredTerm[][];
  /** Objet d'une question « première / dernière fois qu'ils… » (parcours chronologique), présent dans le corpus. */
  subject: RequiredTerm | null;
  /**
   * Série de vidéos à laquelle la question se limite (« les vidéos de la régie »), ramenée par le code
   * aux vidéos dont le titre la nomme ; `query` : la question sans ce nom, sujet de la recherche.
   */
  series: (Series & { query: string }) | null;
}

/** Forme normalisée (celle du corpus) d'un terme. */
function normalized(term: string): string {
  return tokenizeText(term).tokens.join(' ');
}

/** Tous les mots signifiants du terme existent dans le vocabulaire du corpus. */
function inCorpus(term: string, words: ReadonlySet<string>): boolean {
  const tokens = tokenizeText(term).tokens.filter((t) => !STOPWORDS.has(t));
  return tokens.length > 0 && tokens.every((t) => words.has(t));
}

/** Sans LLM : les marques connues (src/norm/brands.ts) citées dans la question. */
export function knownBrands(question: string): RequiredTerm[] {
  const tokens = tokenizeText(question).tokens;
  const found = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    for (const len of [3, 2, 1]) {
      const gram = tokens.slice(i, i + len).join(' ');
      const brand = isCanonicalBrand(gram) ? gram : aliasCanonical(gram);
      if (brand) found.add(brand);
    }
  }
  return [...found].slice(0, MAX_REQUIRED).map((brand) => ({ term: brand, forms: [brand] }));
}

/**
 * Exigences proposées par le LLM, ramenées à une forme du corpus ; une exigence introuvable garde sa
 * forme normalisée (aucune vidéo ne la prouvera).
 */
async function resolveRequired(pool: Pool, terms: string[], corpusVersion: string, notes: string[], collection?: string): Promise<RequiredTerm[]> {
  const required: RequiredTerm[] = [];
  for (const term of terms.slice(0, MAX_REQUIRED)) {
    const resolved = await resolveTerm(pool, term, 'tout', corpusVersion, collection);
    if (resolved.status === 'resolved' && resolved.canonical) {
      if (resolved.fuzzy) notes.push(`exigence « ${term} » lue « ${resolved.canonical} »`);
      required.push({ term, forms: [resolved.canonical, ...resolved.aliases] });
    } else {
      const form = normalized(term);
      if (form) required.push({ term, forms: [form] });
    }
  }
  return required;
}

/**
 * Aiguillage et préparation de la recherche par LLM, validés par le
 * code : un décompte exact (`lister`) exige un terme présent dans le corpus,
 * sinon la question devient une recherche générale ; les mots-clés absents du
 * corpus sont écartés. Sans LLM, ou si l'appel échoue, les règles décident.
 * La portée (paroles/visuel/écran) et la vidéo citée restent celles des règles.
 */
export async function analyzeQuestion(
  pool: Pool,
  question: string,
  llm: LlmClient | null,
  /** Ligne « Corpus : … » (`corpusLine`) : de quelle chaîne viennent les vidéos. */
  corpus: string | null = null,
  collection?: string,
): Promise<QuestionAnalysis> {
  const rules = classify(question);
  const explicitToolUse = sharedToolTargets(question) !== null;
  const fallback = (note: string | null): QuestionAnalysis => {
    const action = explicitToolUse || asksAboutAction(question);
    return { routed: rules, action, projects: [], observed: false, keywords: [], hypothetical: null, source: 'règles', note, required: knownBrands(question),
      actionTargets: rules.general && action && !rules.order ? coordinatedTargets(question, []) : [], subject: null, series: null };
  };
  if (!llm) return fallback(null);

  const prompt = corpus ? `${corpus}\nQuestion : ${question}` : `Question : ${question}`;
  const request = (maxTokens: number) => llm.chat(ANALYZE_SYSTEM_PROMPT, prompt, { maxTokens, jsonSchema: ANALYZE_SCHEMA, temperature: 0 });
  let analysis: ReturnType<typeof parseAnalysis>;
  try {
    // Température 0 : la même question doit être aiguillée de la même façon (mesuré : sans elle, une question
    // mal orthographiée partait une fois sur deux en « clarifier »).
    const raw = (await request(400)).trim();
    analysis = parseAnalysis(raw);
    // Une sortie tronquée perd les contraintes du geste au repli. Reprendre une seule fois avec de la marge.
    if (!analysis && raw.startsWith('{') && !raw.endsWith('}')) analysis = parseAnalysis(await request(800));
  } catch (err) {
    return fallback(`analyse LLM impossible (${err instanceof Error ? err.message : String(err)}) : règles`);
  }
  if (!analysis) return fallback('analyse LLM illisible : règles');

  const corpusVersion = (await getMetaString(pool, 'corpus_version')) ?? '';
  const words = new Set(await lexique(pool, 'tout', corpusVersion, collection));
  const notes: string[] = [];

  let route = analysis.route;
  // Première / dernière fois repérée par les règles : elles l'emportent sur le LLM (route, ordre, terme).
  // Mention → décompte trié par date ; action → question générale jugée par JEV, triée par date.
  if (rules.order) route = rules.route === 'lister' ? 'lister' : 'chercher';
  // Les routes étroites (plan : titres de plans seuls ; infos : descriptions seules) restreignent les
  // preuves, et « clarifier » renonce à chercher : le LLM ne peut y envoyer une question que si les règles
  // le font aussi. Il peut en revanche élargir (quitter une route étroite, reconnaître un décompte ou une
  // question générale). Mesuré : « à quel moment… » envoyé en `plan` faisait perdre des citations précises,
  // et une question mal orthographiée (« quand parle ton de moutique ») partait en « clarifier ».
  let downgraded = false;
  // « Combien de pièces ont cassé ? » se résout dans la scène. Compter les lignes qui
  // mentionnent les pièces donnerait un entier plausible, mais dans une autre unité.
  const countedNoun = /\bcombien\s+(?:de\s+|d['’])([\p{L}-]+)/iu.exec(question)?.[1];
  const quantityMisrouted = route === 'lister' && countedNoun !== undefined && rules.route === 'chercher' && !rules.order
    && !/^(?:fois|vidéos?|épisodes?|moments?|passages?|extraits?|mentions?|occurrences?|apparitions?|citations?)$/iu.test(countedNoun);
  if (quantityMisrouted) {
    notes.push('quantité demandée dans le contenu : recherche de la valeur dans les extraits');
    route = 'chercher';
  }
  // « Quand parlent-ils de X » est une question générale pour les règles, sans demande de décompte : le
  // LLM ne la transforme pas en liste de mentions (il hésitait d'un appel à l'autre, même à température 0).
  if (route === 'lister' && rules.route === 'chercher' && rules.general && !rules.order && !analysis.ordre) {
    notes.push('décompte proposé pour une question générale : recherche générale');
    route = 'chercher';
    downgraded = true;
  }
  // Un décompte répond en vidéos et en occurrences. Une question qui ne nomme aucune de ces unités attend
  // autre chose (un nom, une manière, une raison), même si elle porte sur un objet concret : le LLM
  // l'envoyait au décompte du mot, et la réponse listait des vidéos au lieu de ce qui était demandé.
  const namesCountUnit = /(?<!\p{L})(?:combien|vidéos?|épisodes?|fois|mentions?|occurrences?|apparitions?|citations?|passages?|extraits?|moments?|partout)(?!\p{L})/iu.test(question);
  let listedInstead = false;
  if (route === 'lister' && rules.route !== 'lister' && !rules.order && !analysis.ordre && !namesCountUnit) {
    notes.push('décompte proposé pour une question qui ne demande ni vidéos ni occurrences : recherche générale');
    route = 'chercher';
    downgraded = true;
    listedInstead = true;
  }
  if ((route === 'plan' || route === 'infos' || route === 'clarifier') && rules.route !== route) {
    notes.push(`route « ${route} » proposée sans accord des règles : recherche classée`);
    route = 'chercher';
    downgraded = true;
  }
  // Une question que les règles reconnaissent comme générale (« quand parlent-ils de… », « qu'est-ce qu'ils
  // pensent de… ») le reste : le LLM la classait « précise » de façon constante (mesuré sur 3 passages).
  // Le modèle voulait toutes les occurrences : la réponse couvre plusieurs vidéos.
  let general = route === 'chercher' && (rules.general || listedInstead || (analysis.generale && !quantityMisrouted));
  let term: string | null = rules.order && rules.term ? rules.term : analysis.terme ? normalized(analysis.terme) : null;
  // Un sigle de moins de 3 lettres se confond avec un mot court ou une interjection (« ha » pour Home
  // Assistant comptait une enceinte de 2018) : écarté des variantes.
  let alternatives = analysis.alternatives.map(normalized).filter((t) => t && t !== term && t.replace(/\s/g, '').length >= 3);

  if (route === 'lister' || route === 'plan') {
    // Un décompte exact ne porte que sur un terme réellement présent dans le corpus.
    const present = [term, ...alternatives].filter((t): t is string => !!t && inCorpus(t, words));
    if (present.length === 0) {
      notes.push(`terme « ${analysis.terme} » absent du corpus : recherche générale`);
      route = 'chercher';
      general = true;
      term = null;
      alternatives = [];
    } else {
      [term = null, ...alternatives] = present;
    }
  }
  if (route !== 'lister' && route !== 'plan') {
    term = null;
    alternatives = [];
  }

  const seen = new Set<string>([normalized(question)]);
  const keywords: string[] = [];
  const dropped: string[] = [];
  for (const keyword of analysis.motsCles) {
    const key = normalized(keyword);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (inCorpus(key, words)) keywords.push(keyword);
    else dropped.push(keyword);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  if (dropped.length > 0) notes.push(`mots-clés absents du corpus écartés : ${dropped.join(', ')}`);

  const required = await resolveRequired(pool, analysis.exigences, corpusVersion, notes, collection);
  const action = explicitToolUse || (analysis.action ?? asksAboutAction(question));
  const questionWords = ` ${normalized(question)} `;
  const targetable = general && action && !analysis.ordre && !rules.order;
  const actionTargets = targetable ? analysis.ciblesGeste.slice(0, MAX_REQUIRED).map((group) =>
    group.slice(0, MAX_REQUIRED).map((term) => ({ term, form: normalized(term) }))
      .filter(({ form }) => form.length > 1 && !STOPWORDS.has(form) && questionWords.includes(` ${form} `))
      .map(({ term, form }) => ({ term, forms: actionTargetForms(form) })),
  ).filter((group) => group.length > 0) : [];
  // Sujet d'une « première / dernière fois » : seulement s'il existe dans le corpus (sinon, chemin général).
  const subject = analysis.sujet ? ((await resolveRequired(pool, [analysis.sujet], corpusVersion, notes, collection))[0] ?? null) : null;
  const order = rules.order ?? (route === 'lister' || general ? analysis.ordre : null);
  // Série nommée par la question : un filtre sur des vidéos, jamais un mot à chercher. Une vidéo citée par
  // son identifiant reste plus précise.
  const found = rules.videoId ? null : await findSeries(pool, analysis.serie, notes, collection);
  const series = found ? { ...found, query: withoutSeries(question, found.terms) } : null;
  // Le nom de la série parmi les mots-clés ramènerait les passages qui en parlent, pas le sujet.
  const seriesForms = new Set(found?.terms.map(normalized) ?? []);
  const subjectKeywords = keywords.filter((k) => !seriesForms.has(normalized(k)));
  const routed: RoutedQuery = {
    ...rules,
    route,
    general,
    term,
    alternatives,
    order,
    reason: `analyse LLM : ${route}${general ? ' (générale)' : ''}${order ? ` (${order === 'premiere' ? 'première' : 'dernière'} mention)` : ''}`,
  };
  return {
    routed,
    action,
    projects: analysis.projets.filter(p => mentionsProject(question, p)),
    observed: analysis.gesteObserve && routed.scope !== 'ecran' && routed.scope !== 'paroles',
    keywords: subjectKeywords,
    hypothetical: analysis.passage || null,
    source: 'llm',
    note: notes.length > 0 ? notes.join(' ; ') : null,
    required,
    actionTargets: targetable ? coordinatedTargets(question, actionTargets) : [],
    subject: subject && inCorpus(subject.forms[0]!, words) ? subject : null,
    series,
  };
}
