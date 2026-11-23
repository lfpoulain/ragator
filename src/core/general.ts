import { getConfig } from '../config.js';
import type { LlmClient } from '../providers/llm.js';
import type { RelevanceJudge } from '../providers/judge.js';
import { WRITE_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_PROOF, writeSchema, buildWritePrompt, parseWritten, renderPassage, type IdOf, type PromptWindow } from '../prompts/answer.js';
import { sourceContainsProof, sourcesForProof, type Claim } from './citations.js';
import { entrySource, type AnswerSource } from './sources.js';
import { mapConcurrent } from './concurrent.js';
import type { RequiredTerm } from './analyze.js';
import { requiredGroups, missingRequiredGroups, mentionsActionTargets, onlyReportsAction } from './requirements.js';
import { tokenizeText } from '../norm/normalize.js';
import { contentTokens } from '../norm/stopwords.js';
import type { Scope } from './page.js';
import { evidenceBudgetChars } from './passages.js';
import { sortByDate } from './video-rank.js';
import { questionOperation } from './operation.js';
import { sharedToolTargets } from './tool-functions.js';

/**
 * Questions générales (« quand utilisent-ils X ? ») : le juge (JEV) note chaque vidéo
 * candidate, par vagues, puis le LLM rédige une affirmation par vidéo retenue.
 */

/** Lots de rédaction simultanés sans LLM configuré (tests) : ceux d'OpenRouter. */
const DEFAULT_PARALLEL = 16;

/**
 * Jugement par vagues : les 150 vidéos les mieux classées d'abord, puis 100 de
 * plus tant que la vague précédente en a gardé au moins 25 %. Un sujet étroit
 * s'arrête à la première vague (même coût qu'avec un plafond fixe) ; un sujet
 * large (imprimante 3D, visseuse : 200 à 300 vidéos candidates) va chercher
 * les vidéos pertinentes au-delà des 150 premières.
 */
const JUDGE_WAVES = { first: 150, next: 100, minYield: 0.25 } as const;

/**
 * Juge des vidéos classées par vagues (`JUDGE_WAVES`) : s'arrête dès qu'une
 * vague garde moins de `minYield` de ses vidéos au-dessus du seuil. Rend les
 * vidéos jugées, chacune avec sa probabilité, dans l'ordre d'entrée.
 */
export async function judgeInWaves<V>(
  videos: V[],
  judgeWave: (wave: V[]) => Promise<number[]>,
  threshold: number,
  waves: { first: number; next: number; minYield: number } = JUDGE_WAVES,
): Promise<Array<V & { relevance: number }>> {
  const judged: Array<V & { relevance: number }> = [];
  for (let start = 0; start < videos.length; ) {
    const wave = videos.slice(start, start + (start === 0 ? waves.first : waves.next));
    const probabilities = await judgeWave(wave);
    const scored = wave.map((video, i) => ({ ...video, relevance: probabilities[i] ?? 0 }));
    judged.push(...scored);
    start += wave.length;
    if (scored.filter((video) => video.relevance >= threshold).length < wave.length * waves.minYield) break;
  }
  return judged;
}

/** Vidéos rédigées par appel : un petit lot garde l'attention du modèle sur chacune. */
const WRITE_BATCH_VIDEOS = 6;
const WRITE_TOKENS_PER_VIDEO = 250;

function inRequestedScope(s: AnswerSource, scope: Scope): boolean {
  return scope === 'tout' || (scope === 'paroles' ? s.kind === 'parole' : s.kind === 'visuel' && (scope !== 'ecran' || s.excerpt.includes('ÉCRAN :')));
}

function operationText(source: AnswerSource): string {
  // Une étiquette à l’écran peut nommer un procédé pendant l’inspection du produit fini.
  return source.excerpt.split(' | ÉCRAN : ', 1)[0]!;
}

