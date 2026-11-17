import { describe, expect, it } from 'vitest';
import { judgeInWaves, packVideoBatches } from '../../src/core/general.js';

const video = (id: string, ...lengths: number[]) => ({ id, texts: lengths.map((n) => 'x'.repeat(n)) });
const ids = (batches: Array<Array<{ id: string }>>) => batches.map((b) => b.map((v) => v.id));

describe('lots de rédaction', () => {
  it('au plus N vidéos par lot, dans l’ordre du classement', () => {
    const videos = ['a', 'b', 'c', 'd', 'e'].map((id) => video(id, 10));
    expect(ids(packVideoBatches(videos, 1000, 2))).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('ferme un lot avant de dépasser le budget', () => {
    const videos = [video('a', 400), video('b', 400), video('c', 300), video('d', 100)];
    expect(ids(packVideoBatches(videos, 800, 6))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('une vidéo trop longue garde ses premiers passages, au moins un, sans modifier l’original', () => {
    const long = video('a', 500, 400, 300);
    const [[packed]] = packVideoBatches([long], 950, 6) as [[typeof long]];
    expect(packed.texts.map((t) => t.length)).toEqual([500, 400]);
    expect(long.texts).toHaveLength(3);
    expect(packVideoBatches([video('b', 2000)], 100, 6)[0]![0]!.texts).toHaveLength(1);
  });
});

describe('jugement par vagues', () => {
  const videos = Array.from({ length: 400 }, (_, i) => ({ id: i }));
  const waves = { first: 150, next: 100, minYield: 0.1 };

  it('sujet étroit : une seule vague quand la suite n’apporte plus rien', async () => {
    const calls: number[] = [];
    // Pertinentes : les 20 premières seulement.
    const judged = await judgeInWaves(videos, async (wave) => {
      calls.push(wave.length);
      return wave.map((v) => (v.id < 20 ? 0.9 : 0.1));
    }, 0.3, waves);
    expect(calls).toEqual([150, 100]);
    expect(judged).toHaveLength(250);
    expect(judged.filter((v) => v.relevance >= 0.3)).toHaveLength(20);
  });

  it('sujet large : continue tant qu’une vague garde au moins 10 %', async () => {
    const calls: number[] = [];
    // Pertinentes : une sur quatre jusqu'à 300, plus rien ensuite.
    const judged = await judgeInWaves(videos, async (wave) => {
      calls.push(wave.length);
      return wave.map((v) => (v.id < 300 && v.id % 4 === 0 ? 0.8 : 0.05));
    }, 0.3, waves);
    expect(calls).toEqual([150, 100, 100, 50]);
    expect(judged.filter((v) => v.relevance >= 0.3)).toHaveLength(75);
  });
});
