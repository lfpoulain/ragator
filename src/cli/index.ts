import type { Pool } from 'pg';
import { getConfig } from '../config.js';
import { canConnect, closePool, getPool } from '../db/pool.js';
import { prewarmVectorIndexes } from '../db/vector-index.js';
import { migrate } from '../db/migrate.js';
import { ingestPaths } from '../core/ingest.js';
import { embedPending, resetEmbeddings } from '../core/embed.js';
import { enrichPending } from '../core/enrich.js';
import { updateCorpus } from '../core/update.js';
import { stats } from '../core/stats.js';
import { enrichLlmFromConfig } from '../providers/llm.js';
import { createWebServer } from '../web/server.js';
import { listCollections } from '../core/collections.js';
import { readQuestionLog } from '../db/question-log.js';
import { ask } from './ask.js';
import { chat } from './chat.js';
import { printStats } from './print.js';
import { Args } from './args.js';
import { applyStoredSettings } from '../settings.js';

const USAGE = `Ragator — commandes :

Base et corpus
  npm run db:migrate                          applique les migrations
  npm run update [-- --surveiller <minutes>]  ingestion + enrichissement + vecteurs des vidéos nouvelles ou modifiées
  npm run ingest [-- <fichier|dossier>…]      étape 1 seule : ingestion (défaut : CORPUS_DIR)
  npm run enrich [-- --videos N]              étape 2 seule : contexte et mots-clés des blocs de 30 s (LLM)
  npm run embed [-- --reset]                  étape 3 seule : vecteurs manquants et index HNSW (--reset : changement de modèle)
  npm run stats [-- --json]                   état du corpus indexé

Questions
  npm run ask -- "question" [--court|--extractif] [--sources N] [--collection clé] [--json]
  npm run chat [-- --detaille --collection clé] conversation avec relances (« et dans cette vidéo ? »)
  npm run collections                         chaînes du corpus (--collection limite une question à l'une d'elles)
  npm run journal [-- --echecs --jours N]     questions posées (web, ligne de commande) ; --echecs : refus, rien de cité, erreurs
  npm run web [-- --port 3210 --mettre-a-jour] interface web locale (http://127.0.0.1:3210), recherche et administration
  npm run --silent mcp                        serveur MCP en stdio, pour un client IA`;

async function withDatabase(work: (pool: Pool) => Promise<number>): Promise<number> {
  if (!(await canConnect())) {
    console.error('PostgreSQL injoignable : vérifier DATABASE_URL (ou lancer `npm run db:up`).');
    return 2;
  }
  const pool = getPool();
  try {
    // Réglages enregistrés depuis l'interface (mode, clé, modèle) ; ils priment sur .env.
    if (process.argv[2] !== 'db:migrate') await applyStoredSettings(pool);
    return await work(pool);
  } finally {
    await closePool(pool);
  }
}

