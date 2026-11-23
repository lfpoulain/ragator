import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ingestDocument, ingestPaths } from '../../src/core/ingest.js';
import { reviewOccurrence, scanChronologically } from '../../src/core/first-time.js';
import { repondre } from '../../src/core/answer.js';
import type { CorpusDocument } from '../../src/core/validate.js';
import { closePool } from '../../src/db/pool.js';
import type { RelevanceJudge } from '../../src/providers/judge.js';
import { formatTimestamp } from '../../src/windows/format.js';
import { dbAvailable, fakeLlm, FIXTURES_DIR, getTestPool, readFixture, resetDatabase, setupDatabase } from './helpers.js';

/** Juge simulé : une probabilité par moment, selon le titre de la vidéo ; compte les décisions. */
function judgeBy(probability: (title: string, text: string) => number): RelevanceJudge & { decisions: number } {
  const judge = {
    model: 'juge-simule',
    decisions: 0,
    async judge(_question: string, videos: Array<{ title: string; text: string }>) {
      judge.decisions += videos.length;
      return videos.map((v) => probability(v.title, v.text));
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
    expect(found).toMatchObject({ examined: 1, candidates: 2, confirmed: { videoId: 'Gu8bnHQaG5s', relevance: 0.9 } });
    // Chaque moment où le sujet apparaît reçoit sa propre décision.
    expect(judge.decisions).toBeGreaterThan(2);
  });

  it('une vidéo écartée par le juge laisse répondre la suivante ; « dernière » part de la plus récente', async () => {
    expect((await scan(judgeBy((title) => (glaciere(title) ? 0.1 : 0.9))))?.confirmed?.videoId).toBe('cKRqOdTi5yE');
    expect((await scan(judgeBy(() => 0.9), 'derniere'))?.confirmed?.videoId).toBe('cKRqOdTi5yE');
  });

  it('aucune vidéo retenue, ou sujet absent du corpus : null (le chemin général prend le relais)', async () => {
    expect(await scan(judgeBy(() => 0.1))).toBeNull();
    const absent = await scanChronologically(pool, 'q', 'premiere', { term: 'zorglub', forms: ['zorglub'] }, [], judgeBy(() => 0.9), 0.4);
    expect(absent).toBeNull();
  });

  describe('marque de la scie et première utilisation', () => {
    const saw = { term: 'scie plongeante', forms: ['scie plongeante'] };
    const brand = { term: 'Ryobi', forms: ['ryobi'] };
    const channel = 'atelier-temoin';
    const question = 'Quelle est la première fois qu’ils utilisent une scie plongeante Ryobi ?';
    const videoId = (n: number) => `temoin0000${n}`;
    // Le juge retient les découpes. La scène Ryobi déballée à 05:00 reçoit une note basse.
    const judgeAction = (confirmLast: boolean) => judgeBy((title, text) => {
      if (text.includes('Nous déballons') || (!confirmLast && title === 'Film 5')) return 0.1;
      return text.includes('avec la scie plongeante Ryobi') ? 0.8 : 0.95;
    });
    const scanAction = (confirm: boolean) => scanChronologically(pool, question, 'premiere', saw, [brand], judgeAction(confirm), 0.4, channel);

    beforeAll(async () => {
      for (let n = 1; n <= 5; n++) {
        const id = videoId(n);
        const doc = JSON.parse(readFixture('Gu8bnHQaG5s')) as CorpusDocument;
        doc.videoId = id;
        doc.source = { ...doc.source, title: `Film ${n}`, channel, publicationDate: `2020-01-0${n}`, durationSeconds: 400, url: `https://www.youtube.com/watch?v=${id}` };
        doc.youtubeDescription = '';
        doc.visualSegments = [];
        const lines: Array<[number, string]> = [
          [5, 'Nous découpons une planche avec la scie plongeante.'],
          [15, 'À côté, le cloueur Ryobi est posé sur la table.'],
        ];
        if (n === 4) lines.push([300, 'Nous déballons une scie plongeante Ryobi pour plus tard.']);
        if (n === 5) lines.push([300, 'Nous recoupons le panneau avec la scie plongeante Ryobi.']);
        doc.transcript = lines.map(([startSeconds, text], i) => ({
          id: `${id}:t${String(i + 1).padStart(5, '0')}`, speaker: 'Artus', speakerId: null,
          timestamp: formatTimestamp(startSeconds),
          startSeconds, endSeconds: startSeconds + 3, text,
        }));
        await ingestDocument(pool, id, JSON.stringify(doc));
      }
    });

    it('continue après quatre pistes et ne cite que le moment confirmé de la cinquième vidéo', async () => {
      const result = await scanAction(true);
      expect(result).toMatchObject({ examined: 5, candidates: 5, confirmed: { videoId: videoId(5), relevance: 0.8 } });
      expect(result!.earlier.map((v) => [v.videoId, v.relevance])).toEqual([1, 2, 3].map((n) => [videoId(n), 0.95]));
      expect(result!.confirmed!.passages.flatMap((p) => p.entries.map((e) => e.startS))).toEqual([300]);
    });

    it('garde les premières pistes incertaines sans en promouvoir une si la relation reste improuvée', async () => {
      const result = await scanAction(false);
      expect(result).toMatchObject({ examined: 5, confirmed: null });
      expect(result!.earlier.map((v) => v.videoId)).toEqual([1, 2, 3].map(videoId));
    });

    it('relit les mots d’un sujet composé dans une même fenêtre et poursuit si la scène ne confirme pas le geste', async () => {
      const verified: string[] = [];
      const compound = { term: 'Ryobi scie plongeante', forms: ['ryobi scie plongeante'] };
      const found = await scanChronologically(pool, question, 'premiere', compound, [], judgeBy(() => 0.9), 0.4, channel, null, undefined, async (video) => {
        verified.push(video.videoId);
        const proof = video.passages.flatMap((p) => p.entries).find((e) => e.text.startsWith('Nous recoupons'));
        return proof ? { text: proof.text, preuve: proof.text, sourceIds: [proof.sourceId] } : null;
      });
      expect(verified).toEqual([1, 2, 3, 4, 5].map(videoId));
      expect(found?.confirmed?.claim?.sourceIds).toEqual([`${videoId(5)}:t00003`]);
    });

    it('confirme une formulation indirecte avec une marque seulement sur la ligne réelle qui démontre le geste', async () => {
      const compound = { term: 'plongeante scie', forms: ['plongeante scie'] };
      const llm = {
        ...fakeLlm(''),
        async chat(_system: string, prompt: string) {
          const line = prompt.split('\n').find((s) => s.startsWith('[s') && s.includes('Nous recoupons'));
          return JSON.stringify({ statut: line ? 'observe' : 'absent', sourceId: line?.match(/\[(s\d+) /)?.[1] ?? 'aucun' });
        },
      };
      const found = await scanChronologically(pool, question, 'premiere', compound, [brand], judgeBy(() => 0.9), 0.4, channel, null, undefined,
        (video) => reviewOccurrence(video, question, [brand], llm));
      expect(found?.confirmed?.claim?.sourceIds).toEqual([`${videoId(5)}:t00003`]);
    });

    it('exige chaque détail cumulatif dans les lignes qui relient le sujet, et accepte les alternatives explicites', async () => {
      const bosch = { term: 'Bosch', forms: ['bosch'] };
      const find = (q: string) => scanChronologically(pool, q, 'premiere', saw, [brand, bosch], judgeAction(true), 0.4, channel);
      expect((await find('Quels passages présentent une scie Ryobi et Bosch ?'))?.confirmed).toBeNull();
      expect((await find('Quels passages présentent une scie Ryobi ou Bosch ?'))?.confirmed?.videoId).toBe(videoId(5));
    });

    it.each([false, true])('sépare les pistes incertaines de la réponse courte et du streaming (confirmation %s)', async (confirmed) => {
      const analyzer = fakeLlm(JSON.stringify({ route: 'chercher', generale: true, ordre: 'premiere', sujet: saw.term, exigences: [brand.term] }));
      const llm = {
        ...fakeLlm(''),
        async chat(_system: string, prompt: string) {
          const proved = prompt.includes('Nous recoupons');
          const entry = prompt.split('\n').find((line) => line.startsWith('[s') && line.includes(proved ? 'Nous recoupons' : 'Nous découpons'));
          return JSON.stringify({ statut: proved ? 'observe' : 'indice', sourceId: entry?.match(/\[(s\d+) /)?.[1] ?? 'aucun' });
        },
      };
      const previews: string[] = [];
      const result = await repondre(pool, { question, mode: 'court', collection: channel }, {
        analyzer, llm, judge: judgeAction(confirmed), judgeThreshold: 0.4, embedder: null,
        onProgress: (p) => { if (p.étape === 'lignes') previews.push(p.answer); },
      });
      expect(result.retrieval).toBe('chronologique');
      if (confirmed) {
        expect(result.answer).toMatch(/^Première occurrence confirmée[^\n]*\n« Nous recoupons/);
        expect(result.claims.find((c) => !c.missing)).toMatchObject({ relevance: 0.8, sourceIds: [`${videoId(5)}:t00003`] });
      } else {
        expect(result.answer).toMatch(/^Aucune occurrence confirmée/);
        expect(result.claims.every((c) => c.missing)).toBe(true);
      }
      expect(result.answer).toContain('à vérifier');
      expect(result.claims.filter((c) => c.missing).map((c) => c.relevance)).toEqual([0.95, 0.95, 0.95]);
      expect(previews).toHaveLength(1);
      expect(previews[0]).toContain('à vérifier');
    });
  });
});
