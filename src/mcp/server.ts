import type { Pool } from 'pg';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { listerVideos } from '../core/list-videos.js';
import { chercher } from '../core/search.js';
import { chercherPlan } from '../core/search-plans.js';
import { lireContexte } from '../core/read-context.js';
import { chercherInfosVideo } from '../core/video-info.js';
import { stats } from '../core/stats.js';
import { listCollections, resolveCollection } from '../core/collections.js';
import type { EmbeddingClient } from '../providers/embedding.js';
import { applyStoredSettings } from '../settings.js';

/**
 * Serveur MCP : façade mince sur les six outils de consultation.
 * Aucun SQL, aucun appel direct à un modèle, pas de `repondre` : le modèle du
 * client rédige lui-même à partir des passages et des liens fournis.
 */

/** Plafond de texte par réponse d'outil : ~6 000 tokens. */
const OUTPUT_BUDGET_CHARS = 24_000;
const EXCERPT_CHARS = 300;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const cursor = z.string().optional().describe('Curseur `nextCursor` d’un appel précédent, pour lire la page suivante.');
const dateFrom = z.string().optional().describe('Date de publication minimale, AAAA-MM-JJ (exclut les dates inconnues).');
const dateTo = z.string().optional().describe('Date de publication maximale, AAAA-MM-JJ (exclut les dates inconnues).');
const videoId = z.string().optional().describe('Restreindre à une vidéo (identifiant YouTube de 11 caractères).');
const collection = z
  .string()
  .optional()
  .describe('Restreindre à une chaîne du corpus : identifiant ou nom d’une collection (voir l’outil stats). Défaut : toutes.');

function clip(text: string, max = EXCERPT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function dateRange(from?: string, to?: string): { from?: string; to?: string } | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Filtre de collection d'un appel d'outil : clé validée, ou rien (toutes les chaînes). */
async function collectionOf(pool: Pool, wanted?: string): Promise<{ collection?: string }> {
  return wanted ? { collection: await resolveCollection(pool, wanted) } : {};
}

/** Une erreur d'outil est rendue au modèle client, jamais levée dans le transport. */
async function run(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = message.startsWith('CURSOR_EXPIRED')
      ? ' Le corpus a changé depuis la première page : relancer la recherche sans curseur.'
      : '';
    return { isError: true, content: [{ type: 'text', text: `${message}${hint}` }] };
  }
}

