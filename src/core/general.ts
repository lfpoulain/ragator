import { getConfig } from '../config.js';
import type { LlmClient } from '../providers/llm.js';
import type { RelevanceJudge } from '../providers/judge.js';
import { WRITE_SYSTEM_PROMPT, WRITE_SYSTEM_PROMPT_DECIDED, WRITE_SYSTEM_PROMPT_PROOF, writeSchema, buildWritePrompt, parseWritten, renderPassage, type IdOf, type PromptWindow, type WrittenVideo } from '../prompts/answer.js';
import { mapConcurrent } from './concurrent.js';
import type { RequiredTerm } from './analyze.js';
import { tokenizeText } from '../norm/normalize.js';
import { evidenceBudgetChars } from './passages.js';
import { sortByDate } from './video-rank.js';

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

/**
 * Questions générales : les passages sont regroupés par vidéo, JEV rend la
 * probabilité que chaque vidéo réponde à la question (par vagues, voir
 * `JUDGE_WAVES`), le code garde celles au-dessus du seuil, par probabilité
 * décroissante. Le LLM rédige ensuite une
 * affirmation par vidéo retenue, par lots de 6 au plus (et moins si leurs
 * passages sont longs), 16 lots à la fois ; il peut encore écarter une vidéo
 * dont les extraits ne répondent pas. Un lot en échec est perdu seul et
 * signalé ; si tous échouent, l'erreur remonte (repli extractif). Renvoie une
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
    /** Vidéos déjà retenues (parcours chronologique) : le rédacteur décrit sans rejuger. */
    decided?: boolean;
    /** Vidéos retenues sans preuve directe, avec la raison affichée (« éventuellement »). */
    unproven?: Map<string, string>;
    /** Ligne « Corpus : … » en tête du message de rédaction. */
    corpus?: string | null;
  } = {},
  progress: {
    onJudge?: (videos: number) => void;
    onWrite?: (batches: number) => void;
    /** Affirmations d'un lot, identifiants courts (s12) comme dans la sortie finale. */
    onBatch?: (claims: Array<{ text: string; sourceIds: string[]; relevance?: number; missing?: string; nature?: WrittenVideo['nature'] }>) => void;
  } = {},
): Promise<{ raw: string; issue: string | null }> {
  type Video = { videoId: string; title: string; publishedAt: string | null; texts: string[]; relevance: number };
  const videos = new Map<string, Video>();
  for (const window of windows) {
    const video = videos.get(window.videoId) ?? { videoId: window.videoId, title: window.title, publishedAt: window.publishedAt, texts: [], relevance: 0 };
    video.texts.push(renderPassage(window, idOf, false));
    videos.set(window.videoId, video);
  }
  const { order = null, required = [], decided = false, unproven, corpus = null } = options;
  // Exigences de la question (marque, modèle) absentes du titre et des extraits d'une vidéo : elle reste,
  // mais à part (« éventuellement »), car rien ne prouve que c'est bien la marque demandée.
  const missingIn = (video: Video): string | undefined => {
    const reason = unproven?.get(video.videoId);
    if (reason) return reason;
    if (required.length === 0) return undefined;
    const norm = ` ${tokenizeText([video.title, ...video.texts].join(' ')).norm} `;
    // Au moins une exigence citée suffit : « ESP32 ou ESP8266 » en donne deux, alternatives.
    const cited = required.some((r) => r.forms.some((form) => norm.includes(` ${form} `)));
    return cited ? undefined : `« ${required.map((r) => r.term).join(' » ou « ')} » n’apparaît pas dans leurs extraits`;
  };
  progress.onJudge?.(videos.size);
  const judged = await judgeInWaves(
    [...videos.values()],
    (wave) => judge.judge(question, wave.map((video) => ({ title: video.title, text: video.texts.join('\n') }))),
    threshold,
  );
  // Les plus probables d'abord : la réponse suit la confiance du juge, pas le rang de recherche. « La
  // première / dernière fois qu'ils… » : par date, la vidéo la plus ancienne (ou récente) en tête.
  const byRelevance = judged.filter((video) => video.relevance >= threshold).sort((a, b) => b.relevance - a.relevance);
  const kept = order ? sortByDate(byRelevance, order) : byRelevance;
  const batches = packVideoBatches(kept, evidenceBudgetChars(WRITE_BATCH_VIDEOS * WRITE_TOKENS_PER_VIDEO), WRITE_BATCH_VIDEOS);

  progress.onWrite?.(batches.length);

  const compact = ({ text, sourceIds, relevance, missing, nature }: { text: string; sourceIds: string[]; relevance?: number | undefined; missing?: string | undefined; nature?: WrittenVideo['nature'] | undefined }) => ({
    text,
    sourceIds,
    ...(relevance === undefined ? {} : { relevance }),
    ...(missing === undefined ? {} : { missing }),
    ...(nature === undefined ? {} : { nature }),
  });
  const settings = getConfig().llm;
  const proof = !decided && (settings?.proof ?? false);
  const write = async (batch: Video[]) => {
    // Vidéos numérotées v1… dans le lot ; identifiants autorisés = lignes réellement présentes.
    const labelled = batch.map((video, i) => ({ ...video, label: `v${i + 1}` }));
    const ids = [...new Set(batch.flatMap((video) => video.texts.flatMap((text) => [...text.matchAll(/^\[(s\d+) /gm)].map((m) => m[1]!))))];
    try {
      // Petit modèle (`llm.proof`) : il revérifie chaque vidéo du juge (champs "preuve" et "repond").
      const system = decided ? WRITE_SYSTEM_PROMPT_DECIDED : proof ? WRITE_SYSTEM_PROMPT_PROOF : WRITE_SYSTEM_PROMPT;
      const raw = await llm.chat(system, buildWritePrompt(question, labelled, corpus), {
        maxTokens: batch.length * WRITE_TOKENS_PER_VIDEO,
        jsonSchema: writeSchema(labelled.map((v) => v.label), ids, proof),
      });
      const byLabel = new Map(labelled.map((video) => [video.label, video]));
      const claims = (parseWritten(raw) ?? [])
        // L'ordre est décidé par le code, même si le rédacteur inverse le lot.
        .sort((a, b) => labelled.findIndex((video) => video.label === a.videoId) - labelled.findIndex((video) => video.label === b.videoId))
        // Affirmation vide : le rédacteur écarte une vidéo dont les extraits ne répondent pas.
        .filter((written) => written.affirmation && written.sourceIds.length > 0)
        .map((written) => {
          const video = byLabel.get(written.videoId);
          return { text: written.affirmation, sourceIds: written.sourceIds, relevance: video?.relevance, missing: video ? missingIn(video) : undefined, nature: written.nature };
        });
      if (claims.length > 0) progress.onBatch?.(claims.map(compact));
      return { claims, error: null };
    } catch (err) {
      return { claims: [], error: err };
    }
  };
  // Jamais plus de lots que de places sur le serveur LLM, sinon ils expirent dans sa file.
  const written = await mapConcurrent(batches, settings?.parallel ?? DEFAULT_PARALLEL, write);
  const failed = written.filter((w) => w.error !== null);
  if (failed.length > 0 && failed.length === written.length) throw failed[0]!.error;
  const claims = written.flatMap((w) => w.claims).map(compact);
  const first = failed[0]?.error;
  return {
    raw: JSON.stringify({ refus: claims.length === 0, claims }),
    issue:
      failed.length === 0
        ? null
        : `rédaction partielle : ${failed.length} lot(s) sur ${written.length} en échec (${first instanceof Error ? first.message : String(first)})`,
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
