import type { Pool } from 'pg';
import { timestampedLink } from '../links.js';
import { readSnapshot } from '../db/pool.js';
import { mapSpeaker } from '../norm/speakers.js';
import { formatWindow, type FormatEntry } from '../windows/format.js';
import type { Evidence } from './search.js';
import type { Kind, Page } from './page.js';

export interface ContextData {
  videoId: string;
  title: string;
  publishedAt: string | null;
  link: string;
  startS: number;
  endS: number;
  /** Même format qu'une fenêtre. */
  merged: string;
  entries: Evidence[];
}

export interface ContextInput {
  videoId: string;
  atS: number;
  beforeS?: number;
  afterS?: number;
}

/** Plafond de chaque côté de l'instant : la sortie reste bornée. */
const MAX_SPAN_S = 300;

function span(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_SPAN_S, Math.max(0, Math.floor(value)));
}

/**
 * Paroles et plans entremêlés autour d'un instant : rattrape une phrase
 * coupée entre deux fenêtres ou vérifie une réponse.
 */
export function lireContexte(pool: Pool, input: ContextInput): Promise<Page<ContextData>> {
  const beforeS = span(input.beforeS, 45);
  const afterS = span(input.afterS, 45);
  const atS = Math.max(0, Math.floor(input.atS));
  const startS = Math.max(0, atS - beforeS);
  const endS = atS + afterS;

  return readSnapshot(pool, async (db, versions) => {
    const { rows: videoRows } = await db.query<{ title: string; published_at: string | null }>(
      `SELECT title, published_at::text AS published_at FROM videos WHERE video_id = $1`,
      [input.videoId],
    );
    const video = videoRows[0];
    if (!video) throw new Error(`vidéo inconnue : ${input.videoId}`);

    const { rows } = await db.query<{
      source_id: string;
      kind: Kind;
      start_s: number;
      end_s: number | null;
      text: string;
      speaker: string | null;
      speaker_raw: string | null;
      speaker_is_named: boolean;
      plan_title: string | null;
      screen_text: string[] | null;
      uncertainties: string[] | null;
    }>(
      `SELECT source_id, kind, start_s, end_s, text, speaker, speaker_raw, speaker_is_named,
              plan_title, screen_text, uncertainties
       FROM entries
       WHERE video_id = $1
         AND start_s <= $2
         AND GREATEST(COALESCE(end_s, start_s), start_s + 1) > $3
       ORDER BY start_s, GREATEST(COALESCE(end_s, start_s), start_s + 1), source_id`,
      [input.videoId, endS, startS],
    );

    const entries: FormatEntry[] = rows.map((r) => ({
      sourceId: r.source_id,
      kind: r.kind,
      startS: r.start_s,
      endS: r.end_s,
      text: r.text,
      speaker: r.speaker,
      isVoiceOver: r.speaker_raw !== null && mapSpeaker(r.speaker_raw).isVoiceOver,
      speakerIsNamed: r.speaker_is_named,
      planTitle: r.plan_title,
      screenText: r.screen_text,
      uncertainties: r.uncertainties ?? [],
    }));

    const data: ContextData = {
      videoId: input.videoId,
      title: video.title,
      publishedAt: video.published_at,
      link: timestampedLink(input.videoId, atS),
      startS,
      endS,
      merged: formatWindow(
        { videoId: input.videoId, title: video.title, publishedAt: video.published_at, startS, endS },
        entries,
      ),
      entries: entries.map((e) => ({
        sourceId: e.sourceId,
        kind: e.kind,
        startS: e.startS,
        endS: e.endS,
        text: e.text,
        uncertainties: e.uncertainties,
      })),
    };
    return { data, ...versions, truncated: false, nextCursor: null };
  });
}
