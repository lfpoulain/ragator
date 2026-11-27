import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { logQuestion } from '../db/question-log.js';
import { repondre, turnOf, type AnswerInput, type AnswerMode, type AnswerProgress, type AnswerResult, type AnswerSource } from '../core/answer.js';
import { repondreAgent } from '../core/agent.js';
import { MAX_HISTORY_TURNS, MAX_TURN_SCENES, type Turn, type SceneRef } from '../core/followup.js';
import { channelStats, stats } from '../core/stats.js';
import { listCollections, resolveCollection } from '../core/collections.js';
import { nearbyVideos } from '../core/nearby-videos.js';
import { getConfig, loadConfig, MODES, PROJECT_ROOT, type Mode } from '../config.js';
import { checkOpenRouterKey, localStatus, publicSettings, readStoredSettings, saveSettings, type SettingKey } from '../settings.js';
import { createAdmin } from './admin.js';
import { gatewayConfig, groupPrefix, guestIdentity, isGatewayRequest, peerAddress } from './gateway.js';
import { createAuthThrottle, createGuestLimiter } from './limits.js';

/** Page de l'interface (recherche et administration), autonome : HTML, CSS et JS dans un seul fichier. */
const PAGE = join(PROJECT_ROOT, 'src', 'web', 'public', 'index.html');

/**
 * Les deux pages servies viennent du même fichier : la page des invités est la page principale privée
 * de ses blocs d'administration : balises de commentaire `admin` et `/admin`, en commentaire HTML dans
 * le balisage et en commentaire de bloc dans le script et le style. L'interface reste donc la même par construction, et un invité ne reçoit
 * ni le code ni le balisage de l'administration.
 * Chaque page part avec une politique de contenu stricte : seuls son script et son style, reconnus par
 * leur empreinte, s'exécutent ; aucune ressource tierce hormis les miniatures YouTube.
 */
