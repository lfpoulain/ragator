import { createHash } from 'node:crypto';
import { TEXT_PREP_VERSION } from './versions.js';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export function textHash(searchText: string): string {
  return sha256(`${TEXT_PREP_VERSION}\u0000${searchText}`);
}

export function corpusVersionFrom(retrievalHashes: string[], derivationVersion: string): string {
  const sorted = [...retrievalHashes].sort();
  return sha256(`corpus-v1|${derivationVersion}|${sorted.join('\n')}`);
}
