import type { Pool } from 'pg';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import { getMetaString } from '../db/meta.js';
import type { LlmClient } from '../providers/llm.js';
import { buildExpansionPrompt, parseVariants, EXPANSION_PROMPT_VERSION, EXPANSION_SYSTEM_PROMPT } from '../prompts/expansion.js';
import { lexique } from './resolve.js';

export interface ExpansionResult {
  triggered: boolean;
  variants: string[];
  reason: string;
  promptVersion: string;
}

/** Part minimale de mots absents du corpus pour déclencher l'expansion. */
const MISSING_RATIO = 0.25;

/** Mots de la question qui portent le sujet (4 lettres ou plus, hors mots vides). */
export function contentTokensOf(question: string): string[] {
  return contentTokens(tokenizeText(question).tokens).filter((token) => token.length >= 4);
}

/** Longueur minimale d'un mot du corpus pour reconnaître une forme collée (« bambulab » ← « bambu »). */
const MIN_GLUED_WORD = 4;

/**
 * Mots absents du lexique du corpus : ni tels quels, ni par préfixe de
 * 5 lettres (surélever/surélève), ni comme forme collée d'un mot connu d'au
 * moins 4 lettres (un mot d'une lettre ne « couvre » pas tout ce qui commence par elle).
 */
export function vocabularyMisses(questionTokens: string[], corpusWords: readonly string[]): string[] {
  const known = new Set(corpusWords);
  return questionTokens.filter((token) => {
    if (known.has(token)) return false;
    const stem = token.slice(0, 5);
    return !corpusWords.some(
      (word) => word.startsWith(stem) || (word.length >= MIN_GLUED_WORD && token.startsWith(word)),
    );
  });
}

function result(reason: string, variants: string[] = []): ExpansionResult {
  return { triggered: variants.length > 0, variants, reason, promptVersion: EXPANSION_PROMPT_VERSION };
}

/**
 * Expansion conditionnelle : quand une part des mots de la
 * question n'existe pas dans le corpus, le LLM propose au plus 2 reformulations
 * lexicales. Elles élargissent les candidats de `chercher`, jamais les preuves,
 * et ne participent jamais à un décompte exhaustif.
 */
export async function expandQuery(pool: Pool, question: string, llm: LlmClient | null, collection?: string): Promise<ExpansionResult> {
  const tokens = contentTokensOf(question);
  if (tokens.length === 0) return result('question sans mot signifiant');

  const corpusVersion = (await getMetaString(pool, 'corpus_version')) ?? '';
  const missing = vocabularyMisses(tokens, await lexique(pool, 'tout', corpusVersion, collection));
  if (missing.length === 0 || missing.length / tokens.length < MISSING_RATIO) {
    return result('vocabulaire couvert par le corpus');
  }
  if (!llm) return result('LLM non configuré : pas d’expansion');

  try {
    const raw = await llm.chat(EXPANSION_SYSTEM_PROMPT, buildExpansionPrompt({ question, missing }), { maxTokens: 150 });
    const variants = parseVariants(raw, question);
    return result(`${missing.length}/${tokens.length} mots absents du corpus : ${missing.join(', ')}`, variants);
  } catch (err) {
    return result(`expansion impossible (${err instanceof Error ? err.message : String(err)})`);
  }
}
