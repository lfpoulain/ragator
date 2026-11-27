import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { repondreAgent } from '../../src/core/agent.js';
import { repondre } from '../../src/core/answer.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { closePool } from '../../src/db/pool.js';
import { AGENT_PROMPT } from '../../src/prompts/agent.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

const QUESTION = 'À quoi sert le module Peltier ?';
const written = JSON.stringify({ refus: false, claims: [{ text: 'Le module Peltier refroidit la glacière.', sourceIds: ['Gu8bnHQaG5s:t00061'] }] });

/** Première source du dossier montré à l'agent : son alias et ses premiers mots, à recopier comme preuve. */
function firstSource(dossier: string): { alias: string; words: string } {
  const line = /^\[(s\d+) [^\]]*\] (.+)$/m.exec(dossier)!;
  return { alias: line[1]!, words: line[2]!.split(/\s+/).slice(0, 5).join(' ') };
}

/** Modèle simulé : rédacteur habituel pour `repondre`, et `turns` (un par appel) pour la boucle d'approfondissement. */
function scripted(turns: Array<(dossier: string) => unknown>): LlmClient & { agentCalls: string[] } {
  const client = {
    model: 'llm-simule',
    agentCalls: [] as string[],
    async chat(system: string, user: string) {
      if (system !== AGENT_PROMPT) return written;
      client.agentCalls.push(user);
      return JSON.stringify(turns[client.agentCalls.length - 1]!(user));
    },
    async available() {
      return true;
    },
  };
  return client;
}

(dbAvailable ? describe : describe.skip)('réponse approfondie (modèle simulé, sans réseau)', () => {
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

  it('complète le dossier (relecture, autre question), puis rédige une réponse dont chaque phrase est prouvée', async () => {
    const llm = scripted([
      (dossier) => ({ bilan: 'usage établi, détail à relire', refus: false, phrases: [], recherches: [
        { outil: 'lire', requete: '', source: firstSource(dossier).alias },
        { outil: 'chercher', requete: 'Comment la glacière est-elle refroidie ?', source: '' },
        { outil: 'chercher', requete: QUESTION, source: '' },
      ] }),
      (dossier) => {
        const { alias, words } = firstSource(dossier);
        return { bilan: 'suffisant', recherches: [], refus: false, phrases: [
          { forme: 'puce', titre: 'Module Peltier', texte: 'il refroidit la glacière.', preuve: words, sourceIds: [alias], incertain: false },
          { forme: 'puce', titre: 'Inventé', texte: 'il chauffe aussi le café.', preuve: 'il chauffe aussi le café du matin', sourceIds: [alias], incertain: false },
        ] };
      },
    ]);
    const progress: string[] = [];
    const result = await repondreAgent(pool, { question: QUESTION }, { llm, embedder: null, analyzer: null,
      onProgress: (p) => { if (p.étape === 'approfondissement') progress.push(p.outil); } });
    // La question déjà posée n'est pas reposée ; les deux autres actions s'exécutent.
    expect(result.agent).toMatchObject({ composed: true, steps: [{ outil: 'lire' }, { outil: 'chercher' }] });
    expect(progress.sort()).toEqual(['chercher', 'lire']);
    expect(llm.agentCalls[1]).toContain('<lecture');
    expect(result.refused).toBe(false);
    expect(result.answer).toMatch(/^- \*\*Module Peltier\*\* : il refroidit la glacière\. \[Gu8bnHQaG5s:t\d{5} @ \d\d:\d\d\]$/);
    expect(result.answer).not.toContain('café');
    expect(result.claims).toHaveLength(1);
    expect(result.sources.every((s) => s.videoId === 'Gu8bnHQaG5s')).toBe(true);
    expect(result.citedSourceIds.length).toBeGreaterThan(0);
  });

  it('rend la réponse habituelle quand rien de rédigé ne tient, ou que la synthèse est illisible', async () => {
    const direct = await repondre(pool, { question: QUESTION }, { llm: scripted([]), embedder: null, analyzer: null });
    const unproven = await repondreAgent(pool, { question: QUESTION }, { embedder: null, analyzer: null, llm: scripted([
      (dossier) => ({ bilan: '', recherches: [], refus: false, phrases: [
        { forme: 'paragraphe', titre: '', texte: 'Il sert à tout.', preuve: 'une phrase que personne ne dit', sourceIds: [firstSource(dossier).alias], incertain: false }] }),
    ]) });
    expect(unproven.answer).toBe(direct.answer);
    expect(unproven.agent).toEqual({ steps: [], composed: false });
    const broken = await repondreAgent(pool, { question: QUESTION }, { embedder: null, analyzer: null, llm: scripted([() => 'pas un objet']) });
    expect(broken.answer).toBe(direct.answer);
    expect(broken.degradedReason).toContain('synthèse');
  });

  it('rédige aussi l’introduction d’un décompte exact et garde sa liste complète ; rien sans modèle', async () => {
    const question = 'Toutes les vidéos où on parle de NordVPN';
    const exact = await repondre(pool, { question }, { llm: null, embedder: null, analyzer: null });
    const llm = scripted([(dossier) => {
      const { alias, words } = firstSource(dossier);
      return { bilan: 'décompte fait', recherches: [], refus: false, phrases: [
        { forme: 'paragraphe', titre: '', texte: 'NordVPN revient comme partenaire.', preuve: words, sourceIds: [alias], incertain: false }] };
    }]);
    const counted = await repondreAgent(pool, { question }, { llm, embedder: null, analyzer: null });
    expect(counted.route).toBe('lister');
    expect(llm.agentCalls[0]).toContain('Réponse calculée par le code');
    expect(counted.agent).toEqual({ steps: [], composed: true });
    expect(counted.answer.startsWith('NordVPN revient comme partenaire. [')).toBe(true);
    expect(counted.answer.endsWith(exact.answer)).toBe(true);
    expect(counted.sources.map((s) => s.sourceId)).toEqual(exact.sources.map((s) => s.sourceId));
    expect(counted.exhaustive).toEqual(exact.exhaustive);
    const none = await repondreAgent(pool, { question: QUESTION }, { llm: null, embedder: null, analyzer: null });
    expect(none.agent).toBeUndefined();
    expect(none.model).toBeNull();
  });
});
