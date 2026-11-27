import type { Pool } from 'pg';
import { repondre, type AnswerInput, type AnswerOptions, type AnswerResult } from './answer.js';
import { SURE_RELEVANCE, sourceContainsProof, type Claim } from './citations.js';
import { corpusLine } from './collections.js';
import { mapConcurrent } from './concurrent.js';
import { evidenceBudgetChars } from './passages.js';
import { lireContexte } from './read-context.js';
import { entrySource, groupSources, reference, type AnswerSource } from './sources.js';
import { foldAccents } from '../norm/normalize.js';
import { AGENT_FINAL_NOTE, AGENT_PROMPT, agentSchema, parseAgentTurn, type AgentPhrase } from '../prompts/agent.js';
import { llmFromConfig } from '../providers/llm.js';
import { formatTimestamp } from '../windows/format.js';

/**
 * Réponse approfondie : la réponse habituelle (`repondre`) ouvre un dossier, puis un modèle juge ce
 * dossier, demande au besoin d'autres recherches (nouvelle question posée au corpus, relecture d'une
 * scène) et rédige enfin une réponse dans la forme que la question attend : une liste d'éléments
 * nommés, une explication, un oui ou un non.
 *
 * La règle des citations ne change pas : chaque phrase cite des sources du dossier et recopie une
 * preuve que le code retrouve dans l'une d'elles ; une phrase sans preuve retrouvée est retirée. Si rien
 * ne tient, la réponse habituelle est rendue telle quelle.
 */

/** Tours de recherche complémentaire au plus, et actions par tour. */
const MAX_ROUNDS = 2;
const MAX_ACTIONS = 3;
const OUTPUT_TOKENS = 2600;
/** Sources gardées par recherche, et longueur d'un extrait montré au modèle. */
const MAX_SOURCES_PER_FINDING = 60;
const EXCERPT_CHARS = 420;
const MIN_EXCERPT_CHARS = 140;
/** Scène relue autour d'une source : assez pour une explication, sans noyer le dossier. */
const READ_BEFORE_S = 60;
const READ_AFTER_S = 120;
const MAX_READ_LINES = 40;
const MAX_REFERENCES = 6;

export interface AgentStep {
  outil: 'chercher' | 'lire';
  requête: string;
  /** Sources nouvelles apportées au dossier. */
  sources: number;
}

interface Finding {
  kind: 'recherche' | 'lecture';
  label: string;
  refused: boolean;
  claims: Array<{ text: string; keys: string[]; flag: string | null }>;
  /** Réponse rendue par le code (décompte, crédits) quand elle ne porte pas d'affirmations. */
  summary: string | null;
  keys: string[];
}

const KIND_LABEL = { parole: 'PAROLE', visuel: 'PLAN', titre: 'TITRE', description: 'DESCRIPTION' } as const;
const sameQuestion = (text: string) => foldAccents(text).replace(/[^a-z0-9]+/g, ' ').trim();

/** Dossier : sources citables (une par séquence), affirmations validées et ce qui les a trouvées. */
class Dossier {
  readonly sources = new Map<string, AnswerSource>();
  readonly findings: Finding[] = [];
  /** Identifiant d'entrée → séquence du dossier qui la contient. */
  private readonly keyOf = new Map<string, string>();
  private readonly aliasOf = new Map<string, string>();
  private readonly keyOfAlias = new Map<string, string>();

  private add(source: AnswerSource): { key: string; added: boolean } {
    const known = source.sourceIds.map((id) => this.keyOf.get(id)).find((key) => key !== undefined);
    if (known) return { key: known, added: false };
    this.sources.set(source.sourceId, source);
    for (const id of source.sourceIds) this.keyOf.set(id, source.sourceId);
    const alias = `s${this.aliasOf.size + 1}`;
    this.aliasOf.set(source.sourceId, alias);
    this.keyOfAlias.set(alias, source.sourceId);
    return { key: source.sourceId, added: true };
  }

  /** Verse une réponse de `repondre` au dossier ; rend le nombre de sources nouvelles. */
  addAnswer(question: string, result: AnswerResult): number {
    let added = 0;
    const keys: string[] = [];
    for (const source of result.sources.slice(0, MAX_SOURCES_PER_FINDING)) {
      const entry = this.add(source);
      if (entry.added) added += 1;
      if (!keys.includes(entry.key)) keys.push(entry.key);
    }
    const claims = result.claims.flatMap((claim) => {
      const cited = [...new Set(claim.sourceIds.flatMap((id) => this.keyOf.get(id) ?? []))].filter((key) => keys.includes(key));
      return cited.length ? [{ text: claim.text, keys: cited, flag: flagOf(claim) }] : [];
    });
    this.findings.push({
      kind: 'recherche',
      label: question,
      refused: result.refused,
      claims,
      summary: !result.refused && claims.length === 0 ? result.answer.slice(0, 1500) : null,
      keys,
    });
    return added;
  }

