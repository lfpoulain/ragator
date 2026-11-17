import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import {
  countOccurrences,
  dbAvailable,
  FIXTURES_DIR,
  getTestPool,
  loadEntries,
  readFixture,
  resetDatabase,
  screenMatches,
  setupDatabase,
} from './helpers.js';

(dbAvailable ? describe : describe.skip)('ingestion des témoins.2', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    const report = await ingestPaths(pool, [FIXTURES_DIR]);
    expect(report.failures).toEqual([]);
    expect(report.results).toHaveLength(2);
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('compte 199 paroles et 121 plans pour la glacière', async () => {
    const { rows } = await pool.query<{ kind: string; count: string }>(
      `SELECT kind, count(*) AS count FROM entries WHERE video_id = 'Gu8bnHQaG5s' GROUP BY kind`,
    );
    const counts = new Map(rows.map((r) => [r.kind, Number(r.count)]));
    expect(counts.get('parole')).toBe(199);
    expect(counts.get('visuel')).toBe(121);
  });

  it('compte 343 paroles et 99 plans pour le manoir', async () => {
    const { rows } = await pool.query<{ kind: string; count: string }>(
      `SELECT kind, count(*) AS count FROM entries WHERE video_id = 'cKRqOdTi5yE' GROUP BY kind`,
    );
    const counts = new Map(rows.map((r) => [r.kind, Number(r.count)]));
    expect(counts.get('parole')).toBe(343);
    expect(counts.get('visuel')).toBe(99);
  });

  it('enregistre la glacière avec sa durée, sa date et sa relecture requise', async () => {
    const { rows } = await pool.query<{
      duration_s: number | null;
      effective_duration_s: number;
      published_at: string;
      channel: string | null;
      review_required: boolean;
      views: string;
      comments: string;
    }>(
      `SELECT duration_s, effective_duration_s, published_at::text AS published_at,
              channel, review_required, views, comments
       FROM videos WHERE video_id = 'Gu8bnHQaG5s'`,
    );
    const video = rows[0];
    expect(video).toBeDefined();
    expect(video!.duration_s).toBe(831);
    expect(video!.effective_duration_s).toBe(831);
    expect(video!.published_at).toBe('2026-08-13');
    expect(video!.review_required).toBe(false);
  });

  it('produit 9 fenêtres exactes pour la glacière', async () => {
    const { rows } = await pool.query<{ start_s: number; end_s: number; params: Record<string, unknown> }>(
      `SELECT start_s, end_s, params FROM windows WHERE video_id = 'Gu8bnHQaG5s' ORDER BY start_s`,
    );
    expect(rows.map((r) => [r.start_s, r.end_s])).toEqual([
      [0, 120],
      [90, 210],
      [180, 300],
      [270, 390],
      [360, 480],
      [450, 570],
      [540, 660],
      [630, 750],
      [720, 831],
    ]);
    expect(rows[0]!.params).toEqual({
      windowSeconds: 120,
      stepSeconds: 90,
      formatVersion: '1',
    });
  });

  it('produit 11 fenêtres pour le manoir, dernière de 900 à 1013 s', async () => {
    const { rows } = await pool.query<{ start_s: number; end_s: number }>(
      `SELECT start_s, end_s FROM windows WHERE video_id = 'cKRqOdTi5yE' ORDER BY start_s`,
    );
    expect(rows).toHaveLength(11);
    const last = rows[rows.length - 1];
    expect(last).toEqual({ start_s: 900, end_s: 1013 });
  });

  it('conserve les libellés bruts des locuteurs de la glacière', async () => {
    const { rows } = await pool.query<{ speaker_raw: string | null; count: string }>(
      `SELECT speaker_raw, count(*) AS count FROM entries WHERE video_id = 'Gu8bnHQaG5s' AND kind = 'parole' GROUP BY speaker_raw ORDER BY speaker_raw`,
    );
    const counts = new Map(rows.map((r) => [r.speaker_raw, Number(r.count)]));
    expect(counts.get('Voff')).toBe(90);
    expect(counts.get('Indéterminé')).toBe(107);
    expect(counts.get('Invité')).toBe(2);
  });

  it('conserve les libellés bruts des locuteurs du manoir', async () => {
    const { rows } = await pool.query<{ speaker_raw: string | null; count: string }>(
      `SELECT speaker_raw, count(*) AS count FROM entries WHERE video_id = 'cKRqOdTi5yE' AND kind = 'parole' GROUP BY speaker_raw ORDER BY speaker_raw`,
    );
    const counts = new Map(rows.map((r) => [r.speaker_raw, Number(r.count)]));
    expect(counts.get('Artus')).toBe(101);
    expect(counts.get('Baptiste')).toBe(105);
    expect(counts.get('Voff')).toBe(11);
    expect(counts.get('Invité 1')).toBe(113);
    expect(counts.get('Invité 2')).toBe(5);
    expect(counts.get('Invité 3')).toBe(8);
  });

  it('ne rend filtrables que les noms explicites', async () => {
    const { rows } = await pool.query<{ named: string; unnamed: string }>(
      `SELECT count(*) FILTER (WHERE speaker_is_named) AS named,
              count(*) FILTER (WHERE NOT speaker_is_named) AS unnamed
       FROM entries WHERE video_id = 'cKRqOdTi5yE' AND kind = 'parole'`,
    );
    expect(Number(rows[0]!.named)).toBe(206);
    expect(Number(rows[0]!.unnamed)).toBe(137);
  });

  it('détecte 0 parole de durée nulle dans la glacière', async () => {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM entries
       WHERE video_id = 'Gu8bnHQaG5s' AND kind = 'parole' AND start_s = end_s`,
    );
    expect(rowCount).toBe(0);
  });

  it('détecte 28 paroles de durée nulle dans le manoir, décrites par un seul avertissement', async () => {
    const zero = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM entries
       WHERE video_id = 'cKRqOdTi5yE' AND kind = 'parole' AND start_s = end_s`,
    );
    expect(Number(zero.rows[0]!.count)).toBe(28);
    const quality = await pool.query<{ quality: { warnings: string[] } }>(
      `SELECT quality FROM videos WHERE video_id = 'cKRqOdTi5yE'`,
    );
    expect(quality.rows[0]!.quality.warnings).toHaveLength(1);
  });

  it('stocke les compteurs qualité du manoir, tous nuls', async () => {
    const { rows } = await pool.query<{ quality: Record<string, unknown> }>(
      `SELECT quality FROM videos WHERE video_id = 'cKRqOdTi5yE'`,
    );
    const quality = rows[0]!.quality;
    expect(quality.inaudibleEntries).toBe(0);
    expect(quality.missingSpeechEndTimes).toBe(0);
    expect(quality.visualUncertainties).toBe(0);
  });

  it('ne remplit screen_text que sur les plans', async () => {
    const { rows } = await pool.query<{ on_speech: string; on_visual: string }>(
      `SELECT count(*) FILTER (WHERE kind = 'parole' AND screen_text IS NOT NULL) AS on_speech,
              count(*) FILTER (WHERE kind = 'visuel' AND (screen_text IS NULL OR screen_text_norm IS NULL)) AS on_visual
       FROM entries`,
    );
    expect(Number(rows[0]!.on_speech)).toBe(0);
    expect(Number(rows[0]!.on_visual)).toBe(0);
  });

  it('compte 233 chaînes OCR dans la glacière et 148 dans le manoir', async () => {
    const { rows } = await pool.query<{ video_id: string; total: string | null }>(
      `SELECT video_id, sum(array_length(screen_text, 1)) AS total
       FROM entries WHERE kind = 'visuel' GROUP BY video_id ORDER BY video_id`,
    );
    const totals = new Map(rows.map((r) => [r.video_id, Number(r.total)]));
    expect(totals.get('Gu8bnHQaG5s')).toBe(233);
    expect(totals.get('cKRqOdTi5yE')).toBe(148);
  });

  it('rend « 20,5V -> 12V » trouvable via norm_text à 316 s', async () => {
    const { rows } = await pool.query<{ source_id: string; screen_text_norm: string }>(
      `SELECT source_id, screen_text_norm FROM entries
       WHERE video_id = 'Gu8bnHQaG5s' AND kind = 'visuel' AND start_s = 316`,
    );
    const matching = rows.filter((r) => r.screen_text_norm?.includes('20.5 v'));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching.some((r) => r.screen_text_norm?.includes('20 5 v'))).toBe(true);
  });

  it('rend « X20V TEAM » trouvable sous ses deux formes', async () => {
    const { rows } = await pool.query<{ screen_text_norm: string }>(
      `SELECT screen_text_norm FROM entries
       WHERE video_id = 'Gu8bnHQaG5s' AND kind = 'visuel'
         AND EXISTS (SELECT 1 FROM unnest(screen_text) AS s WHERE s ILIKE '%X20V%')`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.screen_text_norm).toContain('x20v x 20v');
    }
  });

  it('n’a plus d’OCR Bambulab dans la glacière mais garde la marque en description', async () => {
    const screen = screenMatches(await loadEntries(pool, 'Gu8bnHQaG5s'), 'bambulab');
    expect(screen).toHaveLength(0);
    const description = await pool.query<{ description: string }>(
      `SELECT description FROM videos WHERE video_id = 'Gu8bnHQaG5s'`,
    );
    expect(description.rows[0]!.description.toLowerCase()).toContain('bambulab');
  });

  it('compte nordvpn : 13 entrées (9 paroles + 4 plans), première à 78 s', async () => {
    const matches = countOccurrences(await loadEntries(pool, 'Gu8bnHQaG5s'), 'nordvpn');
    expect(matches).toHaveLength(13);
    expect(matches.filter((e) => e.kind === 'parole')).toHaveLength(9);
    expect(Math.min(...matches.map((e) => e.startS))).toBe(78);
  });

  it('compte peltier : 6 entrées (2 paroles + 4 plans), première à 221 s', async () => {
    const matches = countOccurrences(await loadEntries(pool, 'Gu8bnHQaG5s'), 'peltier');
    expect(matches).toHaveLength(6);
    expect(matches.filter((e) => e.kind === 'parole')).toHaveLength(2);
    expect(Math.min(...matches.map((e) => e.startS))).toBe(221);
  });

  it('compte parkside dans la glacière : 5 paroles + 12 plans, dont 6 OCR', async () => {
    const matches = countOccurrences(await loadEntries(pool, 'Gu8bnHQaG5s'), 'parkside');
    expect(matches.filter((e) => e.kind === 'parole')).toHaveLength(5);
    expect(matches.filter((e) => e.kind === 'visuel')).toHaveLength(12);
    expect(screenMatches(await loadEntries(pool, 'Gu8bnHQaG5s'), 'parkside')).toHaveLength(6);
  });

  it('compte parkside dans le manoir : 2 paroles + 2 plans, 1 OCR', async () => {
    const matches = countOccurrences(await loadEntries(pool, 'cKRqOdTi5yE'), 'parkside');
    expect(matches.filter((e) => e.kind === 'parole')).toHaveLength(2);
    expect(matches.filter((e) => e.kind === 'visuel')).toHaveLength(2);
    expect(screenMatches(await loadEntries(pool, 'cKRqOdTi5yE'), 'parkside')).toHaveLength(1);
  });

  it('compte Meshy (terme entier) dans le manoir : 4 paroles + 5 plans, première à 122 s', async () => {
    const matches = countOccurrences(await loadEntries(pool, 'cKRqOdTi5yE'), 'meshy');
    expect(matches.filter((e) => e.kind === 'parole')).toHaveLength(4);
    expect(matches.filter((e) => e.kind === 'visuel')).toHaveLength(5);
    expect(Math.min(...matches.map((e) => e.startS))).toBe(122);
  });

  it('ne confond pas le dérivé Meshysez avec Meshy', async () => {
    const all = await loadEntries(pool, 'cKRqOdTi5yE');
    const meshy = countOccurrences(all, 'meshy');
    expect(meshy).toHaveLength(9);
    const derived = countOccurrences(all, 'meshysez');
    expect(derived.length).toBeGreaterThanOrEqual(2);
    const derivedOnly = derived.filter((e) => !meshy.includes(e));
    expect(derivedOnly.every((e) => !/\bmeshy\b/i.test([e.planTitle ?? '', e.text, ...(e.screenText ?? [])].join('\n')))).toBe(true);
  });

  it('place Bambulab dans les descriptions des deux vidéos', async () => {
    const { rows } = await pool.query<{ video_id: string; description: string }>(
      `SELECT video_id, description FROM videos ORDER BY video_id`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.description.toLowerCase()).toContain('bambulab');
    }
  });

  it('publie les versions et crée un job d’embedding par vidéo', async () => {
    const meta = await pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM corpus_meta`,
    );
    const values = new Map(meta.rows.map((r) => [r.key, r.value]));
    expect(values.get('schema_version')).toBe('2.0');
    expect(values.get('index_version')).toBe('lexical');
    expect(typeof values.get('corpus_version')).toBe('string');
    expect((values.get('corpus_version') as string).length).toBe(64);
    const jobs = await pool.query<{ type: string; state: string; scope: string }>(
      `SELECT type, state, scope FROM corpus_jobs ORDER BY scope`,
    );
    expect(jobs.rows).toHaveLength(2);
    for (const job of jobs.rows) {
      expect(job.type).toBe('embed');
      expect(job.state).toBe('queued');
    }
  });

  it('laisse le corpus source intact', () => {
    const glacière = JSON.parse(readFixture('Gu8bnHQaG5s')) as { transcript: unknown[] };
    expect(glacière.transcript).toHaveLength(199);
  });
});