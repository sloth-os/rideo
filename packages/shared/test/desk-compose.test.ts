import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deskHostProblem, deskOrigin, deskUrlProblem } from '../src';

/**
 * The Docker Compose files run the 3D-Editor beside the studio and point the studio at its desk
 * (docs/deployment.md#the-directors-desk). What they set must make a desk page the studio accepts, on another host
 * name than the studio's, that lets the studio frame it. The files are read as text, through the few shapes they use
 * (the repository has no YAML parser).
 */

const ROOT = resolve(import.meta.dirname, '../../..');

interface Service {
  image?: string;
  envFile: boolean;
  environment: Record<string, string>;
  ports: string[];
}

const unquote = (value: string) => value.replace(/^"(.*)"$/, '$1');

/** The services of a compose file, by indentation: two spaces per service, four per key, six per entry. */
function services(file: string): Map<string, Service> {
  const out = new Map<string, Service>();
  let inServices = false;
  let service: Service | undefined;
  let key = '';
  for (const raw of readFileSync(resolve(ROOT, file), 'utf8').split('\n')) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inServices = line === 'services:';
      service = undefined;
    } else if (inServices && indent === 2) {
      service = { envFile: false, environment: {}, ports: [] };
      out.set(line.replace(/:$/, ''), service);
    } else if (service && indent === 4) {
      const [, k = '', value = ''] = /^([\w-]+):\s*(.*)$/.exec(line) ?? [];
      key = k;
      if (key === 'image') service.image = value;
      if (key === 'env_file') service.envFile = true;
    } else if (service && indent === 6) {
      if (key === 'environment') {
        const [, name, value = ''] = /^(\w+):\s*(.*)$/.exec(line) ?? [];
        if (name) service.environment[name] = unquote(value);
      } else if (key === 'ports') service.ports.push(unquote(line.replace(/^-\s*/, '')));
    }
  }
  return out;
}

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

describe.each(['docker-compose.yml', 'docker-compose.demo.yml'])("%s runs the director's desk", (file) => {
  const all = services(file);
  const rideo = all.get('rideo');
  const editor = all.get('3d-editor');
  if (!rideo || !editor) throw new Error(`${file} has no rideo or 3d-editor service`);
  const studio = `http://localhost:${mapping(rideo.ports[0] ?? '').host}`;
  const deskUrl = whenUnset(rideo.environment.RIDEO_DESK_URL ?? '');
  const published = mapping(editor.ports[0] ?? '');

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
    expect(published.address).toBe('127.0.0.1');
    expect(url.hostname).toBe(published.address);
    expect(url.port).toBe(published.host);
    // the port the 3D-Editor's image listens on (its PORT)
    expect(published.container).toBe('8080');
  });

  it('lets only the studio, opened as the docs say, frame the desk', () => {
    expect(whenUnset(editor.environment.DESK_EMBED_ORIGINS ?? '')).toBe(deskOrigin(studio));
  });

  it("gives the 3D-Editor none of the studio's settings or secrets", () => {
    expect(editor.envFile).toBe(false);
    expect(Object.keys(editor.environment)).toEqual(['DESK_EMBED_ORIGINS']);
  });

  it('takes the desk page and the framing origins from .env, where an empty desk page leaves the desk out', () => {
    // `-`, not `:-`: an empty RIDEO_DESK_URL stays empty (no desk), an unset one is the 3D-Editor's page
    expect(rideo.environment.RIDEO_DESK_URL).toBe(`\${RIDEO_DESK_URL-${deskUrl}}`);
    expect(editor.environment.DESK_EMBED_ORIGINS).toBe(`\${DESK_EMBED_ORIGINS:-${deskOrigin(studio)}}`);
  });

  it('is what the deployment docs and the setting say', () => {
    const deployment = readFileSync(resolve(ROOT, 'docs/deployment.md'), 'utf8').replace(/\s+/g, ' ');
    expect(deployment).toContain(`\`RIDEO_DESK_URL=${deskUrl}\``);
    expect(deployment).toContain(`\`DESK_EMBED_ORIGINS=${deskOrigin(studio)}\``);
    expect(deployment).toContain(`port ${published.host} of ${published.address} only`);
    expect(deployment).toContain(`Opened at | ${studio} |`);
    const setting = readFileSync(resolve(ROOT, 'docs/design/director-desk.md'), 'utf8').replace(/\s+/g, ' ');
    expect(setting).toContain(`set it to \`${deskUrl}\` for a studio opened on \`${studio}\``);
  });
});
