import { foldAccents, tokenizeText } from '../norm/normalize.js';
import { PROCESS_NOUNS, sharedToolTargets, toolProcessStem } from './tool-functions.js';

export interface OperationMatch {
  shown(text: string): boolean;
  mentioned(text: string): boolean;
}

/** Vérifie le geste nommé par la question ou les deux usages alternatifs d'outils de même technologie. */
export function questionOperation(question: string): OperationMatch | null {
  const tools = sharedToolTargets(question);
  if (tools) {
    const stems = tools.tools.map((name) => toolProcessStem(name)!);
    const choices = stems.map((stem) => operationForStem(stem));
    if (stems.includes('decoup')) choices.push(operationForStem('coup', 'coupe'));
    const qualifier = tools.technology.replace(/s$/, '');
    const names = tools.tools.map((name) => name.replace(/s$/, ''));
    // Le qualificatif d'un instrument de mesure peut figurer dans un plan de découpe à la scie.
    const measuringDevice = new RegExp(`\\b(?:niveaux?|pointeurs?|scanners?|telemetres?|guides? d['’]alignement)\\s+${qualifier}s?\\b`, 'g');
    const hasTechnology = (clause: string) => tokenizeText(foldAccents(clause).replace(measuringDevice, ' ')).tokens
      .some((word) => word === qualifier || word === qualifier + 's');
    const matches = (text: string, kind: keyof OperationMatch): boolean => {
      const [first, ...description] = text.split(' | ÉCRAN : ', 1)[0]!.split('|');
      const title = description.length ? first! : '';
      // Le titre identifie la machine du plan. La description doit en montrer l'usage.
      const body = description.length ? description.join(' ') : first!;
      const titleTechnology = hasTechnology(title) && (choices.some((choice) => choice.mentioned(title)) ||
        tokenizeText(title).tokens.some((word) => names.includes(word.replace(/s$/, ''))));
      let previousNamedTool = false;
      for (const part of body.split(/[.!?;\n]+|,?\s+\bpuis\s+/iu).filter((s) => s.trim())) {
        // L'action annoncée après « pour que » reste un objectif, même au présent.
        const clause = kind === 'shown' ? part.split(/\b(?:pour qu[e’']|afin qu[e’']|de sorte qu[e’'])/iu, 1)[0]! : part;
        const flat = foldAccents(clause);
        if (kind === 'shown' && /\b(?:pourr(?:ait|aient|ions)|(?:va|vont|allons) (?:vraiment )?pouvoir|permet(?:tent)? d[e’']|compar(?:ent|er|aison) (?:les differences|entre)|(?:possible|capable) de)\b/.test(flat)) continue;
        const technology = hasTechnology(clause);
        const otherTool = (flat.match(/\b(?:scies?|cutters?|plotters?|fraiseuses?|scanners?|pointeurs?|telemetres?|niveaux?)\b/g) ?? [])
          .some((word) => !names.includes(word.replace(/s$/, '')));
        const sameMachine = previousNamedTool && /^\s*(?:elle|il|la machine|la t[êe]te|(?:le|son) faisceau)\b/iu.test(clause);
        const depicted = clause.trim().replace(/^(?:démonstration|séquence(?: en accéléré)?|gros plan)\s+(?:de (?:la |l['’])?|du |sur la )/iu, '');
        if (!otherTool && (technology || titleTechnology || sameMachine) && choices.some((choice) => choice[kind](depicted))) return true;
        // Un auteur peut décrire l'effet visible du faisceau sans répéter « graver ».
        if (kind === 'shown' && qualifier === 'laser' && technology && !otherTool && stems.includes('grav') && /\bgravure\b/.test(foldAccents(title)) &&
            !/\b(?:alignement|cadrage|projete|delimite)\b/.test(flat) &&
            /\b(?:faisceau|tete) laser\b[^.!?]{0,70}\b(?:(?:trac|marqu|decap|brul)(?:e|ant)|inscrit|balaie ligne par ligne)\b/.test(flat)) return true;
        previousNamedTool = technology && tokenizeText(flat).tokens.some((word) => names.includes(word.replace(/s$/, '')));
      }
      return kind === 'mentioned' && titleTechnology;
    };
    return {
      shown: (text) => matches(text, 'shown'),
      mentioned: (text) => matches(text, 'mentioned'),
    };
  }
  const normalized = foldAccents(question).replaceAll('‑', '-');
  const verbs = [...normalized.matchAll(/\b([a-z]+)ent-(?:ils|elles)\b|\b(?:ils|elles)\s+([a-z]+)ent\b/g)];
  if (verbs.length !== 1) return null;
  const stem = verbs[0]![1] ?? verbs[0]![2]!;
  if (!Object.hasOwn(PROCESS_NOUNS, stem) || /\b(?:ou|et)\s+[a-z]+(?:ent|er)\b/.test(normalized)) return null;
  return operationForStem(stem);
}

function operationForStem(stem: string, noun = PROCESS_NOUNS[stem]!): OperationMatch {
  const actionWord = new RegExp(`^${stem}(?:e|es|ent|ons|ez|ais|ait|aient|ant)$`);
  const participle = new RegExp(`^${stem}ee?s?$`);
  const past = /\b(?:ai|as|a|avons|avez|ont|avait|avaient)\s+(?:(?:aussi|ensuite|finalement|bien)\s+)?$/;
  const inProgress = new RegExp(`\\ben train de ${stem}er\\b`);
  const heading = new RegExp(`(?:^|\\b(?:et|puis) |,\\s*)(?:${noun})s?\\b`);
  const executing = new RegExp(`\\b(?:realis|effectu|execut|poursuiv|termin|continu)(?:e|ent|ons|ez|ant)\\s+(?:un|une|le|la|les|des|sa|ses|leur|leurs)\\s+(?:${noun})s?\\b`);
  const startWithResult = new RegExp(`\\b(?:lancement|demarrage) (?:de la |du |des )?(?:${noun})s?\\b.{0,75}\\b(?:extraction|retrait|recuperation|obtention) (?:des?|du|d['’])\\b`);
  const failed = new RegExp(`\\b(?:${noun})s? (?:ne (?:prend|tient|fonctionne) pas|(?:ratee?|manquee?|impossible)s?)\\b`);
  const mention = new RegExp(`\\b(?:(?:${noun})s?|${stem}(?:e|er|es|ee|ees|ent|ons|ez|ais|ait|aient|ant))\\b`);
  const toolName = new RegExp(`\\b(?:fers?|postes?|machines?|outils?) (?:a|de) (?:${stem}er|(?:${noun})s?)\\b`, 'g');
  const negated = /\b(?:pas|jamais|plus)\b/;
  function describesExecution(fragment: string): boolean {
    const flat = foldAccents(fragment).trim();
    if (!flat || /\b(?:on pourrait|il faudrait|si on|ils pourraient|avant de|au lieu de|sans avoir|comment faire)\b/.test(flat)) return false;
    if (heading.test(flat)) return !/\b(?:impossible|abandonne|a venir|deja realise|a prevoir|prevue?s?|future?s?|prochaine?s?)\b/.test(flat);
    if (executing.test(flat) || inProgress.test(flat) || startWithResult.test(flat)) return true;
    for (const match of fragment.matchAll(/\p{L}+/gu)) {
      const word = foldAccents(match[0]);
      if (!actionWord.test(word) && !participle.test(word)) continue;
      const before = foldAccents(fragment.slice(0, match.index));
      const after = foldAccents(fragment.slice(match.index + match[0].length)).trim();
      // Dans « les futures découpes », « découpes » est un nom, même si sa forme est aussi verbale.
      if (/\b(?:future?s?|prochaine?s?|eventuel(?:le)?s?|possible[s]?)\s*$/.test(before) ||
          /^(?:future?s?|prochaine?s?|prevue?s?)\b/.test(after)) continue;
      if (/\b(?:ne|n)\s*$/.test(before) && negated.test(after.split(' ', 2).join(' '))) continue;
      // « Un cadre soudé » désigne un état. « Elle a soudé le cadre » décrit le geste.
      if (/é(?:e?s?)$/iu.test(match[0]) || !actionWord.test(word)) {
        if (past.test(before)) return true;
        continue;
      }
      if (!/\b(?:une|la|de|du|le|les|des|aux|leurs?|sa|cette)\s*$/.test(before) || /\b(?:on|ils?|elles?)\s+(?:le|la|les|leur)\s*$/.test(before)
        || /(?<!\p{L})\p{Lu}\p{Ll}+\s+(?:le|la|les|leur)\s*$/u.test(fragment.slice(0, match.index))) return true;
    }
    return false;
  }
  return {
    shown: (text) => !failed.test(foldAccents(text)) && text.split(/[|.!?;\n]+/u).some(describesExecution),
    mentioned: (text) => mention.test(foldAccents(text).replace(toolName, '')),
  };
}
