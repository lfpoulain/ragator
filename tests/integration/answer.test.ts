import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ingestPaths } from '../../src/core/ingest.js';
import { repondre, type AnswerInput } from '../../src/core/answer.js';
import { buildPassages } from '../../src/core/passages.js';
import { chercher } from '../../src/core/search.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { closePool } from '../../src/db/pool.js';
import { dbAvailable, fakeLlm, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

/** Sortie structurée du LLM simulé : `[texte, identifiants]` par affirmation. */
function claims(...items: Array<[string, string[]]>): string {
  return JSON.stringify({ refus: false, claims: items.map(([text, sourceIds]) => ({ text, sourceIds })) });
}

function failingLlm(): LlmClient {
  return {
    model: 'llm-en-panne',
    async chat() {
      throw new Error('réseau indisponible');
    },
    async available() {
      return true;
    },
  };
}

(dbAvailable ? describe : describe.skip)('couche de réponse (LLM simulé, sans réseau)', () => {
  let pool: Pool;
  const ask = (input: AnswerInput, llm: LlmClient | null) => repondre(pool, input, { llm, embedder: null, analyzer: null });

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    const report = await ingestPaths(pool, [FIXTURES_DIR]);
    expect(report.failures).toEqual([]);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('cite une preuve réelle de la glacière et la valide', async () => {
    const result = await ask(
      { question: 'À quoi sert le module Peltier ?', mode: 'court' },
      fakeLlm(claims(['Le module Peltier refroidit la glacière.', ['Gu8bnHQaG5s:t00061']])),
    );
    expect(result.refused).toBe(false);
    expect(result.citedSourceIds).toEqual(['Gu8bnHQaG5s:t00061']);
    expect(result.invalidCitations).toEqual([]);
    expect(result.sources.map((s) => s.sourceId)).toEqual(['Gu8bnHQaG5s:t00061']);
    expect(result.model).toBe('llm-simule');
  });

  it('rejette une citation inventée et bascule en extractif', async () => {
    const result = await ask(
      { question: 'Quel firmware utilise le répéteur Wi-Fi ESP32 ?', mode: 'court' },
      fakeLlm(claims(['Le firmware est X.', ['Gu8bnHQaG5s:t88888']])),
    );
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('citation');
    expect(result.invalidCitations).toContain('Gu8bnHQaG5s:t88888');
    expect(result.answer).not.toContain('Le firmware est X');
  });

  it('retire la phrase appuyée sur une citation inventée, garde les autres', async () => {
    const result = await ask(
      { question: 'À quoi sert le module Peltier ?' },
      fakeLlm(claims(['Il refroidit la glacière.', ['Gu8bnHQaG5s:t00061']], ['Il coûte 3 €.', ['Gu8bnHQaG5s:t99999']])),
    );
    expect(result.answer).toContain('refroidit');
    expect(result.answer).not.toContain('3 €');
    expect(result.invalidCitations).toEqual(['Gu8bnHQaG5s:t99999']);
  });

  it('sortie hors du format imposé : aucune phrase gardée, repli extractif', async () => {
    const result = await ask(
      { question: 'À quoi sert le module Peltier ?' },
      fakeLlm('Il refroidit la glacière [Gu8bnHQaG5s:t00061 @ 03:41]. La glacière coûte 9999 euros.'),
    );
    expect(result.degradedReason).toContain('hors du format');
    expect(result.answer).not.toContain('9999');
    expect(result.claims).toEqual([]);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('conserve le refus explicite sans source', async () => {
    const result = await ask(
      { question: 'Comment construire un système aquaponique ?', mode: 'court' },
      fakeLlm(JSON.stringify({ refus: true, claims: [] })),
    );
    expect(result.refused).toBe(true);
    expect(result.sources).toEqual([]);
  });

  it('bascule en extractif si le LLM échoue', async () => {
    const result = await ask({ question: 'Comment créent-ils un bouton tactile avec un ESP32 ?' }, failingLlm());
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('erreur LLM');
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('le mode extractif n’appelle jamais le LLM', async () => {
    const llm = fakeLlm('ne doit pas être appelé');
    const result = await repondre(pool, { question: 'À quoi sert le module Peltier ?', mode: 'extractif' }, { llm, embedder: null, analyzer: null });
    expect(llm.calls).toBe(0);
    // Seule la recherche peut être dégradée (base de test sans vecteurs), jamais la génération.
    expect(result.degradedReason ?? '').not.toContain('LLM');
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.answer).toContain('youtube.com/watch?v=');
  });

  it('résout une citation vidéo+timecode vers l’entrée réelle', async () => {
    const result = await ask({ question: 'À quoi sert le module Peltier ?' }, fakeLlm(claims(['Pour refroidir.', ['Gu8bnHQaG5s @ 03:41']])));
    expect(result.refused).toBe(false);
    expect(result.citedSourceIds[0]).toMatch(/^Gu8bnHQaG5s:/);
    expect(result.answer).toContain(result.citedSourceIds[0]!);
  });

  it('refuse une citation vidéo+timecode sans entrée proche', async () => {
    const result = await ask({ question: 'À quoi sert le module Peltier ?' }, fakeLlm(claims(['Pour refroidir.', ['Gu8bnHQaG5s @ 59:00']])));
    expect(result.invalidCitations).toEqual(['Gu8bnHQaG5s @ 59:00']);
    expect(result.degradedReason).toContain('sans citation vérifiable');
    expect(result.answer).not.toContain('Pour refroidir');
  });

  it('exhaustif : décompte exact rendu par le code, sans LLM', async () => {
    const llm = fakeLlm('ne doit pas être appelé');
    const result = await ask({ question: 'toutes les vidéos où on parle de NordVPN' }, llm);
    expect(llm.calls).toBe(0);
    expect(result.route).toBe('lister');
    expect(result.exhaustive).toMatchObject({ totalVideos: 1, totalEntries: 9, scope: 'paroles' });
    expect(result.answer).toContain('9 extrait(s)');
    expect(result.answer).toContain('https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=78s');
  });

  it('première mention : décompte exact trié par date, la plus ancienne vidéo en tête, sans LLM', async () => {
    const llm = fakeLlm('ne doit pas être appelé');
    const result = await ask({ question: 'La première mention de NordVPN' }, llm);
    expect(llm.calls).toBe(0);
    expect(result.route).toBe('lister');
    expect(result.answer).toMatch(/^Première vidéo qui mentionne « nordvpn »/);
    // « mention » couvre paroles et plans : le premier plan (01:18) précède la première parole.
    expect(result.answer).toContain('https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=75s');
    expect(result.answer).toContain('de la plus ancienne à la plus récente');
  });

  it('passages lus dans le même état du corpus que la recherche, sinon refusés', async () => {
    const page = await chercher(pool, { query: 'module Peltier glacière', limit: 5 }, { embedder: null });
    await expect(buildPassages(pool, page.data.results, 10_000, 'une-autre-version')).rejects.toThrow('corpus modifié');
    expect((await buildPassages(pool, page.data.results, 10_000, page.corpusVersion)).length).toBeGreaterThan(0);
  });

  it('décompte restreint à la vidéo citée', async () => {
    const llm = fakeLlm('ne doit pas être appelé');
    const ailleurs = await ask({ question: 'toutes les vidéos où on parle de NordVPN dans la vidéo cKRqOdTi5yE' }, llm);
    expect(ailleurs.route).toBe('lister');
    expect(ailleurs.refused).toBe(true);
    const ici = await ask({ question: 'toutes les vidéos où on parle de NordVPN dans la vidéo Gu8bnHQaG5s' }, llm);
    expect(ici.exhaustive).toMatchObject({ totalVideos: 1 });
    expect(llm.calls).toBe(0);
  });

  it('route infos : sources de description sans instant', async () => {
    const result = await ask({ question: 'quel est le lien du firmware de la glacière ?' }, null);
    expect(result.route).toBe('infos');
    expect(result.sources.length).toBeGreaterThan(0);
    for (const source of result.sources) {
      expect(source.startS).toBeNull();
      expect(source.link).not.toContain('&t=');
    }
  });

  it('route clarifier : demande une reformulation', async () => {
    const result = await ask({ question: 'toutes les vidéos intéressantes' }, fakeLlm('peu importe'));
    expect(result.route).toBe('clarifier');
    expect(result.refused).toBe(true);
  });

  it('question générale : JEV filtre, le LLM rédige les vidéos retenues, par probabilité décroissante', async () => {
    const prompts: string[] = [];
    const schemas: unknown[] = [];
    const writer: LlmClient = {
      model: 'redacteur-simule',
      async available() {
        return true;
      },
      async chat(_system, user, options) {
        prompts.push(user);
        schemas.push(options?.jsonSchema);
        const videos = user.split('<video id="').slice(1).map((block) => {
          const line = block.match(/^\[(s\d+) [^\]]+\] PAROLE[^\n]*? : (.+)$/m)!;
          return {
            videoId: block.slice(0, block.indexOf('"')),
            preuve: line[2]!.split(' ').slice(0, 12).join(' '),
            affirmation: 'Retenue.',
            sourceIds: [line[1]],
          };
        });
        return JSON.stringify({ videos });
      },
    };
    // Le juge garde la première vidéo candidate et écarte les autres.
    const judge = { model: 'juge-simule', judge: async (_q: string, v: unknown[]) => v.map((_, i) => (i === 0 ? 0.9 : 0.2)) };
    const result = await repondre(
      pool,
      { question: 'Quand parlent-ils de NordVPN ?', mode: 'détaillé' },
      { llm: writer, embedder: null, analyzer: null, judge, judgeThreshold: 0.5 },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split('<video id="').length - 1).toBe(1);
    expect(JSON.stringify(schemas[0])).not.toContain('pertinent');
    expect(result.claims).toEqual([expect.objectContaining({ text: 'Retenue.', relevance: 0.9 })]);
    expect(new Set(result.sources.map((s) => s.videoId)).size).toBe(1);
    expect(result.citedSourceIds.every((id) => /^[A-Za-z0-9_-]{11}:[tv]\d{5}$/.test(id))).toBe(true);
  });

  it('question générale sans JEV : réponse extractive signalée, jamais de tri au hasard', async () => {
    const llm = fakeLlm('ne doit pas être appelé');
    const result = await repondre(
      pool,
      { question: 'Quand parlent-ils de NordVPN ?', mode: 'détaillé' },
      { llm, embedder: null, analyzer: null, judge: null },
    );
    expect(llm.calls).toBe(0);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('sans juge');
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('un rédacteur sans aucune citation valable ne réintroduit pas les vidéos de la recherche brute', async () => {
    const writer = fakeLlm(JSON.stringify({ videos: [
      { videoId: 'v1', preuve: 'Des mots fictifs.', sourceIds: ['s99999'], affirmation: 'Assertion hors corpus.' },
    ] }));
    const result = await repondre(pool, { question: 'Quand parlent-ils de NordVPN ?', mode: 'détaillé' }, {
      llm: writer, analyzer: null, embedder: null, judgeThreshold: 0.4,
      judge: { model: 'juge', judge: async (_question, videos) => videos.map((_, i) => i ? 0.1 : 0.9) },
    });
    expect(result.refused).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.degradedReason).toContain('preuve vérifiable');
  });

  it('retente une rédaction générale tronquée une fois et conserve les exclusions du juge', async () => {
    const writer = fakeLlm('{"videos":[{"videoId":');
    let keptTitle = '';
    const result = await repondre(pool, { question: 'Quand parlent-ils de NordVPN ?', mode: 'détaillé' }, {
      llm: writer, analyzer: null, embedder: null, judgeThreshold: 0.4,
      judge: { model: 'juge', judge: async (_question, videos) => {
        keptTitle = videos[0]!.title;
        return videos.map((_, i) => i ? 0.1 : 0.9);
      } },
    });
    expect(writer.calls).toBe(2);
    expect(result.degradedReason).toContain('hors du format');
    expect(result.claims).toHaveLength(1);
    const source = result.sources[0]!;
    expect(source.title).toBe(keptTitle);
    expect(result.claims[0]).toMatchObject({ missing: expect.any(String), preuve: source.excerpt, sourceIds: [source.sourceId] });
    expect(result.answer).toContain('Éventuellement');
  });

  it('sortie structurée : identifiants courts du prompt rattachés aux vraies sources, schéma fermé', async () => {
    let seen: { user: string; schema: unknown } | null = null;
    const llm: LlmClient = {
      model: 'llm-structure',
      async available() {
        return true;
      },
      async chat(_system, user, options) {
        seen = { user, schema: options?.jsonSchema };
        const first = user.match(/^\[(s\d+) /m)![1];
        return JSON.stringify({ refus: false, claims: [{ text: 'Le module refroidit.', sourceIds: [first, 's99999'] }] });
      },
    };
    const result = await repondre(pool, { question: 'À quoi sert le module Peltier ?', mode: 'court' }, { llm, embedder: null, analyzer: null });
    expect(seen!.user).toMatch(/<passage titre="[^"]+" date="\d{4}-\d{2}-\d{2}" extrait="[\d:–]+">/);
    expect(seen!.user).not.toContain('identité inconnue');
    const allowed = (seen!.schema as { schema: { properties: { claims: { items: { properties: { sourceIds: { items: { enum: string[] } } } } } } } })
      .schema.properties.claims.items.properties.sourceIds.items.enum;
    expect(allowed[0]).toBe('s1');
    expect(result.citedSourceIds).toHaveLength(1);
    expect(result.citedSourceIds[0]).toMatch(/^[A-Za-z0-9_-]{11}:[tv]\d{5}$/);
    expect(result.invalidCitations).toEqual(['s99999']);
    expect(result.answer).toContain(`[${result.citedSourceIds[0]} @`);
  });
});
