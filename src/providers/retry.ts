/**
 * Requête HTTP avec nouvelles tentatives sur 429 (« Model busy ») et erreurs
 * 5xx : OpenRouter et ses fournisseurs saturent par moments. `init` est
 * rappelé à chaque essai, pour qu'un délai d'expiration reparte de zéro. Rend
 * la dernière réponse reçue, bonne ou non : l'appelant décide de l'erreur.
 */
export async function fetchRetrying(url: string, init: () => RequestInit, delaysMs: readonly number[]): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init());
    const retryable = response.status === 429 || response.status >= 500;
    if (response.ok || !retryable || attempt >= delaysMs.length) return response;
    // Corps abandonné : libère la connexion avant le prochain essai.
    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
  }
}

/**
 * Refus du compte chez le fournisseur : crédit épuisé (HTTP 402) ou clé
 * refusée (401). Aucun appel suivant ne passera avant une action humaine : pas
 * de nouvelle tentative, et les traitements par lots s'arrêtent au premier.
 */
export class AccountRefusedError extends Error {
  readonly reason: 'credit' | 'key';
  readonly status: 402 | 401;
  /** Cause et remède, sans le détail du fournisseur : le résumé d'une mise à jour. */
  readonly summary: string;

  constructor(status: 402 | 401, url: string, detail = '') {
    const provider = /openrouter\.ai/i.test(url) ? 'OpenRouter' : `du fournisseur (${URL.canParse(url) ? new URL(url).host : url})`;
    const summary =
      status === 402
        ? `crédit ${provider} épuisé : rechargez puis relancez la mise à jour`
        : `clé ${provider} refusée (invalide ou révoquée) : corrigez-la puis relancez la mise à jour`;
    super(detail ? `${summary} — ${detail}` : summary);
    this.name = 'AccountRefusedError';
    this.reason = status === 402 ? 'credit' : 'key';
    this.status = status;
    this.summary = summary;
  }
}

/** Message d'erreur d'un corps OpenAI/OpenRouter (`{"error":{"message":…}}`), sinon le texte brut. */
function errorDetail(body: string): string {
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string') return message.slice(0, 200);
  } catch {
    // corps non JSON : rendu tel quel
  }
  return body.trim().slice(0, 200);
}

/** Erreur typée pour une réponse 402 ou 401 (corps lu en `body`), `null` pour tout autre statut. */
export function accountRefusal(status: number, url: string, body: string): AccountRefusedError | null {
  return status === 402 || status === 401 ? new AccountRefusedError(status, url, errorDetail(body)) : null;
}
