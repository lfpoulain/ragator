import { createInterface } from 'node:readline';
import type { Pool } from 'pg';
import { logQuestion } from '../db/question-log.js';
import { repondre, turnOf, type AnswerInput } from '../core/answer.js';
import { MAX_HISTORY_TURNS, type Turn } from '../core/followup.js';
import { resolveCollection } from '../core/collections.js';
import type { Args } from './args.js';
import { printAnswer } from './ask.js';

/**
 * `npm run chat` : conversation en terminal. L'historique (5 échanges) sert
 * seulement à résoudre les relances (« et dans cette vidéo ? ») ; il vit en
 * mémoire et disparaît avec la session ou `/reset`.
 */
export async function chat(pool: Pool, args: Args): Promise<number> {
  const mode = args.has('--detaille') ? 'détaillé' : 'court';
  const wanted = args.value('--collection');
  const collection = wanted ? await resolveCollection(pool, wanted) : undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n> ' });
  let history: Turn[] = [];
  // Une entrée redirigée ferme readline avant la fin du traitement : ne plus afficher d'invite.
  let open = true;
  rl.on('close', () => {
    open = false;
  });
  console.log(`Ragator — mode ${mode}${collection ? `, collection ${collection}` : ''}. /reset efface l’historique, /quit ou ligne vide pour sortir.`);
  rl.prompt();
  try {
    // L'itération lit aussi une entrée redirigée sans perdre de ligne.
    for await (const line of rl) {
      const question = line.trim();
      if (question === '' || question === '/quit') break;
      if (question === '/reset') {
        history = [];
        console.log('Historique effacé.');
      } else {
        const input: AnswerInput = { question, mode, history, ...(collection ? { collection } : {}) };
        const result = await repondre(pool, input);
        await logQuestion(pool, 'cli', input, { result });
        if (result.resolvedQuestion !== question) console.log(`(compris : ${result.resolvedQuestion})`);
        printAnswer(result);
        history = [...history, turnOf(result)].slice(-MAX_HISTORY_TURNS);
      }
      if (open) rl.prompt();
    }
    return 0;
  } finally {
    rl.close();
  }
}
