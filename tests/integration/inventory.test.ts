import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repondre, turnOf } from '../../src/core/answer.js';
import { classify } from '../../src/core/classify.js';
import { inventoryBrand, inventoryFollowUp, inventoryFormat } from '../../src/core/followup.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { inventoryOfModels, inventoryText } from '../../src/core/inventory.js';
import { closePool, readSnapshot } from '../../src/db/pool.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

const original = "Fais moi la liste de tout les imprimante 3d qu'ils ont téstés";
const correction = 'Non, je veux les modèles qu’ils ont testés, pas les extraits.';

describe('unité demandée dans le chat', () => {
  it('distingue des produits, un décompte et une question sur un produit', () => {
    expect(classify(original).route).toBe('inventorier');
    expect(classify('Quelles caméras ont-ils essayées ?').route).toBe('inventorier');
    expect(classify('Quelles caméras ont-ils testées ? Avec un lien pour chacune.').route).toBe('inventorier');
    expect(classify('Liste les fichiers STL qu’ils ont testés.').route).toBe('infos');
    expect(classify('Liste toutes les vidéos où ils parlent de caméras testées').route).toBe('lister');
    expect(classify('Quels réglages ont-ils testés sur la caméra ?').route).toBe('chercher');
    expect(classify('Quelles sont les différences entre les caméras testées ?').route).toBe('chercher');
    expect(classify('Comment ont-ils testé la caméra ?').route).toBe('chercher');
  });
  it('garde la catégorie quand la relance corrige un décompte, et respecte un nouveau sujet', () => {
    const before = { question: original, videoIds: [] };
    expect(inventoryFollowUp(correction, before)).toBe(original);
    expect(inventoryFollowUp('Et les références exactes ?', before)).toBe(original);
    expect(inventoryFollowUp('Et lesquelles exactement ?', before)).toBe(original);
    expect(inventoryFollowUp('Tu peux me le dire en une phrase ?', before)).toBe(original);
    expect(inventoryFollowUp('Résume le test de la caméra en une phrase.', before)).toBeNull();
    expect(inventoryFormat('Sous forme de liste, s’il te plaît.')).toBe('liste');
    expect(inventoryBrand('Est-ce qu’on en a déjà testé chez Nacre ?')).toBe('Nacre');
    expect(inventoryBrand('Quelles différences avez-vous mesurées chez Nacre ?')).toBeNull();
    const byBrand = inventoryFollowUp('Et chez Orbe ?', before)!;
    expect(inventoryFollowUp('Et chez Nacre ?', { ...before, question: byBrand })).toBe(original + ' (uniquement la marque Nacre)');
    expect(inventoryFollowUp('Quelles caméras ont-ils testées ?', before)).toBeNull();
    expect(inventoryFollowUp('Les modèles sont-ils compatibles avec ce logiciel ?', before)).toBeNull();
    expect(inventoryFollowUp('Et les modèles ?', { question: 'Toutes les vidéos où on parle de caméras', videoIds: [] })).toContain('cameras');
  });
});