  /** Verse les lignes d'une scène relue ; chacune devient citable. */
  addReading(label: string, lines: AnswerSource[]): number {
    const keys: string[] = [];
    let added = 0;
    for (const line of lines.slice(0, MAX_READ_LINES)) {
      const entry = this.add(line);
      if (entry.added) { added += 1; keys.push(entry.key); }
    }
    if (keys.length) this.findings.push({ kind: 'lecture', label, refused: false, claims: [], summary: null, keys });
    return added;
  }

  asked(question: string): boolean {
    return this.findings.some((f) => f.kind === 'recherche' && sameQuestion(f.label) === sameQuestion(question));
  }

  aliases(): string[] {
    return [...this.keyOfAlias.keys()];
  }

  sourceOfAlias(alias: string): AnswerSource | undefined {
    const key = this.keyOfAlias.get(alias.trim().replace(/^\[+|\]+$/g, '').split(/\s/)[0] ?? '');
    return key === undefined ? undefined : this.sources.get(key);
  }

  /** Une séquence que seules des affirmations réservées citent reste « à vérifier » dans la réponse. */
  weak(key: string): boolean {
    const citing = this.findings.flatMap((f) => f.claims).filter((c) => c.keys.includes(key));
    return citing.length > 0 && citing.every((c) => c.flag === 'incertain' || c.flag?.startsWith('détail non confirmé') === true);
  }

