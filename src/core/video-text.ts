/**
 * Texte encodé pour le vecteur d'une vidéo (migration 0008) : de quoi elle parle, en peu de mots. Le
 * corpus n'a pas de résumé ; les meilleurs témoins sont le titre, la description et les titres des
 * plans (une table des matières visuelle). La description d'une chaîne reprend pourtant le même
 * gabarit d'une vidéo à l'autre (soutien, réseaux, matériel favori) : encodé tel quel, il rapprocherait
 * toutes les vidéos entre elles. Une ligne présente dans plusieurs vidéos est donc écartée, de même
 * pour les titres de plans (« Écran de fin de vidéo »).
 */

export interface VideoTextSource {
  videoId: string;
  title: string;
  /** Blocs de description (`buildDescriptionBlocks`), dans l'ordre. */
  descriptionBlocks: Array<{ text: string; chapter?: { label: string } | null }>;
  /** Titres des plans, dans l'ordre d'apparition. */
  planTitles: string[];
}

/** Une ligne est du gabarit dès qu'elle revient dans ce nombre de vidéos (1 % du corpus, au moins 3). */
export function templateThreshold(videos: number): number {
  return Math.max(3, Math.ceil(videos * 0.01));
}

/** Bornes du texte : la description d'abord tronquée, les plans complètent jusqu'au total. */
const DESCRIPTION_MAX_CHARS = 3000;
const TOTAL_MAX_CHARS = 6000;

const URL = /https?:\/\/\S+/g;

/** Ce que laisse un lien retiré en fin de ligne : « ESP32 : ou » → « ESP32 ». */
const DANGLING = /(?:\s*(?:[:|,;–—-]|\bou\b))+\s*$/iu;

/** Ligne de description sans ses liens ni son horodatage de chapitre. */
function cleanLine(block: VideoTextSource['descriptionBlocks'][number]): string {
  const text = block.chapter ? block.chapter.label : block.text;
  return text.replace(URL, '').replace(/\s+/g, ' ').trim().replace(DANGLING, '');
}

/** Clé de comparaison : lettres et chiffres seuls, en minuscules (« ✔️ Ryobi : » = « Ryobi »). */
function keyOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Nombre de vidéos où revient chaque clé. */
function frequencies(lists: string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const list of lists) for (const key of new Set(list.map(keyOf))) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** Ajoute des morceaux tant qu'ils tiennent dans `max` caractères (séparateur compris). */
function within(parts: string[], separator: string, max: number): string {
  let out = '';
  for (const part of parts) {
    const next = out ? out + separator + part : part;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/**
 * Textes à encoder, un par vidéo. Le gabarit se mesure sur l'ensemble donné : il faut passer toutes
 * les vidéos du corpus, pas seulement celles à encoder.
 */
export function videoTexts(videos: VideoTextSource[]): Map<string, string> {
  const threshold = templateThreshold(videos.length);
  const lines = videos.map((video) => video.descriptionBlocks.map(cleanLine));
  const plans = videos.map((video) => video.planTitles.map((t) => t.replace(/\s+/g, ' ').trim()));
  const lineCounts = frequencies(lines);
  const planCounts = frequencies(plans);
  const own = (list: string[], counts: Map<string, number>): string[] => {
    const seen = new Set<string>();
    return list.filter((text) => {
      const key = keyOf(text);
      if (key.length < 3 || seen.has(key) || (counts.get(key) ?? 0) >= threshold) return false;
      seen.add(key);
      return true;
    });
  };
  const texts = new Map<string, string>();
  videos.forEach((video, i) => {
    const title = video.title.trim();
    const description = within(own(lines[i]!, lineCounts), '\n', DESCRIPTION_MAX_CHARS);
    const head = [title, description].filter(Boolean).join('\n');
    const room = TOTAL_MAX_CHARS - head.length - '\nPlans : '.length;
    const planText = room > 0 ? within(own(plans[i]!, planCounts), ' ; ', room) : '';
    texts.set(video.videoId, planText ? `${head}\nPlans : ${planText}` : head);
  });
  return texts;
}