const commands: Record<string, (args: Args) => Promise<number>> = {
  'db:migrate': () =>
    withDatabase(async (pool) => {
      const result = await migrate(pool);
      for (const name of result.applied) console.log(`appliquée      : ${name}`);
      for (const name of result.alreadyApplied) console.log(`déjà appliquée : ${name}`);
      return 0;
    }),

  update: (args) =>
    withDatabase(async (pool) => {
      const minutes = args.int('--surveiller');
      const once = async () => {
        const started = Date.now();
        const report = await updateCorpus(pool, { llm: enrichLlmFromConfig(), log: (line) => console.log(line) });
        console.log(
          `[${new Date().toLocaleTimeString('fr-FR')}] ${report.ingested.length} vidéo(s) ingérée(s), ${report.enriched} bloc(s) enrichi(s), ` +
            `${report.embedded} vecteur(s), ${report.failures.length} échec(s) — ${((Date.now() - started) / 1000).toFixed(0)} s`,
        );
        for (const note of report.notes) console.log(`  ${note}`);
        if (report.refused) console.error(`ARRÊT : ${report.refused.summary}`);
        return report.failures.length > 0 || report.refused ? 1 : 0;
      };
      if (minutes === undefined) return once();
      console.log(`Surveillance de ${getConfig().corpusDir} toutes les ${minutes} min (Ctrl+C pour arrêter).`);
      for (;;) {
        try {
          await once();
        } catch (err) {
          console.error(`mise à jour en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
      }
    }),

  ingest: (args) =>
    withDatabase(async (pool) => {
      const paths = args.positional();
      const report = await ingestPaths(pool, paths.length > 0 ? paths : [getConfig().corpusDir]);
      for (const r of report.results) {
        console.log(`${r.status.padEnd(10)} ${r.videoId}  entrées=${r.entries} fenêtres=${r.windows}${r.durationEstimated ? ' durée_estimée' : ''}`);
      }
      for (const failure of report.failures) console.error(`ÉCHEC      ${failure.file}\n           ${failure.error}`);
      console.log(`\n${report.results.length} fichier(s) traité(s), ${report.failures.length} échec(s).`);
      return report.failures.length > 0 ? 1 : 0;
    }),

  enrich: (args) =>
    withDatabase(async (pool) => {
      const llm = enrichLlmFromConfig();
      if (!llm || !(await llm.available())) {
        console.error('Aucun modèle (mode à choisir dans Réglages) : rien à enrichir.');
        return 2;
      }
      const maxVideos = args.int('--videos');
      console.log(`Enrichissement des blocs avec ${llm.model}…`);
      const result = await enrichPending(pool, llm, {
        onProgress: (line) => console.log(line),
        ...(maxVideos === undefined ? {} : { maxVideos }),
      });
      console.log(
        `${result.chunks} bloc(s) enrichi(s) sur ${result.videos} vidéo(s), ${result.failedGroups} groupe(s) en échec, ` +
          `${result.pendingChunks} bloc(s) restant(s).` +
          (result.chunks > 0 ? ' Recalculer leurs vecteurs : npm run embed' : ''),
      );
      if (result.refused) console.error(`ARRÊT : ${result.refused.summary}`);
      return result.failedGroups > 0 || result.refused ? 1 : 0;
    }),

  embed: (args) =>
    withDatabase(async (pool) => {
      if (args.has('--reset')) {
        await resetEmbeddings(pool);
        console.log('Vecteurs et modèle effacés. Relancer « npm run embed » pour réindexer.');
        return 0;
      }
      const result = await embedPending(pool, { onProgress: (done, total) => process.stdout.write(`\rembeddings : ${done}/${total}`) });
      if (result.embedded > 0) process.stdout.write('\n');
      console.log(
        `${result.embedded} texte(s) encodé(s) avec ${result.model} ; ${result.pending} en attente.` +
          (result.complete ? ' Terminé.' : ' Interrompu : relancer pour continuer.') +
          (result.vectorIndexCreated ? ' Index HNSW construit.' : ''),
      );
      return 0;
    }),

  stats: (args) =>
    withDatabase(async (pool) => {
      const page = await stats(pool);
      if (args.has('--json')) console.log(JSON.stringify(page, null, 2));
      else printStats(page);
      return 0;
    }),

  collections: (args) =>
    withDatabase(async (pool) => {
      const list = await listCollections(pool);
      if (args.has('--json')) console.log(JSON.stringify(list, null, 2));
      else for (const c of list) console.log(`${c.key.padEnd(28)} ${String(c.videos).padStart(5)} vidéo(s)  ${c.channel}`);
      return 0;
    }),

  journal: (args) =>
    withDatabase(async (pool) => {
      const days = args.int('--jours');
      const limit = args.int('--limite');
      const list = await readQuestionLog(pool, {
        failures: args.has('--echecs'),
        ...(days === undefined ? {} : { days }),
        ...(limit === undefined ? {} : { limit }),
      });
      if (args.has('--json')) {
        console.log(JSON.stringify(list, null, 2));
        return 0;
      }
      for (const q of list) {
        const issue = q.error
          ? `ERREUR ${q.error}`
          : q.refused
            ? 'REFUS'
            : q.citedVideos.length === 0 && q.route !== 'clarifier' && q.route !== 'lister'
              ? 'RIEN DE CITÉ'
              : `${q.citedVideos.length} vidéo(s)`;
        console.log(
          `${q.askedAt.slice(0, 16)} ${q.origin.padEnd(3)} ${(q.route ?? '—').padEnd(9)} ${issue}${q.degradedReason ? ` [dégradé : ${q.degradedReason}]` : ''}` +
            `${q.collection ? ` (${q.collection})` : ''}
    ${q.question}${q.resolved ? `
    → ${q.resolved}` : ''}`,
        );
      }
      console.log(`
${list.length} question(s)${args.has('--echecs') ? ' en échec probable' : ''}.`);
      return 0;
    }),

  ask: (args) => {
    const question = args.positional(['--sources', '--collection']).join(' ').trim();
    if (!question) {
      console.error('Usage : npm run ask -- "question" [--court|--extractif] [--sources N] [--collection clé] [--json]');
      return Promise.resolve(1);
    }
    return withDatabase((pool) => ask(pool, question, args));
  },

  chat: (args) => withDatabase((pool) => chat(pool, args)),

  web: (args) =>
    withDatabase(async (pool) => {
      const port = args.int('--port') ?? 3210;
      // Dans le conteneur, WEB_HOST=0.0.0.0 : le port est publié par compose.yml (3210).
      const host = process.env.WEB_HOST || '127.0.0.1';
      // --mettre-a-jour : mise à jour du corpus au démarrage (conteneur tout-en-un), suivie dans l'administration.
      const server = createWebServer(pool, { updateOnStart: args.has('--mettre-a-jour') });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      console.log(`Ragator : http://127.0.0.1:${port}. Ctrl+C pour arrêter.`);
      // Index vectoriels et tables chargés en mémoire, sans retarder le démarrage : les premières questions n'attendent pas le disque.
      void prewarmVectorIndexes(pool).then((loaded) => {
        if (loaded.length > 0) console.log(`Recherche vectorielle chargée en mémoire : ${loaded.join(', ')}.`);
      });
      // Le serveur tourne jusqu'à l'arrêt du processus ; la base reste ouverte d'ici là.
      await new Promise<void>((resolve) => {
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => resolve()));
      });
      return 0;
    }),

};

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const run = command === undefined ? undefined : commands[command];
  if (!run) {
    console.log(USAGE);
    return 1;
  }
  return run(new Args(rest));
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
