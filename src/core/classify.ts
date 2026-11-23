import type { Scope } from './page.js';
import { tokenizeText } from '../norm/normalize.js';
import { STOPWORDS } from '../norm/stopwords.js';

export type Route = 'lister' | 'chercher' | 'plan' | 'infos' | 'clarifier';
/** Décompte trié par date : la première ou la dernière vidéo qui mentionne le terme. */
export type Order = 'premiere' | 'derniere';

export interface RoutedQuery {
  route: Route;
  /** Terme lexical principal (forme normalisée), pour `lister` et `plan`. */
  term: string | null;
  /** Alternatives explicites (« X ou Y », plusieurs termes entre guillemets). */
  alternatives: string[];
  scope: Scope;
  /** Identifiant de vidéo cité explicitement dans la question. */
  videoId: string | null;
  /** Vidéos d'une série nommée par la question (« les vidéos de la régie »), retrouvée par l'analyse. */
  videoIds?: string[];
  /** Collection (créateur de contenu) choisie par l'utilisateur ; absente : toutes. */
  collection?: string;
  /** Question générale multi-vidéos (« quand parle-t-on de… ») : recherche large, le LLM trie. */
  general: boolean;
  /**
   * « La première / la dernière fois que… » : trié par date. Une MENTION
   * (« première mention de X ») est un décompte `lister` ; une ACTION (« la
   * dernière fois qu'ils utilisent X ») est une question générale, jugée par JEV.
   */
  order: Order | null;
  reason: string;
}

const EXHAUSTIVE_PATTERNS = [
  /toutes les vidéos/i,
  /dans quelles vidéos/i,
  /quelles vidéos/i,
  /combien de vidéos/i,
  /combien de fois/i,
  /\bpartout\b/i,
  /tous les passages/i,
  /liste (?:complète|exhaustive|toutes)/i,
];

/**
 * « Première mention », « pour la première fois », « la dernière vidéo où… » :
 * la réponse est un extrême dans le temps, que seul le décompte exhaustif trié
 * par date donne à coup sûr (la recherche classée ne rend que les passages les
 * plus pertinents, pas tous).
 */
const ORDINAL = String.raw`(?:premi[eè]re?|derni[eè]re?)`;
const ORDER_PATTERN = new RegExp(
  String.raw`(?<!\p{L})${ORDINAL}\s+(?:mention|fois|vidéo|apparition|occurrence)s?(?!\p{L})|pour\s+la\s+${ORDINAL}\s+fois|(?:vidéo|mention)\s+la\s+plus\s+(?:ancienne|récente)`,
  'iu',
);

function orderOf(question: string): Order | null {
  const match = ORDER_PATTERN.exec(question)?.[0];
  if (!match) return null;
  return /premi|ancienne/i.test(match) ? 'premiere' : 'derniere';
}

/**
 * Terme d'une question ordinale : la formule ordinale retirée, l'objet suit un
 * verbe (« parlé de », « mentionné », « utilisé ») ou un nom (« mention du »,
 * « vidéo avec »). « Premier mention du PLA sur nos vidéos » → « pla ».
 */
const ORDINAL_PHRASE = new RegExp(
  String.raw`(?:pour\s+)?(?:la|le|leur|sa|son|leurs)?\s*(?:toute\s+)?${ORDINAL}\s*(?:fois)?|la\s+plus\s+(?:ancienne|récente)`,
  'giu',
);
const ORDINAL_OBJECT =
  /(?:mention\p{L}*|parl\p{L}*|évoqu\p{L}*|cit[ée]\p{L}*|vu|voit|apparition|occurrence|vidéo)\s+(?:(?:avec|de|du|des|sur|en|où\s+(?:on|ils|il)\s+\p{L}+(?:\s+(?:de|du|des))?)\s+|d['’]\s*)?(?:(?:les|le|la|une|un|des|du|de la)\s+|(?:de l['’]|l['’]|d['’])\s*)?(.+)$/iu;

