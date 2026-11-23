import { tokenizeText } from '../norm/normalize.js';
import type { AnswerSource } from './sources.js';

const TIME_CUE = /\b(?:minutage|timecode|timestamp|horodatage|quel (?:moment|instant)|quelle (?:minute|seconde)|quand)\b/;
const TIME_PREFIX = /^(?:(?:et|alors|deja|a|au|c|est|etait|le|la|son|sa|ce|vers|quel|quelle|tu|vous|peux|pourrais|pouvez|pourriez|me|moi|nous|redire|redis|redonne[rs]?|donne[rs]?|rappelle[rs]?|rappeler|precise[rs]?|indique[rs]?)\s+)*$/;
const COURTESY = /\b(?:exact(?:e|ement)?|precis(?:e|ement)?|deja|stp|svp|s il (?:te|vous) plait)\b/g;
const SHOWING = /^(?:est ce (?:que|qu) )?(?:(?:on|ils|elles|tu|vous) )?(?:(?:les?|la|l|en|y) )?(?:voit|vois|voyez|voient|montr(?:e|ent|ez)|font|fait|parl(?:e|ent|ez))(?: (?:t )?(?:ils|elles|on|tu|vous))?(?: (?:faire|montrer))?(?: |$)/;
const SCENE_NOUN = /^(?:scene|extrait|plan|moment|instant|passage|sequence|geste|operation|etape|manipulation|demonstration)$/;

/** null pour une question de fond, '' pour un simple repère, sinon le nom du geste à rattacher. */
export function timeReferent(text: string): string | null {
  const cue = TIME_CUE.exec(text);
  if (!cue || !TIME_PREFIX.test(text.slice(0, cue.index))) return null;
  const tail = text.slice(cue.index + cue[0].length).replace(COURTESY, '').trim().replace(/\s+/g, ' ');
  const object = tail.replace(SHOWING, '').replace(/^(?:de|pour|sur|dans|a) /, '');
  if (!object || /^(?:ca|cela|ceci)$/.test(object)) return '';
  const mention = /^(ce|cet|cette|le|la|l|du) (?:meme )?([a-z]+)(?: (?:ci|la))?$/.exec(object);
  if (!mention) return null;
  const noun = mention[2]!;
  if (SCENE_NOUN.test(noun)) return '';
  if (!mention[1]!.startsWith('c') || /^(?:video|episode|projet|chaine|serie)$/.test(noun)) return null;
  return noun;
}

/** « Ce ponçage » peut renvoyer à « on ponce ». Un objet nouveau doit garder sa propre recherche. */
export function mentionsTimeReferent(noun: string, text: string): boolean {
  const stem = noun.endsWith('age') ? noun.slice(0, -3) : '';
  // Le tokenizer de recherche conserve les formes composées comme « règlent-ils ».
  return tokenizeText(text).tokens.flatMap(token => token.split('-')).some(word => {
    if (word === noun || word === noun + 's') return true;
    if (stem.length < 3 || !word.startsWith(stem)) return false;
    return /^(?:e|es|ee|ees|er|ent|ez|ons|ant|ait|aient|ais)$/.test(word.slice(stem.length));
  });
}

/** Le plus tardif des débuts cités est le premier instant commun possible, et a un lien exact. */
export function sharedTimeSource(sources: AnswerSource[]): AnswerSource | undefined {
  const first = sources[0];
  if (!first || sources.some(s => s.videoId !== first.videoId || s.startS === null)) return;
  const latest = sources.reduce((a, b) => b.startS! > a.startS! ? b : a);
  const at = latest.startS!;
  if (sources.every(s => s.startS === at)) return latest;
  // Deux plans successifs restent distincts, même très proches. La fin d'un plan est exclusive.
  const mixed = sources.some(s => s.kind === 'parole') && sources.some(s => s.kind === 'visuel');
  if (mixed && sources.every(s => s.startS === at || (s.endS !== null && s.endS > at))) return latest;
}
