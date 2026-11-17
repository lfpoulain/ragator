import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { canonicalJson, sha256, textHash } from './hashes.js';
import { parseCorpusJson, validateCorpusDocument, type CorpusDocument } from './validate.js';
import { normalizeText } from '../norm/normalize.js';
import { BRANDS_VERSION } from '../norm/brands.js';
import { mapSpeaker } from '../norm/speakers.js';
import { buildDescriptionBlocks } from './description.js';
import { generateWindows, windowsForEntry } from '../windows/generate.js';
import { formatWindow, type FormatEntry } from '../windows/format.js';
import { upsertVideo, updateVideoStats, getVideoState } from '../db/videos.js';
import { upsertEntries, deleteEntriesNotIn, type EntryRow } from '../db/entries.js';
import { replaceWindows, type WindowRow } from '../db/windows.js';
import { replaceChunks } from '../db/chunks.js';
import { generateChunks, type Chunk } from '../windows/chunks.js';
import { recomputeCorpusVersion, refreshIndexVersion } from '../db/meta.js';
import { ensureJob } from '../db/jobs.js';
import { withTransaction } from '../db/pool.js';
import {
  CHUNK_FORMAT_VERSION,
  CHUNK_SECONDS,
  CONTENT_HASH_VERSION,
  DERIVATION_VERSION,
  FORMAT_VERSION,
  STEP_SECONDS,
  WINDOW_SECONDS,
} from './versions.js';

export type IngestStatus = 'ingested' | 'unchanged' | 'stats_only';

export interface IngestFileResult {
  file: string;
  videoId: string;
  status: IngestStatus;
  durationEstimated: boolean;
  entries: number;
  windows: number;
}

export interface IngestReport {
  results: IngestFileResult[];
  failures: Array<{ file: string; error: string }>;
}

export function listCorpusFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path)
      .filter((name) => /^video--.+\.json$/.test(name))
      .sort()
      .map((name) => join(path, name));
  }
  return [path];
}

interface Prepared {
  doc: CorpusDocument;
  entries: EntryRow[];
  windows: WindowRow[];
  chunks: Chunk[];
  retrievalHash: string;
  documentHash: string;
  effectiveDurationS: number;
  durationEstimated: boolean;
}

function qualityFlagsForSpeech(speech: CorpusDocument['transcript'][number]): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  if (speech.endSeconds !== null && speech.endSeconds === speech.startSeconds) {
    flags.zeroDuration = true;
  }
  if (speech.endSeconds === null) {
    flags.missingEnd = true;
  }
  if (/\[inaudible\]/i.test(speech.text)) {
    flags.inaudible = true;
  }
  return flags;
}

function prepare(doc: CorpusDocument): Prepared {
  const entries: EntryRow[] = [];

  for (const speech of doc.transcript) {
    const speaker = mapSpeaker(speech.speaker);
    entries.push({
      sourceId: speech.id,
      kind: 'parole',
      startS: speech.startSeconds,
      endS: speech.endSeconds,
      chunkIndex: speech.chunkIndex ?? null,
      speaker: speaker.speaker,
      speakerRaw: speaker.speakerRaw,
      speakerId: speech.speakerId,
      speakerIsNamed: speaker.speakerIsNamed,
      planTitle: null,
      text: speech.text,
      screenText: null,
      uncertainties: [],
      qualityFlags: qualityFlagsForSpeech(speech),
      screenTextNorm: null,
      normText: normalizeText(speech.text),
      searchText: speech.text,
      textHash: textHash(speech.text),
    });
  }

  for (const visual of doc.visualSegments) {
    const searchText = [visual.visualDescription, visual.title, ...visual.screenText].join('\n');
    entries.push({
      sourceId: visual.id,
      kind: 'visuel',
      startS: visual.startSeconds,
      endS: visual.endSeconds,
      chunkIndex: visual.chunkIndex ?? null,
      speaker: null,
      speakerRaw: null,
      speakerId: null,
      speakerIsNamed: false,
      planTitle: visual.title,
      text: visual.visualDescription,
      screenText: visual.screenText,
      uncertainties: visual.uncertainties ?? [],
      qualityFlags: {},
      screenTextNorm: normalizeText(visual.screenText.join('\n')),
      normText: normalizeText(searchText),
      searchText,
      textHash: textHash(searchText),
    });
  }

  const declared = doc.source.durationSeconds;
  const maxBound = entries.reduce(
    (max, entry) => Math.max(max, entry.endS ?? entry.startS),
    0,
  );
  const effectiveDurationS = declared ?? maxBound;
  const durationEstimated = declared === null;
  const windows = generateWindows(effectiveDurationS);
  const windowParams = { windowSeconds: WINDOW_SECONDS, stepSeconds: STEP_SECONDS, formatVersion: FORMAT_VERSION };

  const entryWindowIndices = entries.map((entry) =>
    windowsForEntry(windows, entry.startS, entry.endS),
  );
  const windowRows: WindowRow[] = windows.map((win, winIndex) => {
    const inWindow = entries.filter((_, entryIndex) =>
      entryWindowIndices[entryIndex]?.includes(winIndex),
    );
    const formatEntries: FormatEntry[] = inWindow.map((entry) => ({
      sourceId: entry.sourceId,
      kind: entry.kind,
      startS: entry.startS,
      endS: entry.endS,
      text: entry.text,
      speaker: entry.speaker,
      isVoiceOver: entry.speakerRaw !== null && mapSpeaker(entry.speakerRaw).isVoiceOver,
      speakerIsNamed: entry.speakerIsNamed,
      planTitle: entry.planTitle,
      screenText: entry.screenText,
      uncertainties: entry.uncertainties,
    }));
    const text = formatWindow(
      {
        videoId: doc.videoId,
        title: doc.source.title,
        publishedAt: doc.source.publicationDate,
        startS: win.startS,
        endS: win.endS,
      },
      formatEntries,
    );
    return {
      startS: win.startS,
      endS: win.endS,
      text,
      nEntries: inWindow.length,
      params: windowParams,
    };
  });

  const chunks = generateChunks(doc.source.title, entries, effectiveDurationS);

  const retrievalHash = sha256(
    canonicalJson({
      derivation: {
        version: DERIVATION_VERSION,
        brands: BRANDS_VERSION,
        windows: { windowSeconds: WINDOW_SECONDS, stepSeconds: STEP_SECONDS, formatVersion: FORMAT_VERSION },
        chunks: { seconds: CHUNK_SECONDS, formatVersion: CHUNK_FORMAT_VERSION },
      },
      videoId: doc.videoId,
      source: doc.source,
      youtubeDescription: doc.youtubeDescription,
      provenance: { model: doc.provenance.model, promptVersion: doc.provenance.promptVersion },
      quality: doc.quality,
      transcript: doc.transcript,
      visualSegments: doc.visualSegments,
    }),
  );
  const documentHash = sha256(canonicalJson(doc));

  return {
    doc,
    entries,
    windows: windowRows,
    chunks,
    retrievalHash,
    documentHash,
    effectiveDurationS,
    durationEstimated,
  };
}

