import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ProjectAccessSchema } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import { createStudio, type Studio } from '../../src/domain/studio';
import { registerMcp, toolRegistry } from '../../src/mcp/server';
import { MemoryBackend } from '../../src/storage/memory';

/**
 * MCP tools reached without a caller (docs/design/mcp.md#transport-and-auth). Outside auth mode `none` the app refuses a
 * request to /mcp that carries no principal; a tool reached without one all the same (a route that lost its guard) is
 * refused rather than run as the studio. Mode `none` and recipe steps, which run without a request, are unchanged.
 */

const quiet = () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
};
const dirs: string[] = [];
const studios: Studio[] = [];
const apps: FastifyInstance[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const a of apps.splice(0)) await a.close();
  for (const s of studios.splice(0)) await s.stop().catch(() => undefined);
});
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeStudio(env: Record<string, string> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rideo-mcp-'));
  dirs.push(dataDir);
  const config = loadConfig({
    RIDEO_DATA_DIR: dataDir,
    RIDEO_STORAGE: 'embedded',
    NODE_ENV: 'test',
    RIDEO_WATERMARK_KEY: 'unit-test-key',
    RIDEO_LOG_LEVEL: 'warn',
    ...env,
  });
  const s = createStudio(config, { log: quiet(), storage: new MemoryBackend() });
  await s.deps.accounts.init();
  studios.push(s);
  // A private project of someone's: who may list it is the question
  const project = { ...f.project(), access: ProjectAccessSchema.parse({ visibility: 'private' }) };
  const h = s.deps.projects.handle(project.id);
  await h.repo.init(
    { 'project.json': project },
    { kind: 'user', id: 'local', name: 'You' },
    'Create project',
  );
  await h.worktree.idle();
  return { studio: s, project };
}

/** The MCP endpoint alone, without the app's authentication hooks: no request it answers carries a principal. */
async function bareMcp(studio: Studio) {
  const app = Fastify();
  apps.push(app);
  registerMcp(app, studio);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const client = new Client({ name: 'unit', version: '1.0.0' });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`),
    ),
  );
  return async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
  };
}

const recipe = { kind: 'agent' as const, id: 'recipe', name: 'Recipe' };

describe('MCP tools reached without a caller', () => {
  it('are refused outside auth mode none', async () => {
    const { studio, project } = await makeStudio({ RIDEO_API_TOKEN: 'mcp-unit-token' });
    expect(studio.deps.accounts.mode).toBe('token');
    const call = await bareMcp(studio);
    const seen = {
      projects: await call('project_list'),
      project: await call('project_get', { projectId: project.id }),
      library: await call('library_list'),
    };
    expect(seen).toEqual({
      projects: { error: true, body: expect.objectContaining({ code: 'unauthorized' }) },
      project: { error: true, body: expect.objectContaining({ code: 'unauthorized' }) },
      library: { error: true, body: expect.objectContaining({ code: 'unauthorized' }) },
    });
    // A recipe's step runs its tool from the registry, without a request: unchanged
    const listed = (await toolRegistry(studio).get('project_list')!.run({}, recipe)) as { id: string }[];
    expect(listed.map((p) => p.id)).toEqual([project.id]);
  });

  it('run as the studio in auth mode none', async () => {
    const { studio, project } = await makeStudio();
    expect(studio.deps.accounts.mode).toBe('none');
    const call = await bareMcp(studio);
    const projects = await call('project_list');
    expect(projects.error).toBe(false);
    expect((projects.body as { id: string }[]).map((p) => p.id)).toEqual([project.id]);
    expect(await call('library_list')).toEqual({ error: false, body: { items: [], next: null } });
  });
});
