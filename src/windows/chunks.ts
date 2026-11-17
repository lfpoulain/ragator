import { CHUNK_SECONDS } from '../core/versions.js';

export interface ChunkEntry {
  kind: 'parole' | 'visuel';
  startS: number;
  text: string;
  planTitle: string | null;
}

export interface Chunk {
  startS: number;
  endS: number;
  text: string;
}

/**
 * Blocs sémantiques : tranches fixes de `seconds` secondes, chaque entrée
 * rangée dans la tranche de son début. Le texte encodé porte le titre de la
 * vidéo, les titres des plans puis les paroles : le sujet du passage, sans les
 * longues descriptions visuelles. Une tranche sans entrée ne produit aucun bloc.
 */
export function generateChunks(title: string, entries: ChunkEntry[], durationS: number, seconds = CHUNK_SECONDS): Chunk[] {
  const bins = new Map<number, { plans: string[]; speech: string[] }>();
  const ordered = [...entries].sort((a, b) => a.startS - b.startS);
  for (const entry of ordered) {
    const bin = Math.floor(entry.startS / seconds);
    const group = bins.get(bin) ?? { plans: [], speech: [] };
    if (entry.kind === 'parole') group.speech.push(entry.text.trim());
    else if (entry.planTitle) group.plans.push(`[${entry.planTitle.trim()}]`);
    bins.set(bin, group);
  }
  return [...bins.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bin, group]) => {
      const startS = bin * seconds;
      return {
        startS,
        endS: Math.max(startS + 1, Math.min(startS + seconds, durationS)),
        text: [title.trim(), group.plans.join(' '), group.speech.join(' ')].filter(Boolean).join('\n'),
      };
    });
}
