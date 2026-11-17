import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { listerVideos } from '../../src/core/list-videos.js';
import { chercher } from '../../src/core/search.js';
import { chercherPlan } from '../../src/core/search-plans.js';
import { lireContexte } from '../../src/core/read-context.js';
import { chercherInfosVideo } from '../../src/core/video-info.js';
import { resolveTerm } from '../../src/core/resolve.js';
import {
  dbAvailable,
  FIXTURES_DIR,
  getTestPool,
  resetDatabase,
  setupDatabase,
} from './helpers.js';

(dbAvailable ? describe : describe.skip)('outils lexicaux', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    const report = await ingestPaths(pool, [FIXTURES_DIR]);
    expect(report.failures).toEqual([]);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('« nordvpn » scope paroles : 9 entrées, première à 81 s, lien à 78 s', async () => {
    const page = await listerVideos(pool, { term: 'NordVPN', scope: 'paroles' });
    expect(page.data.status).toBe('resolved');
    expect(page.data.totalEntries).toBe(9);
    expect(page.data.videos).toHaveLength(1);
    const video = page.data.videos[0]!;
    expect(video.videoId).toBe('Gu8bnHQaG5s');
    expect(video.occurrences.speech).toBe(9);
    expect(video.occurrences.visual).toBe(0);
    expect(video.firstMentionS).toBe(81);
    expect(video.link).toBe('https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=78s');
  });

  it('« nordvpn » scope tout : 13 entrées (9 paroles + 4 plans)', async () => {
    const page = await listerVideos(pool, { term: 'nordvpn', scope: 'tout' });
    expect(page.data.totalEntries).toBe(13);
    const video = page.data.videos[0]!;
    expect(video.occurrences.speech).toBe(9);
    expect(video.occurrences.visual).toBe(4);
    expect(video.occurrences.total).toBe(13);
  });

  it('« peltier » scope tout : 6 entrées, première à 221 s', async () => {
    const page = await listerVideos(pool, { term: 'peltier', scope: 'tout' });
    expect(page.data.totalEntries).toBe(6);
    expect(page.data.videos[0]!.firstMentionS).toBe(221);
  });

  it('« parkside » scope ecran : 7 résultats (6 glacière + 1 manoir) — l’affiché est séparé du prononcé', async () => {
    const ecran = await listerVideos(pool, { term: 'parkside', scope: 'ecran' });
    expect(ecran.data.totalEntries).toBe(7);
    const tout = await listerVideos(pool, { term: 'parkside', scope: 'tout' });
    expect(tout.data.totalEntries).toBe(21);
  });

  it('« peltie » se résout vers « peltier » en flou', async () => {
    const resolved = await resolveTerm(pool, 'peltie', 'tout', '');
    expect(resolved.status).toBe('resolved');
    expect(resolved.fuzzy).toBe(true);
    expect(resolved.canonical).toBe('peltier');
    const page = await listerVideos(pool, { term: 'peltie', scope: 'tout' });
    expect(page.data.totalEntries).toBe(6);
  });

  it('terme inconnu : réponse vide explicite, jamais une liste partielle', async () => {
    const page = await listerVideos(pool, { term: 'hérisson', scope: 'tout' });
    expect(page.data.status).toBe('not_found');
    expect(page.data.totalVideos).toBe(0);
    expect(page.data.videos).toHaveLength(0);
  });

  it('« 20,5 v » retrouve le plan de 316 s via norm_text', async () => {
    const page = await chercherPlan(pool, { query: '20,5 v' });
    expect(page.data.results.length).toBeGreaterThan(0);
    expect(page.data.results.some((r) => r.videoId === 'Gu8bnHQaG5s' && r.startS === 316)).toBe(true);
  });

  it('lireContexte(198 s) produit un lien vers 195 s', async () => {
    const page = await lireContexte(pool, { videoId: 'Gu8bnHQaG5s', atS: 198 });
    expect(page.data.link).toBe('https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=195s');
    expect(page.data.entries.length).toBeGreaterThan(0);
    expect(page.data.merged).toContain('=== Fenêtre');
  });

  it('chercher « peltier » classe des fenêtres contenant des preuves, sans doublon', async () => {
    const page = await chercher(pool, { query: 'module Peltier', limit: 5 });
    expect(page.data.results.length).toBeGreaterThan(0);
    const windowIds = new Set(page.data.results.map((r) => r.windowId));
    expect(windowIds.size).toBe(page.data.results.length);
    for (const result of page.data.results) {
      expect(result.windowText).toContain('=== Fenêtre');
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.videoId).toBe('Gu8bnHQaG5s');
    }
  });

  it('chercher sans résultat : dégradé explicite (lexical seul)', async () => {
    const page = await chercher(pool, { query: 'hérisson' });
    expect(page.data.results).toHaveLength(0);
    expect(page.data.degraded).toBe(true);
    expect(page.data.degradedReason).toContain('lexical');
  });

  it('Bambulab dans les descriptions : deux vidéos ; en OCR « Bambu Lab » : les deux vidéos (3 plans)', async () => {
    const descriptions = await chercherInfosVideo(pool, { query: 'bambulab' });
    const videoIds = new Set(descriptions.data.results.map((r) => r.videoId));
    expect(videoIds).toEqual(new Set(['Gu8bnHQaG5s', 'cKRqOdTi5yE']));

    const ecran = await listerVideos(pool, { term: 'bambulab', scope: 'ecran' });
    expect(ecran.data.status).toBe('resolved');
    expect(ecran.data.totalEntries).toBe(3);
    expect(new Set(ecran.data.videos.map((v) => v.videoId))).toEqual(
      new Set(['Gu8bnHQaG5s', 'cKRqOdTi5yE']),
    );
  });

  it('chercherInfosVideo retrouve le lien du firmware en description (sans instant inventé)', async () => {
    const page = await chercherInfosVideo(pool, { query: 'firmware' });
    expect(page.data.results.length).toBeGreaterThan(0);
    for (const result of page.data.results) {
      expect(result.startS).toBeNull();
      expect(result.link).not.toContain('&t=');
    }
  });

  it('Meshy (terme entier) : 9 entrées, première à 122 s — pas Meshysez', async () => {
    const page = await listerVideos(pool, { term: 'Meshy', scope: 'tout' });
    expect(page.data.status).toBe('resolved');
    expect(page.data.totalEntries).toBe(9);
    expect(page.data.videos[0]!.firstMentionS).toBe(122);
  });

  it('pagination sans perte : parcourir le curseur jusqu\'à nextCursor null', async () => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    for (;;) {
      const input: { term: string; scope: 'tout'; cursor?: string } = { term: 'parkside', scope: 'tout' };
      if (cursor !== undefined) input.cursor = cursor;
      const page = await listerVideos(pool, input);
      for (const video of page.data.videos) seen.add(video.videoId);
      pages += 1;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10);
    }
    const single = await listerVideos(pool, { term: 'parkside', scope: 'tout' });
    expect(seen.size).toBe(single.data.totalVideos);
  });

  it('curseur périmé rejeté quand la version change', async () => {
    const page = await listerVideos(pool, { term: 'peltier', scope: 'tout' });
    if (!page.nextCursor) {
      const forged = Buffer.from(JSON.stringify({ k: 'faux', offset: 20 }), 'utf8').toString('base64url');
      await expect(
        listerVideos(pool, { term: 'peltier', scope: 'tout', cursor: forged }),
      ).rejects.toThrow();
    }
  });

  it('la correction Emma → Flore reste lisible dans le contexte du début du manoir', async () => {
    const page = await lireContexte(pool, { videoId: 'cKRqOdTi5yE', atS: 5, beforeS: 5, afterS: 5 });
    const texts = page.data.entries.map((e) => e.text).join('\n');
    expect(texts).toContain('Emma');
    expect(texts).toContain('dit Emma');
  });

  it('chercher applique les filtres vidéo et date sans erreur SQL', async () => {
    const page = await chercher(pool, { query: 'Parkside', videoId: 'cKRqOdTi5yE', dateRange: { from: '2026-01-01' } });
    expect(page.data.results.length).toBeGreaterThan(0);
    for (const result of page.data.results) expect(result.videoId).toBe('cKRqOdTi5yE');
    const none = await chercher(pool, { query: 'Parkside', dateRange: { to: '2000-01-01' } });
    expect(none.data.results).toHaveLength(0);
  });

  it('chercher : une marque ne produit pas de jeton parasite et garde des preuves ciblées', async () => {
    const page = await chercher(pool, { query: 'la vidéo NordVPN', limit: 3 });
    expect(page.data.results.length).toBeGreaterThan(0);
    // Sans vecteurs (base de test), toute preuve est lexicale : elle contient la marque.
    for (const result of page.data.results) {
      expect(result.evidence.length).toBeGreaterThan(0);
      // (une preuve visuelle peut porter la marque dans son titre ou son OCR plutôt que sa description)
      for (const evidence of result.evidence.filter((e) => e.kind === 'parole')) {
        expect(evidence.text.toLowerCase()).toContain('nord');
      }
    }
  });

  it('chercher : requête vide après normalisation, réponse vide sans exception', async () => {
    const page = await chercher(pool, { query: '?!' });
    expect(page.data.results).toHaveLength(0);
    expect(page.data.degraded).toBe(true);
  });

  it('chercher : pagination sans perte ni doublon', async () => {
    const first = await chercher(pool, { query: 'glacière batterie', limit: 3 });
    expect(first.nextCursor).not.toBeNull();
    const second = await chercher(pool, { query: 'glacière batterie', limit: 3, cursor: first.nextCursor! });
    const ids = [...first.data.results, ...second.data.results].map((r) => r.windowId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('chercherPlan filtre par vidéo et pagine sans sauter de résultat', async () => {
    const all = await chercherPlan(pool, { query: 'glacière', limit: 50 });
    const first = await chercherPlan(pool, { query: 'glacière', limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await chercherPlan(pool, { query: 'glacière', limit: 2, cursor: first.nextCursor! });
    expect([...first.data.results, ...second.data.results].map((r) => r.sourceId)).toEqual(
      all.data.results.slice(0, 4).map((r) => r.sourceId),
    );
    const filtered = await chercherPlan(pool, { query: 'Parkside', videoId: 'cKRqOdTi5yE' });
    for (const result of filtered.data.results) expect(result.videoId).toBe('cKRqOdTi5yE');
  });

  it('listerVideos réunit des alternatives sans double compte', async () => {
    const union = await listerVideos(pool, { term: 'nordvpn', alternatives: ['nord vpn', 'nordvpn'], scope: 'tout' });
    expect(union.data.totalEntries).toBe(13);
  });

  it('chercherInfosVideo filtre par date sans erreur de paramètre', async () => {
    const page = await chercherInfosVideo(pool, { query: 'firmware', dateRange: { from: '2026-08-01' } });
    expect(page.data.results.length).toBeGreaterThan(0);
  });
});
