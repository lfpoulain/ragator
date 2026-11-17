import type { Db } from './pool.js';

export interface EntryRow {
  sourceId: string;
  kind: 'parole' | 'visuel';
  startS: number;
  endS: number | null;
  chunkIndex: number | null;
  speaker: string | null;
  speakerRaw: string | null;
  speakerId: string | null;
  speakerIsNamed: boolean;
  planTitle: string | null;
  text: string;
  screenText: string[] | null;
  uncertainties: string[];
  qualityFlags: Record<string, boolean>;
  screenTextNorm: string | null;
  normText: string;
  searchText: string;
  textHash: string;
}

const INSERT_COLUMNS = 19;
const BATCH_SIZE = 100;

export async function upsertEntries(
  client: Db,
  videoId: string,
  rows: EntryRow[],
): Promise<number> {
  let written = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((row, i) => {
      const base = i * INSERT_COLUMNS;
      values.push(
        row.sourceId,
        videoId,
        row.kind,
        row.startS,
        row.endS,
        row.chunkIndex,
        row.speaker,
        row.speakerRaw,
        row.speakerId,
        row.speakerIsNamed,
        row.planTitle,
        row.text,
        row.screenText,
        row.uncertainties,
        JSON.stringify(row.qualityFlags),
        row.screenTextNorm,
        row.normText,
        row.searchText,
        row.textHash,
      );
      const params = Array.from({ length: INSERT_COLUMNS }, (_, k) => `$${base + k + 1}`);
      return `(${params.join(', ')})`;
    });
    await client.query(
      `INSERT INTO entries (
         source_id, video_id, kind, start_s, end_s, chunk_index,
         speaker, speaker_raw, speaker_id, speaker_is_named, plan_title, text,
         screen_text, uncertainties, quality_flags, screen_text_norm, norm_text, search_text, text_hash
       ) VALUES ${placeholders.join(', ')}
       ON CONFLICT (video_id, source_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         start_s = EXCLUDED.start_s,
         end_s = EXCLUDED.end_s,
         chunk_index = EXCLUDED.chunk_index,
         speaker = EXCLUDED.speaker,
         speaker_raw = EXCLUDED.speaker_raw,
         speaker_id = EXCLUDED.speaker_id,
         speaker_is_named = EXCLUDED.speaker_is_named,
         plan_title = EXCLUDED.plan_title,
         text = EXCLUDED.text,
         screen_text = EXCLUDED.screen_text,
         uncertainties = EXCLUDED.uncertainties,
         quality_flags = EXCLUDED.quality_flags,
         screen_text_norm = EXCLUDED.screen_text_norm,
         norm_text = EXCLUDED.norm_text,
         search_text = EXCLUDED.search_text,
         text_hash = EXCLUDED.text_hash,
         embedding = CASE WHEN entries.text_hash = EXCLUDED.text_hash
                          THEN entries.embedding ELSE NULL END`,
      values,
    );
    written += batch.length;
  }
  return written;
}

export async function deleteEntriesNotIn(
  client: Db,
  videoId: string,
  keepSourceIds: string[],
): Promise<number> {
  const { rowCount } = await client.query(
    'DELETE FROM entries WHERE video_id = $1 AND NOT (source_id = ANY($2::text[]))',
    [videoId, keepSourceIds],
  );
  return rowCount ?? 0;
}
