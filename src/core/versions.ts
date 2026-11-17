import { createHash } from 'node:crypto';
import { BRANDS_VERSION } from '../norm/brands.js';

/** Paramètres des dérivés. Tout changement impose une réingestion. */
export const WINDOW_SECONDS = 120;
export const STEP_SECONDS = 90;
export const WINDOW_MIN_SECONDS = 60;
export const FORMAT_VERSION = '1';
export const TEXT_PREP_VERSION = '1';
/** Blocs sémantiques : durée et format du texte encodé. */
export const CHUNK_SECONDS = 30;
export const CHUNK_FORMAT_VERSION = '1';

export const DERIVATION_VERSION = createHash('sha256')
  .update(
    `parser-v1|brands-v${BRANDS_VERSION}|norm-v1|windows-${WINDOW_SECONDS}-${STEP_SECONDS}|format-v${FORMAT_VERSION}` +
      `|chunks-${CHUNK_SECONDS}-v${CHUNK_FORMAT_VERSION}`,
    'utf8',
  )
  .digest('hex')
  .slice(0, 16);

/** `contentHash` est l'empreinte amont (yt-rag), pas un calcul local. */
export const CONTENT_HASH_VERSION = 'upstream-sha256-of-analysis';

/** Recul appliqué aux liens horodatés. */
export const LINK_BACK_S = 3;
