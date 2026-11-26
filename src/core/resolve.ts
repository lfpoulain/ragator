import { tokenizeText } from '../norm/normalize.js';
import { aliasCanonical, variantsOf, isCanonicalBrand } from '../norm/brands.js';
import type { Db } from '../db/pool.js';
import type { Scope } from './page.js';

export type TermStatus = 'resolved' | 'not_found' | 'ambiguous';

export interface ResolvedTerm {
  original: string;
  canonical: string | null;
  fuzzy: boolean;
  aliases: string[];
  status: TermStatus;
  suggestions: string[];
}

/**
 * Colonne et type d'entrée couverts par chaque portée. `ecran` lit
 * `screen_text_norm`, seul champ qui distingue l'affiché du prononcé.
 */
const SCOPE_RULES: Record<Scope, { column: 'norm_text' | 'screen_text_norm'; kind: 'parole' | 'visuel' | null }> = {
  tout: { column: 'norm_text', kind: null },
  paroles: { column: 'norm_text', kind: 'parole' },
  visuel: { column: 'norm_text', kind: 'visuel' },
  ecran: { column: 'screen_text_norm', kind: 'visuel' },
};

export function scopeColumn(scope: Scope): 'norm_text' | 'screen_text_norm' {
  return SCOPE_RULES[scope].column;
}

/** Filtre SQL constant (aucune donnée utilisateur) restreignant les entrées à une portée. */
export function scopeKindSql(scope: Scope, alias = 'e'): string {
  const { kind, column } = SCOPE_RULES[scope];
  return kind === null ? 'true' : `(${alias}.kind = '${kind}' AND ${alias}.${column} IS NOT NULL)`;
}

export function escapeRegexTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Motifs PostgreSQL « mot entier » (`\m…\M`), à passer en paramètre `text[]` avec `~* ANY(…)`. */
export function wordPatterns(forms: readonly string[]): string[] {
  return forms.map((form) => `\\m${escapeRegexTerm(form)}\\M`);
}

const lexiqueCache = new Map<string, string[]>();

/** Vocabulaire normalisé du corpus pour une portée, mis en cache par version de corpus. */
export async function lexique(db: Db, scope: Scope, corpusVersion: string, collection?: string): Promise<string[]> {
  const cacheKey = JSON.stringify([scope, corpusVersion, collection]);
  const cached = lexiqueCache.get(cacheKey);
  if (cached) return cached;
  const column = scopeColumn(scope);
  const { rows } = await db.query<{ word: string }>(
    `SELECT DISTINCT m[1] AS word
     FROM entries e, LATERAL regexp_matches(e.${column}, '[a-z0-9]+(?:[.-][a-z0-9]+)*', 'g') m
     WHERE ${scopeKindSql(scope)} AND ($1::text IS NULL OR e.video_id IN (SELECT video_id FROM videos WHERE collection = $1))`,
    [collection ?? null],
  );
  const words = rows.map((r) => r.word).sort();
  if (lexiqueCache.size >= 8) lexiqueCache.clear();
  lexiqueCache.set(cacheKey, words);
  return words;
}

export function levenshtein(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    const ca = a[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

/** Distance tolérée : 1, ou 2 au-delà de 8 caractères. */
export function editThreshold(termLength: number): number {
  return termLength > 8 ? 2 : 1;
}

/** Mots du lexique les plus proches d'un terme, triés (distance, longueur, ordre alphabétique). */
export function nearestWords(
  term: string,
  words: readonly string[],
  threshold = editThreshold(term.length),
): Array<{ word: string; distance: number }> {
  const candidates: Array<{ word: string; distance: number }> = [];
  for (const word of words) {
    const distance = levenshtein(term, word, threshold);
    if (distance <= threshold) candidates.push({ word, distance });
  }
  return candidates.sort(
    (a, b) => a.distance - b.distance || a.word.length - b.word.length || (a.word < b.word ? -1 : 1),
  );
}

function brandAliasesFor(form: string): string[] {
  if (isCanonicalBrand(form)) return variantsOf(form);
  const canonical = aliasCanonical(form);
  return canonical ? [canonical] : [];
}

/**
 * Résout un terme vers une forme réellement présente dans l'index :
 * forme exacte (et alias validés) d'abord, sinon distance d'édition. Un flou
 * ambigu produit des suggestions, jamais un décompte.
 */
export async function resolveTerm(
  db: Db,
  rawTerm: string,
  scope: Scope,
  corpusVersion: string,
  collection?: string,
): Promise<ResolvedTerm> {
  const original = rawTerm.trim();
  const norm = tokenizeText(original).tokens.join(' ');
  const result: ResolvedTerm = {
    original,
    canonical: null,
    fuzzy: false,
    aliases: [],
    status: 'not_found',
    suggestions: [],
  };
  if (!norm) return result;

  const aliases = brandAliasesFor(norm);
  const exact = await db.query(
    `SELECT 1 FROM entries e
     WHERE ${scopeKindSql(scope)} AND e.${scopeColumn(scope)} ~* ANY($1::text[])
       AND ($2::text IS NULL OR e.video_id IN (SELECT video_id FROM videos WHERE collection = $2))
     LIMIT 1`,
    [wordPatterns([norm, ...aliases]), collection ?? null],
  );
  if ((exact.rowCount ?? 0) > 0) {
    return { ...result, canonical: norm, aliases, status: 'resolved' };
  }

  const candidates = nearestWords(norm, await lexique(db, scope, corpusVersion, collection));
  const best = candidates[0];
  if (!best) return result;
  const suggestions = candidates.slice(0, 5).map((c) => c.word);
  if (candidates.filter((c) => c.distance === best.distance).length > 1) {
    return { ...result, fuzzy: true, status: 'ambiguous', suggestions };
  }
  return {
    ...result,
    canonical: best.word,
    fuzzy: true,
    aliases: brandAliasesFor(best.word),
    status: 'resolved',
    suggestions: suggestions.slice(1),
  };
}
