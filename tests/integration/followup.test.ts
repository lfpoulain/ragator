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

  const coolerScene = { videoId: GLACIERE, sourceId: GLACIERE + ':v00055', startS: 316 };
  const manorScene = { videoId: MANOIR, sourceId: MANOIR + ':t00017', startS: 39 };
  const compared = { question: 'Compare les deux extraits.', videoIds: [MANOIR, GLACIERE], scenes: [manorScene, coolerScene] };

  it('une comparaison garde seulement le minutage qui justifie la réponse à « laquelle »', async () => {
    const llm = { model: 'choix de test', calls: 0, available: async () => true, async chat(system: string) {
      this.calls++;
      if (system.startsWith('Tu prépares')) return JSON.stringify({ indices: ['potentiomètre'] });
      return JSON.stringify(system.startsWith('Identifie') ? { source: 's2', preuve: 'règle le potentiomètre' } : { verdict: 'direct' });
    } };
    const answer = await repondre(pool, { question: 'Dans laquelle règlent-ils un potentiomètre ?', history: [compared] }, { llm });
    expect(llm.calls).toBe(3);
    expect(answer.retrieval).toBe('scènes citées');
    expect(answer.claims[0]?.sourceIds).toEqual([coolerScene.sourceId]);
    expect(turnOf(answer).scenes).toEqual([coolerScene]);
    const at = await repondre(pool, { question: 'Tu me redonnes le minutage ?', history: [compared, turnOf(answer)] }, { llm });
    expect(at.sources).toMatchObject([coolerScene]);
    expect(at.answer).toContain('05:16');
    expect(llm.calls).toBe(3);
  });

  it('un minutage ambigu demande un choix et applique ce choix à la question en attente', async () => {
    const options = { llm: fakeLlm('inattendu') };
    const ask = await repondre(pool, { question: 'À quel moment exactement ?', history: [compared] }, options);
    expect(ask.route).toBe('clarifier');
    expect(ask.sources).toMatchObject([manorScene, coolerScene]);
    const chosen = await repondre(pool, { question: 'La deuxième.', history: [compared, turnOf(ask)] }, options);
    expect(chosen.sources).toMatchObject([coolerScene]);
    expect(chosen.answer).toContain('05:16');
    const byTime = await repondre(pool, { question: 'Celle à 05:16.', history: [compared, turnOf(ask)] }, options);
    expect(byTime.sources).toMatchObject([coolerScene]);
    const otherTime = await repondre(pool, { question: 'Celle à 01:17.', history: [turnOf(ask)] }, options);
    expect(otherTime.route).toBe('clarifier');
    expect(otherTime.answer).not.toContain('01:17');
    expect(options.llm.calls).toBe(0);
  });

  it('deux citations sur une fiche groupée gardent leurs propres secondes et leur ordre dans la réponse', async () => {
    const base = await repondre(pool, { question: 'À quel moment ?', mode: 'extractif', history: [
      { ...compared, videoIds: [GLACIERE], scenes: [coolerScene] },
    ] });
    const meter = { videoId: GLACIERE, sourceId: GLACIERE + ':v00057', startS: 326 };
    const { sceneAnchors, ...search } = base;
    expect(sceneAnchors).toEqual([coolerScene]);
    const turn = turnOf({ ...search,
      sources: [{ ...base.sources[0]!, sourceIds: [coolerScene.sourceId, meter.sourceId] }],
      answer: `Ils mesurent [${meter.sourceId} @ 05:26] après le réglage [${coolerScene.sourceId} @ 05:16].`,
    });
    expect(turn.scenes).toEqual([meter, coolerScene]);
    const choice = await repondre(pool, { question: 'La première.', mode: 'extractif', history: [turn] });
    expect(choice.sources).toMatchObject([meter]);
  });

  it('une citation présente qui ne répond pas au critère laisse le choix ouvert', async () => {
    const llm = { model: 'lecture de test', available: async () => true, chat: async (system: string) =>
      JSON.stringify(system.startsWith('Identifie') ? { source: 's2', preuve: 'règle le potentiomètre' } : { verdict: 'absent' }) };
    const answer = await repondre(pool, { question: 'Dans laquelle remplacent-ils les piles ?', history: [compared] }, { llm });
    expect(answer.refused).toBe(true);
    expect(answer.claims).toHaveLength(0);
    expect(turnOf(answer).scenes).toEqual(compared.scenes);
  });

  it('une citation hors critère ne devient pas la scène de référence quand le modèle propose un mauvais indice', async () => {
    const llm = { model: 'lecture de test', available: async () => true, chat: async (system: string) => {
      if (system.startsWith('Tu prépares')) return JSON.stringify({ indices: ['tissé', 'broderie'] });
      if (system.startsWith('Identifie')) return JSON.stringify({ source: 's2', preuve: 'règle le potentiomètre' });
      return JSON.stringify({ verdict: 'indice' });
    } };
    const answer = await repondre(pool, { question: 'Dans laquelle brodent-ils un écusson ?', history: [compared] }, { llm });
    expect(answer.refused).toBe(true);
    expect(answer.claims).toEqual([]);
    expect(turnOf(answer).scenes).toEqual(compared.scenes);
  });

  it('une réponse qui cite plusieurs vidéos garde aussi le projet du tour précédent pour la comparaison', async () => {
    const meter = { videoId: GLACIERE, sourceId: GLACIERE + ':v00057', startS: 326 };
    const llm = { model: 'comparaison de test', available: async () => true, chat: async (system: string, user: string) => {
      if (!system.startsWith('Identifie')) return JSON.stringify({ verdict: 'direct' });
      const lines = JSON.parse(user).extraits as Array<{ id: string; tour: number; extrait: string }>;
      const earlier = lines.find(s => s.tour === 1 && s.extrait.includes('Pointes de touche'));
      return JSON.stringify({ source: earlier?.id ?? 'aucune', preuve: 'Pointes de touche sur le bornier de sortie' });
    } };
    const answer = await repondre(pool, { question: 'Si on compare ces deux scènes, dans laquelle mesurent-ils la tension ?', history: [
      { question: 'Comment vérifient-ils la sortie ?', videoIds: [GLACIERE], scenes: [meter] }, compared,
    ] }, { llm });
    expect(turnOf(answer).scenes).toEqual([meter]);
    expect(answer.answer).toContain('05:26');
  });

  it('une parole ou un plan voisin peut répondre sans déplacer le repère du tour suivant', async () => {
    const history = [{ ...compared, videoIds: [GLACIERE], scenes: [coolerScene] }];
    const llm = { model: 'lecture de test', available: async () => true, chat: async (_system: string, user: string) => {
      const lines = JSON.parse(user).extraits as Array<{ id: string; extrait: string }>;
      const reading = lines.find(s => s.extrait.includes('Pointes de touche sur le bornier de sortie'));
      return JSON.stringify(reading ? { refus: false, claims: [
        { text: 'Ils posent les pointes de touche sur le bornier de sortie.', preuve: 'Pointes de touche sur le bornier de sortie', sourceIds: [reading.id] },
      ] } : { refus: true, claims: [] });
    } };
    const answer = await repondre(pool, { question: 'Que font-ils dans cette scène ?', history }, { llm });
    expect(answer.refused).toBe(false);
    expect(answer.answer).toContain('05:26');
    expect(answer.answer).toContain('05:16');
    expect(turnOf(answer).scenes).toEqual([coolerScene]);
  });

  it('la question sur le geste départage deux scènes déjà citées du même épisode', async () => {
    const meter = { videoId: GLACIERE, sourceId: GLACIERE + ':v00057', startS: 326 };
    const llm = fakeLlm(JSON.stringify({ refus: false, claims: [{
      text: 'Ils mesurent la sortie avec les pointes de touche.', preuve: 'Pointes de touche sur le bornier de sortie', sourceIds: ['s2'],
    }] }));
    const answer = await repondre(pool, { question: 'Comment mesurent-ils la sortie dans cette scène ?', history: [
      { question: 'Comment procèdent-ils ?', videoIds: [GLACIERE], scenes: [coolerScene, meter] },
    ] }, { llm });
    expect(answer.refused).toBe(false);
    expect(turnOf(answer).scenes).toEqual([meter]);
    expect(llm.calls).toBe(1);
  });

  it('un détail absent conserve son repère et refuse une valeur étrangère à la preuve', async () => {
    const llm = fakeLlm(JSON.stringify({ refus: false, claims: [
      { text: 'Le réglage est de 999 watts.', preuve: 'règle le potentiomètre', sourceIds: ['s1'] },
    ] }));
    const answer = await repondre(pool, { question: 'Quelle puissance ?', history: [
      { ...compared, videoIds: [GLACIERE], scenes: [coolerScene] },
    ] }, { llm });
    expect(llm.calls).toBe(2);
    expect(answer.refused).toBe(true);
    expect(answer.answer).toContain('05:16');
    expect(answer.answer).not.toContain('999');
    expect(turnOf(answer).offeredEpisodeSearch).toBe(true);
    expect(turnOf(answer).scenes).toEqual([coolerScene]);
  });

  it('une scène supprimée, déplacée ou hors collection ne réapparaît pas au minutage fourni', async () => {
    const history = [{ ...compared, scenes: [{ ...coolerScene, startS: 17 }] }];
    const missing = await repondre(pool, { question: 'À quel moment exactement ?', history }, { llm: null });
    const elsewhere = await repondre(pool, { question: 'À quel moment exactement ?', history: [compared], collection: 'autre' }, { llm: null });
    for (const answer of [missing, elsewhere]) {
      expect(answer.route).toBe('clarifier');
      expect(answer.sources).toEqual([]);
    }
  });
});
