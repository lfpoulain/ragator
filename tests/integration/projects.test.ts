import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repondre, turnOf } from '../../src/core/answer.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { mentionsProject, namedProjectVideos, otherProjectEpisodes } from '../../src/core/projects.js';
import { closePool } from '../../src/db/pool.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { dbAvailable, fakeLlm, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

const first = 'Gu8bnHQaG5s', second = 'cKRqOdTi5yE', collection = 'les-freres-poulain';
const scene = { videoId: first, sourceId: first + ':v00055', startS: 316 };
const detail = 'Pourquoi les cheminées ont-elles été ajoutées au devis ?';
const pending = { question: detail, videoIds: [first], scenes: [scene], offeredEpisodeSearch: true };

describe('nom de projet proposé par le modèle', () => {
  it('reconnaît les articles et la notation des dimensions en gardant les vrais noms et unités', () => {
    expect(mentionsProject('Un support pour le plateau de 1,80 m ?', 'plateau de 1m80')).toBe(true);
    expect(mentionsProject('Le cadeau pour enfants', 'cadeau des enfants')).toBe(true);
    expect(mentionsProject('Le plateau de 1,80 m', 'plateau de 1,80 cm')).toBe(false);
    expect(mentionsProject('Le plateau pour les grands enfants', 'plateau en acajou')).toBe(false);
  });
});

(dbAvailable ? describe : describe.skip)('recherche dans les autres épisodes', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
    await pool.query('UPDATE videos SET title=$1 WHERE video_id=$2', ['Radio portative en noyer, prototype du châssis de 1M80 (EP01)', first]);
    await pool.query('UPDATE videos SET title=$1 WHERE video_id=$2', ['Radio portative en noyer, montage du cadran (EP02)', second]);
  });
  afterAll(async () => { await closePool(pool); });

  it('filtre tous les projets nommés ou laisse la recherche ouverte', async () => {
    expect(await namedProjectVideos(pool, ['châssis de 1,80 m'], collection)).toEqual([first]);
    expect(new Set(await namedProjectVideos(pool, ['châssis', 'cadran'], collection))).toEqual(new Set([first, second]));
    expect(await namedProjectVideos(pool, ['châssis', 'piano'], collection)).toBeNull();
    expect(await namedProjectVideos(pool, ['châssis'], 'ailleurs')).toBeNull();
    expect(await namedProjectVideos(pool, [], collection, 'Dans la radio portative en noyer, montage du cadran, où est la vis ?')).toEqual([second]);
    expect(await namedProjectVideos(pool, [], collection, 'Comment assemblent-ils une radio portative ?')).toBeNull();
  });

  it('vérifie l’accord puis cherche la question en attente uniquement dans la suite choisie', async () => {
    let selected = 0;
    const llm: LlmClient = { model: 'test', available: async () => true, chat: async (system, user) => {
      if (system.startsWith('Le spectateur accepte')) {
        const menu = JSON.parse(user);
        expect(menu.detailDemande).toBe(detail);
        expect(menu.candidats).toEqual([{ id: 'p1', titre: expect.stringContaining('EP02') }]);
        selected++;
        return JSON.stringify({ episodes: ['p1'] });
      }
      const line = user.split('\n').find(l => /^\[s\d+ /.test(l) && /allaient tomber/i.test(l));
      expect(line).toBeDefined();
      return JSON.stringify({ refus: false, claims: [{ text: 'Les cheminées allaient tomber.', preuve: 'allaient tomber', sourceIds: [line!.match(/^\[(s\d+) /)![1]] }] });
    } };
    const options = { llm, analyzer: null, embedder: null, judge: null };
    const history = [{ ...pending, question: 'Qui construit ce projet ?', offeredEpisodeSearch: false }, pending];
    const answer = await repondre(pool, { question: 'Oui, vas-y.', history, collection, expand: false, mode: 'court' }, options);
    expect(selected).toBe(1);
    expect(answer, answer.answer).toMatchObject({ refused: false, resolvedQuestion: detail, consideredVideoIds: [second] });
    expect(turnOf(answer).videoIds).toEqual([second]);
    expect(answer.answer).toContain('09:17');
    expect(turnOf(answer).offeredEpisodeSearch).toBeUndefined();
  });

  it('un refus conserve le minutage et consomme l’offre sans appel au modèle', async () => {
    const llm = fakeLlm('inattendu');
    const reply = await repondre(pool, { question: 'Non merci.', history: [pending], collection }, { llm });
    expect(turnOf(reply).scenes).toEqual([scene]);
    expect(turnOf(reply).offeredEpisodeSearch).toBeUndefined();
    expect(llm.calls).toBe(0);
  });

  it('écarte les épisodes inventés ainsi que les repères d’une autre collection', async () => {
    const llm = fakeLlm(JSON.stringify({ episodes: [second] }));
    expect(await otherProjectEpisodes(pool, llm, [first], [detail], collection)).toBeNull();
    const reply = await repondre(pool, { question: 'Oui', history: [pending], collection: 'ailleurs' }, { llm });
    expect(reply.route).toBe('clarifier');
    expect(reply.sources).toEqual([]);
    expect(llm.calls).toBe(1);
  });

  it('un sujet autonome ouvre une recherche quand une offre était en attente', async () => {
    const reply = await repondre(pool, { question: 'Toutes les vidéos où on parle de NordVPN', history: [pending], collection, mode: 'extractif' });
    expect(reply.route).toBe('lister');
    expect(reply.retrieval).not.toBe('scènes citées');
  });
});
