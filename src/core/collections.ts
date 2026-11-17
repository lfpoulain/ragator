import type { Db } from '../db/pool.js';
import { getMetaString } from '../db/meta.js';

/**
 * Collections : une par créateur de contenu, déduite de la chaîne YouTube de chaque vidéo (migration
 * 0007, colonne `videos.collection`). Toute recherche peut s'y limiter ; sans collection, elle porte sur
 * toutes. La chaîne complète (« Les Freres Poulain, French DIY and Tech Explorers ») décrit aussi le
 * corpus aux modèles, sans configuration.
 */
export interface CollectionInfo {
  /** Identifiant (« les-freres-poulain »). */
  key: string;
  /** Nom affiché (« Les Freres Poulain »). */
  name: string;
  /** Chaîne telle que l'écrit le système d'ingestion, accroche comprise. */
  channel: string;
  videos: number;
}

let cached: { corpusVersion: string; list: CollectionInfo[] } | null = null;

/** Collections du corpus, la plus fournie d'abord ; relues seulement quand le corpus change. */
export async function listCollections(db: Db): Promise<CollectionInfo[]> {
  const corpusVersion = (await getMetaString(db, 'corpus_version')) ?? '';
  if (cached?.corpusVersion === corpusVersion) return cached.list;
  const { rows } = await db.query<{ key: string; name: string; channel: string | null; videos: string }>(
    `SELECT collection AS key, ragator_collection_name(channel) AS name,
            mode() WITHIN GROUP (ORDER BY channel) AS channel, count(*) AS videos
     FROM videos
     GROUP BY collection, ragator_collection_name(channel)
     ORDER BY count(*) DESC, collection`,
  );
  const list = rows.map((r) => ({ key: r.key, name: r.name, channel: r.channel ?? r.name, videos: Number(r.videos) }));
  cached = { corpusVersion, list };
  return list;
}

/**
 * Première ligne des prompts : de quelles chaînes viennent les vidéos. `null` sans vidéo.
 * Exemple : « Corpus : vidéos YouTube de la chaîne « Les Freres Poulain, French DIY and Tech Explorers ». »
 */
export async function corpusLine(db: Db, collection?: string | null): Promise<string | null> {
  const all = await listCollections(db);
  const chosen = collection ? all.filter((c) => c.key === collection) : all;
  if (chosen.length === 0) return null;
  const channels = chosen.map((c) => `« ${c.channel} »`);
  return channels.length === 1
    ? `Corpus : vidéos YouTube de la chaîne ${channels[0]}.`
    : `Corpus : vidéos YouTube des chaînes ${channels.join(', ')} ; chaque vidéo appartient à l'une d'elles.`;
}

/** Clé de la collection désignée par son identifiant ou son nom (casse et accents ignorés) ; erreur qui liste les collections sinon. */
export async function resolveCollection(db: Db, wanted: string): Promise<string> {
  const all = await listCollections(db);
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const found = all.find((c) => c.key === wanted || fold(c.name) === fold(wanted));
  if (!found) throw new Error(`collection inconnue « ${wanted} » ; collections : ${all.map((c) => c.key).join(', ') || 'aucune'}`);
  return found.key;
}
