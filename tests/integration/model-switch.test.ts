import { type AddressInfo } from 'node:net';
import { EventEmitter, once } from 'node:events';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setStoredSettings } from '../../src/config.js';
import { closePool } from '../../src/db/pool.js';
import { ModelSettingsChangedError } from '../../src/providers/configured-fetch.js';
import { embeddingFromConfig } from '../../src/providers/embedding.js';
import { llmFromConfig } from '../../src/providers/llm.js';
import { judgeFromConfig } from '../../src/providers/judge.js';
import { saveSettings } from '../../src/settings.js';
import { createWebServer } from '../../src/web/server.js';
import { dbAvailable, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

(dbAvailable ? describe : describe.skip)('confidentialité lors du changement de mode', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    setStoredSettings({});
    await closePool(pool);
  });

  it('une bascule en local bloque un nouvel essai, même avec des clients distants déjà créés', async () => {
    await saveSettings(pool, { mode: 'openrouter', openrouterKey: 'test' });
    const encoder = embeddingFromConfig(pool)!;
    const llm = llmFromConfig(pool)!;
    const judge = judgeFromConfig(pool)!;
    // Le fournisseur simulé a reçu le premier lot, mais n'a pas encore répondu au moment de la bascule.
    const provider = new EventEmitter();
    const first = once(provider, 'request');
    const resume = once(provider, 'retry');
    const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      provider.emit('request');
      await resume;
      return new Response('occupé', { status: 503 });
    });
    const pending = encoder.embed(['premier lot'], 'document');
    await first;
    try {
      await saveSettings(pool, { mode: 'local' });
    } finally {
      provider.emit('retry');
    }
    await expect(pending).rejects.toBeInstanceOf(ModelSettingsChangedError);
    await expect(llm.chat('système', 'nouvelle question')).rejects.toBeInstanceOf(ModelSettingsChangedError);
    await expect(judge.judge('question', [{ title: 'titre', text: 'extrait' }])).rejects.toBeInstanceOf(ModelSettingsChangedError);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('une ancienne page ne charge plus les miniatures distantes après un changement de mode', async () => {
    const server = createWebServer(pool, { password: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/videos/Gu8bnHQaG5s/miniature`;
    try {
      await saveSettings(pool, { mode: 'openrouter' });
      const remote = await fetch(url, { redirect: 'manual' });
      expect(remote.status).toBe(302);
      expect(remote.headers.get('location')).toBe('https://i.ytimg.com/vi/Gu8bnHQaG5s/mqdefault.jpg');
      expect(remote.headers.get('cache-control')).toBe('no-store');
      await saveSettings(pool, { mode: 'local' });
      const local = await fetch(url, { redirect: 'manual' });
      expect(local.status).toBe(200);
      expect(local.headers.get('location')).toBeNull();
      expect(local.headers.get('content-type')).toBe('image/svg+xml');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
