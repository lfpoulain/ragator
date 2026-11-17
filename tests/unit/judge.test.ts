import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jevJudge, localJudge, JUDGE_CRITERIA, JUDGE_CRITERIA_LOCAL, JUDGE_QUESTION } from '../../src/providers/judge.js';

/** Faux endpoint Decisions : probabilité selon le texte, erreur 500 sur « panne », 503 au premier essai sur « instable ». */
let server: Server;
let baseUrl = '';
const bodies: Array<Record<string, unknown>> = [];
let unstableCalls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      res.setHeader('Content-Type', 'application/json');
      const text = JSON.stringify(body);
      if (text.includes('instable') && unstableCalls++ === 0) {
        res.statusCode = 503;
        res.end('{"error":"occupé"}');
        return;
      }
      if (req.url === '/v1/systemone') {
        res.end(JSON.stringify({ model: 'LiquidAI/d1-3B-GGUF:Q8_0', answers: { decision: { type: 'noul', noul: text.includes('chaton') ? 0.8 : 0.2 } } }));
        return;
      }
      if (!req.url?.endsWith('/alpha/decisions') || text.includes('panne')) {
        res.statusCode = 500;
        res.end('{"error":"panne"}');
        return;
      }
      res.end(JSON.stringify({ answers: { decision: { type: 'noul', noul: text.includes('chaton') ? 0.9 : 0.1 } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(() => {
  server.close();
});

const videos = [
  { title: 'Atelier', text: '[s1 14:37] PLAN : un chaton' },
  { title: 'Twitch', text: '[s2 10:48] PAROLE : le chat de notre Twitch' },
];

describe('JEV (endpoint Decisions d’OpenRouter)', () => {
  it('une décision « noul » par vidéo, probabilité rendue telle quelle, dans l’ordre', async () => {
    const judge = jevJudge({ apiKey: 'sk-or-test', model: 'typesafe/jev-1.13', baseUrl });
    expect(await judge.judge('Quand parlent-ils de leur chat ?', videos)).toEqual([0.9, 0.1]);
    const sent = bodies.find((b) => b.model === 'typesafe/jev-1.13')!;
    expect(sent).toMatchObject({ questions: { decision: { type: 'noul', instructions: JUDGE_QUESTION } } });
    expect(sent.state).toMatchObject({ question: 'Quand parlent-ils de leur chat ?' });
  });

  it('une erreur HTTP remonte (la réponse devient extractive)', async () => {
    await expect(jevJudge({ apiKey: 'k', model: 'typesafe/jev-1.13', baseUrl, retryDelaysMs: [1] }).judge('panne', videos)).rejects.toThrow(/JEV HTTP 500/);
  });

  it('juge local (/v1/systemone) : mêmes questions et critères, état en texte, même réponse', async () => {
    const local = baseUrl.replace(/\/api$/, '');
    expect(await localJudge({ baseUrl: local }).judge('Quand parlent-ils de leur chat ?', videos)).toEqual([0.8, 0.2]);
    const sent = bodies.find((b) => typeof b.state === 'string')!;
    expect(sent).toMatchObject({ questions: { decision: { type: 'noul', instructions: JUDGE_QUESTION, criteria: JUDGE_CRITERIA_LOCAL } } });
    expect(sent.state).toContain('question: Quand parlent-ils de leur chat ?\nvideo_title: Atelier\nexcerpts:\n[s1 14:37]');
    expect(sent).not.toHaveProperty('model');
  });

  it('une saturation passagère (503) est réessayée', async () => {
    expect(await jevJudge({ apiKey: 'k', model: 'typesafe/jev-1.13', baseUrl, retryDelaysMs: [1] }).judge('instable', [videos[0]!])).toEqual([0.9]);
    expect(unstableCalls).toBe(2);
  });
});
