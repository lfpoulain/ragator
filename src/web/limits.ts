/**
 * Garde-fous de débit de l'interface web, en mémoire (un seul processus sert Ragator) :
 * quota de questions par invité, et ralentissement des essais de mot de passe.
 */

/** Tables bornées : au-delà, les entrées les plus anciennes partent (ordre d'insertion). */
const MAX_TRACKED = 5_000;

function trim<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

export type GuestRefusal = { reason: 'busy' | 'quota'; retryAfterS: number };

/**
 * Chaque question d'un invité coûte des appels aux modèles : une à la fois par compte, et un
 * nombre borné par heure glissante. Les invités n'occupent jamais toutes les places de réponse,
 * l'administration garde la sienne.
 */
export function createGuestLimiter(options: { perHour: number; concurrent: number }, now: () => number = Date.now) {
  const asked = new Map<string, number[]>();
  const running = new Set<string>();
  const HOUR_MS = 3_600_000;
  return {
    /** Réserve une question ; rend la fonction qui libère la place, ou le motif du refus. */
    start(user: string): (() => void) | GuestRefusal {
      const recent = (asked.get(user) ?? []).filter((at) => now() - at < HOUR_MS);
      if (running.has(user)) return { reason: 'busy', retryAfterS: 5 };
      if (running.size >= options.concurrent) return { reason: 'busy', retryAfterS: 5 };
      if (recent.length >= options.perHour) {
        return { reason: 'quota', retryAfterS: Math.max(1, Math.ceil((recent[0]! + HOUR_MS - now()) / 1000)) };
      }
      recent.push(now());
      asked.delete(user);
      asked.set(user, recent);
      trim(asked);
      running.add(user);
      let released = false;
      return () => {
        if (!released) running.delete(user);
        released = true;
      };
    },
    /** Questions encore permises dans l'heure. */
    remaining(user: string): number {
      return Math.max(0, options.perHour - (asked.get(user) ?? []).filter((at) => now() - at < HOUR_MS).length);
    },
  };
}

/**
 * Essais de mot de passe : les premiers échecs d'une adresse répondent tout de suite (faute de frappe),
 * les suivants de plus en plus tard, et au-delà de quelques échecs en attente l'adresse reçoit 429.
 * Un bon mot de passe passe toujours sans délai : personne n'est verrouillé dehors.
 */
export function createAuthThrottle(now: () => number = Date.now) {
  const failures = new Map<string, { count: number; last: number; pending: number }>();
  const FORGET_MS = 10 * 60_000;
  const FREE_FAILURES = 3;
  const MAX_DELAY_MS = 4_000;
  const MAX_PENDING = 4;
  return {
    /** Délai avant de répondre 401 à cet échec ; `null` : trop d'essais en cours, répondre 429. */
    failed(address: string): number | null {
      const state = failures.get(address);
      const entry = state && now() - state.last < FORGET_MS ? state : { count: 0, last: 0, pending: 0 };
      if (entry.pending >= MAX_PENDING) return null;
      entry.count += 1;
      entry.last = now();
      failures.delete(address);
      failures.set(address, entry);
      trim(failures);
      if (entry.count <= FREE_FAILURES) return 0;
      entry.pending += 1;
      return Math.min(MAX_DELAY_MS, 250 * 2 ** (entry.count - FREE_FAILURES - 1));
    },
    /** À appeler une fois le délai écoulé. */
    released(address: string): void {
      const entry = failures.get(address);
      if (entry && entry.pending > 0) entry.pending -= 1;
    },
  };
}
