import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPENROUTER_BASE_URL } from '../../src/config.js';
import { embedPending } from '../../src/core/embed.js';
import { enrichPending, type EnrichResult } from '../../src/core/enrich.js';
import { updateCorpus } from '../../src/core/update.js';
import type { EmbeddingClient } from '../../src/providers/embedding.js';
import type { LlmClient } from '../../src/providers/llm.js';
import { AccountRefusedError } from '../../src/providers/retry.js';
import { createAdmin } from '../../src/web/admin.js';

// Étapes simulées : la base n'est pas touchée, seul l'enchaînement de la mise à jour est testé.
vi.mock('../../src/core/ingest.js', () => ({ ingestPaths: vi.fn(async () => ({ results: [], failures: [] })) }));
vi.mock('../../src/core/enrich.js', () => ({ enrichPending: vi.fn() }));
vi.mock('../../src/core/embed.js', () => ({ embedPending: vi.fn() }));
// L'administration prend le LLM de la configuration : un faux, pour ne dépendre d'aucune clé locale.
vi.mock('../../src/providers/llm.js', () => ({ llmFromConfig: () => llm, enrichLlmFromConfig: () => llm }));

const pool = {} as Pool;
const llm: LlmClient = { model: 'gpt-6-luna', chat: async () => '', available: async () => true };
const embedder: EmbeddingClient = { model: 'qwen/qwen3-embedding-4b', embed: async () => [] };
const credit = () => new AccountRefusedError(402, OPENROUTER_BASE_URL, 'Insufficient credits');
const enrichResult = (over: Partial<EnrichResult> = {}): EnrichResult => ({ videos: 0, chunks: 0, failedGroups: 0, pendingChunks: 0, refused: null, ...over });

beforeEach(() => {
  vi.mocked(enrichPending).mockReset();
  vi.mocked(embedPending).mockReset();
});

describe('mise à jour face à un compte refusé', () => {
  it('un crédit épuisé à l’enrichissement et aux vecteurs remonte dans le rapport', async () => {
    vi.mocked(enrichPending).mockResolvedValue(enrichResult({ refused: credit() }));
    vi.mocked(embedPending).mockRejectedValue(credit());
    const report = await updateCorpus(pool, { dir: '.', llm, embedder });
    expect(report.refused?.summary).toBe('crédit OpenRouter épuisé : rechargez puis relancez la mise à jour');
    expect(report.notes).toEqual([
      'enrichissement arrêté : crédit OpenRouter épuisé : rechargez puis relancez la mise à jour — Insufficient credits',
      'vecteurs arrêtés : crédit OpenRouter épuisé : rechargez puis relancez la mise à jour — Insufficient credits',
    ]);
  });

  it('un refus aux seuls vecteurs n’est plus « sauté » en silence', async () => {
    vi.mocked(enrichPending).mockResolvedValue(enrichResult({ chunks: 12 }));
    vi.mocked(embedPending).mockRejectedValue(new AccountRefusedError(401, OPENROUTER_BASE_URL));
    const report = await updateCorpus(pool, { dir: '.', llm, embedder });
    expect(report.enriched).toBe(12);
    expect(report.refused?.reason).toBe('key');
    expect(report.notes.some((n) => n.startsWith('vecteurs sautés'))).toBe(false);
  });

  it('une autre erreur des vecteurs reste une note, sans refus', async () => {
    vi.mocked(enrichPending).mockResolvedValue(enrichResult());
    vi.mocked(embedPending).mockRejectedValue(new Error('un autre encodage est déjà en cours'));
    const report = await updateCorpus(pool, { dir: '.', llm, embedder });
    expect(report.refused).toBeNull();
    expect(report.notes).toEqual(['vecteurs sautés : un autre encodage est déjà en cours']);
  });

  it('l’administration passe en erreur, avec la cause en résumé et au journal', async () => {
    vi.mocked(enrichPending).mockResolvedValue(enrichResult({ refused: credit() }));
    vi.mocked(embedPending).mockRejectedValue(credit());
    const admin = createAdmin(pool, { corpusDir: mkdtempSync(join(tmpdir(), 'ragator-admin-')) });
    expect(admin.startUpdate()).toBe(true);
    await vi.waitFor(() => expect(admin.job.state).not.toBe('running'));
    expect(admin.job).toMatchObject({ state: 'error', refused: 'credit', summary: 'crédit OpenRouter épuisé : rechargez puis relancez la mise à jour' });
    expect(admin.job.log.at(-1)).toMatch(/ARRÊT : crédit OpenRouter épuisé : rechargez puis relancez la mise à jour$/);
    // Une relance repart d'un état propre.
    vi.mocked(enrichPending).mockResolvedValue(enrichResult());
    vi.mocked(embedPending).mockResolvedValue({ model: 'm', embedded: 0, pending: 0, complete: true, vectorIndexCreated: false, indexVersion: 'v' });
    expect(admin.startUpdate()).toBe(true);
    await vi.waitFor(() => expect(admin.job.state).not.toBe('running'));
    expect(admin.job).toMatchObject({ state: 'done', refused: null });
  });
});
