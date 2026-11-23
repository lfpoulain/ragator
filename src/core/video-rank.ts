/**
 * Recherche par vidéo (questions générales) : la recherche classe des fenêtres
 * de 2 min ; une question « quand parlent-ils de X » porte sur des vidéos.
 * Classer les fenêtres seules a deux défauts : une vidéo bavarde sur le sujet
 * occupe plusieurs places et en repousse d'autres au-delà de la limite, et une
 * vidéo qui l'évoque souvent mais brièvement n'a aucune fenêtre assez forte
 * pour remonter. Ici, chaque vidéo reçoit un score qui cumule ses fenêtres avec
 * des rendements décroissants, puis on garde ses meilleures fenêtres.
 */

/**
 * Poids de la i-ème meilleure fenêtre d'une vidéo : 1, 0,25, 0,06… Mesuré
 * sur un jeu de questions de référence : 0 (meilleure fenêtre seule), 0,1 et 0,25 se valent
 * (61-62 %) ; 0,5 favorise trop les vidéos bavardes (60 %).
 */
const DECAY = 0.25;

export interface RankedWindow {
  videoId: string;
  /** Score de fusion (RRF) de la fenêtre. */
  score: number;
}

export interface VideoRankOptions {
  /** Fenêtres gardées par vidéo. */
  perVideo: number;
  /** Vidéos gardées au plus. */
  maxVideos: number;
}

/** Score d'une vidéo : somme de ses scores de fenêtres triés, pondérés 1, 0,5, 0,25… */
export function videoScore(scores: number[]): number {
  return [...scores].sort((a, b) => b - a).reduce((sum, score, i) => sum + score * DECAY ** i, 0);
}

/**
 * Réordonne des fenêtres par vidéo : vidéos par score décroissant, et pour
 * chacune ses `perVideo` meilleures fenêtres. Les fenêtres au-delà sont écartées.
 */
export function rankByVideo<W extends RankedWindow>(
  windows: W[], options: VideoRankOptions, focusProof?: (window: W) => W | undefined,
): W[] {
  const byVideo = new Map<string, W[]>();
  for (const window of windows) byVideo.set(window.videoId, [...(byVideo.get(window.videoId) ?? []), window]);
  return [...byVideo.values()]
    .map((list) => ({ list: [...list].sort((a, b) => b.score - a.score), score: videoScore(list.map((w) => w.score)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxVideos)
    .flatMap(({ list }) => {
      const selected = list.slice(0, options.perVideo);
      if (!focusProof || !selected.length) return selected;
      // Réserver une des places au geste observé, même si l'introduction et la présentation
      // de l'outil constituent les deux premières fenêtres. Le classement des vidéos est conservé.
      for (const [index, window] of list.entries()) {
        const proof = focusProof(window);
        if (proof) {
          selected[Math.min(index, selected.length - 1)] = proof;
          break;
        }
      }
      return selected;
    });
}

/** Vidéos triées par date de publication (croissante pour « première »), date inconnue en dernier. */
export function sortByDate<V extends { publishedAt: string | null }>(videos: V[], order: 'premiere' | 'derniere'): V[] {
  const direction = order === 'premiere' ? 1 : -1;
  return [...videos].sort((a, b) => {
    if (a.publishedAt === null || b.publishedAt === null) return (a.publishedAt === null ? 1 : 0) - (b.publishedAt === null ? 1 : 0);
    return direction * a.publishedAt.localeCompare(b.publishedAt);
  });
}
