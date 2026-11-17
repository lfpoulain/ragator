import { describe, expect, it } from 'vitest';
import { pickBySense, type SenseHit } from '../../src/core/first-time.js';

const hit = (videoId: string, publishedAt: string, startS: number, rank: number): SenseHit => ({ videoId, publishedAt, startS, rank });

describe('candidates par le sens du parcours chronologique', () => {
  it('écarte les candidates exactes et garde les plus anciennes, ou les plus récentes', () => {
    const lists = [[hit('A', '2021-01-01', 10, 0), hit('X', '2015-01-01', 10, 1), hit('B', '2019-01-01', 10, 2), hit('C', '2023-01-01', 10, 3)]];
    expect(pickBySense(lists, new Set(['X']), 'premiere').map((p) => p.videoId)).toEqual(['B', 'A', 'C']);
    expect(pickBySense(lists, new Set(['X']), 'derniere').map((p) => p.videoId)).toEqual(['C', 'A', 'B']);
  });

  it('ne garde que les 8 plus anciennes parmi les 24 plus proches', () => {
    // 30 vidéos : la plus proche est la plus récente ; les 6 plus anciennes sont les plus lointaines.
    const list = Array.from({ length: 30 }, (_, rank) => hit(`v${rank}`, `${2050 - rank}-01-01`, 0, rank));
    const picked = pickBySense([list], new Set(), 'premiere').map((p) => p.videoId);
    expect(picked).toEqual(['v23', 'v22', 'v21', 'v20', 'v19', 'v18', 'v17', 'v16']);
  });

  it('cumule les listes de voisins : une vidéo proche de la question et de l’extrait hypothétique passe devant', () => {
    const asked = [hit('A', '2020-01-01', 0, 0), hit('B', '2020-01-01', 0, 1)];
    const imagined = [hit('B', '2020-01-01', 0, 0)];
    // Même date : à égalité de date, l'ordre de proximité est conservé.
    expect(pickBySense([asked, imagined], new Set(), 'premiere').map((p) => p.videoId)).toEqual(['B', 'A']);
  });

  it('retient au plus 3 moments distincts par vidéo, dans l’ordre du film', () => {
    const list = [hit('A', '2020-01-01', 600, 0), hit('A', '2020-01-01', 630, 1), hit('A', '2020-01-01', 100, 2), hit('A', '2020-01-01', 900, 3), hit('A', '2020-01-01', 1200, 4)];
    expect(pickBySense([list], new Set(), 'premiere')[0]!.moments).toEqual([100, 600, 900]);
  });
});
