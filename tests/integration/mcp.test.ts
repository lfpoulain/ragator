import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { closePool } from '../../src/db/pool.js';
import { ingestPaths } from '../../src/core/ingest.js';
import { createRagatorServer } from '../../src/mcp/server.js';
import { dbAvailable, FIXTURES_DIR, getTestPool, resetDatabase, setupDatabase } from './helpers.js';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function json(result: ToolResult): any {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first?.text ?? 'null');
}

(dbAvailable ? describe : describe.skip)('serveur MCP (client en mémoire)', () => {
  let pool: Pool;
  let client: Client;

  beforeAll(async () => {
    pool = getTestPool();
    await setupDatabase(pool);
    await resetDatabase(pool);
    expect((await ingestPaths(pool, [FIXTURES_DIR])).failures).toEqual([]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createRagatorServer(pool, { embedder: null }).connect(serverTransport);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await closePool(pool);
  });

  it('expose les six outils de consultation, en lecture seule, sans repondre', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['chercher', 'chercher_infos_video', 'chercher_plan', 'lire_contexte', 'lister_videos', 'stats'],
    );
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    const lister = tools.find((t) => t.name === 'lister_videos')!;
    expect(lister.description).toContain('EXHAUSTIF');
    expect(tools.find((t) => t.name === 'chercher')!.description).toContain('jamais une liste complète');
  });

  it('lister_videos renvoie le décompte exact', async () => {
    const data = json(await client.callTool({ name: 'lister_videos', arguments: { term: 'NordVPN', scope: 'paroles' } }));
    expect(data.data.totalEntries).toBe(9);
    expect(data.data.videos[0].link).toBe('https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=78s');
    expect(data.nextCursor).toBeNull();
  });

  it('chercher renvoie du contexte borné et citable', async () => {
    const result = await client.callTool({ name: 'chercher', arguments: { query: 'module Peltier', limit: 8 } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text.length).toBeLessThan(30_000);
    const data = JSON.parse(text);
    expect(data.data.results.length).toBeGreaterThan(0);
    expect(data.data.results[0].windowText).toContain('[Gu8bnHQaG5s:');
  });

  it('lire_contexte et chercher_infos_video répondent sans instant inventé', async () => {
    const context = json(await client.callTool({ name: 'lire_contexte', arguments: { videoId: 'Gu8bnHQaG5s', atS: 198 } }));
    expect(context.data.link).toBe('https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=195s');
    const infos = json(await client.callTool({ name: 'chercher_infos_video', arguments: { query: 'firmware' } }));
    for (const r of infos.data.results) expect(r.startS).toBeNull();
  });

  it('une erreur (curseur forgé, vidéo inconnue) est rendue au client, pas levée', async () => {
    const forged = Buffer.from(JSON.stringify({ k: 'autre', offset: 20 })).toString('base64url');
    const expired = await client.callTool({ name: 'lister_videos', arguments: { term: 'nordvpn', cursor: forged } });
    expect(expired.isError).toBe(true);
    expect((expired.content as Array<{ text: string }>)[0]!.text).toContain('CURSOR_EXPIRED');
    const unknown = await client.callTool({ name: 'lire_contexte', arguments: { videoId: 'inconnue', atS: 0 } });
    expect(unknown.isError).toBe(true);
  });

  it('stats décrit le corpus', async () => {
    const data = json(await client.callTool({ name: 'stats', arguments: {} }));
    expect(data.data.videos).toBe(2);
  });
});
