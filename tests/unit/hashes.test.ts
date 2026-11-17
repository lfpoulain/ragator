import { describe, expect, it } from 'vitest';
import { canonicalJson, corpusVersionFrom, sha256, textHash } from '../../src/core/hashes.js';

describe('hashes', () => {
  it('canonicalJson trie les clés et préserve l’ordre des tableaux', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([{ x: 1 }, { y: 2 }])).toBe('[{"x":1},{"y":2}]');
    expect(canonicalJson({ a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1}}');
  });

  it('document_hash est insensible à l’ordre des clés du JSON source', () => {
    const docA = JSON.parse('{"videoId":"x","title":"t"}');
    const docB = JSON.parse('{"title":"t","videoId":"x"}');
    expect(sha256(canonicalJson(docA))).toBe(sha256(canonicalJson(docB)));
  });

  it('corpus_version est indépendante de l’ordre des vidéos', () => {
    const a = corpusVersionFrom(['h1', 'h2'], '1');
    const b = corpusVersionFrom(['h2', 'h1'], '1');
    expect(a).toBe(b);
    expect(corpusVersionFrom(['h1'], '1')).not.toBe(a);
  });

  it('text_hash lie le texte exact à la version de préparation', () => {
    expect(textHash('abc')).toBe(textHash('abc'));
    expect(textHash('abc')).not.toBe(textHash('abd'));
    expect(textHash('abc')).toMatch(/^[a-f0-9]{64}$/);
  });
});
