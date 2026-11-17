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

  it('« quand parlent-ils de X » reste une question générale, jamais un décompte de mentions', async () => {
    const a = await analyzeQuestion(pool, 'Quand parle-t-on de NordVPN ?', analyst({ route: 'lister', terme: 'NordVPN', ordre: 'aucun' }));
    expect(a.routed).toMatchObject({ route: 'chercher', general: true, term: null });
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
