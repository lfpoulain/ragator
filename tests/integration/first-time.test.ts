import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ingestPaths } from '../../src/core/ingest.js';
import { scanChronologically } from '../../src/core/first-time.js';
import { closePool } from '../../src/db/pool.js';
import type { RelevanceJudge } from '../../src/providers/judge.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

/** Juge simulé : une probabilité par moment, selon le titre de la vidéo ; compte les décisions. */
function judgeBy(probability: (title: string) => number): RelevanceJudge & { decisions: number } {
  const judge = {
    model: 'juge-simule',
    decisions: 0,
    async judge(_question: string, videos: Array<{ title: string; text: string }>) {
      judge.decisions += videos.length;
      return videos.map((v) => probability(v.title));
    },
  };
  return judge;
}

// Deux vidéos de test citent « collaboration » : la glacière (13/08/2026), puis le manoir (02/09/2026).
const subject = { term: 'collaboration', forms: ['collaboration'] };
const glaciere = (title: string) => /glaci/i.test(title);

(dbAvailable ? describe : describe.skip)('parcours chronologique « la première / dernière fois »', () => {
  let pool: Pool;
  const scan = (judge: RelevanceJudge, order: 'premiere' | 'derniere' = 'premiere') =>
    scanChronologically(pool, 'La première fois qu’ils parlent de collaboration', order, subject, [], judge, 0.4);

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('la plus ancienne vidéo retenue répond, examinée moment par moment', async () => {
    const judge = judgeBy(() => 0.9);
    const found = await scan(judge);
    expect(found).toMatchObject({ examined: 1, candidates: 2, relevance: 0.9 });
    expect(new Set(found!.passages.map((p) => p.videoId))).toEqual(new Set(['Gu8bnHQaG5s']));
    // Chaque moment où le sujet apparaît reçoit sa propre décision.
    expect(judge.decisions).toBeGreaterThan(2);
  });

  it('une vidéo écartée par le juge laisse répondre la suivante ; « dernière » part de la plus récente', async () => {
    expect((await scan(judgeBy((title) => (glaciere(title) ? 0.1 : 0.9))))!.passages[0]!.videoId).toBe('cKRqOdTi5yE');
    expect((await scan(judgeBy(() => 0.9), 'derniere'))!.passages[0]!.videoId).toBe('cKRqOdTi5yE');
  });

  it('aucune vidéo retenue, ou sujet absent du corpus : null (le chemin général prend le relais)', async () => {
    expect(await scan(judgeBy(() => 0.1))).toBeNull();
    const absent = await scanChronologically(pool, 'q', 'premiere', { term: 'zorglub', forms: ['zorglub'] }, [], judgeBy(() => 0.9), 0.4);
    expect(absent).toBeNull();
  });
});
