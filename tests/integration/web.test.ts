import { mkdtempSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { updateCorpus } from '../../src/core/update.js';
import type { SceneRef, Turn } from '../../src/core/followup.js';
import { createWebServer } from '../../src/web/server.js';
import { closePool } from '../../src/db/pool.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

(dbAvailable ? describe : describe.skip)('mise à jour du corpus et interface web', () => {
  let pool: Pool;
  let server: Server;
  let base = '';
  // Dossier du corpus de l'administration : temporaire, jamais le vrai corpus.
  const adminDir = mkdtempSync(join(tmpdir(), 'ragator-admin-'));

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    server = createWebServer(pool, { corpusDir: adminDir, password: null, hosts: [] });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool(pool);
  });

  it('update : n’ingère que les nouveautés, relançable sans effet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ragator-update-'));
    const [first, second] = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
    copyFileSync(join(FIXTURES_DIR, first!), join(dir, first!));
    writeFileSync(join(dir, first!.replace(/\.json$/, '.local.json')), JSON.stringify({ revision: 'test' }));
    const one = await updateCorpus(pool, { dir, llm: null, embedder: null });
    expect(one.ingested).toHaveLength(1);
    expect(one).toMatchObject({ state: 'done', failures: [] });
    expect(one.notes.join(' ')).toContain('enrichissement sauté');
    // Une nouvelle vidéo arrive : seule elle est ingérée.
    copyFileSync(join(FIXTURES_DIR, second!), join(dir, second!));
    const two = await updateCorpus(pool, { dir, llm: null, embedder: null });
    expect(two.ingested).toHaveLength(1);
    expect((await updateCorpus(pool, { dir, llm: null, embedder: null })).ingested).toEqual([]);
  });

  it('web : page, réponse extractive en JSON, garde-fous hôte et type', async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Ragator</title>');

    const answer = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'À quoi sert le module Peltier ?', mode: 'extractif', history: [{ question: 'x', videoIds: ['pas-un-id'] }] }),
    });
    expect(answer.status).toBe(200);
    const data = (await answer.json()) as { sources: unknown[]; turn: { videoIds: string[] } };
    expect(data.sources.length).toBeGreaterThan(0);
    expect(data.turn.videoIds.length).toBeGreaterThan(0);

    const plain = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"question":"x"}' });
    expect(plain.status).toBe(415);
    const empty = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(empty.status).toBe(400);
  });

  it('le chat relit le repère du tour JSON lors de la relance en streaming', async () => {
    const post = (route: string, body: unknown) => fetch(base + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const first = await (await post('/api/ask', { question: 'Toutes les vidéos où on parle de NordVPN', mode: 'extractif' })).json() as { turn: Turn & { scenes: SceneRef[] } };
    expect(first.turn.scenes).toHaveLength(1);
    const scene = first.turn.scenes[0]!;
    const response = await post('/api/ask/stream', { question: 'À quel moment exactement ?', mode: 'extractif',
      history: [{ ...first.turn, scenes: [{ ...scene, excerpt: 'Texte fourni par le client' }] }] });
    const data = JSON.parse((await response.text()).trim().split('\n').at(-1)!).data;
    expect(data.retrieval).toBe('scènes citées');
    expect(data.turn.scenes).toEqual([scene]);
    expect(data.sources[0]).toMatchObject(scene);
    expect(data.sources[0].excerpt).not.toContain('Texte fourni par le client');
    expect(data.answer).toContain('01:21');
  });

  it('web : réponse au fil de l’eau, une ligne JSON par étape puis la réponse complète', async () => {
    const response = await fetch(`${base}/api/ask/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'À quoi sert le module Peltier ?', mode: 'extractif' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as { type: string; étape?: string; data?: { sources: unknown[]; turn: unknown } });
    expect(events.some((e) => e.type === 'progrès' && e.étape === 'recherche')).toBe(true);
    const last = events.at(-1)!;
    expect(last.type).toBe('résultat');
    expect(last.data!.sources.length).toBeGreaterThan(0);
    expect(last.data!.turn).toBeDefined();
  });

  it('web : erreurs de la requête rendues avec leur code, sonde de santé, questions simultanées bornées', async () => {
    const ask = (body: string) => fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const unreadable = await ask('{"question":');
    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toEqual({ error: 'JSON illisible' });
    const oversized = await ask(JSON.stringify({ question: 'x'.repeat(300_000) }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: 'requête trop longue' });

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    // Quatre questions dont le corps n'arrive jamais occupent toutes les places.
    const pending = Array.from({ length: 4 }, () => {
      const req = request(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' } });
      req.on('error', () => {});
      req.write('{');
      return req;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const busy = await ask(JSON.stringify({ question: 'Peltier ?', mode: 'extractif' }));
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('5');
    // Les clients partis libèrent leur place.
    for (const req of pending) req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await ask(JSON.stringify({ question: 'Peltier ?', mode: 'extractif' }))).status).toBe(200);
  });

  it('administration : dépôt validé, nommé par l’identifiant, puis mise à jour suivie', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bad = (await (await post('/api/admin/upload', { name: '../x.json', content: '{"schemaVersion":"2.0"}' })).json()) as { ok: boolean; issues: string[] };
    expect(bad.ok).toBe(false);
    expect(bad.issues.join(' ')).toContain('schéma');

    const [fixture] = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'));
    const content = readFileSync(join(FIXTURES_DIR, fixture!), 'utf8');
    const first = (await (await post('/api/admin/upload', { name: 'nimporte-quoi.json', content })).json()) as { ok: boolean; status: string; videoId: string };
    expect(first).toMatchObject({ ok: true, status: 'nouvelle' });
    expect(readdirSync(adminDir)).toEqual([`video--${first.videoId}.json`]);
    writeFileSync(join(adminDir, `video--${first.videoId}.local.json`), JSON.stringify({ revision: 'test' }));
    expect(((await (await post('/api/admin/upload', { name: 'bis.json', content })).json()) as { status: string }).status).toBe('identique');

    expect((await post('/api/admin/update', {})).status).toBe(202);
    let status: { job: { state: string }; corpus: { files: number; notIngested: string[] } };
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      status = (await (await fetch(`${base}/api/admin/status`)).json()) as typeof status;
    } while (status.job.state === 'running');
    expect(status.job.state).toBe('done');
    expect(status.corpus).toMatchObject({ files: 1, notIngested: [] });
    const { videos } = (await (await fetch(`${base}/api/admin/videos`)).json()) as { videos: Array<{ videoId: string }> };
    expect(videos.map((v) => v.videoId)).toContain(first.videoId);
  });
});
