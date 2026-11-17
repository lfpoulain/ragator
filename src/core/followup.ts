import type { Pool } from 'pg';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import { classify, extractTerm } from './classify.js';

/** Un échange précédent, du plus ancien au plus récent. */
export interface Turn {
  /** Question telle que résolue à ce tour. */
  question: string;
  /** Vidéos des sources citées dans la réponse. */
  videoIds: string[];
}

export interface FollowUp {
  /** Question à traiter, complétée si c'était une relance. */
  question: string;
  /** Vidéo désignée par la relance (« cette vidéo », « celle du manoir »). */
  videoId: string | null;
  /** Message de clarification si la référence est ambiguë ou introuvable. */
  clarify: string | null;
}

/** Tours conservés au plus : l'historique sert aux références, jamais de preuve. */
export const MAX_HISTORY_TURNS = 5;

const THIS_VIDEO = /(?<!\p{L})(?:(?:cette|la même|même)\s+vidéo|celle-(?:ci|là)|dedans)(?!\p{L})/iu;
const OTHER_VIDEO = /\bcelle\s+(?:du|de la|de l['’]|des|sur\s+(?:le|la|les|l['’])?|avec\s+(?:le|la|les|l['’])?)\s*(.+?)\s*[?!.]*$/i;
const ELLIPSIS = /^\s*et\s+/i;
/** Une question qui porte ses propres mots interrogatifs n'a pas besoin de la précédente. */
const INTERROGATIVE = /(?<!\p{L})(?:quel(?:le)?s?|comment|pourquoi|quand|combien|où|qu['’]est-ce|qui|que|quoi)(?!\p{L})/iu;
const ELLIPSIS_TERM = /^\s*et\s+(?:(?:de|du|des|d['’]|pour|sur|avec)\s+)?(?:(?:le|la|les|l['’]|un|une)\s*)?(.+?)\s*[?!.]*$/i;

async function videosByTitle(pool: Pool, words: string[], collection: string | null): Promise<Array<{ videoId: string; title: string }>> {
  const { rows } = await pool.query<{ video_id: string; title: string }>(
    'SELECT video_id, title FROM videos WHERE $1::text IS NULL OR collection = $1',
    [collection],
  );
  return rows
    .filter((row) => {
      const titleWords = new Set(tokenizeText(row.title).tokens);
      return words.every((word) => titleWords.has(word));
    })
    .map((row) => ({ videoId: row.video_id, title: row.title }));
}

/**
 * Résout une relance par le code : l'historique sert à retrouver la
 * question et la vidéo visées, jamais de preuve. Une référence unique est
 * résolue ; plusieurs antécédents plausibles demandent une clarification.
 */
export async function resolveFollowUp(pool: Pool, question: string, history: Turn[] = [], collection: string | null = null): Promise<FollowUp> {
  const unchanged: FollowUp = { question, videoId: null, clarify: null };
  const previous = history.at(-1);
  if (!previous) return unchanged;

  let videoId: string | null = null;
  const other = OTHER_VIDEO.exec(question);
  if (other) {
    const words = contentTokens(tokenizeText(other[1] ?? '').tokens);
    const matches = words.length > 0 ? await videosByTitle(pool, words, collection) : [];
    if (matches.length !== 1) {
      return {
        ...unchanged,
        clarify:
          matches.length === 0
            ? `Je ne trouve aucune vidéo dont le titre correspond à « ${other[1]} ». Précisez le titre.`
            : `Plusieurs vidéos correspondent : ${matches.slice(0, 5).map((m) => `« ${m.title} »`).join(', ')}. Laquelle ?`,
      };
    }
    videoId = matches[0]!.videoId;
  } else if (THIS_VIDEO.test(question)) {
    const videos = [...new Set(previous.videoIds)];
    if (videos.length !== 1) {
      return {
        ...unchanged,
        clarify:
          videos.length === 0
            ? 'La réponse précédente ne citait aucune vidéo : de laquelle parlez-vous ?'
            : 'La réponse précédente citait plusieurs vidéos : précisez laquelle (par son titre).',
      };
    }
    videoId = videos[0]!;
  }

  if (!ELLIPSIS.test(question)) return { ...unchanged, videoId };

  // Une question complète porte son propre terme, même après un décompte.
  const own = question.replace(ELLIPSIS, '');
  if (INTERROGATIVE.test(own) || extractTerm(own) !== null) return { question: own, videoId, clarify: null };
  // Une référence seule change le filtre vidéo, jamais le terme recherché.
  const withoutReference = own.replace(other?.[0] ?? THIS_VIDEO, '').replace(/\bdans\b/gi, '').replace(/[?!.]/g, '').trim();
  if (videoId && contentTokens(tokenizeText(withoutReference).tokens).length === 0) {
    return { question: previous.question, videoId, clarify: null };
  }

  // « et de Parkside ? » après un décompte : même intention et même portée,
  // reformulées en question canonique pour rester relançables au tour suivant.
  const before = classify(previous.question);
  const newTerm = other ? null : ELLIPSIS_TERM.exec(question)?.[1];
  if (before.route === 'lister' && newTerm) {
    const quoted = newTerm
      .split(/\s+ou\s+/i)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `« ${t} »`)
      .join(' ou ');
    const canonical = {
      paroles: `toutes les vidéos où on parle de ${quoted}`,
      visuel: `toutes les vidéos où on voit ${quoted}`,
      ecran: `toutes les vidéos où ${quoted} est affiché à l’écran`,
      tout: `toutes les vidéos où ${quoted} est mentionné`,
    }[before.scope];
    return { question: canonical, videoId, clarify: null };
  }
  // Sinon la relance elliptique complète la question précédente.
  const leftover = question.replace(ELLIPSIS, '').replace(other?.[0] ?? '', '').trim();
  const rest = contentTokens(tokenizeText(leftover).tokens).length > 0 ? leftover : '';
  return { question: [previous.question, rest].filter(Boolean).join(' '), videoId, clarify: null };
}
