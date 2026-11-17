export type Kind = 'parole' | 'visuel';
export type Scope = 'tout' | 'paroles' | 'visuel' | 'ecran';
export type DateRange = { from?: string; to?: string };

/**
 * Enveloppe commune des outils de consultation. La taille de chaque page
 * est bornée par le `limit` de l'outil ; `nextCursor` reprend la suite.
 */
export interface Page<T> {
  data: T;
  corpusVersion: string;
  indexVersion: string;
  truncated: boolean;
  nextCursor: string | null;
}

export interface PageInput {
  cursor?: string;
  /** Collection (créateur de contenu) à laquelle se limiter ; absente : toutes. */
  collection?: string;
}

export class CursorExpiredError extends Error {
  constructor() {
    super('CURSOR_EXPIRED');
    this.name = 'CursorExpiredError';
  }
}

export class CursorInvalidError extends Error {
  constructor(reason: string) {
    super(`CURSOR_INVALID: ${reason}`);
    this.name = 'CursorInvalidError';
  }
}

/** Clé qui lie un curseur à sa requête et aux versions publiées. */
export function cursorKey(...parts: Array<string | number>): string {
  return parts.join('|');
}

export function encodeCursorOffset(key: string, offset: number): string {
  return Buffer.from(JSON.stringify({ k: key, offset }), 'utf8').toString('base64url');
}

export function decodeCursorOffset(key: string, cursor: string): number {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorInvalidError('décodage impossible');
  }
  const candidate = payload as { k?: unknown; offset?: unknown };
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    typeof candidate.k !== 'string' ||
    typeof candidate.offset !== 'number' ||
    !Number.isInteger(candidate.offset) ||
    candidate.offset < 0
  ) {
    throw new CursorInvalidError('contenu inattendu');
  }
  if (candidate.k !== key) {
    throw new CursorExpiredError();
  }
  return candidate.offset;
}

/** Offset de départ d'une page : 0 sans curseur. */
export function pageOffset(key: string, cursor: string | undefined): number {
  return cursor === undefined ? 0 : decodeCursorOffset(key, cursor);
}

/** Construit l'enveloppe à partir d'un total connu. */
export function pageOf<T>(
  data: T,
  versions: { corpusVersion: string; indexVersion: string },
  paging: { key: string; offset: number; returned: number; total: number },
): Page<T> {
  const next = paging.offset + paging.returned;
  const truncated = next < paging.total;
  return {
    data,
    corpusVersion: versions.corpusVersion,
    indexVersion: versions.indexVersion,
    truncated,
    nextCursor: truncated ? encodeCursorOffset(paging.key, next) : null,
  };
}

export function clampLimit(limit: number | undefined, fallback: number, max = 50): number {
  if (limit === undefined) return fallback;
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.floor(limit), max));
}
