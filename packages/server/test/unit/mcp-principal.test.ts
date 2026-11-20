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
    const listed = (await toolRegistry(studio)
      .get('project_list')!
      .run({} as never, recipe)) as { id: string }[];
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

/** JSON Schema of a tool's arguments, as `tools/list` gives it. */
interface Schema {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
}

/** Values for the patterned strings tools require besides their project id. */
const PATTERNED: Record<string, string> = {
  '^[a-z]{2,3}(-[A-Z]{2})?$': 'en',
  '^[a-z]{3}_[0-9a-z]{10,32}$': 'chr_0123456789abcdef',
  '^lib_[0-9a-z]{10,32}$': 'lib_0123456789abcdef',
  '^media\\/[a-z0-9._/-]+$': 'media/clip.mp4',
  '^[0-9a-f]{64}$': '0'.repeat(64),
};

/** The smallest arguments a tool's schema accepts: its required properties, each with a value of its type. */
function example(s: Schema): unknown {
  if (s.const !== undefined) return s.const;
  if (s.enum) return s.enum[0];
  const alternatives = (s.oneOf ?? s.anyOf)?.filter((a) => a.type !== 'null');
  if (alternatives?.length) return example(alternatives[0]!);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'string':
      if (s.pattern === undefined) return 'x'.repeat(Math.max(1, s.minLength ?? 1));
      if (!(s.pattern in PATTERNED)) throw new Error(`no example for the pattern ${s.pattern}`);
      return PATTERNED[s.pattern];
    case 'number':
    case 'integer':
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case 'boolean':
      return false;
    case 'array':
      return Array.from({ length: s.minItems ?? 0 }, () => example(s.items ?? {}));
    case 'object':
      return Object.fromEntries((s.required ?? []).map((k) => [k, example(s.properties![k]!)]));
    default:
      return null;
  }
}

describe('MCP tools given a malformed project id', () => {
  it('answer validation_error before anything reads the project, whatever the tool', async () => {
    const { studio, project } = await makeStudio();
    const call = await bareMcp(studio);
    const client = clients.at(-1)!;
    const tools = (await client.listTools()).tools.filter(
      (t) => (t.inputSchema.properties as Record<string, unknown> | undefined)?.projectId,
    );
    // every tool of a project, the library's and the recipes' included
    expect(tools.length).toBeGreaterThan(120);
    for (const name of ['project_get', 'library_status', 'library_save', 'recipe_run', 'ui_notify'])
      expect(tools.map((t) => t.name)).toContain(name);
    // not an id, another case, too short, a path, a trailing newline, empty
    const ids = ['not-an-id', 'PRJ_0123456789abcdef', 'prj_short', 'prj_bad/../x', `${project.id}\n`, ''];
    const answers: Record<string, string[]> = {};
    for (const t of tools) {
      const args = example(t.inputSchema as Schema) as Record<string, unknown>;
      const seen = new Set<string>();
      for (const projectId of ids) {
        const r = await client.callTool({ name: t.name, arguments: { ...args, projectId } });
        const text = (r.content as { text: string }[])[0]!.text;
        let code: string;
        try {
          code = (JSON.parse(text) as { code: string }).code;
        } catch {
          code = text.slice(0, 120);
        }
        seen.add(r.isError ? code : 'ok');
      }
      answers[t.name] = [...seen];
    }
    expect(answers).toEqual(Object.fromEntries(tools.map((t) => [t.name, ['validation_error']])));
    // the message says which argument and what a project id is
    expect(await call('project_get', { projectId: 'prj_short' })).toEqual({
      error: true,
      body: expect.objectContaining({
        code: 'validation_error',
        message: expect.stringMatching(/^projectId .*prj_/),
      }),
    });
    // a well-formed id is the project's business: missing is not_found, an existing one answers
    expect((await call('project_get', { projectId: 'prj_0000000000000000' })).body).toMatchObject({
      code: 'not_found',
    });
    expect(await call('project_get', { projectId: project.id })).toMatchObject({ error: false });
    // a recipe's step runs the same tool from the registry: the same answer
    await expect(
      toolRegistry(studio)
        .get('project_get')!
        .run({ projectId: 'prj_short' } as never, recipe),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // the prompts and the project resources say the same before they ask who may read the project
    const refusal = /projectId is not a project id/;
    await expect(
      client.getPrompt({ name: 'cast_voices', arguments: { projectId: 'prj_short' } }),
    ).rejects.toThrow(refusal);
    await expect(client.readResource({ uri: 'rideo://projects/prj_short/state' })).rejects.toThrow(refusal);
    await expect(
      client.readResource({ uri: 'rideo://projects/PRJ_0123456789abcdef/timeline' }),
    ).rejects.toThrow(refusal);
  });
});
