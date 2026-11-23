import { tokenizeText } from '../norm/normalize.js';
import type { RequiredTerm } from './analyze.js';
import { sharedToolTargets, toolFunctionForms } from './tool-functions.js';

// Un matériau précis peut attester sa famille. L'inverse ne permet pas d'identifier le matériau.
// « Fer » seul désigne aussi un outil, notamment le fer à souder des pièces en plastique.
const METAL_FORMS = [
  'metal', 'metaux', 'metallique', 'metalliques', 'acier', 'aciers', 'inox', 'aluminium', 'alu',
  'cuivre', 'laiton', 'etain', 'zinc', 'titane', 'en fer', 'de fer', 'en fonte', 'en bronze',
];

/** La première forme reste le mot de la question, utilisé pour résoudre les coordinations. */
export function actionTargetForms(form: string): string[] {
  if (form === 'metal' || form === 'metaux') {
    return [form, ...METAL_FORMS.filter((word) => word !== form)];
  }
  return [form, form.endsWith('s') ? form.slice(0, -1) : form + 's'];
}

/**
 * Chaque groupe est obligatoire ; ses termes sont interchangeables uniquement si la question les
 * relie explicitement par « ou ». Un terme que l'analyse a reformulé sans le situer reste obligatoire.
 */
export function requiredGroups(question: string, required: RequiredTerm[]): RequiredTerm[][] {
  if (required.length < 2) return required.map((term) => [term]);
  // Le « où » interrogatif ne coordonne pas deux options. Garder une frontière avant de plier les accents.
  const text = ' ' + question.split(/(?<!\p{L})où(?!\p{L})/iu).map((part) => tokenizeText(part).tokens.join(' ')).join(' | ') + ' ';
  const mentions = required.map((term) => {
    let start = Infinity;
    let end = Infinity;
    for (const form of [term.term, ...term.forms]) {
      const words = tokenizeText(form).tokens.join(' ');
      if (!words) continue;
      const at = text.indexOf(` ${words} `);
      if (at >= 0 && (at < start || (at === start && at + words.length + 1 > end))) {
        start = at;
        end = at + words.length + 1;
      }
    }
    return { term, start, end };
  }).sort((a, b) => a.start - b.start);

  const groups: RequiredTerm[][] = [];
  let previousEnd = Infinity;
  for (const { term, start, end } of mentions) {
    const between = previousEnd <= start && Number.isFinite(start) ? text.slice(previousEnd, start).trim() : '';
    // Les mots d'un autre objet ou d'une autre proposition ne suffisent pas à rendre les termes interchangeables.
    if (/^(?:et )?ou(?: bien)?(?: (?:avec|de|en))?(?: (?:le|la|les|un|une|des|du|l))?$/.test(between)) {
      groups.at(-1)!.push(term);
    } else {
      groups.push([term]);
    }
    previousEnd = end;
  }
  return groups;
}

/** Réunit les deux options nominales de « du X ou de la Y Z ». Les contraintes extérieures
 * (par exemple « avec un outil T ») restent obligatoires pour chacune des options. */
export function coordinatedTargets(question: string, groups: RequiredTerm[][]): RequiredTerm[][] {
  const pair = sharedToolTargets(question);
  if (pair) {
    const local = new Set([...pair.tools, pair.technology]);
    const outside = groups.map(group => group.filter(term => !term.forms[0]!.split(' ').every(word => local.has(word))))
      .filter(group => group.length > 0);
    return [
      pair.tools.map(term => ({ term, forms: toolFunctionForms(term) })),
      [{ term: pair.technology, forms: actionTargetForms(pair.technology) }],
      ...outside,
    ];
  }
  if (groups.length < 2) return groups;
  const parts = question.split(/(?<!\p{L})ou(?!\p{L})/iu);
  if (parts.length !== 2) return groups;
  const terms = new Map(groups.flat().map((term) => [term.forms[0]!, term]));
  const before = tokenizeText(parts[0]!).tokens.reverse();
  const after = tokenizeText(parts[1]!).tokens;
  while (after.length && /^(?:bien|de|du|des|d|le|la|les|l|un|une)$/.test(after[0]!)) after.shift();
  const adjacent = (words: string[]) => {
    const found = new Set<string>();
    for (const word of words) {
      if (!terms.has(word)) break;
      found.add(word);
    }
    return found;
  };
  const left = adjacent(before), right = adjacent(after);
  if (!left.size || !right.size || [...left].some((word) => right.has(word))) return groups;

  const local = new Set([...left, ...right]);
  // Une alternative qui dépend d'un terme situé ailleurs dans la phrase est laissée à l'analyseur.
  if (groups.some((group) => group.some((t) => local.has(t.forms[0]!)) && group.some((t) => !local.has(t.forms[0]!)))) return groups;
  const keys = groups.map((group) => group.map((t) => t.forms[0]!));
  const option = (words: Set<string>) => keys.map((group) => group.filter((key) => words.has(key))).filter((group) => group.length);
  // (A et B) ou C équivaut à (A ou C) et (B ou C). Ne pas exiger B lorsqu'on a observé C.
  const combinations = option(left).flatMap((a) => option(right).map((b) => [...new Set([...a, ...b])]));
  const minimal: string[][] = [];
  for (const group of combinations.sort((a, b) => a.length - b.length)) {
    if (!minimal.some((smaller) => smaller.every((key) => group.includes(key)))) minimal.push(group);
  }
  return [...groups.filter((group) => !local.has(group[0]!.forms[0]!)), ...minimal.map((group) => group.map((key) => terms.get(key)!))];
}

/** Groupes sans aucune forme attestée dans le texte normalisé des lignes de preuve. */
export function missingRequiredGroups(groups: RequiredTerm[][], norm: string): RequiredTerm[][] {
  const padded = ` ${norm} `;
  return groups.filter((group) => !group.some((term) => term.forms.some((form) => padded.includes(` ${form} `))));
}

// Une alternative envisagée et une substitution identifient souvent le matériau sans prouver son usage.
const UNREALIZED_OPTION = /(?:\b(?:aurai[st]|auraient|aurions|auriez)\s+pu\b|\b(?:pourrait|pourraient|pourrions|pourrais|pourriez)\s+(?:aussi\s+)?(?:utiliser|employer|prendre|choisir|faire|appliquer)\b|\bau lieu d[e’']|\bplutôt qu[e’']|\bsans (?:utiliser|employer|appliquer)\b)/iu;

export function mentionsActionTargets(groups: RequiredTerm[][], texts: string[]): boolean {
  if (!groups.length) return true;
  const evidence = texts.flatMap((text) => text.split(/[!?;|\n]+|(?<!\d)\.|\.(?!\d)|\bmais\b/iu))
    .map((clause) => tokenizeText(clause.split(UNREALIZED_OPTION, 1)[0]!).norm).join(' | ');
  return missingRequiredGroups(groups, evidence).length === 0;
}

/** Le rédacteur décrit parfois un conseil ou une mention comme résultat d'une recherche d'usages réels. */
export function onlyReportsAction(claim: string, question: string): boolean {
  const indirect = /(?<!\p{L})(?:recommand|conseill|preconis|mentionn|evoqu|envisag|sugger|signal|parl)(?:e|ent|er|ez|ons|ait|aient|e[es]?)(?!\p{L})/u;
  const opening = tokenizeText(claim).tokens.slice(0, 5).join(' ');
  return indirect.test(opening) && !indirect.test(tokenizeText(question).tokens.join(' '));
}
