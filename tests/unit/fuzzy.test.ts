import { describe, expect, it } from 'vitest';
import { levenshtein } from '../../src/core/resolve.js';

describe('résolution floue', () => {
  it('bamblab → bambulab à distance 1', () => {
    expect(levenshtein('bamblab', 'bambulab', 2)).toBe(1);
  });

  it('peltie → peltier à distance 1', () => {
    expect(levenshtein('peltie', 'peltier', 1)).toBe(1);
  });

  it('rejette au-delà du seuil', () => {
    expect(levenshtein('bamblab', 'parkside', 1)).toBe(2);
    expect(levenshtein('xyz', 'bambulab', 2)).toBe(3);
  });

  it('2 substitutions tolérées au-delà de 8 caractères', () => {
    expect(levenshtein('collaboratoin', 'collaboration', 2)).toBe(2);
  });

  it('exact ≠ flou', () => {
    expect(levenshtein('peltier', 'peltier', 1)).toBe(0);
  });
});