export function buildPages(html: string): Record<'main' | 'guest', { html: string; csp: string }> {
  const page = (source: string) => {
    const hash = (tag: string) => {
      const body = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(source)?.[1] ?? '';
      return `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    };
    const csp = [
      "default-src 'none'", `script-src ${hash('script')}`, `style-src ${hash('style')}`, "style-src-attr 'unsafe-inline'",
      "img-src 'self' data: https://i.ytimg.com", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; ');
    return { html: source, csp };
  };
  const guest = html
    .replace(/<!--admin-->[\s\S]*?<!--\/admin-->/g, '')
    .replace(/\/\*admin\*\/[\s\S]*?\/\*\/admin\*\//g, '')
    .replace('<html lang="fr">', '<html lang="fr" data-guest>');
  return { main: page(html), guest: page(guest) };
}

let pagesCache: { mtimeMs: number; pages: ReturnType<typeof buildPages> } | null = null;
function pages(): ReturnType<typeof buildPages> {
  const { mtimeMs } = statSync(PAGE);
  if (pagesCache?.mtimeMs !== mtimeMs) pagesCache = { mtimeMs, pages: buildPages(readFileSync(PAGE, 'utf8')) };
  return pagesCache.pages;
}

function sendPage(res: ServerResponse, page: { html: string; csp: string }): void {
  send(res, 200, page.html, 'text/html; charset=utf-8', {
    'Content-Security-Policy': page.csp, 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
  });
}


/** Corps accepté au plus : une question et son historique court ; un fichier de vidéo pour le dépôt. */
const MAX_BODY_BYTES = 262_144;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const MAX_QUESTION_CHARS = 1000;

/**
 * Questions traitées en même temps au plus : une question générale lance déjà
 * des dizaines d'appels modèles en parallèle. Au-delà, 429 plutôt qu'une file.
 */
const MAX_CONCURRENT_ASKS = 4;
/** Places que les invités peuvent occuper ensemble : l'administration garde toujours les siennes. */
const MAX_GUEST_ASKS = 2;
/** Questions par heure et par invité, sauf `RAGATOR_GUEST_HOURLY`. */
const GUEST_HOURLY = 30;

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  type = 'application/json; charset=utf-8',
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Erreur due à la requête elle-même : son code HTTP et son message sont rendus tels quels. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Corps JSON borné : 413 au-delà de `limit` (annoncé ou constaté), 400 s'il
 * est illisible. Un corps trop long est lu jusqu'au bout sans être gardé,
 * pour que la réponse parvienne au client.
 */
function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    // Le client peut encore écrire pendant l’envoi du 413. Vider le flux sans le stocker.
    req.resume();
    return Promise.reject(new HttpError(413, 'requête trop longue'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('error', reject);
    // Client parti en cours d'envoi : sans cela, la question resterait comptée en cours.
    req.on('close', () => {
      if (!req.complete) reject(new HttpError(400, 'requête interrompue'));
    });
    req.on('end', () => {
      if (size > limit) return reject(new HttpError(413, 'requête trop longue'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON illisible'));
      }
    });
  });
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Adresse IP en clair (v4, ou v6 entre crochets), avec ou sans port. */
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])(:\d+)?$/;

/**
 * Hôte de la requête, contre le rebinding DNS (un site tiers qui ferait pointer son nom vers ce
 * serveur). Sans mot de passe l'accès se fait par localhost ou son adresse de bouclage.
 * Avec un mot de passe, RAGATOR_HOSTS peut restreindre les noms de domaine acceptés.
 */
export function hostAllowed(host: string | undefined, allowed: readonly string[], protectedByPassword = false): boolean {
  const value = (host ?? '').toLowerCase();
  if (!value) return false;
  if (LOCAL_HOST.test(value)) return true;
  if (!protectedByPassword) return false;
  return IP_HOST.test(value) || allowed.length === 0 || allowed.includes(value) || allowed.includes(value.replace(/:\d+$/, ''));
}

const digest = (text: string) => createHash('sha256').update(text).digest();

/** Mot de passe HTTP Basic (nom d'utilisateur libre), comparé en temps constant. */
export function passwordOk(header: string | undefined, password: string): boolean {
  const match = /^Basic\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return false;
  const given = decoded.slice(separator + 1);
  return timingSafeEqual(digest(given), digest(password));
}

/** Seules les coordonnées renvoyées par le client servent à la relecture dans le corpus. */
function parseHistory(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is { question: string; videoIds?: unknown; scenes?: unknown; choosingScene?: unknown; offeredEpisodeSearch?: unknown } => typeof t?.question === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => {
      const videoIds = Array.isArray(t.videoIds) ? t.videoIds.filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v)) : [];
      const scenes: SceneRef[] = Array.isArray(t.scenes) ? t.scenes.slice(0, MAX_TURN_SCENES).flatMap((s) => {
        if (!s || !videoIds.includes(s.videoId) || typeof s.sourceId !== 'string' || !s.sourceId || s.sourceId.length > 200 ||
          !Number.isSafeInteger(s.startS) || s.startS < 0 || s.startS > 2_147_483_647) return [];
        return [{ videoId: s.videoId, sourceId: s.sourceId, startS: s.startS }];
      }) : [];
      return { question: t.question.slice(0, MAX_QUESTION_CHARS), videoIds, ...(scenes.length ? { scenes } : {}),
        ...(t.choosingScene === true && scenes.length ? { choosingScene: true } : {}),
        ...(t.offeredEpisodeSearch === true && scenes.length ? { offeredEpisodeSearch: true } : {}) };
    });
}

/** Réponse envoyée à la page : ce qu'elle affiche, et la référence du tour pour la relance suivante. */
function answerPayload(result: AnswerResult) {
  return {
    question: result.question,
    resolvedQuestion: result.resolvedQuestion,
    route: result.route,
    mode: result.mode,
    // Qui a aiguillé : l'analyse LLM ou les règles seules.
    analysis: result.analysis ? { source: result.analysis.source } : null,
    answer: result.answer,
    refused: result.refused,
    claims: result.claims,
    sources: result.sources,
    degradedReason: result.degradedReason,
    model: result.model,
    // Qui a jugé les vidéos d'une question générale (affiché seulement si des affirmations portent une probabilité).
    judge: getConfig().judge?.label ?? 'JEV',
    // Comment les preuves ont été trouvées : recherche classée (vecteurs ou mots) ou lecture du corpus.
    retrieval: result.retrieval,
    timings: result.timings,
    // Réponse approfondie : recherches complémentaires faites avant la synthèse.
    agent: result.agent ?? null,
    turn: turnOf(result),
  };
}

/** Ce que la page affiche d'une source : ni extrait ni liens de description, inutiles à l'écran. */
function shownSource({ sourceId, sourceIds, videoId, title, publishedAt, kind, startS, endS, link }: AnswerSource) {
  return { sourceId, sourceIds, videoId, title, publishedAt, kind, startS, endS, link };
}

/**
 * Réponse envoyée à un invité : liste fermée de champs. Jamais le motif détaillé d'une réponse dégradée
 * (il peut porter l'état de tout le corpus ou un message du fournisseur), ni l'analyse, ni les modèles.
 */
function guestPayload(result: AnswerResult) {
  return {
    question: result.question,
    resolvedQuestion: result.resolvedQuestion,
    route: result.route,
    mode: result.mode,
    analysis: null,
    answer: result.answer,
    refused: result.refused,
    claims: result.claims.some((c) => c.relevance !== undefined) ? [{ relevance: 1 }] : [],
    sources: result.sources.map(shownSource),
    degradedReason: result.degraded ? 'Réponse partielle : une étape de la recherche ou de la rédaction n’a pas abouti.' : null,
    model: null,
    judge: null,
    retrieval: result.retrieval,
    timings: { totalMs: result.timings.totalMs },
    agent: result.agent ? { steps: result.agent.steps.map(({ outil }) => ({ outil })), composed: result.agent.composed } : null,
    turn: turnOf(result),
  };
}

type AskMode = AnswerMode | 'approfondi';
/** Forme demandée par la page ; `approfondi` : réponse détaillée, complétée et rédigée par l'agent. */
function askMode(value: unknown): { mode: AnswerMode; deep: boolean } {
  const wanted: AskMode = value === 'court' || value === 'extractif' || value === 'approfondi' ? value : 'détaillé';
  return wanted === 'approfondi' ? { mode: 'détaillé', deep: true } : { mode: wanted, deep: false };
}

/**
 * Interface web : recherche (réponse citée, sources) et administration du
 * corpus (dépôt de vidéos, mise à jour, état de l'index) et réglages
 * (mode, clé, modèle, mot de passe). Garde-fous : hôte vérifié (`hostAllowed`) ;
 * mot de passe facultatif (réglages, HTTP Basic), exigé aussi en accès local ;
 * seule la sonde `/healthz` est publique ; POST en `application/json` seulement, qu'un
 * autre site ne peut envoyer sans preflight CORS, jamais accordé ; corps bornés ;
 * questions simultanées bornées (`MAX_CONCURRENT_ASKS`).
 * `updateOnStart` : lance une mise à jour du corpus au démarrage (conteneur).
 */
export function createWebServer(
  pool: Pool,
  options: { updateOnStart?: boolean; corpusDir?: string; hosts?: string[]; password?: string | null } = {},
): Server {
  // Lus à chaque requête : les réglages changent sans redémarrage.
  const hostsNow = () => options.hosts ?? getConfig().web.hosts;
  const passwordNow = () => (options.password !== undefined ? options.password : getConfig().web.password);
  // Compose transmet l'adresse publiée sur l'hôte ; sans Compose, on utilise celle de l'écoute HTTP.
  const address = process.env.RAGATOR_BIND_ADDRESS || process.env.WEB_HOST || '127.0.0.1';
  const requiresPassword = !['127.0.0.1', '::1', 'localhost'].includes(address);
  if (requiresPassword && !passwordNow()?.trim()) {
    throw new Error('Accès réseau : définir RAGATOR_PASSWORD ou enregistrer un mot de passe depuis une installation locale avant de publier le port.');
  }
  const admin = createAdmin(pool, options.corpusDir === undefined ? {} : { corpusDir: options.corpusDir });
  if (options.updateOnStart) admin.startUpdate();
  let asking = 0;
  const gateway = gatewayConfig(process.env);
  const settingsView = () => gateway.origin ? { ...publicSettings(), guestGateway: true } : publicSettings();
  const hourly = Number(process.env.RAGATOR_GUEST_HOURLY ?? '');
  const guests = createGuestLimiter({ perHour: Number.isInteger(hourly) && hourly > 0 ? hourly : GUEST_HOURLY, concurrent: MAX_GUEST_ASKS });
  const throttle = createAuthThrottle();
  /** Dernière adresse d'où la passerelle s'est présentée avec le bon secret (réglage de RAGATOR_GATEWAY_PEERS). */
  let gatewayPeer: string | null = null;
  /** Question, puis réponse complète ou au fil de l'eau (une ligne JSON par étape). */
  const answer = async (res: ServerResponse, input: AnswerInput, deep: boolean, stream: boolean, origin: 'web' | 'invite',
    payload: (result: AnswerResult) => unknown, shown: (progress: AnswerProgress) => unknown) => {
    const run = deep ? repondreAgent : repondre;
    if (!stream) {
      try {
        const result = await run(pool, input);
        void logQuestion(pool, origin, input, { result });
        return send(res, 200, payload(result));
      } catch (err) {
        void logQuestion(pool, origin, input, { error: err });
        throw err;
      }
    }
    // X-Accel-Buffering : un proxy nginx ne retient pas le flux ; Caddy : « flush_interval -1 ».
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
    const emit = (event: unknown) => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const result = await run(pool, input, { onProgress: (progress) => emit({ type: 'progrès', ...(shown(progress) as object) }) });
      void logQuestion(pool, origin, input, { result });
      emit({ type: 'résultat', data: payload(result) });
    } catch (err) {
      void logQuestion(pool, origin, input, { error: err });
      emit({ type: 'erreur', error: origin === 'invite' ? 'Recherche temporairement indisponible.' : err instanceof Error ? err.message : String(err) });
    }
    return res.end();
  };
  return createServer((req, res) => {
    void (async () => {
      let external = false;
      try {
        external = isGatewayRequest(req, gateway, hostsNow());
        if (external) {
          // Liste fermée sur la cible brute, avant toute normalisation ou authentification interne.
          const path = req.url;
          const page = req.method === 'GET' && (path === '/' || path === '/invite');
          const session = req.method === 'GET' && path === '/api/guest/session';
          const ask = req.method === 'POST' && path === '/api/guest/ask';
          if (!page && !session && !ask) return send(res, 404, '', 'text/plain');
          const identity = guestIdentity(req, gateway);
          if (!identity) return send(res, 403, 'Accès refusé.', 'text/plain; charset=utf-8');
          gatewayPeer = peerAddress(req);
          if (page) {
            if (path === '/') return send(res, 302, '', 'text/plain', { Location: '/invite' });
            return sendPage(res, pages().guest);
          }
          if (ask && req.headers.origin !== gateway.origin) return send(res, 403, { error: 'Origine refusée.' });
          const collections = (await listCollections(pool)).filter(c => identity.keys.has(c.key));
          if (!collections.length) return send(res, 403, { error: 'Accès refusé.' });
          if (session) {
            return send(res, 200, { authenticated: true, label: identity.label, remaining: guests.remaining(identity.user),
              // Miniatures YouTube seulement quand les modèles passent déjà par Internet (comme l'interface principale).
              thumbnails: getConfig().mode === 'openrouter',
              collections: collections.map(({ key, name, videos }) => ({ key, name, videos })) });
          }
          if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') return send(res, 415, { error: 'JSON attendu' });
          if (asking >= MAX_CONCURRENT_ASKS) return send(res, 429, { error: 'Trop de questions en cours.' }, undefined, { 'Retry-After': '5' });
          const release = guests.start(identity.user);
          if (typeof release !== 'function') {
            const wait = release.reason === 'quota'
              ? `Limite de questions atteinte : réessayez dans ${Math.ceil(release.retryAfterS / 60)} min.`
              : 'Une question est déjà en cours : attendez sa réponse.';
            req.resume();
            return send(res, 429, { error: wait }, undefined, { 'Retry-After': String(release.retryAfterS) });
          }
          asking++;
          try {
            const body = await readJson(req) as { collection?: unknown; question?: unknown; mode?: unknown; history?: unknown; stream?: unknown } | null;
            const collection = collections.find(c => c.key === body?.collection);
            if (!collection) return send(res, 403, { error: 'Collection non autorisée.' });
            const question = typeof body?.question === 'string' ? body.question.trim() : '';
            if (!question || question.length > MAX_QUESTION_CHARS) return send(res, 400, { error: 'Saisissez une question de 1 à 1 000 caractères.' });
            const { mode, deep } = askMode(body?.mode);
            // L'historique vient du navigateur : chaque repère est relu dans la collection autorisée, jamais cru.
            const input = { question, mode, history: parseHistory(body?.history), collection: collection.key };
            return await answer(res, input, deep, body?.stream === true, 'invite', guestPayload,
              (progress) => progress.étape === 'lignes' ? { ...progress, sources: progress.sources.map(shownSource) }
                : progress.étape === 'approfondissement' ? { étape: progress.étape, outil: progress.outil } : progress);
          } finally {
            asking--;
            release();
          }
        }
        const password = passwordNow();
        if (requiresPassword && !password?.trim()) return send(res, 503, { error: 'Mot de passe réseau requis.' });
        if (!hostAllowed(req.headers.host, hostsNow(), password !== null)) {
          return send(res, 403, { error: 'Nom d’hôte refusé. En local, utiliser localhost. Pour un accès réseau, vérifier le mot de passe et RAGATOR_HOSTS.' });
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/healthz') {
          // Sonde publique : jamais le détail de l'erreur de la base.
          const ok = await pool.query('SELECT 1').then(() => true, () => false);
          return send(res, ok ? 200 : 503, { ok });
        }
        if (password && !passwordOk(req.headers.authorization, password)) {
          // Un mauvais mot de passe (pas une simple absence) : réponse de plus en plus tardive pour cette adresse.
          if (req.headers.authorization !== undefined) {
            const address = peerAddress(req);
            const delay = throttle.failed(address);
            if (delay === null) return send(res, 429, { error: 'Trop d’essais : patientez.' }, undefined, { 'Retry-After': '5' });
            if (delay > 0) {
              await new Promise((resolve) => setTimeout(resolve, delay));
              throttle.released(address);
            }
          }
          res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Ragator", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Mot de passe requis.');
        }
        if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return send(res, 415, { error: 'JSON attendu' });
        }
        if (req.method === 'GET' && url.pathname === '/') return sendPage(res, pages().main);
        // La destination est décidée ici, y compris pour une ancienne page encore ouverte après une bascule.
        const thumbnail = req.method === 'GET' && /^\/api\/videos\/([A-Za-z0-9_-]{11})\/miniature$/.exec(url.pathname);
        if (thumbnail) {
          const current = loadConfig(process.env, await readStoredSettings(pool));
          if (current.mode === 'openrouter') {
            return send(res, 302, '', 'text/plain', { Location: `https://i.ytimg.com/vi/${thumbnail[1]}/mqdefault.jpg`, 'Referrer-Policy': 'no-referrer' });
          }
          return send(res, 200, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36"><path fill="#898781" d="M28 11v14l11-7z"/></svg>', 'image/svg+xml');
        }
        if (req.method === 'GET' && url.pathname === '/api/stats') return send(res, 200, (await stats(pool)).data);
        if (req.method === 'GET' && url.pathname === '/api/collections') return send(res, 200, { collections: await listCollections(pool) });
        // Vidéos proches d'une vidéo, par leur vecteur (?limit=8, ?collection=…).
        const nearby = req.method === 'GET' ? /^\/api\/videos\/([A-Za-z0-9_-]{11})\/proches$/.exec(url.pathname) : null;
        if (nearby) {
          const wanted = url.searchParams.get('collection');
          let collection: string | null = null;
          if (wanted) {
            try {
              collection = await resolveCollection(pool, wanted);
            } catch (err) {
              return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
          }
          const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
          const result = await nearbyVideos(pool, nearby[1]!, { ...(limit === undefined ? {} : { limit }), collection });
          return result ? send(res, 200, result) : send(res, 404, { error: 'vidéo inconnue' });
        }

        // Question : réponse complète (/api/ask) ou au fil de l'eau (/api/ask/stream, une ligne JSON par
        // étape, puis la réponse complète ; X-Accel-Buffering : un proxy nginx ne la retient pas).
        if (req.method === 'POST' && (url.pathname === '/api/ask' || url.pathname === '/api/ask/stream')) {
          if (asking >= MAX_CONCURRENT_ASKS) {
            return send(res, 429, { error: 'trop de questions en cours : réessayer dans un instant' }, undefined, { 'Retry-After': '5' });
          }
          asking += 1;
          try {
            const body = (await readJson(req)) as { question?: unknown; mode?: unknown; history?: unknown; collection?: unknown };
            const question = typeof body.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION_CHARS) : '';
            if (!question) return send(res, 400, { error: 'question vide' });
            const { mode, deep } = askMode(body.mode);
            // Collection : une chaîne du corpus, ou toutes (absente ou vide).
            let collection: string | undefined;
            if (typeof body.collection === 'string' && body.collection !== '') {
              try {
                collection = await resolveCollection(pool, body.collection);
              } catch (err) {
                return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
              }
            }
            const input = { question, mode, history: parseHistory(body.history), ...(collection ? { collection } : {}) };
            return await answer(res, input, deep, url.pathname === '/api/ask/stream', 'web', answerPayload, (progress) => progress);
          } finally {
            asking -= 1;
          }
        }

        // Administration du corpus.
        if (req.method === 'GET' && url.pathname === '/api/admin/status') {
          // Bilan d'une chaîne (?collection=…) ou de tout le corpus, plus un bilan par chaîne.
          const wanted = url.searchParams.get('collection');
          let collection: string | null = null;
          if (wanted) {
            try {
              collection = await resolveCollection(pool, wanted);
            } catch (err) {
              return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
          }
          return send(res, 200, {
            job: admin.job,
            corpus: await admin.corpusState(),
            stats: (await stats(pool, { collection })).data,
            channels: await channelStats(pool),
          });
        }
        if (req.method === 'GET' && url.pathname === '/api/admin/videos') return send(res, 200, { videos: await admin.listVideos() });
        if (req.method === 'POST' && url.pathname === '/api/admin/upload') {
          const body = (await readJson(req, MAX_UPLOAD_BYTES)) as { name?: unknown; content?: unknown };
          if (typeof body.content !== 'string') return send(res, 400, { error: 'contenu du fichier attendu' });
          return send(res, 200, admin.saveUpload(typeof body.name === 'string' ? body.name.slice(0, 200) : 'fichier', body.content));
        }
        if (req.method === 'POST' && url.pathname === '/api/admin/update') {
          const hasBody = req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
          const body = hasBody ? (await readJson(req)) as { afterCurrent?: boolean } | null : null;
          if (body?.afterCurrent === true) {
            admin.requestUpdate();
            return send(res, 202, { started: true });
          }
          const started = admin.startUpdate();
          return send(res, started ? 202 : 409, started ? { started: true } : { error: 'une mise à jour est déjà en cours' });
        }

        // Réglages : mode (local ou OpenRouter), clé OpenRouter (vérifiée avant d'être enregistrée), modèle
        // des réponses, serveurs locaux et jeton Hugging Face du juge local, mot de passe.
        if (req.method === 'GET' && url.pathname === '/api/settings') return send(res, 200, settingsView());
        if (gateway.origin && req.method === 'GET' && url.pathname === '/api/gateway') {
          return send(res, 200, { origin: gateway.origin ?? null, secretSet: !!gateway.secret, trusted: gateway.trusted,
            peersSet: gateway.peers !== null, lastPeer: gatewayPeer,
            groups: (await listCollections(pool)).map(c => ({ collection: c.name, group: groupPrefix + c.key })) });
        }
        if (req.method === 'GET' && url.pathname === '/api/settings/local') return send(res, 200, await localStatus());
        if (req.method === 'POST' && url.pathname === '/api/settings') {
          const body = (await readJson(req)) as Record<string, unknown>;
          const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string).slice(0, 500) : undefined);
          const patch: Partial<Record<SettingKey, string>> = {};
          for (const key of ['mode', 'openrouterKey', 'llmModel', 'password', 'localLlmUrl', 'localEmbeddingUrl', 'localJudgeUrl', 'hfToken'] as const) {
            const value = text(key);
            if (value !== undefined) patch[key] = value;
          }
          if (requiresPassword && patch.password !== undefined && !patch.password.trim() && !process.env.RAGATOR_PASSWORD?.trim()) {
            return send(res, 400, { error: 'Un mot de passe est obligatoire tant que le port est publié sur le réseau.' });
          }
          if (patch.mode && !MODES.includes(patch.mode.trim() as Mode)) return send(res, 400, { error: 'mode attendu : local ou openrouter' });
          if (patch.openrouterKey?.trim()) {
            const refused = await checkOpenRouterKey(patch.openrouterKey.trim());
            if (refused) return send(res, 400, { error: refused });
          }
          if (patch.llmModel?.trim() && !/^[\w.-]+\/[\w.:-]+$/.test(patch.llmModel.trim())) return send(res, 400, { error: 'modèle attendu sous la forme fournisseur/modèle' });
          for (const key of ['localLlmUrl', 'localEmbeddingUrl', 'localJudgeUrl'] as const) {
            if (patch[key]?.trim() && !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(patch[key]!.trim())) return send(res, 400, { error: 'adresse attendue sous la forme http://machine:port' });
          }
          if (patch.hfToken?.trim() && !/^hf_\w{20,}$/.test(patch.hfToken.trim())) return send(res, 400, { error: 'jeton Hugging Face attendu (hf_…)' });
          const before = getConfig();
          await saveSettings(pool, patch);
          const after = getConfig();
          // Modèles désormais disponibles (première clé, mode choisi ou changé) : le corpus déjà déposé est
          // enrichi et encodé sans attendre.
          if (after.llm && (before.mode !== after.mode || before.llm?.apiKey !== after.llm.apiKey ||
              before.llm?.enrichModel !== after.llm.enrichModel || before.llm?.baseUrl !== after.llm.baseUrl ||
              before.embedding?.baseUrl !== after.embedding?.baseUrl)) admin.requestUpdate();
          // Nouveau jeton : transmis tout de suite au juge local (téléchargement d'Aplomb).
          if (patch.hfToken?.trim() && after.mode === 'local') void localStatus().catch(() => {});
          return send(res, 200, settingsView());
        }
        send(res, 404, { error: 'introuvable' });
      } catch (err) {
        if (err instanceof HttpError) return send(res, err.status, { error: err.message });
        if (external) return send(res, 503, { error: 'Recherche temporairement indisponible.' });
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }).once('close', admin.close);
}
