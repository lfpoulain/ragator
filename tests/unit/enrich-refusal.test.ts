import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { OPENROUTER_BASE_URL } from '../../src/config.js';
import { enrichPending } from '../../src/core/enrich.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { AccountRefusedError } from '../../src/providers/retry.js';

/** Fausse base : 3 vidéos de 100 blocs chacune (3 groupes par vidéo), verrous toujours obtenus. */
function fakePool(): Pool {
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('FROM videos v')) {
      return { rows: ['v1', 'v2', 'v3'].map((id) => ({ video_id: id, title: `Vidéo ${id}`, published_at: null, channel: null })) };
    }
    if (sql.includes('FROM chunks WHERE video_id')) {
      return { rows: Array.from({ length: 100 }, (_, i) => ({ id: `${params[0]}-${i}`, start_s: i * 30, text: `Vidéo\nbloc ${i}` })) };
    }
    if (sql.includes('count(*) AS n')) return { rows: [{ n: '300' }] };
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
}

/** LLM dont le compte est à sec : chaque appel est refusé (402). */
function brokeLlm(): LlmClient & { calls: number } {
  return {
    model: 'gpt-6-luna',
    calls: 0,
    async chat() {
      this.calls += 1;
      throw new AccountRefusedError(402, OPENROUTER_BASE_URL, 'Insufficient credits');
    },
    available: async () => true,
  };
}

describe('enrichissement face à un compte refusé', () => {
  it('s’arrête au premier refus au lieu d’essayer chaque groupe', async () => {
    const llm = brokeLlm();
    const lines: string[] = [];
    const result = await enrichPending(fakePool(), llm, { parallel: 1, onProgress: (line) => lines.push(line) });
    expect(llm.calls).toBe(1);
    expect(result.refused).toBeInstanceOf(AccountRefusedError);
    expect(result.refused?.reason).toBe('credit');
    expect(result).toMatchObject({ chunks: 0, failedGroups: 0, pendingChunks: 300 });
    expect(lines.filter((l) => l.startsWith('enrichissement arrêté : crédit OpenRouter épuisé'))).toHaveLength(1);
  });

  it('en parallèle, seuls les appels déjà partis échouent, signalés une fois', async () => {
    const llm = brokeLlm();
    const lines: string[] = [];
    const result = await enrichPending(fakePool(), llm, { parallel: 8, onProgress: (line) => lines.push(line) });
    // Un appel par vidéo lancée en même temps, aucun pour leurs groupes suivants (9 groupes en tout).
    expect(llm.calls).toBe(3);
    expect(result.failedGroups).toBe(0);
    expect(lines.filter((l) => l.startsWith('enrichissement arrêté'))).toHaveLength(1);
  });

  it('une autre erreur reste un groupe en échec, repris plus tard', async () => {
    const llm: LlmClient = {
      model: 'gpt-6-luna',
      chat: async () => {
        throw new Error('LLM HTTP 500 : panne');
      },
      available: async () => true,
    };
    const result = await enrichPending(fakePool(), llm, { parallel: 1 });
    expect(result.refused).toBeNull();
    expect(result.failedGroups).toBe(9);
  });
});
