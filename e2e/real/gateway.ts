import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GATEWAY_KEY_ENV, gatewayConfig, type RealEnv, SECRET_ENV } from './env';

const run = promisify(execFile);

export interface RealGateway {
  url: string;
  apiKey: string;
  /** Saves the gateway's log and removes its container (nothing for a gateway the suite did not start). */
  stop(): Promise<void>;
}

/**
 * The log without the keys: the gateway masks a credential to its first and last four characters, and CI uploads
 * the log, so neither form of a key the suite holds may stay in it.
 */
export function redactKeys(text: string, keys: (string | undefined)[]): string {
  let out = text;
  for (const key of keys) {
    if (!key || key.length < 8) continue;
    out = out
      .split(key)
      .join('***')
      .split(`${key.slice(0, 4)}...${key.slice(-4)}`)
      .join('***');
  }
  return out;
}

async function docker(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await run('docker', args, { env, maxBuffer: 256 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * mm-gateway for the real-model suite (docs/testing.md#real-models-e2ereal): the published image with the suite's
 * configuration, or the gateway at MM_GATEWAY_URL. The keys reach the container as environment variables named by
 * the configuration, never on a command line or in a file.
 */
export async function startRealGateway(
  env: RealEnv,
  opts: { port: number; dir: string; logFile: string; log: (line: string) => void },
): Promise<RealGateway> {
  if (env.MM_GATEWAY_URL) {
    opts.log(`using the gateway at ${env.MM_GATEWAY_URL}`);
    return { url: env.MM_GATEWAY_URL, apiKey: env.MM_GATEWAY_API_KEY ?? '', stop: async () => undefined };
  }
  const apiKey = `rideo-real-${randomBytes(18).toString('hex')}`;
  const config = join(opts.dir, 'mm-gateway.yaml');
  // JSON is YAML; the container's user reads it, so it is world-readable (it holds no key).
  await writeFile(config, `${JSON.stringify(gatewayConfig(env), null, 2)}\n`, { mode: 0o644 });
  opts.log(`pulling ${env.MM_GATEWAY_IMAGE}`);
  await docker(['pull', '--quiet', env.MM_GATEWAY_IMAGE]);
  // A run that was killed leaves its gateway on the port behind.
  const stale = await docker(['ps', '--all', '--quiet', '--filter', `publish=${opts.port}`]).catch(() => '');
  if (stale) await docker(['rm', '--force', ...stale.split('\n')]);
  const name = `rideo-real-gateway-${process.pid}`;
  await docker(
    [
      'run',
      '--detach',
      '--name',
      name,
      '--publish',
      `127.0.0.1:${opts.port}:8000`,
      '--volume',
      `${config}:/etc/mm-gateway/config.yaml:ro`,
      '--env',
      'MM_GATEWAY_CONFIG=/etc/mm-gateway/config.yaml',
      ...[...SECRET_ENV, GATEWAY_KEY_ENV].flatMap((n) => ['--env', n]),
      env.MM_GATEWAY_IMAGE,
    ],
    { ...process.env, [GATEWAY_KEY_ENV]: apiKey },
  );
  const url = `http://127.0.0.1:${opts.port}`;
  const stop = async () => {
    const logs = await run('docker', ['logs', name], { maxBuffer: 256 * 1024 * 1024 }).catch(
      (err: { stdout?: string; stderr?: string }) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
    );
    const keys = [...SECRET_ENV.map((n) => process.env[n]), apiKey];
    await writeFile(opts.logFile, redactKeys(`${logs.stdout}${logs.stderr}`, keys)).catch(() => undefined);
    await docker(['rm', '--force', name]).catch(() => undefined);
  };
  const deadline = Date.now() + 120_000;
  while (true) {
    const health = await fetch(`${url}/health`).catch(() => null);
    if (health?.ok) break;
    const running = await docker(['inspect', '--format', '{{.State.Running}}', name]).catch(() => 'false');
    if (running !== 'true' || Date.now() > deadline) {
      await stop();
      throw new Error(`mm-gateway did not start (its log: ${opts.logFile})`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  opts.log(`mm-gateway ${env.MM_GATEWAY_IMAGE} on ${url} (container ${name})`);
  return { url, apiKey, stop };
}
