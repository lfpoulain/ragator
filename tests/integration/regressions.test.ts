import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMBEDDING_COLUMN_DIMS, getStoredSettings, setStoredSettings } from '../../src/config.js';
import { repondre } from '../../src/core/answer.js';
import { embedPending, resetEmbeddings } from '../../src/core/embed.js';
import { resolveFollowUp } from '../../src/core/followup.js';
import { ingestDocument, ingestPaths } from '../../src/core/ingest.js';
import { listerVideos } from '../../src/core/list-videos.js';
import { chercher } from '../../src/core/search.js';
import { validateCorpusDocument, type CorpusDocument } from '../../src/core/validate.js';
import { getMetaString } from '../../src/db/meta.js';
import { closePool } from '../../src/db/pool.js';
import type { EmbeddingClient } from '../../src/providers/embedding.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { createAdmin } from '../../src/web/admin.js';
import { createWebServer } from '../../src/web/server.js';
import { applyStoredSettings, saveSettings } from '../../src/settings.js';
import { dbAvailable, getTestPool, readFixture, resetDatabase, setupDatabase } from './helpers.js';

const OLD = 'aaaaaaaaaaa';
const NEW = 'bbbbbbbbbbb';

function document(videoId = OLD, title = 'Ancienne perceuse', date = '2020-01-01'): CorpusDocument {
  const doc = JSON.parse(readFixture('Gu8bnHQaG5s')) as CorpusDocument;
  doc.videoId = videoId;
  doc.source = { ...doc.source, title, publicationDate: date, durationSeconds: 60, url: `https://www.youtube.com/watch?v=${videoId}` };
  doc.youtubeDescription = '';
  doc.transcript = [{ id: `${videoId}:t00001`, speaker: 'Artus', speakerId: null, timestamp: '00:05', startSeconds: 5, endSeconds: 10, text: 'On utilise une perceuse pour percer le bois.' }];
  doc.visualSegments = [];
  return doc;
}

