// Banc volontaire, hors CI. Après ingestion et vectorisation de tests/fixtures dans une base dédiée :
// RAGATOR_MODE=local DATABASE_URL=… node --import tsx tests/evaluation/poulain.mjs
// Le mode OpenRouter appelle le fournisseur et engage des frais. Sortie JSONL, une ligne par question.
import { readFileSync } from 'node:fs';
import { repondre } from '../../src/core/answer.ts';
import { closePool, getPool } from '../../src/db/pool.ts';
import { getConfig } from '../../src/config.ts';
import { judgeFromConfig } from '../../src/providers/judge.ts';
import { llmFromConfig } from '../../src/providers/llm.ts';
import { applyStoredSettings } from '../../src/settings.ts';

const cooler = 'Gu8bnHQaG5s';
const manor = 'cKRqOdTi5yE';
// Les lignes sont des alternatives acceptables, pas une liste exhaustive de preuves.
// La référence en français sert à la relecture des affirmations, y compris celles qui ajoutent des détails.
const cases = [
  [cooler, 'Quelle marque de batterie montent-ils finalement sur leur glacière autonome ?',
    'Ils montent une batterie Parkside.', 't00070 t00072 t00087 v00045 v00120'],
  [cooler, 'Où les voit-on alimenter leur glacière terminée avec la batterie Ryobi ?',
    'Prémisse erronée. Ils comparent la Ryobi, puis choisissent la Parkside.', 'v00044 t00068 t00070 t00072 v00045 v00120'],
  [cooler, 'Combien de petits modules abaisseurs grillent pendant leurs essais sur la glacière ?',
    'Trois modules sont hors service.', 't00097 v00061'],
  [cooler, 'Quelle tension obtiennent-ils en sortie du convertisseur pour la glacière ?',
    '12 V en sortie. Environ 20 V est la tension en entrée.', 't00087 t00089 v00055 v00057'],
  [cooler, 'Dans quelles vidéos voit-on les Frères Poulain connecter leur glacière en Bluetooth ?',
    'Ils appairent effectivement la glacière au téléphone.', 't00192 t00195 v00117'],
  [manor, 'Pourquoi les propriétaires ajoutent-ils les cheminées au devis de la toiture du manoir ?',
    'Les cheminées risquaient de tomber.', 't00167 v00057'],
  [manor, 'Qu’est-ce qui attaque la charpente et le bâti du manoir à l’étage ?',
    'De la moisissure.', 't00300'],
  [manor, 'À quel moment jouent-ils vraiment à GTA VI devant le poêle du manoir ?',
    'Prémisse erronée. Ils en rêvent pour après la rénovation.', 't00177 t00179'],
];

const args = process.argv.slice(2);
const index = Number(args[1]) - 1;
if (args.length && (args.length !== 2 || args[0] !== '--case' || !Number.isInteger(index) || index < 0 || index >= cases.length)) {
  throw new Error('Usage : poulain.mjs [--case 1-' + cases.length + ']');
}
const pool = getPool();
try {
  const { rows } = await pool.query('SELECT video_id FROM videos ORDER BY video_id');
  if (rows.map(r => r.video_id).sort().join() !== [cooler, manor].sort().join()) {
    throw new Error('Ce banc demande une base contenant uniquement les deux vidéos de tests/fixtures.');
  }
  const { rows: [coverage] } = await pool.query(`
    SELECT (SELECT count(*) FROM entries WHERE embedding IS NULL)
         + (SELECT count(*) FROM chunks WHERE embedding IS NULL)
         + (SELECT count(*) FROM videos WHERE embedding IS NULL) AS pending
  `);
  if (Number(coverage.pending)) throw new Error('Index vectoriel incomplet. Terminer npm run embed avant la comparaison.');
  await applyStoredSettings(pool);
  const config = getConfig();
  const llm = llmFromConfig(pool);
  const judge = judgeFromConfig(pool);
  if (!llm || !judge || !await llm.available()) throw new Error('LLM et juge configurés requis.');
  const originals = new Map();
  for (const id of [cooler, manor]) {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/video--' + id + '.json', import.meta.url), 'utf8'));
    for (const line of [...fixture.transcript, ...fixture.visualSegments]) {
      originals.set(line.id, line.text ?? [line.title, line.visualDescription, ...line.screenText].join(' | '));
    }
  }
  for (const [video, question, expected, localIds] of args.length ? [cases[index]] : cases) {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/video--' + video + '.json', import.meta.url), 'utf8'));
    const ids = localIds.split(' ').map(id => video + ':' + id);
    const entries = [...fixture.transcript, ...fixture.visualSegments].filter(entry => ids.includes(entry.id));
    if (entries.length !== ids.length) throw new Error('Ligne de référence inconnue pour ' + question);
    const containsEvidence = text => entries.some(e => text.includes(e.text ?? e.visualDescription));
    let sentToWriter = false;
    const judged = [];
    const writer = {
      ...llm,
      chat(system, user, options) {
        if (containsEvidence(user)) sentToWriter = true;
        return llm.chat(system, user, options);
      },
    };
    const observedJudge = {
      ...judge,
      async judge(q, videos) {
        const probabilities = await judge.judge(q, videos);
        for (const [i, candidate] of videos.entries()) {
          if (containsEvidence(candidate.text)) judged.push(probabilities[i]);
        }
        return probabilities;
      },
    };
    const before = { llmCalls: llm.usage?.calls ?? 0, judgeCalls: judge.usage?.calls ?? 0, cost: (llm.usage?.cost ?? 0) + (judge.usage?.cost ?? 0) };
    const result = await repondre(pool, { question, collection: 'les-freres-poulain', mode: 'court' }, { llm: writer, analyzer: llm, judge: observedJudge });
    const citations = [...new Set(result.claims.flatMap(c => c.sourceIds))];
    console.log(JSON.stringify({
      question, expected, mode: config.mode, model: result.model, retrieval: result.retrieval,
      degraded: result.degradedReason, refused: result.refused, answer: result.answer,
      goldLines: ids, referenceSentToWriter: sentToWriter, judgeScoresForCandidatesWithReference: judged,
      referenceCited: citations.some(id => ids.includes(id)),
      claims: result.claims.map(c => ({ ...c, sources: c.sourceIds.map(id => originals.get(id) ?? result.sources.find(s => s.sourceIds.includes(id))?.excerpt) })),
      ms: result.timings.totalMs, llmCalls: (llm.usage?.calls ?? 0) - before.llmCalls,
      judgeCalls: (judge.usage?.calls ?? 0) - before.judgeCalls,
      llmAndJudgeUsd: (llm.usage?.cost ?? 0) + (judge.usage?.cost ?? 0) - before.cost,
    }));
  }
} finally {
  await closePool(pool);
}
