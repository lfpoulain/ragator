import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ingestPaths } from '../../src/core/ingest.js';
import { analyzeQuestion } from '../../src/core/analyze.js';
import { repondre } from '../../src/core/answer.js';
import { closePool } from '../../src/db/pool.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { dbAvailable, fakeLlm, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

/** LLM simulé qui rend une analyse fixe. */
function analyst(analysis: Record<string, unknown>): LlmClient & { calls: number } {
  const client = {
    model: 'analyste-simule',
    calls: 0,
    async available() {
      return true;
    },
    async chat() {
      client.calls += 1;
      return JSON.stringify({ generale: false, terme: '', alternatives: [], motsCles: [], passage: '', ...analysis });
    },
  };
  return client;
}

(dbAvailable ? describe : describe.skip)('analyse de la question par LLM, validée par le corpus', () => {
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

  it('un décompte exact garde un terme présent dans le corpus', async () => {
    const a = await analyzeQuestion(pool, 'Dans combien de vidéos apparaît NordVPN ?', analyst({ route: 'lister', terme: 'NordVPN' }));
    expect(a.source).toBe('llm');
    expect(a.routed).toMatchObject({ route: 'lister', term: 'nordvpn' });
  });

  it('garde le projet cité par la question et distingue la lecture à l’écran du geste matériel', async () => {
    const model = analyst({ route: 'chercher', projets: ['caisson pour atelier', 'hélicoptère'], gesteObserve: true });
    const physical = await analyzeQuestion(pool, 'Comment assemblent-ils les côtés du caisson de leur atelier ?', model);
    expect(physical.projects).toEqual(['caisson pour atelier']);
    expect(physical.observed).toBe(true);
    const screen = await analyzeQuestion(pool, 'Quel texte à l’écran apparaît sur le caisson ?', model);
    expect(screen.routed.scope).toBe('ecran');
    expect(screen.observed).toBe(false);
  });

  it('un terme absent du corpus ne donne jamais de décompte : recherche générale', async () => {
    const a = await analyzeQuestion(pool, 'Combien de fois disent-ils Zorglub ?', analyst({ route: 'lister', terme: 'Zorglub' }));
    expect(a.routed).toMatchObject({ route: 'chercher', general: true, term: null });
    expect(a.note).toContain('absent du corpus');
  });

  it('première / dernière fois : les règles l’emportent sur le LLM (ordre, route, terme)', async () => {
    // Le LLM propose l'inverse de la question : ordre « dernière », terme et route faux.
    const a = await analyzeQuestion(
      pool,
      'La première mention de NordVPN',
      analyst({ route: 'chercher', generale: true, terme: 'glacière', ordre: 'derniere' }),
    );
    expect(a.routed).toMatchObject({ route: 'lister', order: 'premiere', term: 'nordvpn' });
  });

  it('dernière fois qu’ils FONT quelque chose : question générale triée par date, pas un décompte', async () => {
    const a = await analyzeQuestion(pool, 'La dernière fois où ils utilisent une visseuse', analyst({ route: 'lister', terme: 'visseuse', ordre: 'aucun' }));
    expect(a.routed).toMatchObject({ route: 'chercher', general: true, order: 'derniere', term: null });
  });

  it('le LLM ne renonce pas à chercher (« clarifier ») si les règles, elles, cherchent', async () => {
    const a = await analyzeQuestion(pool, 'Quand parle ton de moutique ?', analyst({ route: 'clarifier', ordre: 'aucun' }));
    expect(a.routed).toMatchObject({ route: 'chercher', general: true });
  });

  it('distingue la quantité observée du nombre de mentions dans le corpus', async () => {
    const model = analyst({ route: 'lister', generale: true, terme: 'module' });
    const quantity = await analyzeQuestion(pool, 'Combien de petits modules ont grillé pendant le test ?', model);
    expect(quantity.routed).toMatchObject({ route: 'chercher', general: false, term: null });
    const mentions = await analyzeQuestion(pool, 'Combien de mentions du module figurent dans le corpus ?', model);
    expect(mentions.routed.route).toBe('lister');
  });

  it('conserve l’analyse fraîche et corrige les lectures concurrentes de deux outils de même technologie', async () => {
    const question = 'Quand utilisent-ils une ponceuse ou une fraiseuse pneumatique ?';
    const first = analyst({ route: 'chercher', action: true, generale: true, ciblesGeste: [['ponceuse', 'fraiseuse', 'pneumatique']], passage: 'Premier passage proposé.' });
    const second = analyst({ route: 'chercher', action: false, generale: true, ciblesGeste: [['ponceuse', 'fraiseuse'], ['pneumatique']], passage: 'Nouveau passage proposé.' });
    const a = await analyzeQuestion(pool, question, first);
    const b = await analyzeQuestion(pool, question, second);
    expect(a.source).toBe('llm');
    expect(b.source).toBe('llm');
    expect(a.hypothetical).toBe('Premier passage proposé.');
    expect(b.hypothetical).toBe('Nouveau passage proposé.');
    expect(a.actionTargets).toEqual(b.actionTargets);
    expect(a.actionTargets.map(g => g.map(t => t.term))).toEqual([['ponceuse', 'fraiseuse'], ['pneumatique']]);
    expect((await analyzeQuestion(pool, question, null)).actionTargets).toEqual(a.actionTargets);
  });

  it('conserve la cible et le parcours multi-vidéo si le modèle juge précise une question de geste récurrent', async () => {
    const model = analyst({ route: 'chercher', generale: false, action: true, ciblesGeste: [['bois']] });
    const repeated = await analyzeQuestion(pool, 'Quand tournent-ils du bois ?', model);
    expect(repeated.routed).toMatchObject({ route: 'chercher', general: true });
    expect(repeated.actionTargets[0]?.[0]?.term).toBe('bois');
    const particular = await analyzeQuestion(pool, 'Quand tournent-ils du bois pour le pied de lampe ?', model);
    expect(particular.routed).toMatchObject({ route: 'chercher', general: false });
  });

  it('« quand parlent-ils de X » reste une question générale, jamais un décompte de mentions', async () => {
    const a = await analyzeQuestion(pool, 'Quand parle-t-on de NordVPN ?', analyst({ route: 'lister', terme: 'NordVPN', ordre: 'aucun' }));
    expect(a.routed).toMatchObject({ route: 'chercher', general: true, term: null });
  });

  it('un décompte ne répond qu’à une question qui demande des vidéos ou des occurrences', async () => {
    const model = analyst({ route: 'lister', terme: 'module', ordre: 'aucun' });
    // La question attend des noms : compter le mot « module » listerait des vidéos à la place.
    const named = await analyzeQuestion(pool, 'Quelles marques de module utilisent-ils ?', model);
    expect(named.routed).toMatchObject({ route: 'chercher', general: true, term: null });
    expect(named.note).toContain('ni vidéos ni occurrences');
    // « Quels X ont-ils testés » n'a plus de chemin à part : c'est une question générale comme une autre.
    const tried = await analyzeQuestion(pool, 'Quels modules ont-ils testés ?', analyst({ route: 'chercher', generale: true }));
    expect(tried.routed).toMatchObject({ route: 'chercher', general: true });
    const counted = await analyzeQuestion(pool, 'Quelles vidéos citent le module ?', model);
    expect(counted.routed).toMatchObject({ route: 'lister', term: 'module' });
  });

  it('l’aiguillage demande une réponse stable (température 0)', async () => {
    const seen: Array<number | undefined> = [];
    const llm = analyst({ route: 'chercher', generale: true, ordre: 'aucun' });
    const chat = llm.chat.bind(llm);
    llm.chat = async (system, user, options) => {
      seen.push(options?.temperature);
      return chat(system, user, options);
    };
    await analyzeQuestion(pool, 'Quand parle-t-on de NordVPN ?', llm);
    expect(seen).toEqual([0]);
  });

  it('les mots-clés absents du corpus sont écartés, la portée reste celle des règles', async () => {
    const a = await analyzeQuestion(
      pool,
      'Quand parle-t-on du module Peltier ?',
      analyst({ route: 'chercher', generale: true, motsCles: ['glacière', 'refroidir', 'zorglubium', 'Peltier'], passage: 'Le Peltier refroidit.' }),
    );
    expect(a.routed.general).toBe(true);
    expect(a.keywords).toContain('glacière');
    expect(a.keywords).not.toContain('zorglubium');
    expect(a.note).toContain('zorglubium');
    expect(a.hypothetical).toBe('Le Peltier refroidit.');
  });

  it('une route étroite (plan, infos) proposée sans accord des règles devient une recherche classée', async () => {
    const a = await analyzeQuestion(
      pool,
      'Dans la vidéo de la glacière, à quel moment parle-t-on du module Peltier ?',
      analyst({ route: 'plan', terme: 'module Peltier glacière' }),
    );
    expect(a.routed).toMatchObject({ route: 'chercher', term: null });
    expect(a.note).toContain('sans accord des règles');
    const plan = await analyzeQuestion(pool, 'Où voit-on un Peltier ?', analyst({ route: 'plan', terme: 'Peltier' }));
    expect(plan.routed).toMatchObject({ route: 'plan', term: 'peltier' });
  });

  it('exigences : marque ou modèle imposé, ramené à une forme du corpus ; sans LLM, les marques connues', async () => {
    const a = await analyzeQuestion(
      pool,
      'La première fois qu’ils utilisent une glacière Peltier',
      analyst({ route: 'chercher', generale: true, ordre: 'premiere', exigences: ['Peltiier'] }),
    );
    // Faute de frappe corrigée sur le vocabulaire du corpus.
    expect(a.required).toEqual([{ term: 'Peltiier', forms: ['peltier'] }]);
    expect(a.note).toContain('exigence « Peltiier » lue « peltier »');
    const none = await analyzeQuestion(pool, 'Quand parlent-ils du module Peltier ?', analyst({ route: 'chercher', generale: true }));
    expect(none.required).toEqual([]);
    expect((await analyzeQuestion(pool, 'La première fois qu’ils utilisent une visseuse Ryobi', null)).required).toEqual([{ term: 'ryobi', forms: ['ryobi'] }]);
  });

  it('conserve des matières alternatives imposées par un geste sans inventer celle proposée par l’analyse', async () => {
    const answer = await analyzeQuestion(pool, 'Quand découpent-ils du feutre ou du cuir ?', analyst({
      route: 'chercher', generale: true, action: true, ciblesGeste: [['feutre', 'cuir', 'zinc']],
    }));
    expect(answer.actionTargets.map((group) => group.map((term) => term.term))).toEqual([['feutre', 'cuir']]);
  });

  it('reprend une analyse tronquée une seule fois et conserve la cible du geste', async () => {
    const limits: number[] = [];
    const truncated = '{"route":"chercher","motsCles":["module",';
    const complete = JSON.stringify({ route: 'chercher', generale: true, action: true, ciblesGeste: [['module']] });
    let second = complete;
    const llm: LlmClient = { model: 'analyse simulée', available: async () => true, chat: async (_system, _prompt, options) => {
      limits.push(options?.maxTokens ?? 0);
      return limits.length === 1 ? truncated : second;
    } };
    const question = 'Quand utilisent-ils un module ?';
    const recovered = await analyzeQuestion(pool, question, llm);
    expect(recovered.source).toBe('llm');
    expect(recovered.actionTargets[0]?.[0]?.term).toBe('module');
    expect(limits).toEqual([400, 800]);
    second = truncated;
    limits.length = 0;
    expect((await analyzeQuestion(pool, question, llm)).source).toBe('règles');
    expect(limits).toEqual([400, 800]);
  });

  it('sans LLM, ou si sa sortie est illisible, les règles décident', async () => {
    expect((await analyzeQuestion(pool, 'toutes les vidéos où on parle de NordVPN', null)).source).toBe('règles');
    const broken = { ...fakeLlm('pas du JSON'), model: 'casse' };
    const a = await analyzeQuestion(pool, 'toutes les vidéos où on parle de NordVPN', broken);
    expect(a).toMatchObject({ source: 'règles', routed: { route: 'lister', term: 'nordvpn' } });
  });

  it('le mode extractif n’appelle aucun LLM, même pour analyser', async () => {
    const llm = analyst({ route: 'chercher', generale: true });
    const result = await repondre(pool, { question: 'Quand parle-t-on du module Peltier ?', mode: 'extractif' }, { llm, embedder: null });
    expect(llm.calls).toBe(0);
    expect(result.analysis).toBeNull();
  });
});
