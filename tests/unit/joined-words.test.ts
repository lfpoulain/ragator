import { describe, expect, it } from 'vitest';
import { joinedWords } from '../../src/core/search.js';

describe('joinedWords', () => {
  const known = new Set(['placo', 'platre', 'placoplatre', 'nul', 'ba13']);

  it('colle deux mots voisins quand la forme collée est dans le corpus', () => {
    expect(joinedWords(['le', 'placo', 'platre', 'nul'], known)).toEqual({
      rewritten: ['le', 'placoplatre', 'nul'],
      joined: ['placoplatre'],
    });
  });

  it('ne réécrit rien sans forme collée connue', () => {
    expect(joinedWords(['placo', 'nul'], known)).toEqual({ rewritten: [], joined: [] });
  });

  it('ignore les formes collées de moins de 5 lettres', () => {
    expect(joinedWords(['ba', '13'], known)).toEqual({ rewritten: [], joined: [] });
  });
});
