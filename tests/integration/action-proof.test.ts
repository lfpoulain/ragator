import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getStoredSettings, setStoredSettings } from '../../src/config.js';
import { repondre } from '../../src/core/answer.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { closePool } from '../../src/db/pool.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { dbAvailable, fakeLlm, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

// La transcription réelle des Frères Poulain oppose une batterie Ryobi utilisée auparavant (04:10)
// à la batterie Parkside retenue pour la glacière (04:26).
const question = 'Quelle marque de batterie utilisent-ils pour la glacière, Ryobi ou Parkside, dans la vidéo Gu8bnHQaG5s ?';
const clue = 'Ryobi, on a déjà utilisé';
const answer = 'Glacière Parkside, entretoise Parkside, batterie Parkside.';
function quoted(user: string, proof: string, claim: string, refuse: boolean): string {
  const line = user.split('\n').find((l) => l.startsWith('[s') && l.includes(proof));
  expect(line, proof).toBeDefined();
  return JSON.stringify({ refus: refuse, claims: [{ preuve: proof, text: claim, sourceIds: [line!.match(/^\[(s\d+) /)![1]] }] });
}

(dbAvailable ? describe : describe.skip)('preuve d’usage dans la glacière des Frères Poulain', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
  });
  afterAll(async () => { await closePool(pool); });

  async function ask(reply: (user: string, attempt: number) => string, asked = question) {
    let calls = 0;
    const llm: LlmClient = { model: 'rédacteur simulé', available: async () => true, chat: async (_system, user) => reply(user, ++calls) };
    const result = await repondre(pool,
      { question: asked, collection: 'les-freres-poulain', mode: 'court', expand: false },
      { llm, analyzer: null, embedder: null, judge: null },
    );
    return { calls, result };
  }

  it('accepte le choix établi en une seule rédaction', async () => {
    const { result, calls } = await ask((user) => quoted(user, answer, 'La batterie de la glacière est une Parkside.', false));
    expect(calls).toBe(1);
    expect(result.claims[0]).toMatchObject({ preuve: answer, sourceIds: ['Gu8bnHQaG5s:t00072'] });
  });

  it('relit une seule scène après un souvenir attribué à tort au projet', async () => {
    const { result, calls } = await ask((user, attempt) => attempt === 1
      ? quoted(user, clue, 'Ils utilisent une batterie Ryobi pour cette glacière.', false)
      : quoted(user, answer, 'La batterie de ce projet est une Parkside.', false));
    expect(calls, result.degradedReason ?? result.answer).toBe(2);
    expect(result.citedSourceIds).toEqual(['Gu8bnHQaG5s:t00072']);
    expect(result.answer).toContain('Parkside');
    expect(result.answer).not.toContain('Ryobi');
  });

  it('rend uniquement la citation vérifiable si la relecture reste indécise', async () => {
    const { result, calls } = await ask((user) => quoted(user, clue, 'Une batterie Ryobi alimente cette glacière.', true));
    expect(calls, result.degradedReason ?? result.answer).toBe(2);
    expect(result.claims[0]).toMatchObject({ preuve: clue, missing: expect.any(String), sourceIds: ['Gu8bnHQaG5s:t00068'] });
    expect(result.answer).not.toContain('alimente');
  });

  it('une question qui impose une marque ne se satisfait pas d’une réponse générique sur les batteries', async () => {
    const { result } = await ask((user) => quoted(user, 'avec une batterie de perceuse par exemple', 'Ils alimentent la glacière avec une batterie de perceuse.', false),
      'Comment utilisent-ils une batterie Ryobi pour leur glacière dans la vidéo Gu8bnHQaG5s ?');
    expect(result.claims[0]?.missing).toContain('nom demandé');
    expect(result.answer).not.toContain('Ils alimentent');
  });

  it('une parole seule ne confirme pas que le geste est visible à l’image', async () => {
    let words = '';
    const { result } = await ask((user) => {
      const spoken = user.split('\n').find((line) => /^\[s\d+ [^\]]+\] PAROLE/.test(line) && /batterie/i.test(line));
      words ||= spoken?.split(' : ')[1]?.split(/\s+/).slice(0, 12).join(' ') ?? '';
      expect(words).not.toBe('');
      return quoted(user, words, 'Ils montent la batterie devant la caméra.', false);
    }, 'Où les voit-on monter la batterie sur la glacière dans la vidéo Gu8bnHQaG5s ?');
    expect(result.claims[0]?.missing, [result.route, result.degradedReason, result.answer].join(' ')).toContain('image');
    expect(result.answer).not.toContain('devant la caméra');
  });

  it('conserve la piste vérifiée si le modèle échoue pendant la relecture', async () => {
    const { result, calls } = await ask((user, attempt) => {
      if (attempt === 2) throw new Error('requête de test interrompue');
      return quoted(user, clue, 'Ils utilisent une batterie Ryobi pour cette glacière.', false);
    });
    expect(calls).toBe(2);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('relecture');
    expect(result.claims[0]?.missing).toBeDefined();
  });

  it('un refus sans indice ne déclenche aucune relecture', async () => {
    const { result, calls } = await ask(() => JSON.stringify({ refus: true, claims: [] }));
    expect(calls).toBe(1);
    expect(result.refused).toBe(true);
  });

  it('une rédaction hors format sur un geste précis conserve la ligne classée comme piste horodatée', async () => {
    const { result } = await ask(() => '{"refus":false,"claims":[', 'Comment ont-ils installé la batterie dans la vidéo Gu8bnHQaG5s ?');
    expect(result.degradedReason).toContain('hors du format');
    expect(result.claims).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source.videoId).toBe('Gu8bnHQaG5s');
    expect(source.startS).not.toBeNull();
    expect(result.claims[0]).toMatchObject({ text: `« ${source.excerpt} »`, preuve: source.excerpt, sourceIds: [source.sourceId], missing: expect.any(String) });
    expect(result.answer).toContain('Éventuellement');
  });

  it('rattache la proposition coordonnée au souhait formulé juste avant dans le manoir', async () => {
    const { result, calls } = await ask((user) => quoted(user, "Et qu'on joue à GTA VI devant le poêle à bois.",
      'Ils souhaitent jouer à GTA VI devant le poêle à bois après la rénovation.', false),
      'À quel moment jouent-ils vraiment à GTA VI devant le poêle du manoir ?');
    expect(result.citedSourceIds).toEqual(['cKRqOdTi5yE:t00177', 'cKRqOdTi5yE:t00179']);
    expect(result.answer).toContain('souhaitent');
    expect(calls).toBe(1);
  });

  it.each(['local', 'openrouter'] as const)('une formulation nouvelle utilise le contrat sémantique en mode %s', async (mode) => {
    const settings = getStoredSettings();
    try {
      setStoredSettings({ mode, openrouterKey: 'test-sans-reseau' });
      const analyzer = fakeLlm(JSON.stringify({ route: 'chercher', generale: false, action: true }));
      let calls = 0;
      const writer: LlmClient = { model: 'simulé', available: async () => true, async chat(_system, user, options) {
        calls++;
        expect(JSON.stringify(options?.jsonSchema)).toContain('"preuve"');
        return quoted(user, answer, 'La glacière reçoit une batterie Parkside.', false);
      } };
      const result = await repondre(pool, {
        question: 'Quelle marque de batterie les frères ont-ils retenue pour la glacière dans la vidéo Gu8bnHQaG5s ?',
        collection: 'les-freres-poulain', mode: 'court', expand: false,
      }, { analyzer, llm: writer, embedder: null, judge: null });
      expect(result.analysis?.action).toBe(true);
      expect(result.claims[0]?.preuve).toBe(answer);
      expect(analyzer.calls).toBe(1);
      expect(calls).toBe(1);
    } finally {
      setStoredSettings(settings);
    }
  });
});
