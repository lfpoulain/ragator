import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { closePool, getPool } from '../db/pool.js';
import { createRagatorServer } from './server.js';

/**
 * Point d'entrée MCP en stdio, pour Claude Code, Claude Desktop, Cursor…
 * stdout est réservé au protocole : lancer avec `npm run --silent mcp` ou
 * `npx tsx src/mcp/stdio.ts`, jamais `npm run mcp` (l'en-tête npm corromprait le flux).
 */
const pool = getPool();
const handle = serveStdio(() => createRagatorServer(pool));

async function shutdown(): Promise<void> {
  await handle.close().catch(() => {});
  await closePool(pool).catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void shutdown());