  render(budgetChars: number): string {
    const cap = Math.max(MIN_EXCERPT_CHARS, Math.min(EXCERPT_CHARS, Math.floor(budgetChars / Math.max(1, this.sources.size)) - 90));
    const line = (key: string) => {
      const s = this.sources.get(key)!;
      const at = s.startS === null ? '' : ` ${formatTimestamp(s.startS)}`;
      const excerpt = s.excerpt.length > cap ? `${s.excerpt.slice(0, cap)}…` : s.excerpt;
      return `[${this.aliasOf.get(key)}${at} ${KIND_LABEL[s.kind]} « ${s.title.replace(/[«»]/g, '')} » ${s.publishedAt ?? 'date inconnue'}] ${excerpt.replace(/\s*\n\s*/g, ' ')}`;
    };
    const shown = new Set<string>();
    const blocks: string[] = [];
    let used = 0;
    for (const [index, finding] of this.findings.entries()) {
      const fresh = finding.keys.filter((key) => !shown.has(key));
      const lines: string[] = [];
      if (finding.kind === 'lecture') {
        lines.push(`<lecture n="${index + 1}" scene="${finding.label.replace(/"/g, '’')}">`);
      } else {
        lines.push(`<recherche n="${index + 1}" question="${finding.label.replace(/"/g, '’')}" issue="${finding.refused ? 'rien trouvé' : 'réponse'}">`);
        if (finding.claims.length) {
          lines.push('Affirmations validées :');
          for (const claim of finding.claims) {
            lines.push(`- ${claim.text} ${claim.keys.map((key) => `[${this.aliasOf.get(key)}]`).join('')}${claim.flag ? ` (${claim.flag})` : ''}`);
          }
        }
        if (finding.summary) lines.push('Réponse calculée par le code :', finding.summary);
        if (fresh.length) lines.push('Sources :');
      }
      for (const key of fresh) {
        const text = line(key);
        if (used + text.length > budgetChars) break;
        used += text.length;
        shown.add(key);
        lines.push(text);
      }
      lines.push(finding.kind === 'lecture' ? '</lecture>' : '</recherche>');
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
  }
}

function flagOf(claim: Claim): string | null {
  if (claim.missing !== undefined) return `détail non confirmé : ${claim.missing}`;
  if (claim.relevance !== undefined && claim.relevance < SURE_RELEVANCE) return 'incertain';
  if (claim.nature === 'en_passant') return 'en passant';
  if (claim.nature === 'promotion') return 'promotion';
  return null;
}

type Action = { outil: 'lire'; source: AnswerSource } | { outil: 'chercher'; question: string };

interface Written {
  phrase: AgentPhrase;
  keys: string[];
  uncertain: boolean;
}

/** Garde les phrases dont la preuve se retrouve dans une source citée ; les autres sont retirées. */
export function validatePhrases(phrases: AgentPhrase[], dossier: Pick<Dossier, 'sources' | 'sourceOfAlias' | 'weak'>): { written: Written[]; invalid: string[] } {
  const written: Written[] = [];
  const invalid: string[] = [];
  for (const phrase of phrases) {
    const keys: string[] = [];
    for (const alias of phrase.sourceIds) {
      const source = dossier.sourceOfAlias(alias);
      if (!source) invalid.push(alias);
      else if (!keys.includes(source.sourceId)) keys.push(source.sourceId);
    }
    const proves = (key: string) => sourceContainsProof(dossier.sources.get(key)!, phrase.preuve);
    let proven = keys.filter(proves);
    // Preuve exacte mais alias voisin : une citation assez longue et unique dans le dossier désigne sa ligne.
    if (!proven.length && phrase.preuve.split(/\s+/).length >= 4) {
      const elsewhere = [...dossier.sources.keys()].filter(proves);
      if (elsewhere.length === 1) { keys.unshift(elsewhere[0]!); proven = elsewhere; }
    }
    if (!proven.length) {
      invalid.push(...phrase.sourceIds);
      continue;
    }
    // La source qui porte la preuve d'abord : c'est elle que la référence ouvre.
    const ordered = [...proven, ...keys.filter((key) => !proven.includes(key))].slice(0, MAX_REFERENCES);
    const clean = (text: string) => text.replace(/\[s\d+[^\]]*\]/g, '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
    const texte = clean(phrase.texte);
    if (!texte) continue;
    written.push({
      phrase: { ...phrase, texte, titre: clean(phrase.titre).replace(/\s*:$/, '') },
      keys: ordered,
      uncertain: phrase.incertain || ordered.every((key) => dossier.weak(key)),
    });
  }
  return { written, invalid };
}

/** Texte de la réponse : paragraphes et puces, chaque phrase suivie de ses références. */
export function renderWritten(written: Written[], sources: ReadonlyMap<string, AnswerSource>): string {
  const refs = (keys: string[]) => groupSources(keys.map((key) => sources.get(key)!)).map(reference).join(' ');
  const bullet = (w: Written) => `- ${w.phrase.titre ? `**${w.phrase.titre}** : ` : ''}${w.phrase.texte} ${refs(w.keys)}`;
  const sure = written.filter((w) => !w.uncertain);
  const unsure = written.filter((w) => w.uncertain);
  const listed = new Set(sure.filter((w) => w.phrase.forme === 'puce').flatMap((w) => w.keys));
  const lines: string[] = [];
  for (const [index, w] of sure.entries()) {
    if (w.phrase.forme === 'puce') { lines.push(bullet(w)); continue; }
    // Phrase d'ouverture d'une liste : ses références sont déjà sur les puces qu'elle annonce.
    const opensList = sure[index + 1]?.phrase.forme === 'puce' && w.keys.every((key) => listed.has(key));
    const lead = w.phrase.titre ? `**${w.phrase.titre}** : ` : '';
    if (lines.length && sure[index - 1]?.phrase.forme === 'puce') lines.push('');
    lines.push(opensList ? `${lead}${w.phrase.texte}` : `${lead}${w.phrase.texte} ${refs(w.keys)}`);
  }
  if (unsure.length) {
    if (lines.length) lines.push('');
    lines.push('Pertinence incertaine, à vérifier :', ...unsure.map(bullet));
  }
  return lines.join('\n');
}

export async function repondreAgent(pool: Pool, input: AnswerInput, options: AnswerOptions = {}): Promise<AnswerResult> {
  const startedAt = Date.now();
  const question = input.question;
  const progress = options.onProgress ?? (() => {});
  const first = await repondre(pool, { ...input, mode: 'détaillé' }, options);
  const llm = options.llm !== undefined ? options.llm : llmFromConfig(pool);
  // Une demande de précision attend la réponse de la personne. Sans modèle, rien pour juger ni rédiger.
  // Tout le reste passe par la rédaction, décompte exact et repli extractif compris.
  if (!llm || first.route === 'clarifier' || !(await llm.available())) return first;

  const dossier = new Dossier();
  dossier.addAnswer(first.resolvedQuestion, first);
  const steps: AgentStep[] = [];
  const considered = new Set(first.consideredVideoIds);
  const corpus = await corpusLine(pool, input.collection);
  const budget = evidenceBudgetChars(OUTPUT_TOKENS);
  let written: Written[] = [];
  let invalid: string[] = [];
  let failure: string | null = null;

  try {
    for (let round = 0; ; round++) {
      const final = round >= MAX_ROUNDS;
      progress({ étape: 'synthèse' });
      const user = [
        ...(corpus ? [corpus] : []),
        `Question : ${first.resolvedQuestion}`,
        '',
        'Dossier :',
        dossier.render(budget),
        '',
        final ? AGENT_FINAL_NOTE : `Recherches encore permises : ${MAX_ROUNDS - round} tour(s) de ${MAX_ACTIONS} au plus.`,
      ].join('\n');
      const turn = parseAgentTurn(await llm.chat(AGENT_PROMPT, user, { maxTokens: OUTPUT_TOKENS, jsonSchema: agentSchema(dossier.aliases()), temperature: 0 }));
      if (!turn) { failure = 'synthèse hors du format imposé'; break; }
      const seen = new Set<string>();
      const actions: Action[] = final ? [] : turn.recherches.flatMap((action): Action[] => {
        if (action.outil === 'lire') {
          // Seules les sources du dossier se relisent : elles viennent d'une recherche déjà bornée à la collection.
          const source = dossier.sourceOfAlias(action.source);
          if (!source || source.startS === null || seen.has(`lire ${source.sourceId}`)) return [];
          seen.add(`lire ${source.sourceId}`);
          return [{ outil: 'lire', source }];
        }
        const wanted = action.requete.slice(0, 400).trim();
        if (wanted.length < 8 || dossier.asked(wanted) || seen.has(sameQuestion(wanted))) return [];
        seen.add(sameQuestion(wanted));
        return [{ outil: 'chercher', question: wanted }];
      }).slice(0, MAX_ACTIONS);
      if (!actions.length) {
        ({ written, invalid } = turn.refus ? { written: [], invalid: [] } : validatePhrases(turn.phrases, dossier));
        break;
      }
      const found = await mapConcurrent(actions, MAX_ACTIONS, async (action) => {
        if (action.outil === 'lire') {
          const { source } = action;
          const label = `« ${source.title} » vers ${formatTimestamp(source.startS!)}`;
          progress({ étape: 'approfondissement', outil: 'lire', requête: label });
          const page = await lireContexte(pool, { videoId: source.videoId, atS: source.startS!, beforeS: READ_BEFORE_S, afterS: READ_AFTER_S });
          return { outil: 'lire' as const, label, lines: page.data.entries.map((entry) => entrySource(entry, page.data)) };
        }
        progress({ étape: 'approfondissement', outil: 'chercher', requête: action.question });
        // Même chaîne de preuves que la question d'origine, sans son historique ni son affichage au fil de l'eau.
        const { onProgress: _onProgress, ...quiet } = options;
        const result = await repondre(pool, { question: action.question, mode: 'détaillé', ...(input.collection ? { collection: input.collection } : {}) }, quiet);
        return { outil: 'chercher' as const, label: action.question, result };
      });
      let fresh = 0;
      // Versés dans l'ordre demandé : les alias du dossier ne dépendent pas de la vitesse des recherches.
      for (const item of found) {
        const added = item.outil === 'lire' ? dossier.addReading(item.label, item.lines) : dossier.addAnswer(item.label, item.result);
        if (item.outil === 'chercher') for (const id of item.result.consideredVideoIds) considered.add(id);
        steps.push({ outil: item.outil, requête: item.label, sources: added });
        fresh += added;
      }
      // Rien de neuf : inutile de chercher encore, le tour suivant rédige.
      if (fresh === 0) round = MAX_ROUNDS - 1;
    }
  } catch (err) {
    failure = `approfondissement interrompu : ${err instanceof Error ? err.message : String(err)}`;
  }

  const agent = { steps, composed: written.length > 0 };
  const totalMs = Date.now() - startedAt;
  if (!written.length) {
    // Rien de rédigé qui tienne : la réponse habituelle reste la référence, refus compris.
    return { ...first, agent, ...(failure ? { degraded: true, degradedReason: [first.degradedReason, failure].filter(Boolean).join(' ; ') } : {}),
      timings: { ...first.timings, llmMs: totalMs - first.timings.searchMs, totalMs } };
  }
  const citedKeys = [...new Set(written.flatMap((w) => w.keys))];
  const cited = groupSources(citedKeys.map((key) => dossier.sources.get(key)!));
  // Décompte exact : la rédaction l'introduit, la liste complète calculée par le code reste dessous, intacte.
  const counted = first.route === 'lister' && !first.refused;
  const answer = counted ? `${renderWritten(written, dossier.sources)}\n\n${first.answer}` : renderWritten(written, dossier.sources);
  const listed = new Set(first.sources.flatMap((s) => s.sourceIds));
  const sources = counted ? [...first.sources, ...cited.filter((s) => !s.sourceIds.some((id) => listed.has(id)))] : cited;
  const { sceneAnchors: _sceneAnchors, offeredEpisodeSearch: _offered, ...base } = first;
  return {
    ...base,
    answer,
    refused: false,
    claims: written.map((w) => ({ text: w.phrase.titre ? `${w.phrase.titre} : ${w.phrase.texte}` : w.phrase.texte, sourceIds: w.keys, preuve: w.phrase.preuve })),
    citedSourceIds: sources.flatMap((s) => s.sourceIds),
    invalidCitations: invalid,
    sources,
    consideredVideoIds: [...considered],
    retrieval: first.retrieval ?? 'vecteurs',
    model: llm.model,
    agent,
    timings: { searchMs: first.timings.searchMs, llmMs: totalMs - first.timings.searchMs, totalMs },
  };
}