export function createRagatorServer(pool: Pool, options: { embedder?: EmbeddingClient | null } = {}): McpServer {
  const server = new McpServer({ name: 'ragator', version: '0.1.0' });
  const searchOptions = options.embedder === undefined ? {} : { embedder: options.embedder };

  server.registerTool(
    'lister_videos',
    {
      title: 'Lister toutes les vidéos qui contiennent un terme',
      description: [
        'Outil EXHAUSTIF : renvoie TOUTES les vidéos du corpus où un terme apparaît, avec le décompte exact des extraits par vidéo, la première mention et un lien horodaté.',
        'À utiliser pour « toutes les vidéos où… », « dans quelles vidéos… », « combien de fois… ». Le décompte est lexical (mot ou expression entière) : il ne trouve pas les synonymes.',
        'Les totaux (totalVideos, totalEntries) portent sur tout le corpus (ou la collection demandée) ; la liste est paginée par 20 vidéos : rappeler l’outil avec nextCursor jusqu’à nextCursor = null pour obtenir la liste entière.',
        'scope : « paroles » (dit à l’oral), « visuel » (plans filmés), « ecran » (texte affiché à l’écran), « tout » (défaut). Les descriptions YouTube ne sont pas comptées (voir chercher_infos_video).',
      ].join(' '),
      inputSchema: z.object({
        term: z.string().min(1).describe('Terme ou expression exacte à compter (marque, référence, nom d’objet).'),
        alternatives: z.array(z.string()).optional().describe('Autres formes à réunir (« BirdNET-Pi » pour « BirdNET »). Union des extraits, jamais une somme.'),
        scope: z.enum(['tout', 'paroles', 'visuel', 'ecran']).optional(),
        videoId: z.string().min(1).optional().describe('Restreint le décompte à une vidéo (identifiant YouTube).'),
        dateFrom,
        dateTo,
        collection,
        cursor,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const range = dateRange(args.dateFrom, args.dateTo);
        const page = await listerVideos(pool, {
          ...(await collectionOf(pool, args.collection)),
          term: args.term,
          ...(args.alternatives ? { alternatives: args.alternatives } : {}),
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.videoId ? { videoId: args.videoId } : {}),
          ...(range ? { dateRange: range } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        });
        return {
          ...page,
          data: {
            ...page.data,
            videos: page.data.videos.map((video) => ({
              ...video,
              excerpts: video.excerpts.map((e) => ({ ...e, text: clip(e.text) })),
            })),
          },
        };
      }),
  );

  server.registerTool(
    'chercher',
    {
      title: 'Chercher les passages les plus pertinents',
      description: [
        'Recherche CLASSÉE (lexicale + sémantique) : renvoie les passages les plus pertinents pour une question, jamais une liste complète — pour « toutes les vidéos où… », utiliser lister_videos.',
        'Chaque résultat est une fenêtre de contexte de 2 minutes (windowText) où chaque ligne porte son identifiant [sourceId @ mm:ss], avec la meilleure preuve et un lien horodaté.',
        'Renvoie du CONTEXTE, pas une réponse : lis les passages, rédige toi-même et cite les identifiants et les liens fournis. Si rien ne répond à la question, dis que le corpus ne contient pas l’information.',
        'Les horodatages sont estimés (le lien recule de 3 s). Paroles « identité inconnue » : le locuteur n’est pas identifié ; n’attribue jamais la phrase à une personne.',
      ].join(' '),
      inputSchema: z.object({
        query: z.string().min(1).describe('Question ou mots-clés, en français.'),
        limit: z.number().int().min(1).max(8).optional().describe('Nombre de fenêtres (défaut 4, max 8).'),
        kind: z.enum(['parole', 'visuel']).optional().describe('Restreindre aux paroles ou aux plans visuels.'),
        videoId,
        fromS: z.number().int().min(0).optional().describe('Début de la plage horaire dans la vidéo, en secondes.'),
        toS: z.number().int().min(0).optional().describe('Fin de la plage horaire dans la vidéo, en secondes.'),
        dateFrom,
        dateTo,
        collection,
        cursor,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const range = dateRange(args.dateFrom, args.dateTo);
        // Ce serveur peut rester ouvert pendant un changement de mode dans l'interface.
        await applyStoredSettings(pool);
        const page = await chercher(
          pool,
          {
            ...(await collectionOf(pool, args.collection)),
            query: args.query,
            limit: args.limit ?? 4,
            ...(args.kind ? { kind: args.kind } : {}),
            ...(args.videoId ? { videoId: args.videoId } : {}),
            ...(args.fromS !== undefined || args.toS !== undefined
              ? { timeRange: { fromS: args.fromS ?? 0, toS: args.toS ?? Number.MAX_SAFE_INTEGER } }
              : {}),
            ...(range ? { dateRange: range } : {}),
            ...(args.cursor ? { cursor: args.cursor } : {}),
          },
          searchOptions,
        );
        let used = 0;
        const results = page.data.results.map((r) => {
          const fits = used + r.windowText.length <= OUTPUT_BUDGET_CHARS;
          if (fits) used += r.windowText.length;
          return {
            videoId: r.videoId,
            title: r.title,
            publishedAt: r.publishedAt,
            startS: r.startS,
            endS: r.endS,
            link: r.link,
            bestEntry: { sourceId: r.bestEntry.sourceId, kind: r.bestEntry.kind, startS: r.bestEntry.startS, text: clip(r.bestEntry.text) },
            evidenceIds: r.evidence.map((e) => e.sourceId),
            windowText: fits ? r.windowText : null,
            ...(fits ? {} : { note: 'texte omis (budget de réponse) : appeler lire_contexte avec videoId et startS' }),
          };
        });
        return {
          ...page,
          data: {
            results,
            degraded: page.data.degraded,
            degradedReason: page.data.degradedReason,
          },
        };
      }),
  );

  server.registerTool(
    'chercher_plan',
    {
      title: 'Trouver des plans visuels',
      description: [
        'Trouve des PLANS FILMÉS dont la description, le titre ou le texte à l’écran contiennent les mots demandés : utile pour « dans quelle vidéo voit-on… » ou pour retrouver un plan à réutiliser au montage.',
        'Les descriptions sont des annotations automatiques : elles ne valent pas vérification de l’image ; signale les incertitudes (uncertainties).',
        'Pour une description longue ou sans mot exact, utiliser plutôt chercher avec kind = « visuel ».',
      ].join(' '),
      inputSchema: z.object({
        query: z.string().min(1).describe('Objet, marque ou texte visible recherché.'),
        limit: z.number().int().min(1).max(20).optional().describe('Nombre de plans (défaut 10).'),
        minDurationS: z.number().int().min(0).optional().describe('Durée minimale du plan en secondes (montage). Défaut 0.'),
        videoId,
        dateFrom,
        dateTo,
        collection,
        cursor,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const range = dateRange(args.dateFrom, args.dateTo);
        const page = await chercherPlan(pool, {
          ...(await collectionOf(pool, args.collection)),
          query: args.query,
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.minDurationS !== undefined ? { minDurationS: args.minDurationS } : {}),
          ...(args.videoId ? { videoId: args.videoId } : {}),
          ...(range ? { dateRange: range } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        });
        return {
          ...page,
          data: { ...page.data, results: page.data.results.map((r) => ({ ...r, description: clip(r.description, 600) })) },
        };
      }),
  );

  server.registerTool(
    'lire_contexte',
    {
      title: 'Lire le contexte autour d’un instant',
      description:
        'Renvoie paroles et plans d’une vidéo autour d’un instant, dans l’ordre chronologique, au même format que les fenêtres de chercher. Sert à compléter une phrase coupée, à vérifier une réponse ou à lire un passage omis. Fenêtre de ±45 s par défaut, ±300 s au plus.',
      inputSchema: z.object({
        videoId: z.string().min(1).describe('Identifiant YouTube de la vidéo.'),
        atS: z.number().int().min(0).describe('Instant visé, en secondes.'),
        beforeS: z.number().int().min(0).max(300).optional(),
        afterS: z.number().int().min(0).max(300).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const page = await lireContexte(pool, {
          videoId: args.videoId,
          atS: args.atS,
          ...(args.beforeS !== undefined ? { beforeS: args.beforeS } : {}),
          ...(args.afterS !== undefined ? { afterS: args.afterS } : {}),
        });
        const { entries: _entries, ...data } = page.data;
        return { ...page, data: { ...data, merged: clip(data.merged, OUTPUT_BUDGET_CHARS) } };
      }),
  );

  server.registerTool(
    'chercher_infos_video',
    {
      title: 'Chercher dans les titres et descriptions YouTube',
      description: [
        'Cherche dans les TITRES et DESCRIPTIONS YouTube : liens, firmware, fichiers 3D, références de matériel, liens affiliés.',
        'Ces sources n’ont pas d’instant : ne pas inventer de timecode. Une mention en description ne prouve pas que l’objet est montré ou utilisé dans l’épisode.',
      ].join(' '),
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).optional().describe('Défaut 8.'),
        videoId,
        dateFrom,
        dateTo,
        collection,
        cursor,
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const range = dateRange(args.dateFrom, args.dateTo);
        return chercherInfosVideo(pool, {
          ...(await collectionOf(pool, args.collection)),
          query: args.query,
          ...(args.limit ? { limit: args.limit } : {}),
          ...(args.videoId ? { videoId: args.videoId } : {}),
          ...(range ? { dateRange: range } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
        });
      }),
  );

  server.registerTool(
    'stats',
    {
      title: 'État du corpus',
      description:
        'Nombre de vidéos, durée totale, période couverte, entrées indexées et état des embeddings, et collections (une par chaîne YouTube, avec leur identifiant pour le paramètre collection des autres outils). Utile pour situer la couverture du corpus avant de conclure qu’une information est absente.',
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const page = await stats(pool);
        return { ...page, data: { ...page.data, collections: await listCollections(pool) } };
      }),
  );

  return server;
}
