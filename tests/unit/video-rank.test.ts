import { describe, expect, it } from 'vitest';
import { rankByVideo, videoScore } from '../../src/core/video-rank.js';

const w = (videoId: string, score: number) => ({ videoId, score });

describe('recherche par vidéo', () => {
  it('cumule les fenêtres avec des rendements décroissants', () => {
    expect(videoScore([0.2, 0.4, 0.1])).toBeCloseTo(0.4 + 0.2 * 0.25 + 0.1 * 0.0625);
  });

  it('une vidéo qui revient souvent passe devant une vidéo à un seul passage à peine meilleur', () => {
    // A : un passage un peu plus fort ; C : cinq passages moyens.
    const windows = [w('A', 0.35), w('C', 0.3), w('C', 0.3), w('C', 0.3), w('C', 0.3), w('C', 0.3), w('B', 0.2)];
    const ranked = rankByVideo(windows, { perVideo: 2, maxVideos: 10 });
    expect(ranked.map((x) => x.videoId)).toEqual(['C', 'C', 'A', 'B']);
  });

  it('une vidéo bavarde n’occupe que perVideo places, et maxVideos borne la liste', () => {
    const windows = [w('A', 0.9), w('A', 0.8), w('A', 0.7), w('B', 0.6), w('C', 0.5), w('D', 0.4)];
    expect(rankByVideo(windows, { perVideo: 1, maxVideos: 3 }).map((x) => x.videoId)).toEqual(['A', 'B', 'C']);
    expect(rankByVideo(windows, { perVideo: 2, maxVideos: 2 }).map((x) => x.score)).toEqual([0.9, 0.8, 0.6]);
  });

  it('garde le contexte le mieux classé et peut recentrer une seconde fenêtre sur une preuve', () => {
    const windows = [w('A', 0.9), w('A', 0.8), w('A', 0.7), w('B', 0.6)];
    const ranked = rankByVideo(windows, { perVideo: 2, maxVideos: 2 }, (window) =>
      window.score === 0.7 ? { ...window, source: 'geste observé' } : undefined);
    expect(ranked).toEqual([windows[0], { ...windows[2], source: 'geste observé' }, windows[3]]);
  });
});
