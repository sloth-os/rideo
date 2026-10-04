import { afterEach, describe, expect, it } from 'vitest';
import { mediaUrl } from '../src/lib/api';
import {
  apiUrl,
  appUrl,
  assetUrl,
  configureRuntime,
  documentBase,
  liveUrl,
  resetRuntime,
  routePath,
  serverUrl,
} from '../src/lib/runtime';
import { resetWorkspaceId, setWorkspaceEnabled, workspaceId } from '../src/workspace/id';

afterEach(() => {
  document.head.querySelector('base')?.remove();
  resetRuntime();
  resetWorkspaceId();
});

describe('where the studio is (docs/design/subpath.md, docs/design/embedding.md)', () => {
  it('reads the base the server wrote into the page', () => {
    expect(documentBase()).toBe('/');
    const base = document.createElement('base');
    base.href = '/rideo/';
    document.head.append(base);
    expect(documentBase()).toBe('/rideo/');
    resetRuntime();
    expect(apiUrl('/projects')).toBe('/rideo/api/projects');
    expect(assetUrl('/logo.svg')).toBe('/rideo/logo.svg');
    expect(appUrl('/login')).toBe('/rideo/login');
    expect(routePath('/rideo/p/prj_1/editor')).toBe('/p/prj_1/editor');
    expect(routePath('/rideo')).toBe('/');
    expect(routePath('/elsewhere')).toBe('/elsewhere');
    expect(liveUrl('/live')).toBe(`ws://${location.host}/rideo/api/live`);
    expect(serverUrl('mcp')).toBe(`${location.origin}/rideo/mcp`);
  });

  it('talks to a server on another origin when embedded', () => {
    configureRuntime({ apiBase: 'https://studio.example.com/rideo', routerBase: '/video/', embedded: true });
    expect(apiUrl('/config')).toBe('https://studio.example.com/rideo/api/config');
    expect(liveUrl('/live')).toBe('wss://studio.example.com/rideo/api/live');
    expect(serverUrl('/mcp')).toBe('https://studio.example.com/rideo/mcp');
    expect(appUrl('/p/prj_1')).toBe('/video/p/prj_1');
  });

  it('names this browser’s workspace on media URLs when it keeps the projects', () => {
    const id = workspaceId();
    expect(id).toMatch(/^ws_[0-9a-z]{26}$/);
    expect(workspaceId()).toBe(id);
    expect(mediaUrl('prj_1', 'media/a.mp4')).toBe('/api/projects/prj_1/media/media/a.mp4');
    setWorkspaceEnabled(true);
    expect(mediaUrl('prj_1', 'media/a.mp4')).toBe(`/api/projects/prj_1/media/media/a.mp4?ws=${id}`);
  });
});