/** Le plan peut montrer le bon geste dans une archive ou dans la démonstration d’un tiers. */
function operationContext(text: string): string | undefined {
  if (/(?<!\p{L})(?:archives?|flash-?back|rétrospective|ancien(?:ne)? (?:vidéo|épisode)|(?:vidéo|épisode) précédente?|autre (?:vidéo|épisode))(?!\p{L})/iu.test(text)) {
    return 'la scène évoque un autre moment';
  }
  if (/(?<!\p{L})(?:invitée?s?|sous-traitant\p{L}*|prestataire|fournisseur|en usine|par un professionnel|par une entreprise)(?!\p{L})/iu.test(text)) {
    return 'l’attribution du geste aux auteurs reste incertaine';
  }
  if (/\b(?:si (?:nous|on|ils|elles)\b|(?:on|ils|elles|nous) (?:pourrai\p{L}*|pourrions|voudrai\p{L}*|voudrions)\b)/iu.test(text)) {
    return 'le passage présente une possibilité';
  }
  return undefined;
}

/** Une ligne classée par la recherche, par vidéo. Un résultat de recherche reste une piste si la rédaction échoue. */
export function retrievedClues(
  rankedIds: Iterable<string>, sources: ReadonlyMap<string, AnswerSource>, scope: Scope, targets: RequiredTerm[][], limit: number, question: string,
): Claim[] {
  const operation = questionOperation(question);
  const ids = [...rankedIds];
  // Une parole voisine peut porter le matériau qui a déclenché la recherche. La ligne suivante du
  // même passage peut à elle seule montrer le geste et sa cible. Elle reste une piste en cas de panne.
  if (operation) {
    const rankedVideos = new Set(ids.map((id) => sources.get(id)?.videoId));
    const ranked = new Set(ids);
    for (const source of sources.values()) if (!ranked.has(source.sourceId) && rankedVideos.has(source.videoId)) ids.push(source.sourceId);
  }
  const seen = new Set<string>();
  const clues: Claim[] = [];
  for (const id of ids) {
    const source = sources.get(id);
    if (!source || seen.has(source.videoId) || source.startS === null || !source.excerpt.trim() || !inRequestedScope(source, scope)) continue;
    if (!mentionsActionTargets(targets, [source.excerpt])) continue;
    if (operation && (!operation.shown(operationText(source)) || operationContext(source.excerpt))) continue;
    seen.add(source.videoId);
    clues.push({ text: `« ${source.excerpt} »`, preuve: source.excerpt, sourceIds: [id], missing: 'passage retrouvé, réponse à la question non vérifiée' });
    if (clues.length >= limit) break;
  }
  return clues;
}

