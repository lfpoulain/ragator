import type { Pool } from 'pg';
import type { RoutedQuery } from './classify.js';
import { listerVideos, type ListerVideoResult } from './list-videos.js';
import { sourceOf, type AnswerSource } from './sources.js';
import { sortByDate } from './video-rank.js';
import { formatTimestamp } from '../windows/format.js';
import type { AnswerResult } from './answer.js';
import type { Scope } from './page.js';

/** Route exhaustive (« toutes les vidéos où on parle de X ») : décompte exact rendu par le code, sans LLM. */

const SCOPE_LABELS: Record<Scope, string> = {
  tout: 'paroles, plans et texte à l’écran',
  paroles: 'paroles prononcées',
  visuel: 'plans visuels',
  ecran: 'texte affiché à l’écran',
};

export async function answerExhaustive(
  pool: Pool,
  routed: RoutedQuery & { term: string },
  base: Pick<AnswerResult, 'question' | 'resolvedQuestion' | 'route' | 'mode' | 'promptVersion' | 'analysis'>,
  startedAt: number,
): Promise<AnswerResult> {
  const videos: ListerVideoResult[] = [];
  let cursor: string | undefined;
  const request = {
    term: routed.term,
    alternatives: routed.alternatives,
    scope: routed.scope,
    ...(routed.videoId ? { videoId: routed.videoId } : {}),
    ...(routed.videoIds ? { videoIds: routed.videoIds } : {}),
    ...(routed.collection ? { collection: routed.collection } : {}),
  };
  let page = await listerVideos(pool, request);
  for (;;) {
    videos.push(...page.data.videos);
    // Toutes les pages : la réponse liste chaque vidéo (le corpus entier tient en quelques pages).
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
    page = await listerVideos(pool, { ...request, cursor });
  }
  const data = page.data;
  const searchMs = Date.now() - startedAt;
  const common = {
    ...base,
    consideredVideoIds: videos.map((v) => v.videoId),
    claims: [] as AnswerResult['claims'],
    citedSourceIds: [] as string[],
    invalidCitations: [] as string[],
    expansion: null,
    // Décompte et première / dernière mention : lecture exhaustive du corpus, sans classement.
    retrieval: 'corpus' as const,
    degraded: false,
    degradedReason: null,
    model: null,
    corpusVersion: page.corpusVersion,
    indexVersion: page.indexVersion,
    timings: { searchMs, llmMs: 0, totalMs: Date.now() - startedAt },
  };
  if (data.status !== 'resolved' || data.resolved === null || data.totalVideos === 0) {
    const answer =
      data.status === 'ambiguous'
        ? `Terme « ${routed.term} » ambigu : précisez parmi ${data.suggestions.map((s) => `« ${s} »`).join(', ')}.`
        : `Aucune occurrence de ${[routed.term, ...routed.alternatives].map((t) => `« ${t} »`).join(' ou ')} (${SCOPE_LABELS[routed.scope]}) dans le corpus.`;
    return { ...common, answer, refused: true, sources: [], exhaustive: null };
  }

  // Première / dernière mention : toutes les vidéos triées par date (date inconnue en dernier).
  const listed = routed.order ? sortByDate(videos, routed.order) : videos;
  const term = data.forms.join(' | ');
  const forms = data.forms.map((f) => `« ${f} »`).join(' ou ');
  const fuzzy = data.resolved.fuzzy ? ` (forme la plus proche de « ${routed.term} »)` : '';
  const lines: string[] = [];
  const extreme = routed.order ? listed[0] : undefined;
  if (routed.order && extreme) {
    const excerpt = extreme.excerpts[0];
    lines.push(
      `${routed.order === 'premiere' ? 'Première vidéo' : 'Dernière vidéo'} qui mentionne ${forms}${fuzzy} : « ${extreme.title} » (${extreme.publishedAt ?? 'date inconnue'}), ` +
        `première mention dans la vidéo à ${formatTimestamp(extreme.firstMentionS)}${excerpt ? ` : « ${excerpt.text.length > 240 ? `${excerpt.text.slice(0, 240)}…` : excerpt.text} »` : ''}`,
      `  ${extreme.link}`,
      '',
    );
  }
  lines.push(
    `${forms}${fuzzy} apparaît dans ${data.totalEntries} extrait(s) répartis sur ${data.totalVideos} vidéo(s) — portée : ${SCOPE_LABELS[routed.scope]}.`,
    'Décompte exact : une entrée compte une fois, quel que soit le nombre de répétitions.',
    '',
  );
  if (routed.order) {
    lines.push(`Toutes les vidéos, ${routed.order === 'premiere' ? 'de la plus ancienne à la plus récente' : 'de la plus récente à la plus ancienne'} :`);
  }
  const sources: AnswerSource[] = [];
  for (const video of listed) {
    const o = video.occurrences;
    lines.push(
      `- ${video.publishedAt ?? 'date inconnue'} — « ${video.title} » : ${o.total} extrait(s) (${o.speech} parole(s), ${o.visual} plan(s)) — première mention à ${formatTimestamp(video.firstMentionS)}${video.reviewRequired ? ' — à relire' : ''}`,
      `  ${video.link}`,
    );
    const first = video.excerpts[0];
    if (first) {
      sources.push(
        sourceOf({ sourceId: first.sourceId, videoId: video.videoId, title: video.title, publishedAt: video.publishedAt, kind: first.kind }, first.startS, null, first.text),
      );
    }
  }
  return {
    ...common,
    answer: lines.join('\n'),
    refused: false,
    citedSourceIds: sources.map((s) => s.sourceId),
    sources,
    exhaustive: {
      term,
      scope: routed.scope,
      totalVideos: data.totalVideos,
      totalEntries: data.totalEntries,
      listedVideos: listed.length,
    },
    timings: { searchMs, llmMs: 0, totalMs: Date.now() - startedAt },
  };
}
