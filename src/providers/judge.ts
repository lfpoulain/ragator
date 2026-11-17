import { getConfig } from '../config.js';
import { mapConcurrent } from '../core/concurrent.js';
import { fetchRetrying } from './retry.js';

/**
 * Juge de pertinence des questions générales : JEV (TypeSafe), un modèle de
 * DÉCISION servi par l'endpoint Decisions d'OpenRouter, pas un modèle de texte.
 * Pour chaque vidéo candidate, il rend la probabilité calibrée que ses extraits
 * répondent à la question ; le code garde celles au-dessus du seuil
 * (`JUDGE_THRESHOLD`). Version figée (`typesafe/jev-1.13`), facturée à l'entrée
 * seulement (0,042 $ le million de tokens) : ~0,00006 $ la décision, ~0,25 s.
 */
export interface RelevanceJudge {
  readonly model: string;
  /** Probabilité de pertinence (0 à 1) de chaque vidéo, dans l'ordre. */
  judge(question: string, videos: Array<{ title: string; text: string }>): Promise<number[]>;
  /** Décisions et coût facturé en dollars (`usage.cost`) depuis la création du juge. */
  readonly usage?: { calls: number; cost: number };
}

/**
 * Question posée à JEV, suivant sa documentation : en anglais (sa langue
 * d'entraînement principale, les autres sont moins précises), les champs de
 * l'état cités entre accents graves, et des critères structurés — une
 * définition et des exemples de chaque côté — car la frontière est subtile :
 * la question est prise au mot (« quand utilisent-ils X » exige qu'ils
 * l'utilisent). Les exemples et les données restent en français. Mesuré : même
 * rappel que la version française (85 %), précision estimée 79 % contre 78 % ;
 * sans critères, 81 % de rappel seulement.
 */
export const JUDGE_QUESTION = 'Do the `excerpts` of this video answer the `question`, taken literally?';
export const JUDGE_CRITERIA = {
  true: {
    what:
      'The excerpts show exactly what the question asks for, following its verb: if it asks when they use, test, build or do something, they actually do it in the video; if it asks when they talk about something, they genuinely discuss it, even briefly or in a sponsored segment.',
    examples: [
      'question « Quand utilisent-ils une visseuse ? » ; excerpt « On visse les tasseaux avec la visseuse Ryobi. »',
      'question « Quand parlent-ils de leur chat ? » ; excerpt « On vous présente Khéops, notre chatte, qui dort sur l’établi. »',
    ],
  },
  false: {
    what:
      'The thing is only named, shown or evoked without the requested action taking place (talked about but not used, shown but not tested), the word has another meaning, or it is a call to action such as « abonnez-vous ».',
    examples: [
      'question « Quand utilisent-ils une visseuse ? » ; excerpt « Le sponsor du jour propose une visseuse à prix réduit. »',
      'question « Quand parlent-ils de leur chat ? » ; excerpt « Posez vos questions dans le chat du live. »',
    ],
  },
};

/** Extraits envoyés au juge au plus par vidéo (le coût et la latence suivent la longueur). */
const MAX_VIDEO_CHARS = 6000;
const TIMEOUT_MS = 30_000;
/** 32 décisions simultanées : un 429 passager ne doit pas faire perdre une vidéo. */
const RETRY_DELAYS_MS = [1_000, 3_000];

function clip(text: string): string {
  return text.length > MAX_VIDEO_CHARS ? `${text.slice(0, MAX_VIDEO_CHARS)}\n…` : text;
}

interface DecisionEndpoint {
  label: string;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: (question: string, video: { title: string; text: string }) => Record<string, unknown>;
  parallel: number;
  retryDelaysMs: number[];
}

/** Une décision oui/non (« noul ») par vidéo, sur une API au format de JEV. */
function decisionJudge(endpoint: DecisionEndpoint): RelevanceJudge {
  const usage = { calls: 0, cost: 0 };
  return {
    model: endpoint.model,
    usage,
    judge: (question, videos) =>
      mapConcurrent(videos, endpoint.parallel, async (video) => {
        const response = await fetchRetrying(
          endpoint.url,
          () => ({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...endpoint.headers },
            body: JSON.stringify(endpoint.body(question, video)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          }),
          endpoint.retryDelaysMs,
        );
        if (!response.ok) throw new Error(`${endpoint.label} HTTP ${response.status} : ${(await response.text()).slice(0, 200)}`);
        const body = (await response.json()) as { answers?: { decision?: { noul?: number } }; usage?: { cost?: number } };
        usage.calls += 1;
        usage.cost += body.usage?.cost ?? 0;
        const p = body.answers?.decision?.noul;
        if (typeof p !== 'number') throw new Error(`${endpoint.label} : réponse sans probabilité`);
        return p;
      }),
  };
}

const QUESTIONS = { decision: { type: 'noul', instructions: JUDGE_QUESTION, criteria: JUDGE_CRITERIA } };

interface JudgeOptions {
  baseUrl: string;
  /** Décisions à la fois (1 par défaut). */
  parallel?: number;
  retryDelaysMs?: number[];
}

/** JEV via OpenRouter (`POST /api/alpha/decisions`) : une décision oui/non (« noul ») par vidéo. */
export function jevJudge(options: JudgeOptions & { apiKey: string; model: string }): RelevanceJudge {
  const { model } = options;
  return decisionJudge({
    label: 'JEV',
    model,
    url: `${options.baseUrl.replace(/\/+$/, '')}/alpha/decisions`,
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: (question, video) => ({ model, state: { question, video_title: video.title, excerpts: clip(video.text) }, questions: QUESTIONS }),
    parallel: options.parallel ?? 1,
    retryDelaysMs: options.retryDelaysMs ?? RETRY_DELAYS_MS,
  });
}

let shared: { key: string; judge: RelevanceJudge } | null = null;

/** Juge configuré (JEV), ou `null` sans clé OpenRouter. Une instance par configuration : ses compteurs couvrent le processus. */
export function judgeFromConfig(): RelevanceJudge | null {
  const { judge } = getConfig();
  if (!judge) return null;
  const key = `${judge.baseUrl}|${judge.apiKey}`;
  if (shared?.key !== key) shared = { key, judge: jevJudge(judge) };
  return shared.judge;
}
