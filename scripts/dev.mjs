#!/usr/bin/env node
// Development runner: the Rideo server (tsx watch) and the Vite dev server, plus the mock mm-gateway
// with --demo (fully offline). Ctrl-C stops everything.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const demo = process.argv.includes('--demo');
const root = new URL('..', import.meta.url).pathname;
const colors = { gateway: 35, server: 36, web: 33 };

const env = { ...process.env };
if (existsSync(`${root}.env`) && !demo) {
  try {
    process.loadEnvFile(`${root}.env`);
    Object.assign(env, process.env);
  } catch {
    // unreadable .env: environment only
  }
}
if (demo) {
  const gatewayPort = env.MOCK_GATEWAY_PORT ?? '8790';
  Object.assign(env, {
    MOCK_GATEWAY_PORT: gatewayPort,
    MM_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
    MM_GATEWAY_API_KEY: '',
    RIDEO_LLM_PROVIDER: 'openai',
    RIDEO_LLM_PROXY_DOMAIN: 'api.openai.com',
    RIDEO_GATEWAY_POLL_MS: env.RIDEO_GATEWAY_POLL_MS ?? '500',
    RIDEO_DATA_DIR: env.RIDEO_DATA_DIR ?? `${root}data-demo`,
    RIDEO_WEB_DIST: `${root}packages/web/no-dist`,
  });
}

const children = [];
let stopping = false;

function run(name, command, args) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${colors[name]}m${name.padEnd(7)}\x1b[0m│ `;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
  }
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`${prefix}exited (${signal ?? code}); stopping`);
    stop(code ?? 1);
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (demo) run('gateway', 'npx', ['tsx', 'packages/mock-gateway/src/main.ts']);
run('server', 'npx', ['tsx', 'watch', '--clear-screen=false', 'packages/server/src/main.ts']);
run('web', 'npm', ['run', 'dev', '-w', '@rideo/web', '--', '--host', env.RIDEO_WEB_HOST ?? '127.0.0.1']);
console.log(
  `Rideo dev${demo ? ' (demo: mock mm-gateway)' : ''}: open http://localhost:5173 · MCP http://localhost:8787/mcp`,
);
