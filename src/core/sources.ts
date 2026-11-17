import { timestampedLink, videoLink } from '../links.js';
import type { EvidenceKind } from '../prompts/answer.js';
import { formatTimestamp } from '../windows/format.js';
import type { Kind } from './page.js';

/**
 * Sources citables d'une réponse : construction depuis les entrées et les
 * plans, regroupement par séquence, et rendu des références et du repli extractif.
 */

export interface AnswerSource {
  /** Premier identifiant du groupe (voir `sourceIds`). */
  sourceId: string;
  /** Identifiants réunis dans cette source : entrées voisines d'une même séquence. */
  sourceIds: string[];
  videoId: string;
  title: string;
  publishedAt: string | null;
  kind: EvidenceKind;
  startS: number | null;
  endS: number | null;
  link: string;
  excerpt: string;
  urls: string[];
}

export function sourceOf(
  base: { sourceId: string; videoId: string; title: string; publishedAt: string | null; kind: EvidenceKind },
  startS: number | null,
  endS: number | null,
  text: string,
  urls: string[] = [],
): AnswerSource {
  return {
    ...base,
    sourceIds: [base.sourceId],
    startS,
    endS,
    link: startS === null ? videoLink(base.videoId) : timestampedLink(base.videoId, startS),
    excerpt: text,
    urls,
  };
}

/** Source d'une entrée (parole ou plan) d'une fenêtre de résultat. */
export function entrySource(
  entry: { sourceId: string; kind: Kind; startS: number; endS: number | null; text: string; screenText?: string[] | null },
  video: { videoId: string; title: string; publishedAt: string | null },
): AnswerSource {
  // Le texte à l'écran fait partie de la preuve montrée au modèle : l'extrait le garde (contrôle d'appui, affichage).
  const screen = entry.screenText?.length ? ` | ÉCRAN : ${entry.screenText.map((t) => `« ${t} »`).join(' | ')}` : '';
  return sourceOf(
    { sourceId: entry.sourceId, videoId: video.videoId, title: video.title, publishedAt: video.publishedAt, kind: entry.kind },
    entry.startS,
    entry.endS,
    entry.text + screen,
  );
}

/** Écart en deçà duquel deux sources d'une même vidéo appartiennent à la même séquence. */
const SAME_SEQUENCE_S = 30;

/**
 * Réunit les sources d'une même vidéo espacées de moins de 30 s : une séquence
 * s'affiche une fois, avec le lien vers son début, même si plusieurs de ses
 * lignes sont citées.
 */
export function groupSources(sources: AnswerSource[]): AnswerSource[] {
  const groups: AnswerSource[] = [];
  for (const source of sources) {
    const group =
      source.startS === null
        ? undefined
        : groups.find(
            (g) =>
              g.videoId === source.videoId &&
              g.startS !== null &&
              source.startS! >= g.startS - SAME_SEQUENCE_S &&
              source.startS! <= Math.max(g.endS ?? g.startS, g.startS) + SAME_SEQUENCE_S,
          );
    if (!group) {
      groups.push({ ...source, sourceIds: [...source.sourceIds], urls: [...source.urls] });
      continue;
    }
    const startS = Math.min(group.startS!, source.startS!);
    group.endS = Math.max(group.endS ?? group.startS!, source.endS ?? source.startS!);
    if (startS < group.startS!) {
      group.startS = startS;
      group.sourceId = source.sourceId;
      group.link = source.link;
      group.kind = source.kind;
    }
    group.sourceIds.push(...source.sourceIds.filter((id) => !group.sourceIds.includes(id)));
    group.urls.push(...source.urls.filter((u) => !group.urls.includes(u)));
    if (!group.excerpt.includes(source.excerpt)) group.excerpt = `${group.excerpt} … ${source.excerpt}`;
  }
  return groups;
}

export function extractiveAnswer(sources: AnswerSource[], note: string | null): string {
  const lines = note ? [note] : [];
  for (const source of sources) {
    const at = source.startS !== null ? ` @ ${formatTimestamp(source.startS)}` : '';
    const excerpt = source.excerpt.length > 240 ? `${source.excerpt.slice(0, 240)}…` : source.excerpt;
    lines.push(`- [${source.sourceId}${at}] « ${excerpt} » — ${source.title} (${source.publishedAt ?? 'date inconnue'})`, `  ${source.link}`);
  }
  return lines.join('\n');
}

/** Référence affichée d'une source : `[id @ mm:ss]`, ou `[id]` sans instant. */
export function reference(source: AnswerSource): string {
  return source.startS === null ? `[${source.sourceId}]` : `[${source.sourceId} @ ${formatTimestamp(source.startS)}]`;
}