/** Les lignes d'une liste d'usages décrivent ce que les sources montrent, sans ajouter de finalité ni d'acteur. */
export function usageExcerpt(
  evidence: AnswerSource[], proof: string, targets: RequiredTerm[][], question: string, scope: Scope,
): { text: string; preuve: string; sources: AnswerSource[]; missing?: string } | null {
  const owner = evidence.find((s) => sourceContainsProof(s, proof));
  if (!owner) return null;
  const allowed = evidence.filter((s) => inRequestedScope(s, scope));
  const anchor = allowed.includes(owner) ? owner : allowed[0];
  if (!anchor) return null;
  const sources = [anchor];
  // Une réplique brève peut désigner l'objet par « ça ». Un plan cité de la même scène peut le nommer et montrer le geste.
  const gap = (s: AnswerSource) => Math.max(0, (s.startS ?? Infinity) - (anchor.endS ?? anchor.startS ?? 0), (anchor.startS ?? 0) - (s.endS ?? s.startS ?? 0));
  const nearby = allowed.filter((s) => s !== anchor && s.videoId === anchor.videoId && gap(s) <= 30)
    .sort((a, b) => Number(b.kind === 'visuel') - Number(a.kind === 'visuel') || gap(a) - gap(b));
  const extra = nearby.find((s) => (anchor.kind !== s.kind || !mentionsActionTargets(targets, [anchor.excerpt])) &&
    mentionsActionTargets(targets, [anchor.excerpt, s.excerpt]));
  if (extra) sources.push(extra);
  if (!mentionsActionTargets(targets, sources.map((s) => s.excerpt))) {
    const standalone = allowed.find((s) => mentionsActionTargets(targets, [s.excerpt]));
    if (!standalone) return null;
    sources.splice(0, sources.length, standalone);
  }
  const text = sources.map((s) => `« ${s.excerpt.trim()} »`).join(' ');
  // Le passif décrit aussi des objets livrés déjà assemblés. À lui seul, il ne permet pas d'en attribuer la fabrication.
  const describesState = /(?<!\p{L})(?:est|sont|étaient|était|ont été|a été)\s+(?:(?:directement|déjà|solidement|encore|aussi|bien)\s+){0,2}\p{L}+(?:é|i|u|it|int)e?s?(?!\p{L})/iu;
  const agentNamed = /\bpar (?:nous|eux|elles|moi|lui|les auteurs|les créateurs)\b|\bpar [A-ZÀ-ÖØ-Þ][\p{Ll}’-]+/u;
  const uncertain = sources.every((s) => describesState.test(s.excerpt) && !agentNamed.test(s.excerpt)) && !describesState.test(question);
  return { text, preuve: sources[0]!.excerpt, sources, ...(uncertain ? { missing: 'le passage décrit un état sans établir qui a effectué le geste' } : {}) };
}

/**
 * Questions générales : les passages sont regroupés par vidéo, JEV rend la
 * probabilité que chaque vidéo réponde à la question (par vagues, voir
 * `JUDGE_WAVES`), le code garde celles au-dessus du seuil, par probabilité
 * décroissante. Le LLM rédige ensuite une
 * affirmation par vidéo retenue, par lots de 6 au plus (et moins si leurs
 * passages sont longs), 16 lots à la fois ; il peut encore écarter une vidéo
 * dont les extraits ne répondent pas. En cas d'échec d'un lot, ses lignes classées par la recherche
 * peuvent apparaître comme pistes, après les affirmations validées. Renvoie une
 * sortie `claims`, validée ensuite comme toute sortie structurée.
 */