export async function ingestDocument(
  pool: Pool,
  fileLabel: string,
  raw: string,
): Promise<IngestFileResult> {
  let parsed: unknown;
  try {
    parsed = parseCorpusJson(raw);
  } catch (err) {
    throw new IngestError(fileLabel, `JSON illisible : ${err instanceof Error ? err.message : String(err)}`);
  }
  const validated = validateCorpusDocument(parsed);
  if (!validated.ok) {
    throw new IngestError(fileLabel, validated.issues.join(' ; '));
  }
  const prepared = prepare(validated.doc);
  const videoId = validated.doc.videoId;

  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ragator:publish'))");
    const existing = await getVideoState(client, videoId);
    const derivedUpToDate =
      existing !== null &&
      existing.retrievalHash === prepared.retrievalHash &&
      existing.derivationVersion === DERIVATION_VERSION;

    if (derivedUpToDate && existing.documentHash === prepared.documentHash) {
      return {
        file: fileLabel,
        videoId,
        status: 'unchanged' as const,
        durationEstimated: prepared.durationEstimated,
        entries: prepared.entries.length,
        windows: prepared.windows.length,
      };
    }

    // Statistiques seules : ni entrées, ni fenêtres, ni vecteurs réécrits.
    if (derivedUpToDate) {
      await updateVideoStats(client, {
        videoId,
        views: validated.doc.publicStats.views,
        comments: validated.doc.publicStats.comments,
        contentHash: validated.doc.contentHash,
        documentHash: prepared.documentHash,
        generatedAt: validated.doc.generatedAt,
      });
      return {
        file: fileLabel,
        videoId,
        status: 'stats_only' as const,
        durationEstimated: prepared.durationEstimated,
        entries: prepared.entries.length,
        windows: prepared.windows.length,
      };
    }

    await upsertVideo(client, {
      videoId,
      title: validated.doc.source.title,
      url: validated.doc.source.url,
      channel: validated.doc.source.channel,
      publishedAt: validated.doc.source.publicationDate,
      durationS: validated.doc.source.durationSeconds,
      effectiveDurationS: prepared.effectiveDurationS,
      views: validated.doc.publicStats.views,
      comments: validated.doc.publicStats.comments,
      description: validated.doc.youtubeDescription,
      descriptionBlocks: buildDescriptionBlocks(videoId, validated.doc.youtubeDescription),
      provenance: validated.doc.provenance,
      quality: validated.doc.quality,
      contentHash: validated.doc.contentHash,
      documentHash: prepared.documentHash,
      contentHashVersion: CONTENT_HASH_VERSION,
      retrievalHash: prepared.retrievalHash,
      derivationVersion: DERIVATION_VERSION,
      reviewRequired: validated.doc.quality.reviewRequired,
      generatorModel: validated.doc.provenance.model,
      promptVersion: validated.doc.provenance.promptVersion,
      generatedAt: validated.doc.generatedAt,
    });

    await upsertEntries(client, videoId, prepared.entries);
    await deleteEntriesNotIn(
      client,
      videoId,
      prepared.entries.map((entry) => entry.sourceId),
    );
    await replaceWindows(client, videoId, prepared.windows);
    await replaceChunks(client, videoId, prepared.chunks);
    const corpusVersion = await recomputeCorpusVersion(client);
    await refreshIndexVersion(client);
    await ensureJob(client, {
      type: 'embed',
      scope: videoId,
      targetHash: prepared.retrievalHash,
      version: corpusVersion,
    });

    return {
      file: fileLabel,
      videoId,
      status: 'ingested' as const,
      durationEstimated: prepared.durationEstimated,
      entries: prepared.entries.length,
      windows: prepared.windows.length,
    };
  });
}

export class IngestError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`[${file}] ${message}`);
    this.name = 'IngestError';
  }
}

/** Ingère fichiers et dossiers ; un fichier invalide n'arrête pas les autres. */
export async function ingestPaths(pool: Pool, paths: string[]): Promise<IngestReport> {
  const report: IngestReport = { results: [], failures: [] };
  const files: string[] = [];
  for (const path of paths) {
    try {
      files.push(...listCorpusFiles(path));
    } catch (err) {
      report.failures.push({ file: path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const file of files) {
    try {
      const raw = readFileSync(file, 'utf8');
      const result = await ingestDocument(pool, file, raw);
      report.results.push(result);
    } catch (err) {
      report.failures.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}
