import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLlmClient } from '../../src/providers/llm.js';
import { AccountRefusedError } from '../../src/providers/retry.js';

/** Faux serveur compatible OpenAI : enregistre les requêtes, répond selon le modèle demandé. */
let server: Server;
let baseUrl = '';
const received: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    received.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.endsWith('/models')) {
      res.end(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] }));
    } else if (body.model === 'sans-credit') {
      res.statusCode = 402;
      res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }));
    } else if (body.model === 'cle-morte') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: 'User not found.', code: 401 } }));
    } else if (body.model === 'en-panne') {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: 'quota dépassé' } }));
    } else if (body.model === 'instable' && received.filter((r) => r.body.model === 'instable').length === 1) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { message: 'occupé' } }));
    } else if (body.model === 'prudent') {
      res.end(JSON.stringify({ choices: [{ message: { content: null, refusal: 'Je ne peux pas aider.' } }] }));
    } else {
      res.end(
        JSON.stringify({
          choices: [{ message: { content: ' {"refus":true,"claims":[]} ' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 200 }, cost: 0.0002 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
  server.close();
});

describe('client LLM (OpenRouter, format OpenAI)', () => {
  it('envoie la clé et la forme OpenAI, compte les tokens', async () => {
    const client = createLlmClient('gpt-6-luna', 'sk-test', baseUrl);
    expect(await client.available()).toBe(true);
    expect(await client.chat('système', 'question', { maxTokens: 300 })).toBe('{"refus":true,"claims":[]}');
    const call = received.find((r) => r.path.endsWith('/chat/completions'))!;
    expect(call.auth).toBe('Bearer sk-test');
    expect(call.body).toMatchObject({ model: 'gpt-6-luna', reasoning_effort: 'none', max_completion_tokens: 300 });
    expect(client.usage).toEqual({ calls: 1, input: 1000, cachedInput: 200, output: 50, cost: 0.0002 });
  });

  it('un refus de sécurité remonte comme une erreur explicite', async () => {
    await expect(createLlmClient('prudent', 'k', baseUrl).chat('s', 'u')).rejects.toThrow(/refus du modèle \(Je ne peux pas aider/);
  });

  it('la disponibilité confirmée n’est pas revérifiée à chaque réponse', async () => {
    const client = createLlmClient('gpt-6-luna', 'k', baseUrl);
    const before = received.filter((r) => r.path.endsWith('/models')).length;
    expect(await client.available()).toBe(true);
    expect(await client.available()).toBe(true);
    expect(received.filter((r) => r.path.endsWith('/models')).length).toBe(before + 1);
  });

  it('remonte l’erreur HTTP avec son détail', async () => {
    await expect(createLlmClient('en-panne', 'k', baseUrl, { retryDelaysMs: [1] }).chat('s', 'u')).rejects.toThrow(/LLM HTTP 429 : .*quota dépassé/);
  });

  it('une saturation passagère (503) est réessayée', async () => {
    const before = received.filter((r) => r.body.model === 'instable').length;
    expect(await createLlmClient('instable', 'k', baseUrl, { retryDelaysMs: [1] }).chat('s', 'u')).toBe('{"refus":true,"claims":[]}');
    expect(received.filter((r) => r.body.model === 'instable').length).toBe(before + 2);
  });

  it('un crédit épuisé (402) lève une erreur typée, sans nouvelle tentative', async () => {
    const before = received.filter((r) => r.body.model === 'sans-credit').length;
    const error = await createLlmClient('sans-credit', 'k', baseUrl, { retryDelaysMs: [1, 1] }).chat('s', 'u').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountRefusedError);
    expect(error).toMatchObject({ reason: 'credit', status: 402 });
    expect((error as Error).message).toMatch(/^crédit du fournisseur \(127\.0\.0\.1:\d+\) épuisé : rechargez puis relancez la mise à jour — Insufficient credits$/);
    expect(received.filter((r) => r.body.model === 'sans-credit').length).toBe(before + 1);
  });

  it('une clé refusée (401) lève une erreur typée, sans nouvelle tentative', async () => {
    const before = received.filter((r) => r.body.model === 'cle-morte').length;
    const error = await createLlmClient('cle-morte', 'k', baseUrl, { retryDelaysMs: [1, 1] }).chat('s', 'u').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountRefusedError);
    expect(error).toMatchObject({ reason: 'key', status: 401 });
    expect(received.filter((r) => r.body.model === 'cle-morte').length).toBe(before + 1);
  });

  it('un modèle absent de /models est indisponible', async () => {
    expect(await createLlmClient('inconnu', 'k', baseUrl).available()).toBe(false);
  });
});
