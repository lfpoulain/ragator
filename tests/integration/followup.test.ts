import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { resolveFollowUp } from '../../src/core/followup.js';
import { repondre, turnOf } from '../../src/core/answer.js';
import { dbAvailable, fakeLlm, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

const GLACIERE = 'Gu8bnHQaG5s';
const MANOIR = 'cKRqOdTi5yE';

(dbAvailable ? describe : describe.skip)('relances de conversation.8', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('sans historique, la question reste telle quelle', async () => {
    expect(await resolveFollowUp(pool, 'et dans cette vidéo ?', [])).toEqual({
      question: 'et dans cette vidéo ?',
      videoId: null,
      clarify: null,
    });
  });

  it('« cette vidéo » désigne l’unique vidéo citée au tour précédent', async () => {
    const out = await resolveFollowUp(pool, 'à quel moment on parle de Parkside dans cette vidéo ?', [
      { question: 'à quoi sert le module Peltier ?', videoIds: [GLACIERE] },
    ]);
    expect(out.videoId).toBe(GLACIERE);
    expect(out.clarify).toBeNull();
  });

  it('« celle-là » et « la même vidéo » sont reconnus', async () => {
    const history = [{ question: 'q', videoIds: [GLACIERE] }];
    expect((await resolveFollowUp(pool, 'on voit quoi dans celle-là ?', history)).videoId).toBe(GLACIERE);
    expect((await resolveFollowUp(pool, 'et dans la même vidéo ?', history)).videoId).toBe(GLACIERE);
  });

  it('plusieurs vidéos citées : clarification, jamais un choix silencieux', async () => {
    const out = await resolveFollowUp(pool, 'et dans cette vidéo ?', [{ question: 'q', videoIds: [GLACIERE, MANOIR] }]);
    expect(out.clarify).toContain('plusieurs vidéos');
  });

  it('« et dans celle du manoir ? » : vidéo retrouvée par son titre, question précédente reprise', async () => {
    const out = await resolveFollowUp(pool, 'et dans celle du manoir ?', [
      { question: 'à quel moment on parle de Parkside ?', videoIds: [GLACIERE] },
    ]);
    expect(out).toEqual({ question: 'à quel moment on parle de Parkside ?', videoId: MANOIR, clarify: null });
  });

  it('une relance qui est une question complète garde ses mots et reprend seulement la vidéo', async () => {
    const out = await resolveFollowUp(pool, 'et à quel moment on parle de Parkside dans cette vidéo ?', [
      { question: 'à quoi sert le module Peltier ?', videoIds: [GLACIERE] },
    ]);
    expect(out).toEqual({ question: 'à quel moment on parle de Parkside dans cette vidéo ?', videoId: GLACIERE, clarify: null });
  });

  it('une relance elliptique complète la question précédente', async () => {
    const out = await resolveFollowUp(pool, 'et pour la batterie ?', [
      { question: 'à quoi sert le module Peltier ?', videoIds: [GLACIERE] },
    ]);
    expect(out.question).toBe('à quoi sert le module Peltier ? pour la batterie ?');
  });

  it('« et de Parkside ? » après un décompte : même intention, même portée, nouveau terme', async () => {
    const llm = fakeLlm('inutile');
    const first = await repondre(pool, { question: 'toutes les vidéos où on parle de NordVPN' }, { llm, embedder: null, analyzer: null });
    const second = await repondre(pool, { question: 'et de Parkside ?', history: [turnOf(first)] }, { llm, embedder: null, analyzer: null });
    expect(second.route).toBe('lister');
    expect(second.exhaustive).toMatchObject({ term: 'parkside', scope: 'paroles' });
    expect(llm.calls).toBe(0);
    const third = await repondre(pool, { question: 'et de Meshy ?', history: [turnOf(first), turnOf(second)] }, { llm, embedder: null, analyzer: null });
    expect(third.exhaustive).toMatchObject({ term: 'meshy', scope: 'paroles' });
  });

  it('la vidéo résolue filtre réellement la recherche', async () => {
    const result = await repondre(
      pool,
      { question: 'et dans celle du manoir ?', mode: 'extractif', history: [{ question: 'on parle de Parkside', videoIds: [GLACIERE] }] },
      { embedder: null, analyzer: null },
    );
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) expect(source.videoId).toBe(MANOIR);
  });
});
