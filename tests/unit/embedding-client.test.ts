import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_BASE_URL } from '../../src/config.js';
import { createEmbeddingClient } from '../../src/providers/embedding.js';
import { AccountRefusedError } from '../../src/providers/retry.js';

/** Faux endpoint d'embeddings : « occupé » (429) aux deux premiers appels, puis des vecteurs de 4 dimensions. */
let server: Server;
let baseUrl = '';
let calls = 0;
const auth: Array<string | undefined> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls += 1;
      auth.push(req.headers.authorization);
      const body = JSON.parse(raw) as { input: string[] };
      res.setHeader('Content-Type', 'application/json');
      if (calls <= 2) {
        res.statusCode = 429;
        res.end('{"error":{"message":"Model busy, retry later"}}');
        return;
      }
      res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `fetch` simulé : chaque appel rend la même réponse d'erreur OpenRouter. */
function refusingFetch(status: number, message: string) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message, code: status } }), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('encodeur d’embeddings (OpenRouter)', () => {
  it('envoie la clé et réessaie quand le modèle est occupé', async () => {
    const client = createEmbeddingClient('qwen/qwen3-embedding-4b', 'sk-or-test', { baseUrl, dims: 4, retryDelaysMs: [1, 1, 1] });
    expect(await client.embed(['a', 'b'], 'document')).toEqual([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    expect(calls).toBe(3);
    expect(auth.every((a) => a === 'Bearer sk-or-test')).toBe(true);
  });

  it('refuse des vecteurs de la mauvaise dimension', async () => {
    const client = createEmbeddingClient('m', 'k', { baseUrl, dims: 2560, retryDelaysMs: [] });
    await expect(client.embed(['a'], 'query')).rejects.toThrow(/4 dimensions \(attendu 2560\)/);
  });

  it('un crédit OpenRouter épuisé (402) arrête net, avec le remède', async () => {
    const fetch = refusingFetch(402, 'Insufficient credits');
    const client = createEmbeddingClient('qwen/qwen3-embedding-4b', 'k', { baseUrl: OPENROUTER_BASE_URL, retryDelaysMs: [1, 1, 1] });
    const error = await client.embed(['a'], 'document').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountRefusedError);
    expect(error).toMatchObject({ reason: 'credit', summary: 'crédit OpenRouter épuisé : rechargez puis relancez la mise à jour' });
    expect((error as Error).message).toBe('crédit OpenRouter épuisé : rechargez puis relancez la mise à jour — Insufficient credits');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('une clé OpenRouter refusée (401) arrête net', async () => {
    const fetch = refusingFetch(401, 'User not found.');
    const client = createEmbeddingClient('m', 'k', { baseUrl: OPENROUTER_BASE_URL, retryDelaysMs: [1, 1, 1] });
    await expect(client.embed(['a'], 'query')).rejects.toThrow(/^clé OpenRouter refusée \(invalide ou révoquée\) : corrigez-la puis relancez la mise à jour/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
