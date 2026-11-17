import { describe, expect, it } from 'vitest';
import { contentTokensOf, vocabularyMisses } from '../../src/core/expansion.js';
import { parseVariants } from '../../src/prompts/expansion.js';

describe('déclencheur de l’expansion', () => {
  const corpus = ['a', 'c', 'bambu', 'brise-vue', 'surelevent', 'tasseaux'];

  it('un mot absent du corpus est signalé, même s’il commence comme un mot très court', () => {
    expect(vocabularyMisses(['claustra'], corpus)).toEqual(['claustra']);
  });

  it('une flexion (préfixe de 5 lettres) ou une forme collée n’est pas absente', () => {
    expect(vocabularyMisses(['surelever', 'bambulab', 'tasseaux'], corpus)).toEqual([]);
  });

  it('ne garde que les mots signifiants de 4 lettres ou plus', () => {
    expect(contentTokensOf('Quels sont les points importants pour fabriquer leur claustra ?')).toEqual([
      'points',
      'importants',
      'fabriquer',
      'claustra',
    ]);
  });

  it('lit les variantes du LLM de façon tolérante et sans doublon', () => {
    const raw = '```json\n{"variantes": ["brise-vue tasseaux", "Brise-vue tasseaux", "question"]}\n```';
    expect(parseVariants(raw, 'question')).toEqual(['brise-vue tasseaux']);
    expect(parseVariants('pas du JSON', 'q')).toEqual([]);
  });
});
