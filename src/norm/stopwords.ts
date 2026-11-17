/**
 * Mots vides, sous forme normalisée (minuscules, sans accents).
 * Ils ne portent pas le sujet d'une question : ils ne servent ni de terme
 * exhaustif, ni de preuve lexicale, ni de déclencheur d'expansion.
 */
const FUNCTION_WORDS = [
  'a', 'ai', 'as', 'au', 'aux', 'avec', 'avoir', 'c', 'ca', 'ce', 'ces', 'cet', 'cette',
  'chez', 'comme', 'comment', 'd', 'dans', 'de', 'des', 'donc', 'du', 'elle', 'elles',
  'en', 'est', 'et', 'etait', 'ete', 'etre', 'eu', 'fait', 'il', 'ils', 'j', 'je', 'l',
  'la', 'le', 'les', 'leur', 'leurs', 'lui', 'm', 'ma', 'mais', 'me', 'mes', 'moi', 'mon',
  'n', 'ne', 'nos', 'notre', 'nous', 'on', 'ont', 'ou', 'par', 'pas', 'plus', 'pour',
  'pourquoi', 'qu', 'quand', 'que', 'quel', 'quelle', 'quelles', 'quels', 'qui', 'quoi',
  's', 'sa', 'sans', 'se', 'ses', 'si', 'son', 'sont', 'sur', 't', 'ta', 'te', 'tes',
  'toi', 'ton', 'tous', 'tout', 'toute', 'toutes', 'tu', 'un', 'une', 'vos', 'votre',
  'vous', 'y', 'alors', 'aussi', 'juste', 'vient', 'avait',
];

/** Mots de la question qui décrivent la recherche elle-même, pas son objet. */
const QUESTION_WORDS = [
  'video', 'videos', 'episode', 'episodes', 'passage', 'passages', 'extrait', 'extraits',
  'moment', 'instant', 'parle', 'parler', 'parlant', 'parlent', 'dit', 'dire', 'voir',
  'voit', 'montre', 'montrent', 'montrer', 'montre-t-on', 'ecran', 'image', 'parole',
  'paroles', 'corpus', 'mentionne', 'cite', 'combien', 'fois', 'liste', 'partout',
];

export const STOPWORDS: ReadonlySet<string> = new Set([...FUNCTION_WORDS, ...QUESTION_WORDS]);

/** Jetons qui portent le sujet : ni mots vides, ni mots de la question. */
export function contentTokens(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !STOPWORDS.has(token));
}