function embedder(model: string, axis: number): EmbeddingClient {
  return { model, async embed(texts) { return texts.map(() => Array.from({ length: EMBEDDING_COLUMN_DIMS }, (_, i) => i === axis ? 1 : 0)); } };
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

(dbAvailable ? describe : describe.skip)('régressions de l’audit de la codebase', () => {
  let pool: Pool;
  const directories: string[] = [];
  const directory = () => {
    const path = mkdtempSync(join(tmpdir(), 'ragator-regressions-'));
    directories.push(path);
    return path;
  };
  const ingest = (doc: CorpusDocument) => ingestDocument(pool, 'témoin', JSON.stringify(doc));

  beforeAll(async () => { pool = getTestPool(); await setupDatabase(pool); });
  beforeEach(async () => { await resetDatabase(pool); });
  afterAll(async () => {
    await closePool(pool);
    for (const path of directories) rmSync(path, { recursive: true, force: true });
  });

  it('exige un mot de passe avant toute publication réseau et empêche de le retirer à chaud', async () => {
    vi.stubEnv('RAGATOR_BIND_ADDRESS', '0.0.0.0');
    vi.stubEnv('RAGATOR_PASSWORD', '');
    const previous = getStoredSettings();
    try {
      await applyStoredSettings(pool);
      expect(() => createWebServer(pool)).toThrow('RAGATOR_PASSWORD');
      await Promise.all([saveSettings(pool, { password: 'initial' }), saveSettings(pool, { llmModel: 'test/modele' })]);
      expect(await applyStoredSettings(pool)).toMatchObject({ password: 'initial', llmModel: 'test/modele' });
      const server = createWebServer(pool);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/settings`;
        const headers = { Authorization: `Basic ${Buffer.from('user:initial').toString('base64')}`, 'Content-Type': 'application/json' };
        expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ password: '' }) })).status).toBe(400);
        expect((await fetch(url)).status).toBe(401);
        expect((await fetch(url, { headers })).status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      setStoredSettings(previous);
      vi.unstubAllEnvs();
    }
  });

  it('exige le mot de passe en local et derrière un proxy, avec une sonde dédiée', async () => {
    const corpusDir = directory();
    const server = createWebServer(pool, { password: 'secret', hosts: ['ragator.example'], corpusDir });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const status = (path: string, method: string, headers: Record<string, string>, body = '') => new Promise<number>((resolve, reject) => {
      const req = request(new URL(path, base), { method, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.end(body);
    });
    try {
      expect((await fetch(`${base}/`)).status).toBe(401);
      expect((await fetch(`${base}/api/stats`)).status).toBe(401);
      const headers = { Host: 'ragator.example', 'X-Forwarded-For': '203.0.113.10', 'Content-Type': 'application/json' };
      const body = JSON.stringify({ name: 'video.json', content: JSON.stringify(document()) });
      expect(await status('/api/admin/upload', 'POST', headers, body)).toBe(401);
      expect(readdirSync(corpusDir)).toEqual([]);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect(await status('/healthz', 'GET', { Host: 'interdit.example' })).toBe(403);
      const authorized = { ...headers, Authorization: `Basic ${Buffer.from('bot:secret').toString('base64')}` };
      expect(await status('/api/admin/upload', 'POST', authorized, body)).toBe(200);
      expect(await status('/api/stats', 'GET', authorized)).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuse le reset pendant un calcul puis réencode uniquement avec le nouveau modèle', async () => {
    await ingest(document());
    const entered = signal();
    const release = signal();
    const old = embedder('ancien', 0);
    const worker = embedPending(pool, { batchSize: 1, parallel: 1, maxBatches: 1, embedder: {
      model: old.model, async embed(texts, task) { entered.resolve(); await release.promise; return old.embed(texts, task); },
    } });
    await entered.promise;
    try {
      await expect(resetEmbeddings(pool)).rejects.toThrow('encodage est en cours');
      expect(await getMetaString(pool, 'embedding_model')).toBe('ancien');
    } finally { release.resolve(); await worker; }
    await resetEmbeddings(pool);
    expect(await getMetaString(pool, 'embedding_model')).toBeNull();
    await embedPending(pool, { embedder: embedder('nouveau', 1) });
    const { rows } = await pool.query<{ good: string; total: string }>(
      `SELECT count(*) FILTER (WHERE embedding::text LIKE '[0,1,%') AS good, count(*) AS total
       FROM (SELECT embedding FROM entries UNION ALL SELECT embedding FROM chunks) vectors`,
    );
    expect(rows[0]!.good).toBe(rows[0]!.total);
    expect(await getMetaString(pool, 'embedding_model')).toBe('nouveau');
  });

  it('publie la version du lot réussi même si le lot suivant échoue', async () => {
    await ingest(document());
    const original = embedder('interrompu', 0);
    let calls = 0;
    await expect(embedPending(pool, { batchSize: 1, parallel: 1, embedder: {
      model: original.model,
      async embed(texts, task) { if (++calls === 2) throw new Error('interruption'); return original.embed(texts, task); },
    } })).rejects.toThrow('interruption');
    expect((await pool.query('SELECT count(*) AS ready FROM entries WHERE embedding IS NOT NULL')).rows[0].ready).toBe('1');
    expect(await getMetaString(pool, 'index_version')).toMatch(/^partiel:interrompu:1\/2:/);
  });

  it('accepte un BOM au dépôt et à l’ingestion directe', async () => {
    const corpusDir = directory();
    const admin = createAdmin(pool, { corpusDir });
    const raw = JSON.stringify(document());
    expect(admin.saveUpload('bom.json', `\uFEFF${raw}`)).toMatchObject({ ok: true, status: 'nouvelle' });
    expect(readFileSync(join(corpusDir, `video--${OLD}.json`), 'utf8')).toBe(raw);
    expect(admin.saveUpload('sans-bom.json', raw)).toMatchObject({ ok: true, status: 'identique' });
    expect((await ingestPaths(pool, [corpusDir])).failures).toEqual([]);
    await expect(ingestDocument(pool, 'BOM local', `\uFEFF${JSON.stringify(document(NEW))}`)).resolves.toMatchObject({ status: 'ingested' });
  });

  it('rejette les identifiants locaux ou d’une autre vidéo avant toute écriture', async () => {
    for (const sourceId of ['t00001', `${NEW}:t00001`, `${OLD}:`]) {
      const doc = document();
      doc.transcript[0]!.id = sourceId;
      expect(validateCorpusDocument(doc).ok).toBe(false);
      await expect(ingest(doc)).rejects.toThrow('l’ID doit commencer');
    }
    expect((await pool.query('SELECT count(*) AS n FROM videos')).rows[0].n).toBe('0');
  });

  it('garde les deux vidéos quand leurs identifiants locaux ont le même suffixe', async () => {
    await ingest(document());
    await ingest(document(NEW, 'Récente perceuse', '2022-01-01'));
    const search = await chercher(pool, { query: 'perceuse', limit: 20 }, { embedder: null });
    expect(new Set(search.data.results.map((r) => r.videoId))).toEqual(new Set([OLD, NEW]));
    const answer = await repondre(pool, { question: 'perceuse', mode: 'extractif' }, { embedder: null, analyzer: null, judge: null });
    expect(new Set(answer.sources.map((s) => s.videoId))).toEqual(new Set([OLD, NEW]));
  });

  it('compte le terme réellement affiché, puis reconnaît sa présence à l’écran', async () => {
    const doc = document();
    doc.transcript = [];
    doc.visualSegments = [{ id: `${OLD}:v00001`, timestamp: '00:05', endTimestamp: '00:10', startSeconds: 5, endSeconds: 10, title: 'Perceuse', visualDescription: 'Une perceuse sur une table.', screenText: ['12 V'] }];
    await ingest(doc);
    const all = await listerVideos(pool, { term: 'perceuse' });
    expect(all.data.videos[0]!.occurrences).toEqual({ total: 1, speech: 0, visual: 1, screen: 0 });
    expect((await listerVideos(pool, { term: 'perceuse', scope: 'ecran' })).data.totalEntries).toBe(0);
    doc.visualSegments[0]!.screenText = ['Perceuse 12 V'];
    await ingest(doc);
    expect((await listerVideos(pool, { term: 'perceuse' })).data.videos[0]!.occurrences.screen).toBe(1);
    expect((await listerVideos(pool, { term: 'perceuse', scope: 'ecran' })).data.totalEntries).toBe(1);
  });

  it('après un décompte, une référence seule garde le terme et une question complète garde ses mots', async () => {
    const history = [{ question: 'Toutes les vidéos où on parle de NordVPN', videoIds: [OLD] }];
    expect(await resolveFollowUp(pool, 'Et dans cette vidéo ?', history)).toEqual({ question: history[0]!.question, videoId: OLD, clarify: null });
    expect(await resolveFollowUp(pool, 'Et à quel moment on parle de Parkside dans cette vidéo ?', history)).toEqual({ question: 'à quel moment on parle de Parkside dans cette vidéo ?', videoId: OLD, clarify: null });
    expect((await resolveFollowUp(pool, 'Et de Parkside ?', history)).question).toBe('toutes les vidéos où on parle de « Parkside »');
  });

  it.each(['premiere', 'derniere'] as const)('préserve l’ordre %s malgré la confiance et un lot rédigé à l’envers', async (order) => {
    await ingest(document());
    await ingest(document(NEW, 'Récente perceuse', '2022-01-01'));
    const writer: LlmClient = {
      model: 'rédacteur simulé', async available() { return true; },
      async chat(_system, user) {
        const videos = user.split('<video id="').slice(1).map((block) => ({
          videoId: block.slice(0, block.indexOf('"')),
          affirmation: block.includes('Ancienne perceuse') ? 'Vidéo ancienne.' : 'Vidéo récente.',
          sourceIds: [block.match(/^\[(s\d+) /m)![1]],
        }));
        return JSON.stringify({ videos: videos.reverse() });
      },
    };
    const answer = await repondre(pool, { question: `La ${order === 'premiere' ? 'première' : 'dernière'} fois qu’ils utilisent une perceuse ?`, mode: 'détaillé' }, {
      llm: writer, embedder: null, analyzer: null, judgeThreshold: 0.3,
      judge: { model: 'juge simulé', async judge(_question, videos) {
        return videos.map((video) => (video.title.includes(order === 'premiere' ? 'Ancienne' : 'Récente') ? 0.35 : 0.9));
      } },
    });
    const expected = order === 'premiere' ? 'Vidéo ancienne.' : 'Vidéo récente.';
    expect(answer.claims[0]!.text).toBe(expected);
    expect(answer.answer.split('\n')[1]).toContain(expected);
    expect(answer.answer.split('\n')[1]).toContain('pertinence incertaine, à vérifier');
  });
});
