import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { corpusLine, listCollections, resolveCollection } from '../../src/core/collections.js';
import { listerVideos } from '../../src/core/list-videos.js';
import { chercher } from '../../src/core/search.js';
import { repondre } from '../../src/core/answer.js';
import { resolveFollowUp } from '../../src/core/followup.js';
import { createWebServer } from '../../src/web/server.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

/**
 * Deux chaînes dans la même base : la vidéo de la glacière (Gu8bnHQaG5s, NordVPN, Peltier) reste aux
 * Frères Poulain, l'autre fixture passe à une chaîne fictive. Chaque recherche limitée à une collection
 * ne doit rien rendre de l'autre.
 */
(dbAvailable ? describe : describe.skip)('collections', () => {
  let pool: Pool;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    const report = await ingestPaths(pool, [FIXTURES_DIR]);
    expect(report.failures).toEqual([]);
    await pool.query(`UPDATE videos SET channel = 'L''Atelier Test, bricolage et essais' WHERE video_id = 'cKRqOdTi5yE'`);
    // Le cache des collections suit la version du corpus : la changer comme le ferait une ingestion.
    await pool.query(`UPDATE corpus_meta SET value = '"collections-test"' WHERE key = 'corpus_version'`);
    vi.stubEnv('RAGATOR_PUBLIC_URL', 'https://ragator.example.org');
    vi.stubEnv('RAGATOR_GATEWAY_SECRET', 'test-secret-for-integration-only');
    try {
      server = createWebServer(pool, { password: null, hosts: [] });
    } finally { vi.unstubAllEnvs(); }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool(pool);
  });

  it('une collection par chaîne, nommée avant la virgule, clé sans accents ni apostrophe', async () => {
    const list = await listCollections(pool);
    expect(list.map((c) => [c.key, c.name, c.videos])).toEqual(
      expect.arrayContaining([
        ['les-freres-poulain', 'Les Freres Poulain', 1],
        ['l-atelier-test', "L'Atelier Test", 1],
      ]),
    );
    expect(await resolveCollection(pool, "l'atelier TEST")).toBe('l-atelier-test');
    await expect(resolveCollection(pool, 'inconnue')).rejects.toThrow(/collections : .*les-freres-poulain/);
  });

  it('ligne « Corpus » des prompts : une chaîne ou toutes', async () => {
    expect(await corpusLine(pool, 'les-freres-poulain')).toBe(
      'Corpus : vidéos YouTube de la chaîne « Les Freres Poulain, French DIY and Tech Explorers ».',
    );
    const all = await corpusLine(pool);
    expect(all).toContain('des chaînes');
    expect(all).toContain('« L\'Atelier Test, bricolage et essais »');
  });

  it('invité : voit et interroge seulement sa collection, puis perd son accès au retrait du groupe', async () => {
    const headers = { host: 'ragator.example.org', origin: 'https://ragator.example.org', 'content-type': 'application/json', 'remote-user': 'ami',
      'remote-groups': 'ragator-collection-l-atelier-test', 'x-ragator-gateway': 'test-secret-for-integration-only' };
    function guest(path: string, body?: object) {
      return new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request(base + path, { method: body ? 'POST' : 'GET', headers }, async res => {
          const chunks = [];
          for await (const chunk of res) chunks.push(chunk);
          resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() });
        });
        req.on('error', reject);
        req.end(body && JSON.stringify(body));
      });
    }
    const session = await guest('/api/guest/session');
    expect(session.status).toBe(200);
    expect(JSON.parse(session.text).collections.map((c: { key: string }) => c.key)).toEqual(['l-atelier-test']);
    const question = 'Toutes les vidéos où on parle de NordVPN';
    for (const collection of ['', 'les-freres-poulain', undefined]) {
      expect((await guest('/api/guest/ask', { question, collection })).status).toBe(403);
    }
    const result = await guest('/api/guest/ask', { question, collection: 'l-atelier-test' });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text).sources).toEqual([]);
    headers['remote-groups'] = 'ragator-collection-les-freres-poulain';
    const allowed = await guest('/api/guest/ask', { question, collection: 'les-freres-poulain' });
    expect(JSON.parse(allowed.text).sources[0].link).toContain('Gu8bnHQaG5s');
    for (const path of ['/api/settings', '/api/admin/videos', '/api/collections', '/api/gateway', '/healthz']) {
      expect(await guest(path)).toEqual({ status: 404, text: '' });
    }
    headers.origin = 'https://autre.example';
    expect((await guest('/api/guest/ask', { question, collection: 'les-freres-poulain' })).status).toBe(403);
    headers['remote-groups'] = 'ragator-invites';
    expect((await guest('/api/guest/session')).status).toBe(403);
  });

  it('décompte et recherche limités à la collection', async () => {
    const poulain = await listerVideos(pool, { term: 'NordVPN', scope: 'paroles', collection: 'les-freres-poulain' });
    expect(poulain.data.totalEntries).toBe(9);
    const other = await listerVideos(pool, { term: 'NordVPN', scope: 'paroles', collection: 'l-atelier-test' });
    expect(other.data.totalEntries).toBe(0);
    expect(other.data.videos).toEqual([]);

    const found = await chercher(pool, { query: 'module Peltier', limit: 5 });
    expect(found.data.results.some((r) => r.videoId === 'Gu8bnHQaG5s')).toBe(true);
    const filtered = await chercher(pool, { query: 'module Peltier', limit: 5, collection: 'l-atelier-test' });
    expect(filtered.data.results.every((r) => r.videoId === 'cKRqOdTi5yE')).toBe(true);
  });

  it('réponse et relance limitées à la collection', async () => {
    const answer = await repondre(pool, { question: 'À quoi sert le module Peltier ?', mode: 'extractif', collection: 'l-atelier-test' });
    expect(answer.sources.every((s) => s.videoId === 'cKRqOdTi5yE')).toBe(true);

    const history = [{ question: 'x', videoIds: ['cKRqOdTi5yE'] }];
    const elsewhere = await resolveFollowUp(pool, 'et celle sur les glacières ?', history, 'l-atelier-test');
    expect(elsewhere.clarify).toContain('aucune vidéo');
    const here = await resolveFollowUp(pool, 'et celle sur les glacières ?', history, 'les-freres-poulain');
    expect(here.videoId).toBe('Gu8bnHQaG5s');
  });

  it('web : liste des collections, question limitée, collection inconnue refusée', async () => {
    const listed = (await (await fetch(`${base}/api/collections`)).json()) as { collections: Array<{ key: string }> };
    expect(listed.collections.map((c) => c.key).sort()).toEqual(['l-atelier-test', 'les-freres-poulain']);

    const ask = (collection: string) =>
      fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'À quoi sert le module Peltier ?', mode: 'extractif', collection }),
      });
    const limited = (await (await ask('les-freres-poulain')).json()) as { sources: Array<{ videoId: string }> };
    expect(limited.sources.length).toBeGreaterThan(0);
    expect(limited.sources.every((s) => s.videoId === 'Gu8bnHQaG5s')).toBe(true);
    const unknown = await ask('pas-une-chaine');
    expect(unknown.status).toBe(400);
  });

  it('administration : chiffres d’une chaîne, bilan par chaîne, vidéos marquées de leur chaîne', async () => {
    type Status = {
      stats: { collection: string | null; videos: number; entries: { parole: number; visuel: number }; chunks: { total: number } };
      channels: Array<{ key: string; videos: number; entries: number; chunks: { total: number } }>;
    };
    const status = async (q = '') => (await (await fetch(`${base}/api/admin/status${q}`)).json()) as Status;
    const all = await status();
    expect(all.stats.collection).toBeNull();
    expect(all.channels.map((c) => c.key).sort()).toEqual(['l-atelier-test', 'les-freres-poulain']);

    const one = await status('?collection=les-freres-poulain');
    expect(one.stats.collection).toBe('les-freres-poulain');
    expect(one.stats.videos).toBe(1);
    const own = all.channels.find((c) => c.key === 'les-freres-poulain')!;
    expect(one.stats.entries.parole + one.stats.entries.visuel).toBe(own.entries);
    expect(one.stats.chunks.total).toBe(own.chunks.total);
    // Les chaînes se partagent le corpus sans recouvrement.
    const sum = all.channels.reduce((n, c) => n + c.entries, 0);
    expect(sum).toBe(all.stats.entries.parole + all.stats.entries.visuel);

    expect((await fetch(`${base}/api/admin/status?collection=pas-une-chaine`)).status).toBe(400);
    const { videos } = (await (await fetch(`${base}/api/admin/videos`)).json()) as { videos: Array<{ videoId: string; collection: string }> };
    expect(videos.find((v) => v.videoId === 'cKRqOdTi5yE')?.collection).toBe('l-atelier-test');
  });
});
