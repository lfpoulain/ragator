import { describe, expect, it } from 'vitest';
import {
  CursorExpiredError,
  CursorInvalidError,
  clampLimit,
  cursorKey,
  decodeCursorOffset,
  encodeCursorOffset,
  pageOf,
} from '../../src/core/page.js';

describe('curseurs de pagination', () => {
  const key = cursorKey('lister|nordvpn|paroles', 'corpus-1', 'index-1');

  it('boucle encoder → décoder', () => {
    const cursor = encodeCursorOffset(key, 20);
    expect(decodeCursorOffset(key, cursor)).toBe(20);
  });

  it('rejette un curseur périmé (versions changées)', () => {
    const cursor = encodeCursorOffset(cursorKey('q', 'corpus-1', 'index-1'), 0);
    expect(() => decodeCursorOffset(cursorKey('q', 'corpus-2', 'index-1'), cursor)).toThrow(
      CursorExpiredError,
    );
    expect(() => decodeCursorOffset(cursorKey('autre-requête', 'corpus-1', 'index-1'), cursor)).toThrow(
      CursorExpiredError,
    );
  });

  it('rejette un curseur arbitraire', () => {
    expect(() => decodeCursorOffset(key, 'pas-un-curseur')).toThrow(CursorInvalidError);
    const forged = Buffer.from(JSON.stringify({ arbitrary: 'sql' }), 'utf8').toString('base64url');
    expect(() => decodeCursorOffset(key, forged)).toThrow(CursorInvalidError);
    const negative = Buffer.from(JSON.stringify({ k: key, offset: -1 }), 'utf8').toString('base64url');
    expect(() => decodeCursorOffset(key, negative)).toThrow(CursorInvalidError);
  });

  it('pageOf : curseur seulement s’il reste des éléments', () => {
    const versions = { corpusVersion: 'c', indexVersion: 'i' };
    const partial = pageOf([], versions, { key, offset: 0, returned: 10, total: 25 });
    expect(partial.truncated).toBe(true);
    expect(decodeCursorOffset(key, partial.nextCursor!)).toBe(10);
    const last = pageOf([], versions, { key, offset: 20, returned: 5, total: 25 });
    expect(last.truncated).toBe(false);
    expect(last.nextCursor).toBeNull();
  });

  it('clampLimit borne la taille demandée', () => {
    expect(clampLimit(undefined, 8)).toBe(8);
    expect(clampLimit(0, 8)).toBe(1);
    expect(clampLimit(999, 8)).toBe(50);
    expect(clampLimit(Number.NaN, 8)).toBe(8);
  });
});
