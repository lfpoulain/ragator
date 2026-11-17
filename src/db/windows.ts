import { createHash } from 'node:crypto';
import { FORMAT_VERSION } from '../core/versions.js';
import type { Db } from './pool.js';

export interface WindowRow {
  startS: number;
  endS: number;
  text: string;
  nEntries: number;
  params: { windowSeconds: number; stepSeconds: number; formatVersion: string };
}

export function windowTextHash(text: string): string {
  return createHash('sha256').update(`${FORMAT_VERSION}\u0000${text}`, 'utf8').digest('hex');
}

/** Remplace toutes les fenêtres d'une vidéo (dans la transaction de publication). */
export async function replaceWindows(client: Db, videoId: string, rows: WindowRow[]): Promise<void> {
  await client.query('DELETE FROM windows WHERE video_id = $1', [videoId]);
  for (const row of rows) {
    await client.query(
      `INSERT INTO windows (video_id, start_s, end_s, text, text_hash, n_entries, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [videoId, row.startS, row.endS, row.text, windowTextHash(row.text), row.nEntries, JSON.stringify(row.params)],
    );
  }
}
