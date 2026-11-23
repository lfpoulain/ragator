import type { Pool } from 'pg';
import { readSnapshot } from '../db/pool.js';
import { normalizeText, tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import { promptLine, SYSTEM_PROMPT, SYSTEM_PROMPT_PROOF, type PromptWindow } from '../prompts/answer.js';
import type { RequiredTerm } from './analyze.js';
import { renderClaims, sourceContainsProof, type AnswerMode, type Claim, type validateClaims } from './citations.js';
import type { Scope } from './page.js';
import { passagesForSpans } from './passages.js';
import { missingRequiredGroups, requiredGroups } from './requirements.js';
import { reference, type AnswerSource } from './sources.js';

/** Repli si l'analyse sémantique manque. L'inversion sujet/verbe couvre des gestes inconnus du dictionnaire. */
export function asksAboutAction(question: string): boolean {
  if (/(?<!\p{L})(?:parl|mentionn|cit|évoqu|pens)(?:e|ent|é|er)(?!\p{L})/iu.test(question)) return false;
  return /(?<!\p{L})(?:\p{L}+ent-(?:ils|elles)|les voit-on\s+\p{L}+(?:er|ir|re)|(?:utilis|employ|test|fabriqu|install|répar|découp|coll|soud|imprim|programm|branch|déball|assembl|perc|fix)(?:e|ent|er|ez|ée?s?|ait|aient|ant|ons)|construi(?:te?s?|sent|re|saient)|serv(?:ent|ir|is?)|emploient)(?!\p{L})/iu.test(question);
}

const ACTION_RULE = `
Vérifie précisément la relation demandée. Identifie qui fait quoi, avec quel objet et à quel moment. Une marque sur un autre outil, un logo isolé, une annonce ou un projet futur ne prouvent pas l'action décrite. Vérifie si la question suppose à tort un objet, une marque ou un geste accompli. Si un passage montre l'objet effectivement employé à la place de celui supposé, décris ce fait et corrige la prémisse. Si le geste est un souhait, une blague ou un projet, cite ensemble la ligne qui établit ce statut et celle qui nomme le geste. Ce sont des réponses établies : "refus" false, même si personne ne dit explicitement « cela n'est jamais arrivé ». Limite la correction au projet ou à la scène attestée. Le champ "correction" recopie la valeur réelle qui figure à la fois dans les lignes citées et dans ta réponse (marque, modèle, autre détail rectifié) ; sinon écris "". Cite la ligne qui montre le résultat fini quand la question demande ce qu'ils font finalement.
Trois sorties possibles :
- Réponse établie : "refus" false, affirmations et preuves. Une réponse négative exige aussi une preuve explicite.
- Indice pertinent, relation incertaine : "refus" true, avec UNE affirmation limitée à ce qui est observé. Recopie dans "preuve" les mots exacts de la ligne autour de laquelle il faudrait relire la scène et cite uniquement son identifiant.
- Aucun indice sur le sujet : "refus" true, "claims" vide.`;

const NO_ANSWER_RULE = 'Si les extraits ne contiennent pas l\'information demandée : "refus": true et "claims": [].';
const PARTIAL_RULE = 'Si les extraits ne répondent que partiellement à une question sur un geste, conserve au plus une piste selon la règle ci-dessous. Sans indice, "refus": true et "claims": [].';
export const ACTION_SYSTEM_PROMPT = SYSTEM_PROMPT_PROOF.replace(NO_ANSWER_RULE, PARTIAL_RULE) + ACTION_RULE;

/** La rédaction spéculative démarre avant l'analyse. Le même schéma accepte les deux résultats possibles. */
export const SPECULATIVE_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(NO_ANSWER_RULE, PARTIAL_RULE) + `
Chaque affirmation a aussi un champ "preuve". Pour une question factuelle ordinaire, ce champ vaut null.
Si la réponse demande d'établir un geste, son objet, son moment ou sa manière, écris dans "preuve" au plus 20 mots consécutifs de la ligne décisive et applique la règle suivante :` + ACTION_RULE;

type Validation = ReturnType<typeof validateClaims>;

// Un projet futur ou un souvenir, seul dans la preuve citée, ne démontre pas l'exécution dans cette scène.
// On accepte ces temps quand ils sont demandés ou restitués comme tels.
const OTHER_TIME = /(?<!\p{L})(?:plus tard|prévu\p{L}*|prévoi\p{L}*|envisag\p{L}*|la prochaine fois|(?:on va|nous allons|ils vont|compte(?:nt)?|comptons)\s+(?:\p{L}+\s+){0,2}\p{L}+(?:er|ir|re)|(?:on a|nous avons|ils ont) (?:déjà|auparavant))(?!\p{L})/iu;
const EXPRESS_OTHER_TIME = /(?<!\p{L})(?:déjà|auparavant|autrefois|prévue?s?|à l'avenir|au futur)(?!\p{L})/iu;

const WISH = /(?<!\p{L})(?:rêv\p{L}*|souhait\p{L}*|esp[éè]r\p{L}*|voudr\p{L}*|aimerai\p{L}*|désir\p{L}*)(?!\p{L})/iu;

/** Une parole « et qu’on … » hérite du souhait de la proposition qui la gouverne. Chercher un seul
 * antécédent immédiat déjà transmis au modèle ; seule une interjection peut s'intercaler. */
function precedingWish(line: AnswerSource, sources: Map<string, AnswerSource>): AnswerSource | undefined {
  const at = line.startS!;
  const preceding = [...sources.values()].filter((s) =>
    s.videoId === line.videoId && s.kind === 'parole' && s.startS !== null && s.startS < at && at - s.startS <= 10,
  );
  const options = preceding.filter((s) => at - (s.endS ?? s.startS!) <= 3 &&
    /(?<!\p{L})(?:rêv\p{L}*|souhait\p{L}*|esp[éè]r\p{L}*|voudr\p{L}*|aimerai\p{L}*|désir\p{L}*)\s+(?:(?:bien|vraiment|tant)\s+)?qu(?:e\s|['’])/iu.test(s.excerpt) &&
    !/(?<!\p{L})(?:ne|n['’]|pas|jamais|aucun\p{L}*)(?!\p{L})/iu.test(s.excerpt) &&
    preceding.every((next) => next.startS! <= s.startS! || /^\s*(?:ah|oh|ouais|oui|euh|hm)[\s.!?,…]*$/iu.test(next.excerpt)));
  return options.length === 1 ? options[0] : undefined;
}

export interface ActionClue {
  source: AnswerSource;
  proof: string;
  missing: string;
  alternative?: string;
}

/** Le rédacteur vérifie le sens. Le code exige la preuve recopiée et contrôle les noms propres affirmés. */
export function assessAction(
  validated: Validation,
  sources: Map<string, AnswerSource>,
  mode: AnswerMode,
  question: string,
  required: RequiredTerm[],
  scope: Scope,
): { validated: Validation; clue: ActionClue | null } {
  const claims: Claim[] = [];
  let clue: ActionClue | null = null;
  const groups = requiredGroups(question, required);
  for (const candidate of validated.claims) {
    if (!candidate.preuve) continue;
    let claim = candidate;
    const cited = candidate.sourceIds.map((id) => sources.get(id)!);
    const line = cited[0]!;
    let incompleteClause = false;
    const subordinate = /^(?:et|ou)\s+qu(?:e\s|['’])/iu.test(line.excerpt.trim());
    const mainClauses = subordinate ? line.excerpt.split(/(?:[.!?]\s+|,\s+(?=(?:et (?:ben|bah)|alors|actuellement|aujourd’hui|maintenant)\b))/iu).slice(1) : [];
    if (cited.length === 1 && line.kind === 'parole' && line.startS !== null && subordinate &&
        !mainClauses.some(excerpt => sourceContainsProof({ excerpt }, candidate.preuve!))) {
      const governor = precedingWish(line, sources);
      if (governor) {
        cited.unshift(governor);
        claim = { ...claim, sourceIds: [governor.sourceId, line.sourceId] };
        if (!WISH.test(claim.text)) {
          claim.text = `Ils évoquent un souhait. « ${governor.excerpt} » « ${line.excerpt} »`;
        }
      } else {
        incompleteClause = true;
      }
    }
    const norm = cited.map((line) => normalizeText(line.excerpt)).join(' | ');
    const absentGroups = missingRequiredGroups(groups, norm);
    // Parmi des alternatives (« A ou B »), l'objet effectivement nommé dans la réponse doit être attesté.
    const statement = ` ${normalizeText(claim.text)} `;
    const named = required.filter(({ forms }) => forms.some((form) => statement.includes(` ${form} `)));
    // Le nom supposé n'a pas à être inscrit sur l'objet réellement employé. L'alternative doit
    // provenir de la preuve et être elle-même énoncée dans la réponse.
    const replacement = claim.correction ? tokenizeText(claim.correction).tokens : [];
    const premise = new Set(tokenizeText(question).tokens);
    const corrected = contentTokens(replacement).some((t) => !premise.has(t)) && statement.includes(` ${replacement.join(' ')} `)
      && cited.every((s) => s.videoId === cited[0]!.videoId);
    const missingName = !corrected && (absentGroups.length > 0 || missingRequiredGroups(named.map((term) => [term]), norm).length > 0);
    const describesAnotherTime = (s: string) => OTHER_TIME.test(s) || EXPRESS_OTHER_TIME.test(s);
    const singleStatement = !/[.;!?]\s+\p{L}|\bmais\b/iu.test(candidate.preuve);
    const otherTime = cited.length === 1 && singleStatement && OTHER_TIME.test(candidate.preuve) && ![question, claim.text].some(describesAnotherTime);
    const missingVisual = scope === 'visuel' && !cited.some((s) => s.kind === 'visuel');
    const missingScreen = scope === 'ecran' && !cited.some((s) => s.kind === 'visuel' && s.excerpt.includes('ÉCRAN :'));
    const missingSpeech = scope === 'paroles' && !cited.some((s) => s.kind === 'parole');
    let missing: string | null = null;
    if (incompleteClause) missing = 'Ce fragment dépend de la parole qui le précède. Le geste reste à confirmer.';
    else if (missingName) missing = "Les lignes citées ne permettent pas d'attribuer le nom demandé à cet objet.";
    else if (missingVisual || missingScreen) missing = "L’extrait ne confirme pas ce que l’on voit à l’image.";
    else if (missingSpeech) missing = "L’extrait ne confirme pas ce qui a été dit.";
    else if (otherTime) missing = "Ce passage évoque un autre moment. Le geste reste à confirmer dans la scène demandée.";
    else if (validated.refused) missing = 'Le passage ne suffit pas à établir le lien demandé.';
    if (!missing) {
      claims.push(claim);
      continue;
    }
    // validateClaims a déjà rattaché la preuve à sa ligne. En cas de doute on ne reprendra que la citation.
    const owner = cited.find((line) => sourceContainsProof(line, claim.preuve!));
    if (owner && owner.startS !== null && (!clue || (corrected && !clue.alternative))) {
      clue = { source: owner, proof: candidate.preuve, missing, ...(corrected && claim.correction ? { alternative: claim.correction } : {}) };
    }
  }
  return {
    validated: { ...validated, claims, answer: renderClaims(claims, sources, mode) },
    clue: claims.length ? null : clue,
  };
}

/** Une piste n'autorise aucune reformulation du geste. Le lecteur reçoit la preuve d'origine et son statut. */
export function uncertainAction(validated: Validation, clue: ActionClue): Validation {
  const quote = clue.source.excerpt.includes(clue.proof) ? clue.proof : clue.source.excerpt;
  const text = `« ${quote} »`;
  const missing = clue.missing;
  return {
    ...validated,
    refused: false,
    claims: [{ text, sourceIds: [clue.source.sourceId], preuve: quote, missing }],
    answer: `${text} ${reference(clue.source)}\n${missing}`,
  };
}

/** Une valeur alternative proposée par le rédacteur est confirmée indépendamment quand une autre ligne
 * décrit le même couple objet–valeur dans la modalité demandée. Le résultat cite littéralement cette
 * seconde ligne : aucune conclusion sur le geste n'est inventée par le code à partir d'un simple logo. */
export function corroboratedAlternative(clue: ActionClue, question: string, scene: PromptWindow, scope: Scope): Claim | null {
  if (!clue.alternative) return null;
  const value = tokenizeText(clue.alternative).tokens.join(' ');
  const initial = ' ' + tokenizeText(clue.proof).tokens.join(' ') + ' ';
  const pairs = contentTokens(tokenizeText(question).tokens).filter((t) => t.length >= 3 && !t.includes('-'))
    .flatMap((t) => [` ${t} ${value} `, ` ${value} ${t} `]).filter((pair) => initial.includes(pair));
  if (!pairs.length) return null;
  for (const entry of scene.entries) {
    if (entry.sourceId === clue.source.sourceId || entry.uncertainties.length) continue;
    if ((scope === 'visuel' || scope === 'ecran') && entry.kind !== 'visuel') continue;
    if (scope === 'paroles' && entry.kind !== 'parole') continue;
    if (scope === 'ecran' && !entry.screenText?.some((t) => tokenizeText(t).tokens.join(' ').includes(value))) continue;
    const body = ' ' + tokenizeText(entry.text).tokens.join(' ') + ' ';
    if (!pairs.some((pair) => body.includes(pair)) || OTHER_TIME.test(entry.text)) continue;
    if (/(?<!\p{L})(?:pas|jamais|aucun\p{L}*|sans|peut-être|pourrai\p{L}*|serai\p{L}*)(?!\p{L})/iu.test(entry.text)) continue;
    return {
      text: `L’extrait identifie « ${clue.alternative} ». « ${entry.text} »`,
      preuve: entry.text, correction: clue.alternative, sourceIds: [entry.sourceId],
    };
  }
  return null;
}

/** Une seule scène de la même vidéo et de la même version du corpus, avec ses plans et paroles d'origine. */
export async function actionNeighborhood(
  pool: Pool, source: AnswerSource, corpusVersion: string, known: ReadonlyMap<string, AnswerSource>, scope: Scope, budget: number,
  question: string, required: RequiredTerm[],
): Promise<PromptWindow | null> {
  if (source.startS === null) return null;
  const proposed = source.startS;
  const kind = scope === 'visuel' || scope === 'ecran' ? 'visuel' : scope === 'paroles' ? 'parole' : null;
  const candidates = contentTokens(tokenizeText(question).tokens);
  const names = new Set(required.flatMap((r) => r.forms.flatMap((form) => tokenizeText(form).tokens)));
  const words = [...new Set(candidates.filter((t) => t.length >= 3 && !t.includes('-') && !names.has(t)))];
  const finished = /(?<!\p{L})(?:finalement|finale?s?|finie?s?|terminée?s?|achevée?s?)(?!\p{L})/iu.test(question);
  const selected = await readSnapshot(pool, async (db, versions) => {
    if (versions.corpusVersion !== corpusVersion) return null;
    // Chercher le résultat du geste dans la seule vidéo retenue, sans exiger la marque supposée.
    // À couverture égale la scène proposée reste prioritaire, sauf demande explicite du résultat fini.
    const { rows } = await db.query<{ start_s: number; source_id: string }>(
      `SELECT e.start_s, e.source_id FROM entries e
       CROSS JOIN LATERAL (
         SELECT count(*) AS n FROM unnest($2::text[]) AS w(word)
         WHERE strpos(' ' || e.norm_text || ' ', ' ' || w.word || ' ') > 0
       ) score
       WHERE e.video_id = $1 AND ($3::text IS NULL OR e.kind = $3) AND score.n > 0
       ORDER BY score.n + CASE WHEN $4 AND e.norm_text ~ '(^| )(fini(e|es|s)?|final(e|es|s)?|resultat|termine(e|es|s)?|acheve(e|es|s)?)( |$)' THEN 1 ELSE 0 END DESC,
                CASE WHEN $4 THEN e.start_s END DESC, abs(e.start_s - $5), e.source_id LIMIT 1`,
      [source.videoId, words, kind, finished, proposed],
    );
    const at = rows[0]?.start_s ?? proposed;
    const span = { videoId: source.videoId, title: source.title, publishedAt: source.publishedAt, startS: Math.max(0, at - 45), endS: at + 45, rank: 0 };
    const scene = (await passagesForSpans(db, [span]))[0];
    return scene ? { scene, at, anchor: rows[0]?.source_id ?? source.sourceId } : null;
  });
  if (!selected) return null;
  const { scene, at, anchor } = selected;
  const nearest = scene.entries.filter((e) => !kind || e.kind === kind || e.sourceId === anchor || e.sourceId === source.sourceId).sort((a, b) =>
    Number(b.sourceId === anchor) - Number(a.sourceId === anchor) || Math.abs(a.startS - at) - Math.abs(b.startS - at),
  );
  let left = Math.min(8_000, budget) - 200;
  const entries = nearest.filter((entry) => {
    const size = promptLine(entry, () => 's000').length + 1;
    if (size > left) return false;
    left -= size;
    return true;
  });
  if (!entries.some((e) => e.sourceId === anchor)) return null;
  if (entries.length === known.size && entries.every((e) => known.has(e.sourceId))) return null;
  return { ...scene, entries: entries.sort((a, b) => a.startS - b.startS || a.sourceId.localeCompare(b.sourceId)) };
}
