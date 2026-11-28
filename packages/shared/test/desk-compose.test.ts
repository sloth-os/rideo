import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deskHostProblem, deskOrigin, deskUrlProblem } from '../src';

/**
 * The Docker Compose files run the 3D-Editor beside the studio and point the studio at its desk
 * (docs/deployment.md#the-directors-desk). What they set must make a desk page the studio accepts, on another host
 * name than the studio's, that lets the studio frame it, while the 3D-Editor gets nothing of the studio's and keeps
 * what the desk does not need closed. The files are read as text, through the few shapes they use (the repository has
 * no YAML parser); the reader refuses a key given twice, as Compose does.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

interface Service {
  image?: string;
  envFile: boolean;
  environment: Record<string, string>;
  ports: string[];
  volumes: string[];
  networks: string[];
}

interface Compose {
  services: Map<string, Service>;
  /** Top-level `volumes:` and `networks:` names. */
  volumes: string[];
  networks: string[];
}

const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1');

/**
 * A compose file's services and top-level names, by indentation: two spaces per service or top-level name, four per
 * key of a service, six per entry of a key. A key given twice in the same mapping throws.
 */
function parseCompose(text: string): Compose {
  const out: Compose = { services: new Map(), volumes: [], networks: [] };
  let top = '';
  let service: Service | undefined;
  let serviceKeys = new Set<string>();
  let key = '';
  const once = (seen: Set<string>, name: string, where: string) => {
    if (seen.has(name)) throw new Error(`mapping key "${name}" already defined in ${where}`);
    seen.add(name);
  };
  const topKeys = new Set<string>();
  let names = new Set<string>();
  for (const raw of text.split('\n')) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      top = line.replace(/:.*$/, '');
      once(topKeys, top, 'the file');
      service = undefined;
      names = new Set();
    } else if (indent === 2) {
      const name = line.replace(/:.*$/, '');
      once(names, name, top);
      if (top === 'services') {
        service = {
          envFile: false,
          environment: {},
          ports: [],
          volumes: [],
          networks: [],
        };
        serviceKeys = new Set();
        out.services.set(name, service);
      } else if (top === 'volumes') out.volumes.push(name);
      else if (top === 'networks') out.networks.push(name);
    } else if (service && indent === 4) {
      const [, k = '', value = ''] = /^([\w-]+):\s*(.*)$/.exec(line) ?? [];
      key = k;
      once(serviceKeys, key, 'a service');
      if (key === 'image') service.image = value;
      if (key === 'env_file') service.envFile = true;
    } else if (service && indent === 6) {
      const entry = unquote(line.replace(/^-\s*/, ''));
      if (key === 'environment') {
        const [, name, value = ''] = /^(\w+):\s*(.*)$/.exec(line) ?? [];
        if (name) {
          if (name in service.environment)
            throw new Error(`mapping key "${name}" already defined in environment`);
          service.environment[name] = unquote(value);
        }
      } else if (key === 'ports') service.ports.push(entry);
      else if (key === 'volumes') service.volumes.push(entry);
      else if (key === 'networks') service.networks.push(entry);
    }
  }
  return out;
}

const compose = (file: string) => parseCompose(readFileSync(resolve(ROOT, file), 'utf8'));

/** What compose makes of `${NAME-default}` or `${NAME:-default}` when NAME is not set. */
function whenUnset(value: string): string {
  return /^\$\{\w+:?-(.*)\}$/.exec(value)?.[1] ?? value;
}

/** The host address, host port and container port of a `[address:]host:container` mapping. */
function mapping(value: string) {
  const parts = value.split(':');
  return parts.length === 3
    ? { address: parts[0], host: parts[1], container: parts[2] }
    : { address: undefined, host: parts[0], container: parts[1] };
}

describe('the compose reader', () => {
  it('refuses a key given twice, as Compose does', () => {
    const service = (env: string) =>
      `services:\n  a:\n    image: x\n    environment:\n      ONE: "1"\n${env}`;
    expect(() => parseCompose(service('      ONE: "2"\n'))).toThrow(/ONE/);
    expect(() => parseCompose('services:\n  a:\n    image: x\n    image: y\n')).toThrow(/image/);
    expect(() => parseCompose('services:\n  a:\n    image: x\n  a:\n    image: y\n')).toThrow(/"a"/);
    expect(() => parseCompose('volumes:\n  v:\nvolumes:\n  w:\n')).toThrow(/volumes/);
    expect(parseCompose(service('      TWO: "2"\n')).services.get('a')?.environment).toEqual({
      ONE: '1',
      TWO: '2',
    });
  });
});

