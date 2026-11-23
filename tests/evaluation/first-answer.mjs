// Banc local du premier tour. Voir docs/evaluation.md pour le format des références.
import { readFile, open } from 'node:fs/promises';
import { repondre, turnOf } from '../../src/core/answer.ts';
import { extractParsedCitations } from '../../src/core/citations.ts';
import { getConfig } from '../../src/config.ts';
import { getPool, closePool } from '../../src/db/pool.ts';

const [manifest, output, group, part = '0', totalParts = '1', collection = 'les-freres-poulain'] = process.argv.slice(2);
if (!manifest || !output || !group || !Number.isInteger(+part) || !Number.isInteger(+totalParts) ||
    +part < 0 || +part >= +totalParts) throw Error('Arguments : manifeste.json sortie.jsonl groupe [partie nombreDeParties collection]');
if (getConfig().mode !== 'local') throw Error('Ce banc utilise la configuration locale de Ragator.');
const cases = JSON.parse(await readFile(manifest, 'utf8')).filter(c => c.split === group).filter((_, i) => i % +totalParts === +part);
if (!cases.length) throw Error('Aucune question dans cette partie du banc.');
const fold = s => s.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '');
const pool = getPool();
const out = await open(output, 'wx');
try {
  const { rows: [corpus] } = await pool.query('SELECT count(*)::int AS videos FROM videos WHERE collection=$1', [collection]);
  if (!corpus.videos) throw Error('Collection vide.');
  for (const c of cases) {
    const result = await repondre(pool, { question: c.question, collection, mode: 'court' });
    const refs = turnOf(result).scenes ?? [];
    const video = refs.some(r => r.videoId === c.video);
    const extra = result.sources.some(s => s.videoId !== c.video);
    const time = refs.some(r => r.videoId === c.video && c.times.some(t => Math.abs(t - r.startS) <= 15));
    let answer = result.answer;
    for (const { raw } of extractParsedCitations(answer)) answer = answer.replaceAll(raw, '');
    const matches = pattern => new RegExp(pattern, 'u').test(fold(answer));
    const fact = !result.refused && !result.degraded && result.claims.some(claim => !claim.missing) &&
      c.all.every(matches) && !(c.forbid ?? []).some(matches);
    await out.writeFile(JSON.stringify({ id: c.id, corpus: corpus.videos, video, time, fact, extra,
      complete: video && !extra && time && fact, answer: result.answer, refs, claims: result.claims,
      titles: result.sources.map(s => [s.videoId, s.title]), degraded: result.degradedReason }) + '\n');
  }
} finally {
  await out.close();
  await closePool(pool);
}