(dbAvailable ? describe : describe.skip)('liste de modèles vérifiés', () => {
  let pool: Pool;
  const scope = 'essais-inventaire', first = 'Gu8bnHQaG5s', second = 'cKRqOdTi5yE';
  beforeAll(async () => {
    pool = getTestPool(); await setupDatabase(pool); await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
    await pool.query('UPDATE videos SET channel=$1, title=$2', [scope, 'Deux caméras au banc d’essai']);
    const proof = ['Nous testons la caméra Orbe S3.', 'Nous testons la caméra Orbe S3+.', 'Nous avons simplement reçu le chargeur Cube.'];
    for (const video of [first, second]) {
      for (const [i, text] of proof.entries()) await pool.query('UPDATE entries SET text=$1 WHERE source_id=$2',
        [text, video + ':t0000' + (i + 1)]);
    }
  });
  afterAll(async () => { await closePool(pool); });

  it('rend deux modèles d’un épisode, fusionne les doublons et relit la liste dans la même collection', async () => {
    let calls = 0;
    const llm: LlmClient = { model: 'lecteur', available: async () => true, chat: async (_s, raw, options) => {
      calls++;
      const { donnees } = JSON.parse(raw);
      switch (options?.jsonSchema?.name) {
        case 'episodes_inventaire': return JSON.stringify({ items: donnees.map((_: unknown, i: number) => ({ video: i+1, noms: ['Orbe S3', 'Orbe S3+'] })) });
        case 'modeles_dans_episode': {
          const sources = donnees.sources as [number, number, string][];
          return JSON.stringify({ items: ['S3', 'S3+', 'S30'].map(modele => {
            // Le lecteur confond les deux variantes : la relecture doit relier chacune à sa propre réplique.
            const found = sources.find(s => s[2].includes('S3+.')) ?? sources[0]!;
            return { marque: 'Orbe', modele, nom: found[0], essai: found[0], citation: found[2] };
          }) });
        }
        case 'essais_attestes': return JSON.stringify({ items: donnees.map((r: {numero: number}) =>
          ({ numero: r.numero, typeObjet: 'caméra', modelePrecis: true, categorieDemandee: true, usage: 'essai_du_modele' })) });
        default: throw new Error('Appel inattendu');
      }
    } };
    const options = { llm, embedder: null, judge: null, analyzer: null };
    const input = { question: 'Quelles caméras ont-ils testées ?', mode: 'court' as const, collection: scope, expand: false };
    const result = await repondre(pool, input, options);
    expect(result.claims.map(c => c.text)).toEqual(['Orbe S3','Orbe S3+']);
    expect(result.claims.map(c => c.preuve)).toEqual(['Nous testons la caméra Orbe S3.', 'Nous testons la caméra Orbe S3+.']);
    expect(result.exhaustive).toBeNull();
    expect(result.answer).toMatch(/^Ils ont testé les modèles Orbe S3 /);
    const sources = new Map(result.sources.map(s => [s.sourceId, s]));
    const viewer = 'Je voudrais savoir quelles caméras elles ont testées.';
    expect(inventoryText(result.claims, sources, viewer, viewer)).toMatch(/^Elles ont testé/);
    const ours = 'Quelles caméras avons-nous testées ?';
    const author = await repondre(pool, { ...input, question: ours }, options);
    expect(author.answer).toMatch(/^Vous avez testé les modèles Orbe S3 /);
    const before = calls;
    const yes = await repondre(pool, { ...input, question: 'Est-ce qu’on en a déjà testé chez Orbe ?', history: [turnOf(author)] }, options);
    expect(yes.answer).toMatch(/^Oui, vous avez testé les modèles Orbe S3 /);
    expect(yes.claims).toEqual(author.claims);
    const list = await repondre(pool, { ...input, question: 'Sous forme de liste, s’il te plaît.', history: [turnOf(yes)] }, options);
    expect(list.answer.split('\n').filter(l => l.startsWith('- '))).toHaveLength(2);
    const sentence = await repondre(pool, { ...input, question: 'Tu peux me le dire en une phrase ?', history: [turnOf(list)] }, options);
    expect(sentence.answer).toMatch(/^Vous avez testé .+ et Orbe S3\+/);
    expect(sentence.sources).toEqual(yes.sources);
    for (const id of yes.citedSourceIds) expect(sentence.answer).toContain(id);
    const follow = await repondre(pool, { ...input, question: correction, history: [turnOf(result)] }, options);
    expect(follow.answer).toBe(result.answer);
    const empty = await repondre(pool, { ...input, question: 'Et chez Nacre ?', history: [turnOf(follow)] }, options);
    expect(empty.claims).toEqual([]);
    expect(empty.refused).toBe(true);
    expect(empty.answer).toContain('Nacre');
    expect(empty.answer).toMatch(/^Je n’ai retrouvé aucun modèle/);
    const back = await repondre(pool, { ...input, question: 'Et chez Orbe ?', history: [turnOf(empty)] }, options);
    expect(back.claims).toEqual(result.claims);
    expect(calls).toBe(before);
    const cold = await repondre(pool, { ...input, question: 'Est-ce qu’on en a testé chez Nacre ?', history: [{ question: ours, videoIds: [] }] }, options);
    expect(cold.claims).toEqual([]);
    expect(cold.sources).toEqual([]);
    expect(cold.answer).toMatch(/^Je n’ai retrouvé aucun modèle de Nacre/);
    const other = await repondre(pool, { ...input, collection: 'autre', question: correction, history: [turnOf(result)] }, options);
    expect(other.sources).toEqual([]);
    const callsBeforeUpdate = calls;
    await pool.query("UPDATE corpus_meta SET value=to_jsonb('nouvelle-version'::text) WHERE key='corpus_version'");
    await repondre(pool, { ...input, question: correction, history: [turnOf(result)] }, options);
    expect(calls).toBeGreaterThan(callsBeforeUpdate);
  });

  it('signale une lecture interrompue et explique le mode nécessaire pour un inventaire extractif', async () => {
    const input = { question: original, collection: scope, expand: false };
    const offline: LlmClient = { model: 'lecteur', available: async () => true, chat: async () => { throw Error('interrompu'); } };
    const options = { llm: offline, embedder: null, judge: null, analyzer: null };
    const failed = await repondre(pool, input, options);
    expect(failed.route).toBe('inventorier');
    expect(failed.degradedReason).toMatch(/lectures ont échoué/);
    expect(failed.refused).toBe(true);
    expect(failed.exhaustive).toBeNull();
    const extract = await repondre(pool, { ...input, mode: 'extractif' }, options);
    expect(extract.answer).toContain('mode court ou détaillé');
  });

  it('écarte un modèle d’une autre catégorie même si le lecteur le propose et que son essai est réel', async () => {
    await pool.query('UPDATE videos SET title=$1 WHERE video_id=$2', ['Une fraiseuse au banc d’essai', first]);
    await pool.query('UPDATE entries SET text=$1 WHERE source_id=$2', ['Nous testons la fraiseuse Nacre S7.', first + ':t00001']);
    await pool.query('UPDATE entries SET text=$1 WHERE source_id=$2', ['Certaines caméras ont aussi cet écran.', first + ':t00002']);
    const llm: LlmClient = { model: 'lecteur', available: async () => true, chat: async (_system, raw, options) => {
      const { donnees } = JSON.parse(raw);
      if (options?.jsonSchema?.name === 'episodes_inventaire') return JSON.stringify({ items: [{ video: 1, noms: ['Nacre S7'] }] });
      if (options?.jsonSchema?.name === 'modeles_dans_episode') {
        const source = (donnees.sources as [number,number,string][]).find(s => s[2].includes('Nacre S7'))!;
        return JSON.stringify({ items: [{ marque: 'Nacre', modele: 'S7', nom: source[0], essai: source[0], citation: source[2] }] });
      }
      return JSON.stringify({ items: [{ numero: 1, typeObjet: 'caméra', modelePrecis: true, categorieDemandee: true, usage: 'essai_du_modele' }] });
    } };
    const question = 'Quelles caméras ont-ils testées ?';
    const version = await readSnapshot(pool, async (_db, v) => v.corpusVersion);
    const result = await inventoryOfModels(pool, llm, question, { ...classify(question), videoId: first, term: 'caméras' },
      new Map(), new Set(), [], version, () => {});
    expect(result.failed).toBe(0);
    expect(result.claims).toEqual([]);
  });

  it('compte une seule machine lorsque les auteurs donnent son autre nom commercial', async () => {
    await pool.query('UPDATE videos SET title=$1 WHERE video_id=$2', ['Essai des caméras Orbe S3 et Nacre Pixel', first]);
    const speech = ['Voici la caméra Orbe S3.', 'Cette caméra existe sous le nom de Nacre Pixel.', 'Voici le résultat mesuré sur cette caméra.'];
    for (const [i, line] of speech.entries()) await pool.query('UPDATE entries SET text=$1 WHERE source_id=$2', [line, first + ':t0000' + (i + 1)]);
    const llm: LlmClient = { model: 'lecteur', available: async () => true, chat: async (_system, raw, options) => {
      const { donnees } = JSON.parse(raw);
      if (options?.jsonSchema?.name === 'episodes_inventaire') return JSON.stringify({ items: [{ video: 1, noms: ['Orbe S3', 'Nacre Pixel'] }] });
      if (options?.jsonSchema?.name === 'modeles_dans_episode') {
        const sources = donnees.sources as [number,number,string][];
        const find = (text: string) => sources.find(s => s[2] === text)![0];
        return JSON.stringify({ items: [['Orbe', 'S3'], ['Nacre', 'Pixel']].map(([marque, modele], i) =>
          ({ marque, modele, nom: find(speech[i]!), essai: find(speech[2]!), citation: speech[2] })) });
      }
      return JSON.stringify({ items: donnees.map((row: { numero: number }) => ({ numero: row.numero, typeObjet: 'caméra',
        modelePrecis: true, categorieDemandee: true, usage: 'essai_du_modele' })) });
    } };
    const question = 'Quelles caméras ont-ils testées ?';
    const version = await readSnapshot(pool, async (_db, v) => v.corpusVersion);
    const result = await inventoryOfModels(pool, llm, question, { ...classify(question), scope: 'paroles', videoId: first, term: 'caméras' },
      new Map(), new Set(), [], version, () => {});
    expect(result.claims.map(c => c.text)).toEqual(['Orbe S3 (aussi commercialisé sous le nom Nacre Pixel)']);
  });
});
