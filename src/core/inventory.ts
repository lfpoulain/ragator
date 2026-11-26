import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readSnapshot } from '../db/pool.js';
import { getConfig } from '../config.js';
import { foldAccents, tokenizeText } from '../norm/normalize.js';
import { STOPWORDS } from '../norm/stopwords.js';
import type { LlmClient } from '../providers/llm.js';
import { INVENTORY_READ, INVENTORY_READ_SCHEMA, INVENTORY_SELECT, INVENTORY_SELECT_SCHEMA, INVENTORY_VERIFY, INVENTORY_VERIFY_SCHEMA } from '../prompts/inventory.js';
import type { AnswerProgress, AnswerResult } from './answer.js';
import { sourceContainsProof, type Claim } from './citations.js';
import type { RoutedQuery } from './classify.js';
import { mapConcurrent } from './concurrent.js';
import { collectionSql, videoIdSql, videoIdsSql } from './filters.js';
import { inventoryFormat, inventoryRestriction } from './followup.js';
import { CorpusChangedError, evidenceBudgetChars, passagesForSpans } from './passages.js';
import { scopeColumn, scopeKindSql, wordPatterns } from './resolve.js';
import { entrySource, reference, type AnswerSource } from './sources.js';

interface Card { videoId: string; title: string; publishedAt: string | null; endS: number }
interface Item { brand: string; model: string; name: AnswerSource; test: AnswerSource; proof: string; categorySource?: AnswerSource }

// Conserve les suffixes de variantes tels que S ou +, que la tokenisation de recherche peut effacer.
const words = (s: string) => foldAccents(s).replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, ' ').trim();
function namePattern(phrase: string): RegExp {
  const tokens = words(phrase).split(/\s+|(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/).filter(Boolean);
  return tokens.length ? new RegExp('(?:^| )' + tokens.join(' *') + '(?= |$)(?! plus(?: |$))') : /(?!)/;
}
const has = (s: string, phrase: string) => namePattern(phrase).test(words(s));
const TEST_WORDS = /\b(?:test\w*|essay\w*|essai\w*|evalu\w*|resultats?|verdict|compar\w*|mesur\w*|bilan|performances?)\b/;
const TRIAL = /\b(?:test(?:e|es|ent|ons|ee?s?|er)?|essai[s]?|essay(?:e|es|ent|ons|ee?s?|er)|techno\s?test|banc d essai|mise? a l epreuve)\b/;

/** Seul un nom issu de la question peut lier un modèle à la catégorie demandée. */
function categoryPattern(question: string, terms: string[]): RegExp | null {
  const questionWords = words(question);
  for (const term of terms) {
    const noun = words(term).split(' ').find(w => w.length >= 3 && !STOPWORDS.has(w) &&
      !/^(?:modeles?|references?|marques?|appareils?|produits?|types?|tests?|essais?|testes?|reviews?)$/.test(w));
    if (!noun) continue;
    const pattern = new RegExp('\\b' + noun.replace(/s$/, '') + 's?\\b');
    if (pattern.test(questionWords)) return pattern;
  }
  return null;
}

function namedTrial(s: AnswerSource, model: string): boolean {
  if (s.kind !== 'parole' || /(?:…|\.\.\.)\s*$/.test(s.excerpt)) return false;
  const text = words(s.excerpt).replace(/\bpas n importe\b/g, '');
  const verb = /\b(?:on (?:a |avait )?(?:vraiment |deja )?(?:teste|essaye)|nous (?:avons (?:teste|essaye)|testons|essayons)|j ai (?:teste|essaye)|celle? qu on teste|tester et (?:vous )?presenter|(?:notre|avec ce) (?:test|essai) de)\b/g;
  for (const match of text.matchAll(verb)) {
    const tail = text.slice(match.index + match[0].length).trimStart();
    const at = tail.search(namePattern(model));
    if (at >= 0 && at < 100 && !/\b(?:sur|avec|mais|pour|comme|pas|sans|autre)\b/.test(tail.slice(0, at)) &&
      !/\b(?:pas|blague|ah non)\b/.test(text.slice(Math.max(0, match.index - 55), match.index))) return true;
  }
  return false;
}

function parts<T>(values: T[], count: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += count) result.push(values.slice(i, i + count));
  return result;
}

