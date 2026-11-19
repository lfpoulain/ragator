import type { Pool } from 'pg';
import { getConfig, loadConfig, type Config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import { readStoredSettings } from '../settings.js';

export class ModelSettingsChangedError extends Error {
  constructor() {
    super('Les réglages du modèle ont changé. Relancez le traitement avec les nouveaux réglages.');
  }
}

export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Chaque lot et chaque nouvelle tentative vérifient la destination, même depuis un autre processus. */
export function configuredFetch(
  provider: 'llm' | 'embedding' | 'judge',
  expected: Config = getConfig(),
  pool: Pool = getPool(expected.databaseUrl),
): ModelFetch {
  const settings = JSON.stringify(expected[provider]);
  return async (url, init) => {
    const { response } = await withTransaction(pool, async (client) => {
      // saveSettings prend le verrou exclusif correspondant. L'envoi commence du côté autorisé de
      // la bascule. Le verrou est rendu dès le départ HTTP, sans attendre le calcul du modèle.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('ragator:model-settings'))");
      const current = loadConfig(process.env, await readStoredSettings(client));
      if (!current[provider] || current.mode !== expected.mode || JSON.stringify(current[provider]) !== settings) {
        throw new ModelSettingsChangedError();
      }
      const response = fetch(url, init);
      // La requête peut déjà avoir échoué avant le COMMIT. Le rejet est propagé à l'appelant ensuite.
      void response.catch(() => {});
      return { response };
    });
    return response;
  };
}
