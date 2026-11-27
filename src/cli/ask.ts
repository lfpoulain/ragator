import type { Pool } from 'pg';
import { logQuestion } from '../db/question-log.js';
import { repondre, type AnswerInput, type AnswerResult } from '../core/answer.js';
import { repondreAgent } from '../core/agent.js';
import { resolveCollection } from '../core/collections.js';
import { formatTimestamp } from '../windows/format.js';
import type { Args } from './args.js';

/** `npm run ask` : même fonction `repondre` que les autres façades. */
export async function ask(pool: Pool, question: string, args: Args): Promise<number> {
  const input: AnswerInput = {
    question,
    mode: args.has('--extractif') ? 'extractif' : args.has('--court') ? 'court' : 'détaillé',
  };
  const collection = args.value('--collection');
  if (collection) input.collection = await resolveCollection(pool, collection);
  const sources = args.int('--sources');
  if (sources !== undefined) input.maxEvidence = sources;

  const result = await (args.has('--approfondi') ? repondreAgent : repondre)(pool, input);
  await logQuestion(pool, 'cli', input, { result });
  if (args.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printAnswer(result);
  }
  return result.route === 'clarifier' ? 1 : 0;
}

export function printAnswer(result: AnswerResult): void {
  console.log(`\n${result.answer}`);
  if (result.degradedReason) console.log(`\n[dégradé : ${result.degradedReason}]`);
  if (result.invalidCitations.length > 0) {
    console.log(`\n⚠ citations invalides retirées : ${result.invalidCitations.join(', ')}`);
  }
  if (result.expansion?.triggered) {
    console.log(`\n[expansion : ${result.expansion.variants.map((v) => `« ${v} »`).join(', ')}]`);
  }
  if (result.mode !== 'extractif' && result.exhaustive === null && result.sources.length > 0) {
    console.log('\nSources :');
    for (const source of result.sources.slice(0, 15)) {
      const at = source.startS !== null ? ` à ${formatTimestamp(source.startS)}` : '';
      console.log(`- ${source.title}${at} (${source.publishedAt ?? 'date inconnue'})`);
      console.log(`  ${source.link}`);
    }
  }
  if (result.agent?.steps.length) console.log(`\n[approfondi : ${result.agent.steps.map((s) => `${s.outil} « ${s.requête} »`).join(' ; ')}]`);
  const t = result.timings;
  console.log(
    `\n[route ${result.route}, mode ${result.mode}, preuves : ${result.retrieval ?? 'aucune'}, recherche ${t.searchMs} ms, LLM ${t.llmMs} ms, total ${t.totalMs} ms, prompt v${result.promptVersion}]`,
  );
}