describe.each(['docker-compose.yml', 'docker-compose.demo.yml'])("%s runs the director's desk", (file) => {
  const all = compose(file);
  const rideo = all.services.get('rideo');
  const editor = all.services.get('3d-editor');
  if (!rideo || !editor) throw new Error(`${file} has no rideo or 3d-editor service`);
  const studio = `http://localhost:${mapping(rideo.ports[0] ?? '').host}`;
  const deskUrl = whenUnset(rideo.environment.RIDEO_DESK_URL ?? '');
  const published = mapping(editor.ports[0] ?? '');
  const others = [...all.services].filter(([name]) => name !== '3d-editor').map(([, s]) => s);

  it("runs the 3D-Editor's image from GHCR, which another image can replace", () => {
    expect(editor.image).toBe(`\${DESK_IMAGE:-ghcr.io/sloth-os/3d-editor:latest}`);
  });

  it("points the studio at a desk page it accepts, on another host name than the studio's", () => {
    expect(studio).toBe('http://localhost:8787');
    expect(deskUrlProblem(deskUrl)).toBeNull();
    // what the server checks with accounts on (RIDEO_OIDC_ISSUER): the studio's session cookie must not reach the desk
    expect(deskHostProblem(deskUrl, studio)).toBeNull();
    expect(new URL(deskUrl).pathname).toBe('/desk.html');
  });

  it("publishes the 3D-Editor at the desk page's address and port, on 127.0.0.1 only", () => {
    const url = new URL(deskUrl);
    expect(editor.ports.length).toBeGreaterThan(0);
    for (const port of editor.ports) expect(mapping(port).address).toBe('127.0.0.1');
    expect(url.hostname).toBe(published.address);
    expect(url.port).toBe(published.host);
    // the port the 3D-Editor's image listens on (its PORT)
    expect(published.container).toBe('8080');
  });

  it('lets only the studio, opened as the docs say, frame the desk', () => {
    expect(whenUnset(editor.environment.DESK_EMBED_ORIGINS ?? '')).toBe(deskOrigin(studio));
  });

  it("gives the 3D-Editor none of the studio's settings, secrets, volumes or network", () => {
    expect(editor.envFile).toBe(false);
    expect(Object.keys(editor.environment).sort()).toEqual([
      'AUTH_TOKEN',
      'DESK_EMBED_ORIGINS',
      'MCP_ENABLED',
    ]);
    // one named volume of its own, declared in the file and mounted by no other service
    expect(editor.volumes).toHaveLength(1);
    const [own = '', target] = (editor.volumes[0] ?? '').split(':');
    expect(target).toBe('/data');
    expect(all.volumes).toContain(own);
    for (const service of others) expect(service.volumes.map((v) => v.split(':')[0])).not.toContain(own);
    // a network of its own, declared in the file, that no other service joins (they stay on the default one)
    expect(editor.networks).toEqual(['desk']);
    expect(all.networks).toContain('desk');
    for (const service of others) expect(service.networks).toEqual([]);
  });

  it("keeps what the desk does not need closed: the 3D-Editor's MCP endpoint off, its token from .env", () => {
    expect(editor.environment.MCP_ENABLED).toBe(`\${DESK_MCP_ENABLED:-false}`);
    expect(whenUnset(editor.environment.MCP_ENABLED ?? '')).toBe('false');
    // `-`: unset or empty, no token (the 3D-Editor then needs none); set on a server
    expect(editor.environment.AUTH_TOKEN).toBe(`\${DESK_AUTH_TOKEN-}`);
  });

  it('takes the desk page and the framing origins from .env, where an empty desk page hands it to Settings', () => {
    // `-`, not `:-`: an empty RIDEO_DESK_URL stays empty (the setting's own value then), an unset one is the
    // 3D-Editor's page
    expect(rideo.environment.RIDEO_DESK_URL).toBe(`\${RIDEO_DESK_URL-${deskUrl}}`);
    expect(editor.environment.DESK_EMBED_ORIGINS).toBe(`\${DESK_EMBED_ORIGINS:-${deskOrigin(studio)}}`);
  });

  it('is what the deployment docs and the setting say', () => {
    const deployment = readFileSync(resolve(ROOT, 'docs/deployment.md'), 'utf8').replace(/\s+/g, ' ');
    expect(deployment).toContain(`\`RIDEO_DESK_URL=${deskUrl}\``);
    expect(deployment).toContain(`\`DESK_EMBED_ORIGINS=${deskOrigin(studio)}\``);
    expect(deployment).toContain(`port ${published.host} of ${published.address} only`);
    expect(deployment).toContain(`Opened at | ${studio} |`);
    expect(deployment).toContain('`DESK_MCP_ENABLED=true` turns it on');
    expect(deployment).toContain('pass `DESK_AUTH_TOKEN` as its `AUTH_TOKEN`');
    expect(deployment).toContain('runs on a network of its own (`desk`)');
    expect(deployment).toContain('`docker compose pull 3d-editor && docker compose up -d 3d-editor`');
    const setting = readFileSync(resolve(ROOT, 'docs/design/director-desk.md'), 'utf8').replace(/\s+/g, ' ');
    expect(setting).toContain(`set it to \`${deskUrl}\` for a studio opened on \`${studio}\``);
  });
});