/**
 * Verbes d'action : « la dernière fois qu'ils utilisent une visseuse » demande
 * un usage réel, qu'une mention du mot ne prouve pas (la question est prise au mot).
 */
const ACTION_VERB = /(?<!\p{L})(?:utilis|test|fabriqu|construi|soud|imprim|install|répar|découp|programm)\p{L}*/iu;
const ORDINAL_CLAUSE = /(?:\bqu['’]|\b(?:où|que)\s+)(?:ils?|elles?|on|nous|vous)\s+\p{L}+/iu;
const MENTION_VERB = /(?<!\p{L})(?:parl\p{L}*|mentionn\p{L}*|cit[éae]\p{L}*|évoqu\p{L}*|voit|voient|vu|vue|aperç\p{L}*)(?!\p{L})/iu;

function extractOrdinalTerm(question: string): string | null {
  const stripped = question.replace(ORDINAL_PHRASE, ' ').replace(/\s+/g, ' ').trim();
  const candidate = ORDINAL_OBJECT.exec(stripped)?.[1];
  if (!candidate) return null;
  const head = candidate.split(/[,?!.;:]|\s+(?:dans|sur|chez|au cours|pour)\s+/)[0] ?? '';
  return trimTerm(head) || null;
}

const SCREEN_PATTERNS = [/[àa] l['’]écran/i, /[àa] l['’]image/i, /(?<!\p{L})écran(?!\p{L})/iu, /\baffich/i];

const VISUAL_PATTERNS = [
  /\bon voit\b/i,
  /\bvoit-on\b/i,
  /\bvisible\b/i,
  /\bvisuellement\b/i,
  /\bmontré/i,
  /\bmontre (?:un|une|la|le|les|des)\b/i,
  /\bapparaît/i,
  /\bplan (?:de|du|sur|où)\b/i,
];

const SPEECH_PATTERNS = [/\bon parle\b/i, /\bil parle\b/i, /\bparlent\b/i, /\bdit\b/i, /\bprononc/i, /[àa] l['’]oral\b/i];

const INFOS_PATTERNS = [
  /\blien\b/i,
  /fichier 3d/i,
  /\bstl\b/i,
  /github/i,
  /référence en description/i,
  /description de la vidéo/i,
  /où acheter/i,
  /on a mis un fichier/i,
];

const QUOTED = /«\s*(.+?)\s*»|"([^"]+)"/g;

/**
 * « quand parle-t-on de… », « dans quels projets… », « avec quels youtubeurs… », « qu'est-ce qu'ils
 * pensent de… », « ont-ils déjà utilisé… » : réponse attendue sur plusieurs vidéos.
 */
const GENERAL_PATTERN =
  /(?<!\p{L})(?:qu['’]est-ce\s+qu['’](?:ils|on)\s+pens|que\s+pensent|(?:ils\s+ont|ont-ils|on\s+a|avez-vous|vous\s+avez)\s+déjà\s+(?:parl|utilis|test|fait|essay|évoqu|mentionn)|quand\s+(?:est-ce\s+qu['’](?:on|ils)\s+)?(?:parl|évoqu|abord|mentionn|utilis|montr|est-il question)|dans\s+quel(?:le)?s\s+(?:projets?|vidéos|épisodes|cas)|(?:avec\s+)?quel(?:le)?s\s+(?:autres\s+)?(?:projets|youtubeurs|créateurs|vidéos|épisodes|sujets|moments)|tous\s+les\s+(?:moments|passages|projets)|à\s+quels\s+moments)/iu;

// Un geste au présent sur une catégorie d'objets (« tournent-ils du bois ? ») peut se répéter.
// L'article défini ou possessif (« leur pied de lampe ») peut au contraire désigner un projet.
const WHEN_GENERIC_OBJECT = /^quand\s+((?:se\s+|s['’])?\p{L}+ent[-‑](?:ils|elles)|(?:est-ce\s+qu['’])?(?:ils|elles)\s+(?:se\s+|s['’])?\p{L}+ent)\s+(?:(?:du|des|un|une|de\s+la)\s+|de\s+l['’])([^,;:?!]+)[?!]*$/iu;
const ALTERNATIVE_ARTICLE = /\s+(?:ou|et)\s+(?:(?:du|des|de\s+la)\s+|de\s+l['’])/giu;
// Un autre référent précis dans la suite (« du bois pour le pied de lampe ») rend le cas ambigu.
const SPECIFIC_CONTEXT = /(?<!\p{L})(?:ce|cet|cette|ces|leur|leurs|son|sa|ses|quand|comment|pourquoi|quel|quelle|du)(?!\p{L})|(?<!\p{L})(?:dans|sur|pour|de)\s+(?:la\b|le\b|les\b|l['’])/iu;

/**
 * L'objet suit le marqueur : « on parle de X », « on voit X », « mentionné X ».
 * Articles du plus long au plus court, suivis d'un espace ou d'une apostrophe :
 * sinon « une CNC » donnait « e cnc » et « les vis » « s vis ».
 */
const AFTER_MARKER =
  /(?:parl(?:e|ent|ait|ant)\s+(?:de|du|des|d['’])|on voit|voit-on|[àa] l['’]écran|[àa] l['’]image|montr(?:e|é|ent|ant))\s+(?:(?:les|le|la|une|un|des|du|de la)\s+|(?:de l['’]|l['’]|d['’])\s*)?(.+)$/i;

/** L'objet précède le marqueur : « où X est (explicitement) mentionné ». */
const BEFORE_MARKER =
  /\boù\s+(.+?)\s+(?:est|sont|a été|ont été|apparaît|apparaissent)\s+(?:\p{L}+ment\s+)?(?:mentionn|cit|évoqu|décrit|montr|prononc|visible|affich)/iu;

/** « qui mentionnent X ». */
const WHO_MENTIONS = /\bqui\s+(?:mentionnent|citent|évoquent|montrent)\s+(?:\p{L}+ment\s+)?(.+)$/iu;

const VIDEO_REF_PATTERN = /(?<!\p{L})(?:vidéo|épisode)\s+(?:«\s*)?([A-Za-z0-9_-]{11})(?:\s*»)?(?![A-Za-z0-9_-])/iu;

/** Mots vides retirés aux extrémités d'un terme, jamais au milieu d'une expression. */
function trimTerm(text: string): string {
  const tokens = tokenizeText(text).tokens;
  let start = 0;
  let end = tokens.length;
  while (start < end && STOPWORDS.has(tokens[start]!)) start += 1;
  while (end > start && STOPWORDS.has(tokens[end - 1]!)) end -= 1;
  return tokens.slice(start, end).join(' ');
}

/**
 * Termes lexicaux d'une question : les expressions entre guillemets telles
 * quelles, sinon l'objet repéré autour d'un marqueur (« parle de », « on voit »,
 * « où X est mentionné »). « X ou Y » donne deux alternatives.
 */
export function extractTerms(question: string): string[] {
  const quoted = [...question.matchAll(QUOTED)].map((m) => tokenizeText(m[1] ?? m[2] ?? '').tokens.join(' '));
  if (quoted.some(Boolean)) return [...new Set(quoted.filter(Boolean))];

  const candidate =
    BEFORE_MARKER.exec(question)?.[1] ?? AFTER_MARKER.exec(question)?.[1] ?? WHO_MENTIONS.exec(question)?.[1] ?? null;
  if (!candidate) return [];
  const head = candidate.split(/[,?!.;:]|\s+dans\s+/)[0] ?? '';
  const terms = head.split(/\s+ou\s+/i).map(trimTerm).filter(Boolean);
  return [...new Set(terms)];
}

export function extractTerm(question: string): string | null {
  return extractTerms(question)[0] ?? null;
}

export function extractVideoReference(question: string): string | null {
  return VIDEO_REF_PATTERN.exec(question)?.[1] ?? null;
}

function matches(patterns: RegExp[], question: string): boolean {
  return patterns.some((pattern) => pattern.test(question));
}

/**
 * Portée demandée : « on parle de » → paroles, « on voit » → visuel,
 * « à l'écran » → ecran, « mentionné » seul → tout. Une question qui vise à la
 * fois l'oral et l'image (« à l'oral ou à l'écran », « mentionné ou décrit
 * visuellement ») couvre tout.
 */
function scopeOf(question: string): Scope {
  const screen = matches(SCREEN_PATTERNS, question);
  const visual = matches(VISUAL_PATTERNS, question);
  const speech = matches(SPEECH_PATTERNS, question);
  const mentioned = /(?<!\p{L})(?:mentionn|cit[ée]|évoqu)/iu.test(question);
  if ((speech || mentioned) && (screen || visual)) return 'tout';
  if (screen) return 'ecran';
  if (visual) return 'visuel';
  if (speech) return 'paroles';
  return 'tout';
}

/** Au-delà, une description visuelle est une phrase à classer, pas un terme. */
const MAX_PLAN_TERM_WORDS = 3;

/**
 * Routage déterministe, testable sans LLM : références en description
 * (`infos`), décompte exhaustif (`lister`), plan précis (`plan`), sinon
 * recherche classée (`chercher`).
 */
export function classify(question: string): RoutedQuery {
  const order = orderOf(question);
  const terms = order
    ? [extractOrdinalTerm(question) ?? extractTerm(question)].filter((t): t is string => t !== null)
    : extractTerms(question);
  const [term = null, ...alternatives] = terms;
  const scope = scopeOf(question);
  const videoId = extractVideoReference(question);
  const when = WHEN_GENERIC_OBJECT.exec(question.trim());
  const general = !videoId && (when && !MENTION_VERB.test(when[1]!)
    ? !SPECIFIC_CONTEXT.test(when[2]!.replace(ALTERNATIVE_ARTICLE, ' '))
    : GENERAL_PATTERN.test(question));
  const base = { term, alternatives, scope, videoId, general, order: null };

  if (matches(INFOS_PATTERNS, question)) {
    return { ...base, route: 'infos', reason: 'demande de lien, fichier ou référence en description' };
  }
  // Une demande de « première fois » sans terme de mention identifiable reste chronologique,
  // même avec un verbe de geste absent du lexique (« ils coulent de la résine »).
  if (order && (ACTION_VERB.test(question) || term === null || (ORDINAL_CLAUSE.test(question) && !MENTION_VERB.test(question)))) {
    const when = order === 'premiere' ? 'première' : 'dernière';
    return { ...base, term: null, alternatives: [], order, route: 'chercher', general: true, reason: `${when} fois qu’ils font quelque chose : question générale triée par date` };
  }
  if (order && term !== null) {
    return { ...base, order, route: 'lister', reason: `${order === 'premiere' ? 'première' : 'dernière'} mention demandée : décompte trié par date` };
  }
  if (matches(EXHAUSTIVE_PATTERNS, question)) {
    return term === null
      ? { ...base, route: 'clarifier', reason: 'intention exhaustive sans terme lexical identifiable' }
      : { ...base, route: 'lister', reason: 'décompte exhaustif demandé' };
  }
  if (term !== null && (scope === 'visuel' || scope === 'ecran') && term.split(' ').length <= MAX_PLAN_TERM_WORDS) {
    return {
      ...base,
      route: 'plan',
      reason: scope === 'ecran' ? 'recherche de texte affiché à l’écran' : 'recherche de plan visuel',
    };
  }
  return { ...base, route: 'chercher', reason: 'question factuelle ou temporelle, classée' };
}
