import type { DateRange } from './page.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string, label: string): string {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${label} invalide : « ${value} » (attendu YYYY-MM-DD)`);
  }
  return value;
}

/**
 * Filtres SQL paramétrés communs aux outils. Chaque fonction ajoute ses
 * valeurs à `params` et renvoie un fragment `AND …` (vide sans filtre).
 * Une plage de dates exclut les vidéos à date inconnue.
 */
export function dateRangeSql(range: DateRange | undefined, params: unknown[], alias = 'v'): string {
  const clauses: string[] = [];
  if (range?.from) {
    params.push(checkDate(range.from, 'dateRange.from'));
    clauses.push(`${alias}.published_at >= $${params.length}::date`);
  }
  if (range?.to) {
    params.push(checkDate(range.to, 'dateRange.to'));
    clauses.push(`${alias}.published_at <= $${params.length}::date`);
  }
  return clauses.map((c) => `AND ${c}`).join(' ');
}

/** Restreint à une collection (un créateur de contenu) ; sans valeur, toutes. */
export function collectionSql(collection: string | undefined | null, params: unknown[], alias = 'v'): string {
  if (!collection) return '';
  params.push(collection);
  return `AND ${alias}.collection = $${params.length}`;
}

export function videoIdSql(videoId: string | undefined | null, params: unknown[], alias = 'v'): string {
  if (!videoId) return '';
  params.push(videoId);
  return `AND ${alias}.video_id = $${params.length}`;
}

/** Restreint à un ensemble de vidéos (une série nommée par la question) ; sans valeur, toutes. */
export function videoIdsSql(videoIds: readonly string[] | undefined | null, params: unknown[], alias = 'v'): string {
  if (!videoIds || videoIds.length === 0) return '';
  params.push([...videoIds]);
  return `AND ${alias}.video_id = ANY($${params.length}::text[])`;
}

/** Recouvrement d'un intervalle `[start, end]` avec une plage `[fromS, toS]`. */
export function timeRangeSql(
  range: { fromS: number; toS: number } | undefined,
  params: unknown[],
  columns: { start: string; end: string },
): string {
  if (!range) return '';
  if (!Number.isFinite(range.fromS) || !Number.isFinite(range.toS) || range.toS < range.fromS) {
    throw new Error(`timeRange invalide : ${JSON.stringify(range)}`);
  }
  params.push(Math.max(0, Math.floor(range.fromS)), Math.floor(range.toS));
  return `AND ${columns.end} > $${params.length - 1} AND ${columns.start} <= $${params.length}`;
}