export async function answerByVideo(
  llm: LlmClient,
  judge: RelevanceJudge,
  threshold: number,
  question: string,
  windows: PromptWindow[],
  idOf: IdOf,
  options: {
    /** « La première / dernière fois » : vidéos triées par date. */
    order?: 'premiere' | 'derniere' | null;
    /** Marques ou modèles imposés par la question. */
    required?: RequiredTerm[];
    /** Matières ou types explicitement demandés pour le geste ; toute vidéo citée doit les attester. */
    actionTargets?: RequiredTerm[][];
    /** Lignes à l'origine du classement, à conserver en pistes si la rédaction d'un lot échoue. */
    rankedIds?: Iterable<string>;
    scope?: Scope;
    /** Ligne « Corpus : … » en tête du message de rédaction. */
    corpus?: string | null;
  } = {},
  progress: {
    onJudge?: (videos: number) => void;
    onWrite?: (batches: number) => void;
    /** Affirmations d'un lot, identifiants courts (s12) comme dans la sortie finale. */
    onBatch?: (claims: Claim[]) => void;
  } = {},
): Promise<{ raw: string; issue: string | null }> {
  type Video = { videoId: string; title: string; publishedAt: string | null; texts: string[]; windows: PromptWindow[]; relevance: number };
  const videos = new Map<string, Video>();
  for (const window of windows) {
    const video = videos.get(window.videoId) ?? { videoId: window.videoId, title: window.title, publishedAt: window.publishedAt, texts: [], windows: [], relevance: 0 };
    video.windows.push(window);
    video.texts.push(renderPassage(window, idOf, false));
    videos.set(window.videoId, video);
  }
  const { order = null, required = [], actionTargets = [], corpus = null, scope = 'tout' } = options;
  const operation = questionOperation(question);
  const groups = requiredGroups(question, required);
  const quoteUses = (actionTargets.length > 0 || operation !== null) && !/\b(?:pourquoi|comment|expliquez?|expliquent|raison[s]?|dans quel but|dans quel objectif|quel(?:le)?s? (?:effets?|avantages?|cons[eé]quences?))\b/iu.test(question);
  // Le titre et les autres passages peuvent proposer la vidéo sans justifier la marque à l'instant cité.
  const missingIn = (evidence: AnswerSource[], uncertain: boolean): string | undefined => {
    if (required.length === 0) return undefined;
    if (uncertain) return 'le lien entre le détail demandé et l’objet reste incertain dans les lignes citées';
    const norm = evidence.map((s) => tokenizeText(s.excerpt).norm).join(' | ');
    const missing = missingRequiredGroups(groups, norm);
    if (!missing.length) return undefined;
    const names = missing.map((group) => group.map((r) => `« ${r.term} »`).join(' ou ')).join(', ');
    return `détail absent des lignes citées : ${names}`;
  };
  const candidates = [...videos.values()].filter((video) => mentionsActionTargets(actionTargets, video.texts));
  progress.onJudge?.(candidates.length);
  const judged = await judgeInWaves(
    candidates,
    (wave) => judge.judge(question, wave.map((video) => ({ title: video.title, text: video.texts.join('\n') }))),
    threshold,
  );
  // Les plus probables d'abord : la réponse suit la confiance du juge, pas le rang de recherche. « La
  // première / dernière fois qu'ils… » : par date, la vidéo la plus ancienne (ou récente) en tête.
  const byRelevance = judged.filter((video) => video.relevance >= threshold).sort((a, b) => b.relevance - a.relevance);
  const kept = order ? sortByDate(byRelevance, order) : byRelevance;
  // Le juge a lu le contexte complet. Le rédacteur reçoit les scènes portant la cible et leurs voisins.
  const forWriting = actionTargets.length || operation ? kept.map((video) => {
    const gestureEntries = (window: PromptWindow) => operation ? window.entries.filter((entry) => {
      const source = entrySource(entry, video);
      return inRequestedScope(source, scope) && operation.shown(operationText(source)) && !operationContext(source.excerpt) && mentionsActionTargets(actionTargets, [source.excerpt]);
    }) : [];
    const windowsWithGestures = video.windows.map((window) => ({ window, gestures: gestureEntries(window) }));
    const hasGesture = windowsWithGestures.some(({ gestures }) => gestures.length > 0);
    const focused = windowsWithGestures.flatMap(({ window, gestures }) => {
      const moments = hasGesture ? gestures : window.entries.filter((entry) => {
        const norm = tokenizeText(entrySource(entry, video).excerpt).norm;
        return !actionTargets.length || actionTargets.some((group) => missingRequiredGroups([group], norm).length === 0);
      });
      if (!moments.length) return [];
      const entries = window.entries.filter((e) => moments.some((m) => (e.endS ?? e.startS) >= m.startS - 15 && e.startS <= (m.endS ?? m.startS) + 15));
      return [{ ...window, entries }];
    });
    return { ...video, windows: focused, texts: focused.map((w) => renderPassage(w, idOf, false)) };
  }).filter((video) => video.windows.length) : kept;
  const batches = packVideoBatches(forWriting, evidenceBudgetChars(WRITE_BATCH_VIDEOS * WRITE_TOKENS_PER_VIDEO), WRITE_BATCH_VIDEOS);

  progress.onWrite?.(batches.length);

  const settings = getConfig().llm;
  const withVeto = settings?.proof ?? false;
  const selectLine = withVeto || actionTargets.length > 0 || operation !== null || scope === 'visuel' || scope === 'ecran';
  const words = contentTokens(tokenizeText(question).tokens);
  const inScope = (s: AnswerSource) => inRequestedScope(s, scope);
  const requiredTerms = required.map((r) => r.term);
  const toolUse = quoteUses && sharedToolTargets(question) !== null;
  const directPlan = (source: AnswerSource) => source.kind === 'visuel' && inScope(source) &&
    operation?.shown(operationText(source)) && !operationContext(source.excerpt) &&
    mentionsActionTargets(actionTargets, [source.excerpt]) && !missingIn([source], false);
  const labelVideo = (video: Video, label: string) => {
    const sources = new Map<string, AnswerSource>();
    // Le lot peut avoir perdu ses derniers passages pour tenir dans le contexte du rédacteur.
    for (const window of video.windows.slice(0, video.texts.length)) {
      for (const entry of window.entries) sources.set(idOf(entry.sourceId), entrySource(entry, video));
    }
    return { ...video, label, sources };
  };
  const readBatch = async (labelled: ReturnType<typeof labelVideo>[], maxTokens: number) => {
    const ids = labelled.flatMap((video) => [...video.sources.keys()]);
    const system = withVeto ? WRITE_SYSTEM_PROMPT_PROOF : WRITE_SYSTEM_PROMPT;
    const prompt = buildWritePrompt(question, labelled, corpus, requiredTerms, actionTargets.map((group) => group.map((r) => r.term)), selectLine, scope);
    const jsonSchema = writeSchema(labelled.map((v) => v.label), ids, withVeto, requiredTerms.length > 0, selectLine);
    return parseWritten(await llm.chat(system, prompt, { maxTokens, jsonSchema }));
  };
  const write = async (batch: Video[]) => {
    const labelled = batch.map((video, i) => labelVideo(video, `v${i + 1}`));
    try {
      let rows = await readBatch(labelled, batch.length * WRITE_TOKENS_PER_VIDEO);
      // Un petit lot peut épuiser sa sortie avant la fin du JSON. Le contexte a déjà réservé la place d’un lot complet.
      if (rows === null && batch.length < WRITE_BATCH_VIDEOS) {
        rows = await readBatch(labelled, WRITE_BATCH_VIDEOS * WRITE_TOKENS_PER_VIDEO);
      }
      if (rows === null) throw new Error('réponse hors du format imposé');
      // Une seule relecture du lot, sur deux plans autonomes au plus par vidéo explicitement refusée.
      const decisions = new Map(labelled.map((video) => [video.label, rows.find((row) => row.videoId === video.label)]));
      const reviews = toolUse ? labelled.flatMap((video) => {
        const first = decisions.get(video.label);
        if (first?.repond !== false || first.ligneGeste !== 'aucune') return [];
        const seen = new Set<string>();
        const windows = video.windows.slice(0, video.texts.length).flatMap((window) => {
          const entries = window.entries.filter((entry) => {
            if (seen.size >= 2 || seen.has(entry.sourceId) || entry.uncertainties.length ||
                !directPlan(video.sources.get(idOf(entry.sourceId))!)) return false;
            seen.add(entry.sourceId);
            return true;
          });
          return entries.length ? [{ ...window, entries }] : [];
        });
        return windows.length ? [labelVideo({ ...video, windows, texts: windows.map((w) => renderPassage(w, idOf, false)) }, video.label)] : [];
      }) : [];
      const reviewed = new Map<string, ReturnType<typeof labelVideo>>();
      if (reviews.length) {
        // Une panne, une sortie invalide ou un nouveau refus laissent le premier veto en place.
        const second = await readBatch(reviews, WRITE_BATCH_VIDEOS * WRITE_TOKENS_PER_VIDEO).catch(() => null);
        for (const video of reviews) {
          const accepted = second?.find((row) => row.videoId === video.label && row.repond === true && !row.lienIncertain);
          const line = video.sources.get(accepted?.ligneGeste ?? '');
          if (!accepted || !line || !accepted.sourceIds.includes(accepted.ligneGeste!) || !sourceContainsProof(line, accepted.preuve ?? '')) continue;
          decisions.set(video.label, accepted);
          reviewed.set(video.label, video);
        }
      }
      const claims: Claim[] = [];
      let foundQuote = false;
      // L'ordre et la portée des citations sont ceux de l'entrée, même si le rédacteur mélange les vidéos.
      for (const original of labelled) {
        const video = reviewed.get(original.label) ?? original;
        const written = decisions.get(video.label);
        if (!written?.affirmation || written.sourceIds.some((id) => !video.sources.has(id))) continue;
        let proof = written.preuve ?? '';
        let text = written.affirmation;
        let sourceIds = sourcesForProof(proof, [...new Set(written.sourceIds)], video.sources);
        if (selectLine && written.ligneGeste !== undefined) {
          const chosen = written.ligneGeste;
          const decisive = video.sources.get(chosen);
          if (!decisive) continue;
          // Si la citation a été mal recopiée, seule la ligne d'origine choisie est publiée. L'ID est
          // fermé, propre à cette vidéo, et la ligne doit elle-même établir la cible.
          const norm = ` ${tokenizeText(decisive.excerpt).norm} `;
          const onTopic = actionTargets.length ? mentionsActionTargets(actionTargets, [decisive.excerpt]) : words.some((word) => norm.includes(` ${word} `));
          if (!sourceIds.some((id) => inScope(video.sources.get(id)!)) && onTopic && inScope(decisive) && !onlyReportsAction(decisive.excerpt, question)) {
            sourceIds = [chosen];
            proof = decisive.excerpt;
            text = `« ${proof} »`;
          }
        }
        if (!sourceIds.length) continue;
        foundQuote = true;
        if (actionTargets.length && onlyReportsAction(written.affirmation, question)) continue;
        let evidence = sourceIds.map((id) => video.sources.get(id)!);
        if (!evidence.some(inScope)) continue;
        let operationMissing: string | undefined;
        if (operation) {
          const owner = evidence.find((s) => inScope(s) && sourceContainsProof(s, proof));
          if (!owner) continue;
          const direct = (s: AnswerSource) => inScope(s) && operation.shown(operationText(s)) && mentionsActionTargets(actionTargets, [s.excerpt]);
          const mentioned = operation.mentioned(operationText(owner));
          operationMissing = operationContext(owner.excerpt) ?? (written.lienIncertain === true ? 'le lien entre le geste et sa cible reste incertain' : undefined);
          if (!direct(owner) && !(operationMissing && mentioned)) {
            const existing = mentioned ? usageExcerpt([owner], proof, actionTargets, question, scope) : null;
            if (existing?.missing) operationMissing = existing.missing;
            else {
              // Une opération effectivement réalisée sur un autre matériau ne peut être corrigée
              // en lui attribuant le matériau d’un autre plan.
              if (operation.shown(operationText(owner)) || !quoteUses) continue;
              const scene = video.windows.slice(0, video.texts.length).filter((w) => w.entries.some((e) => e.sourceId === owner.sourceId));
              const nearby = scene.flatMap((w) => w.entries.map((e) => video.sources.get(idOf(e.sourceId))!));
              const substitute = nearby.filter((s) => direct(s) && !operationContext(s.excerpt))
                .sort((a, b) => Math.abs((a.startS ?? 0) - (owner.startS ?? 0)) - Math.abs((b.startS ?? 0) - (owner.startS ?? 0)))[0];
              if (!substitute && !mentioned) continue;
              if (!substitute) operationMissing ??= 'le passage mentionne le geste sans en établir l’exécution';
              const selected = substitute ?? owner;
              evidence = [selected];
              text = proof = selected.excerpt;
            }
          } else if (quoteUses || operationMissing) {
            evidence = [owner];
            text = proof = owner.excerpt;
          }
        }
        if (!mentionsActionTargets(actionTargets, evidence.map((s) => s.excerpt)) ||
            !mentionsActionTargets(actionTargets, [text, proof])) continue;
        const excerpt = quoteUses ? usageExcerpt(evidence, proof, actionTargets, question, scope) : null;
        if (quoteUses && !excerpt) continue;
        const displayed = excerpt?.sources ?? evidence;
        // Un état décrit à côté du geste dans le même plan peut être au passif.
        const separateState = toolUse && excerpt?.missing && displayed.length === 1 && directPlan(displayed[0]!);
        const missing = missingIn(displayed, written.lienIncertain === true) ?? (separateState ? undefined : excerpt?.missing) ?? operationMissing;
        claims.push({
          text: excerpt?.text ?? (missing ? `« ${proof} »` : text),
          preuve: excerpt?.preuve ?? proof,
          sourceIds: displayed.map((s) => idOf(s.sourceId)),
          relevance: video.relevance,
          ...(missing ? { missing } : {}),
          ...(written.nature ? { nature: written.nature } : {}),
        });
      }
      if (claims.length > 0) progress.onBatch?.(claims);
      // Le modèle a proposé des lignes sans preuve. Ne jamais réintroduire par un repli général les
      // autres vidéos que le juge a écartées de ce lot.
      return { claims, error: null, unverified: !foundQuote && rows.some((row) => row.affirmation), unwritten: [] };
    } catch (err) {
      return { claims: [], error: err, unverified: false, unwritten: labelled.flatMap((v) => [...v.sources.values()]) };
    }
  };
  // Jamais plus de lots que de places sur le serveur LLM, sinon ils expirent dans sa file.
  const written = await mapConcurrent(batches, settings?.parallel ?? DEFAULT_PARALLEL, write);
  const failed = written.filter((w) => w.error !== null);
  const claims = written.flatMap((w) => w.claims);
  if (failed.length && options.rankedIds) {
    const unwritten = new Map(failed.flatMap((w) => w.unwritten.map((s) => [s.sourceId, s] as const)));
    const clues = retrievedClues(options.rankedIds, unwritten, scope, actionTargets, 6, question)
      .map((clue) => ({ ...clue, sourceIds: clue.sourceIds.map(idOf) }));
    claims.push(...clues);
    if (clues.length) progress.onBatch?.(clues);
  }
  const first = failed[0]?.error;
  const noProof = !claims.length && written.some((w) => w.unverified);
  return {
    raw: JSON.stringify({ refus: claims.length === 0, claims }),
    issue:
      failed.length === 0
        ? (noProof ? 'aucune affirmation ne cite une preuve vérifiable dans sa vidéo' : null)
        : `${failed.length === written.length ? 'rédaction indisponible' : 'rédaction partielle'} : ${failed.length} lot(s) sur ${written.length} en échec (${first instanceof Error ? first.message : String(first)})`,
  };
}

/**
 * Lots de vidéos à juger, dans l'ordre : au plus `maxVideos` par lot et au
 * plus `budgetChars` de passages. Une vidéo trop longue à elle seule garde ses
 * premiers (meilleurs) passages dans la limite, au moins un.
 */
export function packVideoBatches<V extends { texts: string[] }>(videos: V[], budgetChars: number, maxVideos: number): V[][] {
  const size = (video: V) => video.texts.reduce((sum, text) => sum + text.length, 0);
  const batches: V[][] = [];
  let current: V[] = [];
  let used = 0;
  for (const original of videos) {
    const video = { ...original, texts: [...original.texts] };
    while (video.texts.length > 1 && size(video) > budgetChars) video.texts.pop();
    if (current.length === maxVideos || (current.length > 0 && used + size(video) > budgetChars)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(video);
    used += size(video);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
