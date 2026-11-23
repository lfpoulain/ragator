import { foldAccents } from '../norm/normalize.js';

export const PROCESS_NOUNS: Readonly<Record<string, string>> = {
  soud: 'soudure|soudage', bras: 'brasage|brasure', assembl: 'assemblage', coll: 'collage',
  decoup: 'decoupe|decoupage', grav: 'gravure|gravage', ponc: 'poncage', perc: 'percage',
  rabot: 'rabotage', usin: 'usinage', frais: 'fraisage', pli: 'pliage', moul: 'moulage',
};

/** « graveuse » et « graveuses » désignent une machine dont le procédé est la gravure. */
export function toolProcessStem(term: string): string | null {
  const match = /^([a-z]+)euses?$/.exec(foldAccents(term));
  return match && Object.hasOwn(PROCESS_NOUNS, match[1]!) ? match[1]! : null;
}

// Seules des technologies applicables aux deux machines se propagent à gauche.
// « une ponceuse ou une fraiseuse neuve » ne dit pas que la ponceuse est neuve.
const TECHNOLOGY = /^(?:lasers?|electriques?|pneumatiques?|hydrauliques?|numeriques?|thermiques?|manuelles?|cnc)$/;
const USED_TOOLS = /\b(?:utilis(?:e|ent|ez|ons|er|ait|aient|es)|emplo(?:ie|ient|yez|yons|yer)|(?:se\s+)?serv(?:ent|ez|ir)|travaill(?:e|ent|ez|ons|er))(?:-(?:t-)?(?:ils|elles|on|vous))?\s+(?:(?:avec|de)\s+|d')?(?:un(?:e)?|le|la|les|des|du)\s+$/;

/** Deux machines employées en alternative avec une technologie finale commune.
 * Le qualificatif peut être répété sur chaque machine. Une autre proposition ou un autre
 * instrument simplement présent dans la question ne définissent pas ce geste. */
export function sharedToolTargets(question: string): { tools: [string, string]; technology: string } | null {
  const parts = question.split(/(?<!\p{L})ou(?!\p{L})/iu);
  if (parts.length !== 2) return null;
  const normalize = (s: string) => foldAccents(s).replace(/[’ʼ]/g, "'").replace(/[‑–]/g, '-').trim();
  const left = /\b([a-z]+euses?)(?:\s+([a-z]+))?$/.exec(normalize(parts[0]!));
  const right = /^(?:bien\s+)?(?:de\s+|d')?(?:(?:une?|la|le|les|des)\s+)?([a-z]+euses?)\s+([a-z]+)\b/.exec(normalize(parts[1]!));
  if (!left || !right) return null;
  const prefix = left.input.slice(0, left.index);
  if (!USED_TOOLS.test(prefix) || /\bsans\s+(?:les\s+)?(?:utiliser|employer|se servir)\b/.test(prefix)) return null;
  const first = left[1]!, second = right[1]!, technology = right[2]!;
  if (first === second || !toolProcessStem(first) || !toolProcessStem(second) ||
    !TECHNOLOGY.test(technology) || (left[2] && left[2] !== technology)) return null;
  return { tools: [first, second], technology };
}

/** Ces formes attestent la fonction d'une machine si l'extrait établit également sa technologie. */
export function toolFunctionForms(tool: string): string[] {
  const stem = toolProcessStem(tool)!;
  const nouns = PROCESS_NOUNS[stem]!.split('|');
  const verbStems = stem === 'decoup' ? [stem, 'coup'] : [stem];
  const inflections = ['e', 'es', 'ee', 'ees', 'ent', 'er', 'ez', 'ons', 'ant', 'ait', 'aient'];
  return [...new Set([tool, tool.replace(/s$/, '') + 's', tool.replace(/s$/, ''),
    ...nouns.flatMap(n => [n, n + 's']), ...verbStems.flatMap(base => inflections.map(ending => base + ending))])];
}
