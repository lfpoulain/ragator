export const EXPANSION_PROMPT_VERSION = '1';

export const EXPANSION_SYSTEM_PROMPT =
  'Tu es un moteur de reformulation pour une recherche lexicale. Tu réponds uniquement en JSON strict.';

export interface ExpansionRequest {
  question: string;
  missing: string[];
}

export function buildExpansionPrompt(request: ExpansionRequest): string {
  return [
    `Question utilisateur : ${request.question}`,
    `Mots absents du corpus : ${request.missing.join(', ')}.`,
    '',
    'Propose 2 reformulations courtes de cette question (mots-clés, pas des phrases),',
    "en utilisant le vocabulaire concret d'un atelier de bricolage français",
    '(matériaux, outils, gestes techniques). Même intention de recherche,',
    'aucun fait inventé, aucun nom de marque nouveau.',
    '',
    "Réponds STRICTEMENT avec ce JSON, rien d'autre :",
    '{"variantes": ["...", "..."]}',
  ].join('\n');
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Lecture tolérante : blocs ```json, texte autour, doublons et excès ignorés. */
export function parseVariants(raw: string, question: string): string[] {
  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = (fence[1] ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  let variants: unknown;
  try {
    const parsed = JSON.parse(text) as { variantes?: unknown; variants?: unknown };
    variants = parsed.variantes ?? parsed.variants;
  } catch {
    return [];
  }
  if (!Array.isArray(variants)) return [];

  const seen = new Set([normalizeForCompare(question)]);
  const cleaned: string[] = [];
  for (const item of variants) {
    if (typeof item !== 'string') continue;
    const variant = item.trim();
    const key = normalizeForCompare(variant);
    if (variant.length < 3 || variant.length > 120 || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(variant);
    if (cleaned.length >= 2) break;
  }
  return cleaned;
}