/** Échantillonne l'épisode entier. Les lignes nommant une référence et les preuves de la recherche
 * hybride gardent la priorité. L'ordre chronologique est rétabli pour interpréter les pronoms. */
function reading(sources: AnswerSource[], hints: string[], ranked: ReadonlySet<string>, budget: number): AnswerSource[] {
  const terms = [...new Set(hints.flatMap(h => [h, ...words(h).split(' ').filter(t => t.length >= 3)]))];
  const patterns = terms.map(namePattern);
  const scored = sources.map((source, index) => {
    const text = words(source.excerpt);
    const named = patterns.some(pattern => pattern.test(text));
    const action = TEST_WORDS.test(text);
    const score = (named ? 5 : 0) + (action ? 4 : 0) + (ranked.has(source.sourceId) ? 3 : 0) +
      (index < 12 ? 2 : 0) + (index >= sources.length - 8 ? 1 : 0);
    return { source, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Map<number, AnswerSource>();
  // L'annonce initiale précise souvent la variante, parfois en corrigeant la réplique précédente.
  for (const [i, s] of sources.entries()) {
    if (s.startS! > 95 || budget < 5000) break;
    if (s.kind === 'parole' && s.excerpt.length < 900) { selected.set(i, s); budget -= s.excerpt.length + 35; }
  }
  for (const { source, index } of scored) {
    if (budget < 100) break;
    const cost = source.excerpt.length + 35;
    if (cost > budget || selected.has(index)) continue;
    selected.set(index, source);
    budget -= cost;
  }
  return [...selected].sort(([a], [b]) => a - b).map(([, s]) => s);
}

function checkedItem(row: Record<string, unknown>, lines: AnswerSource[], episode: AnswerSource[], category: RegExp | null): Item | null {
  if (typeof row.modele !== 'string' || typeof row.marque !== 'string' || typeof row.citation !== 'string' ||
    !Number.isInteger(row.nom) || !Number.isInteger(row.essai)) return null;
  let name = lines[Number(row.nom) - 1], test = lines[Number(row.essai) - 1];
  if (!name || !test) return null;
  const brand = row.marque.trim();
  const spellings = row.modele.split(/[()]/).map(s => s.trim()).flatMap(s => {
    const plain = s.replace(/^original(?:e)?\s+/i, '');
    return plain !== s && brand && words(plain).startsWith(words(brand) + ' ') ? [plain, s] : [s];
  }).filter(s => s.length > 1 && s.length <= 100 && /[a-z]/.test(words(s)));
  const namedLine = name;
  const model = spellings.find(m => has(namedLine.excerpt, m)) ?? spellings.find(m => episode.some(s => has(s.excerpt, m)));
  if (!model) return null;
  if (!has(name.excerpt, model)) name = episode.find(s => has(s.excerpt, model));
  if (!name) return null;
  if (words(brand) === words(model)) return null;
  const attestedBrand = brand && has([name.title, name.excerpt, test.excerpt].join(' | '), brand) ? brand : '';
  const brandPrefix = words(brand) + ' ';
  const short = brand && words(model).startsWith(brandPrefix) ? words(model).slice(brandPrefix.length) : model;
  const ref = short.length > 1 && /[a-z]/i.test(short) ? short : model;
  let categorySource: AnswerSource | undefined;
  if (category && !category.test(words(name.title))) {
    // Une comparaison générique entre deux familles d'appareils ne classe pas le modèle testé.
    categorySource = [name, test, ...episode].find(s => category.test(words(s.excerpt)) && has(s.excerpt, ref));
    if (!categorySource) return null;
  }
  const typed = categorySource ? { categorySource } : {};
  const namedInTitle = has(name.title, model) || !!attestedBrand && has(name.title, attestedBrand) &&
    (has(name.title, ref) || TRIAL.test(words(name.title)));
  // Un essai comparatif mesuré peut lever une ambiguïté entre deux variantes dans l'introduction.
  const comparative = episode.find(s => {
    const description = s.excerpt.split(' | ÉCRAN')[0]!;
    return has(description, ref) && /\b(?:course\b.{0,65}simultane|comparaison (?:chiffree|des (?:vitesses|performances))|test comparatif chronometre)/.test(words(description));
  });
  const direct = comparative ?? episode.find(s => namedTrial(s, ref));
  if (direct) return { brand: attestedBrand, model, name: has(direct.excerpt, model) ? direct : name, test: direct, proof: direct.excerpt, ...typed };
  const quote = row.citation.trim();
  if (!sourceContainsProof(test, quote) && words(quote).split(' ').length >= 4) {
    const matches = lines.filter(s => sourceContainsProof(s, quote));
    if (matches.length === 1) test = matches[0]!;
  }
  if (namedInTitle && !namedTrial(test, ref)) {
    // Dans l'épisode dédié, une démonstration ou son résultat apporte une meilleure preuve qu'une attente.
    const results = episode.filter(s => s.kind === 'visuel' &&
      /\b(?:resultats? (?:du|des?|de la)\b|(?:analyse|comparaison|examen|inspection) (?:du resultat|du test|des pieces de test|de la piece de test)|bilan apres .{1,25} de test|conclusion du test|premiere piece de test)\b/.test(words(s.excerpt.split(' | ')[0]!)));
    if (!results.length) {
      const demonstration = episode.find(s => s.kind === 'visuel' && /^test (?:de |d )/.test(words(s.excerpt)));
      if (demonstration) results.push(demonstration);
    }
    test = results.find(s => has(s.excerpt, ref)) ?? results[0] ?? test;
  }
  // Dans un projet sur autre chose, il faut une déclaration d'essai du matériel lui-même.
  const triedThis = /\b(?:on|nous|j) (?:a |avons |ai |avait )?(?:vraiment |bien |deja )?(?:teste|essaye) (?:cette?|ces)\b/.test(words(test.excerpt));
  if (!namedInTitle && !(triedThis && Math.abs(name.startS! - test.startS!) <= 35)) return null;
  return { brand: attestedBrand, model, name, test, proof: test.excerpt, ...typed };
}

function designation(item: Item): string {
  return item.brand && !has(item.model, item.brand) ? item.brand + ' ' + item.model : item.model;
}

function distinct(items: Item[]): Item[] {
  const byName = new Map<string, Item>();
  // Une réplique qui nomme et teste le modèle constitue la citation la plus simple à suivre.
  const confidence = (i: Item) => 6 * Number(has(i.name.title, i.model)) + 5 * Number(namedTrial(i.test, i.model)) + Number(has(i.proof, i.model));
  for (const item of items.sort((a, b) => confidence(b) - confidence(a))) {
    const key = words(designation(item)).replace(/\s/g, '');
    if (!byName.has(key)) byName.set(key, item);
  }
  const all = [...byName.values()];
  return all.filter(item => item.brand || !all.some(other => other.brand && words(other.model) === words(item.model)))
    .sort((a, b) => designation(a).localeCompare(designation(b), 'fr', { numeric: true }));
}

interface NamedModel { item: Item; aliases: Array<{ item: Item; source: AnswerSource }> }

/** Deux marques peuvent commercialiser la même machine. Exiger une équivalence exprimée dans
 * l'épisode évite de confondre deux variantes simplement chronométrées dans le même plan. */
function groupAliases(items: Item[], episodes: ReadonlyMap<string, AnswerSource[]>): NamedModel[] {
  const groups: NamedModel[] = [];
  for (const item of [...items].sort((a, b) => a.name.startS! - b.name.startS!)) {
    let merged = false;
    for (const group of groups) {
      const first = group.item;
      if (first.test.sourceId !== item.test.sourceId || !first.brand || !item.brand || has(first.brand, item.brand)) continue;
      const speech = (episodes.get(item.test.videoId) ?? []).filter(s => s.kind === 'parole');
      const shared = speech.find(s => {
        const line = words(s.excerpt);
        if (!/\b(?:sous (?:d autres |le |un autre )(?:nom|denomination)|(?:autre|differente) reference chez|rebadge|meme (?:machine|appareil) sous)\b/.test(line)) return false;
        const context = speech.filter(e => Math.abs(e.startS! - s.startS!) <= 28).map(e => e.excerpt).join(' ');
        return has(context, first.brand) && has(context, item.brand) && (has(context, item.model) || has(context, first.model));
      });
      if (!shared) continue;
      group.aliases.push({ item, source: shared });
      merged = true;
      break;
    }
    if (!merged) groups.push({ item, aliases: [] });
  }
  return groups.sort((a, b) => designation(a.item).localeCompare(designation(b.item), 'fr', { numeric: true }));
}

/** Le pronom suit le sujet de l'essai. « Je voudrais savoir ce qu'ils ont testé » reste la question d'un spectateur. */
function testSubject(question: string): 'vous' | 'ils' | 'elles' | null {
  const text = words(question);
  const actor = /\b(on (?:en )?a|a t on|nous (?:en )?avons|avons nous|j (?:en )?ai|ai je|on avait|nous avions|ils (?:en )?ont|ont ils|elles (?:en )?ont|ont elles) (?:(?:deja|vraiment|aussi|reellement|bien|pu) )*(?:test|essay|evalu)(?:e|es|ee|ees|er)\b/.exec(text)?.[1];
  if (actor?.includes('elles')) return 'elles';
  if (actor?.includes('ils')) return 'ils';
  if (actor || /\b(?:(?:nos|mes) (?:videos|essais|tests)|(?:ma|notre) chaine)\b/.test(text)) return 'vous';
  return null;
}

/** Écrit uniquement à partir des modèles validés et rattache chaque nom à ses propres preuves. */
export function inventoryText(claims: Claim[], sources: ReadonlyMap<string, AnswerSource>, question: string, topic: string, brand?: string | null): string {
  if (!claims.length) return brand ? `Je n’ai retrouvé aucun modèle de ${brand} dans cette liste d’essais.` :
    'Je n’ai pas retrouvé de passage qui permette de confirmer l’essai d’un modèle.';
  const cited = claims.map(c => `${c.text} ${c.sourceIds.map(id => reference(sources.get(id)!)).join(' ')}`);
  const subject = testSubject(question) ?? testSubject(topic);
  const action = subject === 'vous' ? 'vous avez testé' : subject ? subject + ' ont testé' : 'j’ai retrouvé des essais pour';
  const wording = words(question);
  const confirms = (/^(?:est ce (?:qu|que) |avons nous |ont (?:ils|elles) |a t on |ai je )/.test(wording) || !!brand && /\b(?:chez|marque)\b/.test(wording)) &&
    !/\b(?:pas|jamais|tous|toutes|chaque|uniquement)\b/.test(wording);
  const lead = confirms ? 'Oui, ' + action : action[0]!.toUpperCase() + action.slice(1);
  const format = inventoryFormat(question) ?? (/\b(?:en (?:une|une seule) phrase)\b/.test(wording) ? 'phrase' : /\b(?:liste|lister|enumere)\b/.test(wording) ? 'liste' : null);
  if (format === 'phrase' || format !== 'liste' && cited.length <= 3) {
    return `${lead} ${cited.length === 1 ? 'le modèle' : 'les modèles'} ${new Intl.ListFormat('fr').format(cited)}.`;
  }
  const count = `${cited.length} modèle${cited.length > 1 ? 's' : ''}`;
  const head = confirms && subject ? `${lead} ${cited.length > 1 ? 'ces ' + count : 'ce modèle'}.` :
    `J’ai retrouvé ${count} dans ${subject === 'vous' ? 'vos essais' : 'les vidéos'}.`;
  return [head, ...cited.map(line => '- ' + line)].join('\n');
}

// Seul le serveur conserve les réponses et les preuves. Une clé envoyée par le chat
// ne peut ni fournir du texte à croire, ni transférer une liste vers une autre collection.
interface StoredInventory { collection: string | undefined; answer: AnswerResult; note: string }
const recent = new WeakMap<Pool, Map<string, StoredInventory>>();
export function rememberInventory(pool: Pool, collection: string | undefined, answer: AnswerResult, note: string): AnswerResult {
  if (answer.refused || !answer.corpusVersion) return answer;
  const entries = recent.get(pool) ?? new Map<string, StoredInventory>();
  if (entries.size >= 16) entries.delete(entries.keys().next().value!);
  const id = randomUUID();
  entries.set(id, { collection, answer: structuredClone(answer), note });
  recent.set(pool, entries);
  return { ...answer, inventoryId: id };
}

export async function recallInventory(pool: Pool, id: string, previous: string, question: string, resolvedQuestion: string,
  brand: string | null, collection: string | undefined, mode: AnswerResult['mode'], model: string): Promise<AnswerResult | null> {
  const saved = recent.get(pool)?.get(id);
  if (!saved || saved.collection !== collection || saved.answer.model !== model) return null;
  const priorScope = inventoryRestriction(previous);
  if (saved.answer.resolvedQuestion !== previous && saved.answer.resolvedQuestion !== priorScope?.root) return null;
  const filter = brand ?? priorScope?.brand;
  const savedScope = inventoryRestriction(saved.answer.resolvedQuestion);
  if (savedScope && filter && words(savedScope.brand) !== words(filter)) return null;
  const start = Date.now();
  const valid = await readSnapshot(pool, async (_db, v) => v.corpusVersion === saved.answer.corpusVersion && v.indexVersion === saved.answer.indexVersion);
  if (!valid) return null;
  const result = structuredClone(saved.answer);
  const claims = result.claims.filter(c => !filter || has(c.text, filter));
  const ids = new Set(claims.flatMap(c => c.sourceIds));
  const sources = result.sources.filter(s => ids.has(s.sourceId));
  const reply = { ...result, question, resolvedQuestion, mode, claims, sources, refused: !claims.length, citedSourceIds: [...ids],
    answer: [inventoryText(claims, new Map(sources.map(s => [s.sourceId, s])), question, resolvedQuestion, filter), saved.note].filter(Boolean).join('\n'),
    timings: { searchMs: Date.now() - start, llmMs: 0, totalMs: Date.now() - start } };
  return { ...reply, inventoryId: id };
}

export async function inventoryOfModels(pool: Pool, llm: LlmClient, question: string, routed: RoutedQuery,
  hits: ReadonlyMap<string, AnswerSource>, ranked: ReadonlySet<string>, keywords: string[], version: string, progress: (p: AnswerProgress) => void) {
  const { cards, samples } = await readSnapshot(pool, async (db, state) => {
    if (state.corpusVersion !== version) throw new CorpusChangedError();
    const params: unknown[] = [];
    const cards = (await db.query<Card>(`SELECT v.video_id AS "videoId", v.title, v.published_at::text AS "publishedAt", v.effective_duration_s AS "endS"
      FROM videos v WHERE true ${collectionSql(routed.collection, params)} ${videoIdSql(routed.videoId, params)} ${videoIdsSql(routed.videoIds, params)}
      ORDER BY v.video_id`, params)).rows;
    const forms = [routed.term ?? '', ...keywords].map(t => tokenizeText(t).tokens.join(' '))
      .filter(t => t.length >= 2 && !/^(?:essais?|tests?|testes?|reviews?|comparatifs?|comparaisons?|modeles?|evaluations?)$/.test(t));
    // Un épisode au titre vague et absent des premiers résultats peut tout de même contenir un essai.
    // On recherche le sujet dans les entrées de toute la collection avant le tri des vidéos.
    const samples = !forms.length || !cards.length ? [] : (await db.query<{ videoId: string; sourceId: string; excerpt: string }>(
      `SELECT DISTINCT ON (e.video_id) e.video_id AS "videoId", e.source_id AS "sourceId",
         left(CASE WHEN $3 THEN array_to_string(e.screen_text, ' ') ELSE concat_ws(' | ', e.plan_title, e.text) END, 300) AS excerpt
       FROM entries e WHERE e.video_id = ANY($1::text[]) AND ${scopeKindSql(routed.scope)}
         AND e.${scopeColumn(routed.scope)} ~* ANY($2::text[])
       ORDER BY e.video_id, (e.norm_text ~ '(^| )(test[a-z]*|essai[a-z]*|comparatif|verdict)( |$)') DESC, e.start_s, e.source_id`,
      [cards.map(c => c.videoId), wordPatterns([...new Set(forms)]), routed.scope === 'ecran'])).rows;
    return { cards, samples };
  });
  const excerpts = new Map(samples.map(s => [s.videoId, [s.excerpt]]));
  const prioritized = new Set([...ranked, ...samples.map(s => s.sourceId)]);
  for (const id of ranked) {
    const source = hits.get(id);
    if (!source) continue;
    const sample = excerpts.get(source.videoId) ?? [];
    if (sample.length < 2 && !sample.some(s => s.startsWith(source.excerpt.slice(0, 80)))) sample.push(source.excerpt.slice(0, 230));
    excerpts.set(source.videoId, sample);
  }
  const parallel = Math.min(8, getConfig().llm?.parallel ?? 4);
  let failed = 0;
  const chat = async (system: string, data: unknown, schema: { name: string; schema: Record<string, unknown> }, maxTokens: number, key: string): Promise<unknown[]> => {
    try {
      const request = (tokens: number) => llm.chat(system, JSON.stringify({ question, donnees: data }), { jsonSchema: schema, temperature: 0, maxTokens: tokens });
      let raw = (await request(maxTokens)).trim();
      if (raw.startsWith('{') && !raw.endsWith('}')) raw = await request(maxTokens * 2);
      const values = JSON.parse(raw)[key];
      if (!Array.isArray(values)) throw new Error('format');
      return values;
    } catch { failed++; return []; }
  };
  const budget = Math.min(13_500, evidenceBudgetChars(1000));
  const packs = parts(cards, Math.max(1, Math.min(20, Math.floor(budget / 680))));
  progress({ étape: 'catalogue', vidéos: cards.length });
  const candidates = (await mapConcurrent(packs, parallel, async batch => {
    const proposals = await chat(INVENTORY_SELECT, batch.map((c, i) => ({ video: i + 1, titre: c.title.slice(0, 220),
      extraits: excerpts.get(c.videoId) ?? [] })), INVENTORY_SELECT_SCHEMA, 850, 'items');
    const chosen = new Map<string, { card: Card; hints: string[] }>();
    for (const proposal of proposals) {
      const p = proposal as { video?: number; noms?: unknown };
      const card = p && Number.isInteger(p.video) ? batch[p.video! - 1] : undefined;
      if (card) chosen.set(card.videoId, { card, hints: Array.isArray(p.noms) ? p.noms.filter((n): n is string => typeof n === 'string' && n.length <= 100) : [] });
    }
    // Un titre qui désigne explicitement la catégorie mérite une lecture, même si le tri a omis l'épisode.
    for (const card of batch) {
      if (routed.term && has(card.title, routed.term) && !chosen.has(card.videoId)) chosen.set(card.videoId, { card, hints: [] });
    }
    return [...chosen.values()];
  })).flat();
  const hints = new Map(candidates.map(c => [c.card.videoId, c.hints]));
  const category = categoryPattern(question, [routed.term ?? '', ...keywords]);
  const passages = await readSnapshot(pool, async (db, state) => {
    if (state.corpusVersion !== version) throw new CorpusChangedError();
    return passagesForSpans(db, candidates.map(({ card }, rank) => ({ ...card, startS: 0, rank })));
  });
  progress({ étape: 'lecture', vidéos: passages.length });
  const episodeSources = new Map<string, AnswerSource[]>();
  const found = (await mapConcurrent(passages, parallel, async passage => {
    const episode = passage.entries.flatMap(e => {
      if (routed.scope === 'paroles' && e.kind !== 'parole' || routed.scope === 'visuel' && e.kind !== 'visuel') return [];
      if (routed.scope === 'ecran') return e.screenText?.length
        ? [entrySource({ ...e, text: e.screenText.join(' | '), planTitle: null, screenText: null }, passage)] : [];
      return [entrySource(e, passage)];
    });
    if (!episode.length) return [];
    episodeSources.set(passage.videoId, episode);
    const names = hints.get(passage.videoId) ?? [];
    const dedicated = names.some(n => has(passage.title, n)) || TRIAL.test(words(passage.title)) || !!routed.term && has(passage.title, routed.term);
    const lines = reading(episode, names, prioritized, dedicated ? budget : Math.min(6000, budget));
    const rows = await chat(INVENTORY_READ, { titre: passage.title, sources: lines.map((s,i) => [i + 1, s.startS, s.excerpt]) },
      INVENTORY_READ_SCHEMA, 950, 'items');
    return rows.flatMap(row => {
      const item = row && typeof row === 'object' ? checkedItem(row as Record<string, unknown>, lines, episode, category) : null;
      return item ? [item] : [];
    });
  })).flat();
  const verified = (await mapConcurrent(parts(found, Math.max(1, Math.min(4, Math.floor(budget / 3000)))), parallel, async batch => {
    const decisions = await chat(INVENTORY_VERIFY, batch.map((r, i) => {
      const nearby = (episodeSources.get(r.test.videoId) ?? []).filter(s => s.kind === 'parole' &&
        s.sourceId !== r.test.sourceId && Math.abs(s.startS! - r.test.startS!) <= 18);
      return { numero: i + 1, modele: designation(r), titre: r.test.title, identification: r.name.excerpt,
        categorieDansLeCorpus: r.categorySource?.excerpt ?? r.name.title, scene: r.test.excerpt,
        parolesVoisines: nearby.map(s => s.excerpt).join(' ').slice(0, 1150) };
    }), INVENTORY_VERIFY_SCHEMA, 650, 'items');
    return batch.filter((_, i) => decisions.some(v => {
      const d = v as Record<string, unknown> | null;
      return d?.numero === i + 1 && d.categorieDemandee === true && d.modelePrecis === true && d.usage === 'essai_du_modele';
    }));
  })).flat();
  const sources = new Map<string, AnswerSource>();
  const brand = inventoryRestriction(question)?.brand;
  const claims: Claim[] = groupAliases(distinct(verified), episodeSources).flatMap(({ item, aliases }) => {
    const names = aliases.map(a => designation(a.item));
    const text = designation(item) + (names.length ? ` (aussi commercialisé sous le nom ${names.join(', ')})` : '');
    if (brand && !has(text, brand)) return [];
    const cited = [item.test, item.name, ...aliases.flatMap(a => [a.source, a.item.name])];
    const ids = [...new Set(cited.map(s => { sources.set(s.sourceId, s); return s.sourceId; }))];
    return [{ text, preuve: item.proof, sourceIds: ids }];
  });
  return { claims, sources, videoIds: cards.map(c => c.videoId), failed, brand };
}
