import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { Ajv as AjvInstance, ValidateFunction } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';

type AjvConstructor = new (options?: Record<string, unknown>) => AjvInstance;

const require = createRequire(import.meta.url);
const { Ajv } = require('ajv') as { Ajv: AjvConstructor };
const addFormats = require('ajv-formats') as FormatsPlugin;
const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCHEMA_PATH = join(PROJECT_ROOT, 'schemas', 'corpus.schema.json');

export interface CorpusProvenance {
  runId: string;
  model: string;
  promptVersion: string;
  fps: number;
  mediaResolution: string;
  chunkSeconds: number | null;
  transcriptionSource: string;
  timestampAccuracy: string;
  speakerScope: string;
}

export interface CorpusSource {
  title: string;
  url: string;
  channel: string | null;
  publicationDate: string | null;
  durationSeconds: number | null;
}

export interface CorpusPublicStats {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface CorpusSpeech {
  speaker: string;
  timestamp: string;
  text: string;
  endTimestamp?: string;
  chunkIndex?: number;
  id: string;
  startSeconds: number;
  endSeconds: number | null;
  speakerId: string | null;
}

export interface CorpusVisual {
  timestamp: string;
  endTimestamp: string;
  title: string;
  visualDescription: string;
  screenText: string[];
  uncertainties?: string[];
  chunkIndex?: number;
  id: string;
  startSeconds: number;
  endSeconds: number;
}

export interface CorpusQuality {
  reviewRequired: boolean;
  warnings: string[];
  visualCoverageRatio: number | null;
  visualGaps: Array<{ startSeconds: number; endSeconds: number }>;
  inaudibleEntries: number;
  missingSpeechEndTimes: number;
  visualUncertainties: number;
}

export interface CorpusDocument {
  schemaVersion: '2.0';
  videoId: string;
  contentHash: string;
  generatedAt: string;
  provenance: CorpusProvenance;
  source: CorpusSource;
  publicStats: CorpusPublicStats;
  youtubeDescription: string;
  transcript: CorpusSpeech[];
  visualSegments: CorpusVisual[];
  quality: CorpusQuality;
}

export type ValidationResult =
  | { ok: true; doc: CorpusDocument }
  | { ok: false; issues: string[] };

let compiled: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!compiled) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = ajv.compile(schema);
  }
  return compiled;
}

export function validateSchema(doc: unknown): ValidationResult {
  const validate = getValidator();
  if (validate(doc)) {
    return { ok: true, doc: doc as CorpusDocument };
  }
  const errors = validate.errors ?? [];
  const issues = errors.map((err: { instancePath: string; message?: string }) => {
    const path = err.instancePath === '' ? '(racine)' : err.instancePath;
    return `schéma : ${path} ${err.message ?? 'invalide'}`;
  });
  return { ok: false, issues };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** L'index alloue des fenêtres et des blocs en fonction de la durée déclarée ou estimée. */
const MAX_VIDEO_SECONDS = 24 * 60 * 60;

export function isValidPublicationDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateBusinessRules(doc: CorpusDocument): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const duration = doc.source.durationSeconds;
  let effectiveDuration = duration ?? 0;

  const checkBounds = (
    id: string,
    kind: string,
    startSeconds: number,
    endSeconds: number | null,
  ): void => {
    effectiveDuration = Math.max(effectiveDuration, startSeconds, endSeconds ?? 0);
    if (!id.startsWith(`${doc.videoId}:`) || id.length === doc.videoId.length + 1) {
      issues.push(`entrée ${id} (${kind}) : l’ID doit commencer par « ${doc.videoId}: » et avoir un suffixe`);
    }
    if (!Number.isInteger(startSeconds) || startSeconds < 0) {
      issues.push(`entrée ${id} (${kind}) : startSeconds doit être un entier >= 0`);
    }
    if (endSeconds !== null && !Number.isInteger(endSeconds)) {
      issues.push(`entrée ${id} (${kind}) : endSeconds doit être un entier ou null`);
    }
    if (endSeconds !== null && endSeconds < startSeconds) {
      issues.push(`entrée ${id} (${kind}) : endSeconds < startSeconds`);
    }
    if (duration !== null) {
      if (startSeconds > duration) {
        issues.push(`entrée ${id} (${kind}) : startSeconds hors de la durée déclarée (${duration}s)`);
      }
      if (endSeconds !== null && endSeconds > duration) {
        issues.push(`entrée ${id} (${kind}) : endSeconds hors de la durée déclarée (${duration}s)`);
      }
    }
  };

  for (const speech of doc.transcript) {
    if (seen.has(speech.id)) {
      issues.push(`ID dupliqué : ${speech.id}`);
    }
    seen.add(speech.id);
    checkBounds(speech.id, 'parole', speech.startSeconds, speech.endSeconds);
  }
  for (const visual of doc.visualSegments) {
    if (seen.has(visual.id)) {
      issues.push(`ID dupliqué : ${visual.id}`);
    }
    seen.add(visual.id);
    checkBounds(visual.id, 'plan', visual.startSeconds, visual.endSeconds);
  }
  if (effectiveDuration > MAX_VIDEO_SECONDS) {
    issues.push('durée vidéo ou horodatage supérieur à la limite d’indexation de 24 h');
  }
  if (doc.source.publicationDate !== null && !isValidPublicationDate(doc.source.publicationDate)) {
    issues.push(
      `date de publication invalide : « ${doc.source.publicationDate} » (attendu YYYY-MM-DD)`,
    );
  }
  return issues;
}

export function validateCorpusDocument(doc: unknown): ValidationResult {
  const schemaResult = validateSchema(doc);
  if (!schemaResult.ok) return schemaResult;
  const businessIssues = validateBusinessRules(schemaResult.doc);
  if (businessIssues.length > 0) return { ok: false, issues: businessIssues };
  return schemaResult;
}

/** Même lecture pour les dépôts web et les fichiers locaux, BOM UTF-8 accepté. */
export function parseCorpusJson(raw: string): unknown {
  return JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
}
