import { X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Reader } from '@contentauth/c2pa-node';
import type { Resource } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevSigner } from '../../src/provenance/dev-cert';
import { startEditorWorker } from '../helpers/editor-worker';
import { makeFootage } from '../helpers/media';
import { type Stack, startStack } from '../helpers/stack';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/**
 * Provenance (docs/design/provenance.md): C2PA manifests on exports, the disclosure label, consent records and
 * the public detection tool. Generated takes are covered by the story test.
 */

const PROBE = {
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 9,
  hasVideo: true,
  hasAudio: true,
  width: 320,
  height: 180,
  fps: 24,
  videoCodec: 'h264',
  audioCodec: 'aac',
};

async function uploadFootage(stack: Stack, projectId: string): Promise<Resource> {
  const form = new FormData();
  form.set('meta', JSON.stringify({ probe: PROBE }));
  const file = await makeFootage(stack.dataDir);
  form.set('file', new Blob([await readFile(file)], { type: 'video/mp4' }), 'holiday.mp4');
  return stack.api<Resource>('POST', `/projects/${projectId}/uploads`, form);
}

describe('development C2PA signer', () => {
  it('builds a CA-issued leaf that node:crypto verifies', () => {
    const dev = createDevSigner('Rideo');
    const [leafPem] = dev.chainPem.split(/(?<=-----END CERTIFICATE-----\n)/);
    const leaf = new X509Certificate(leafPem!);
    const ca = new X509Certificate(dev.caPem);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.4']);
    expect(leaf.subject).toContain('CN=Rideo Studio (development)');
    expect(dev.keyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });
});

describe('export provenance', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('signs a footage export as a composite of its sources and burns in the policy label', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Holiday',
      settings: {
        resolution: { width: 320, height: 180 },
        disclosure: { label: 'always', text: 'Synthetic media' },
      },
    });
    const source = await uploadFootage(stack, p.id);
    expect(source.status).toBe('ready');
    const timeline = await stack.api<any>('GET', `/projects/${p.id}/timeline`);
    await stack.api('POST', `/projects/${p.id}/timeline/ops`, {
      ops: [
        {
          op: 'insert',
          trackId: timeline.tracks[0].id,
          item: {
            kind: 'video',
            source: { type: 'media', media: source.media, resourceId: source.id },
            in: 0,
            out: 3,
          },
        },
      ],
    });
    const editor = await startEditorWorker(stack, p.id);
    const exp = await stack.api<any>('POST', `/projects/${p.id}/exports`, { quality: 'draft' });
    expect(exp.export.disclosure).toEqual({
      label: true,
      text: 'Synthetic media',
      position: 'top_right',
      reason: 'policy',
    });
    expect(exp.job.params.disclosure).toEqual({ text: 'Synthetic media', position: 'top_right' });
    const done = await stack.waitExport(p.id, exp.export.id);
    await editor.stop();
    expect(done.status).toBe('succeeded');
    expect(done.contentCredentials).toMatchObject({
      manifest: expect.stringMatching(/^urn:c2pa:/),
      ingredients: 1,
    });

    const detect = await stack.api<any>('POST', '/watermark/detect', {
      projectId: p.id,
      mediaPath: done.media.path,
    });
    expect(detect.found).toBe(true);
    expect(detect.contentCredentials).toMatchObject({
      present: true,
      state: 'valid',
      issues: [],
      signedByThisStudio: true,
      aiGenerated: false,
      digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/composite',
      actions: ['c2pa.created', 'c2pa.placed', 'c2pa.watermarked'],
      ingredients: 1,
      watermarkId: done.watermarkId,
      bound: true,
      disclosure: { label: true, text: 'Synthetic media', reason: 'policy' },
    });

    // The manifest is standard C2PA: the SDK reads the same store, and the dev CA makes it trusted.
    const local = join(stack.dataDir, 'export-check.mp4');
    const res = await fetch(`${stack.url}/api/projects/${p.id}/media/${done.media.path}`);
    await writeFile(local, Buffer.from(await res.arrayBuffer()));
    const ca = await readFile(join(stack.dataDir, 'c2pa', 'ca.pem'), 'utf8');
    const reader = await Reader.fromAsset(
      { path: local, mimeType: 'video/mp4' },
      new Context({ trust: { trustAnchors: ca } }),
    );
    expect((reader!.json() as { validation_state: string }).validation_state).toBe('Trusted');
  });

  it('requires a consent record for uploaded likenesses', async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', { kind: 'story', title: 'Consent' });
    const c = await stack.api<{ id: string }>('POST', `/projects/${p.id}/characters`, { name: 'Ada' });
    const upload = (consent?: object) => {
      const form = new FormData();
      form.set('view', 'front');
      if (consent) form.set('consent', JSON.stringify(consent));
      form.set('file', new Blob([PNG], { type: 'image/png' }), 'ada.png');
      return stack.api<any>('POST', `/projects/${p.id}/characters/${c.id}/references`, form);
    };
    await expect(upload()).rejects.toMatchObject({ status: 422, body: { code: 'consent_required' } });
    await expect(upload({ depictsRealPerson: true, subject: 'Ada Lovelace' })).rejects.toMatchObject({
      body: { code: 'consent_required', errors: ['grantedBy', 'grantedAt'] },
    });
    const ok = await upload({
      depictsRealPerson: true,
      subject: 'Ada Lovelace',
      grantedBy: 'Ada Lovelace',
      grantedAt: '2026-09-30',
      scope: 'this production',
    });
    expect(ok.references[0].consent).toMatchObject({
      depictsRealPerson: true,
      subject: 'Ada Lovelace',
      recordedBy: { kind: 'user' },
    });
  });
});

describe('the public detection tool', () => {
  let stack: Stack;
  const TOKEN = 'provenance-secret';
  beforeAll(async () => {
    stack = await startStack({ env: { RIDEO_API_TOKEN: TOKEN, RIDEO_PUBLIC_DETECT_MAX_BYTES: '2000000' } });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it('accepts uploads without the token and keeps project details private', async () => {
    const studio = stack.server.studio;
    const input = await makeFootage(stack.dataDir);
    const signed = join(stack.dataDir, 'signed.mp4');
    await studio.deps.c2pa.signTake({
      input,
      output: signed,
      title: 'take.mp4',
      projectId: 'prj_publicdetect01',
      asset: { clipId: 'clp_publicdetect01', shotId: 'sht_publicdetect01', takeId: 'tak_publicdetect01' },
      watermarkId: null,
      models: { videoModel: 'mock-video-v1' },
      consistency: { status: 'passed', score: 0.9, judge: 'test' },
    });
    const form = new FormData();
    form.set('file', new Blob([await readFile(signed)], { type: 'video/mp4' }), 'take.mp4');
    const res = await fetch(`${stack.url}/api/watermark/detect`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.found).toBe(false);
    expect(body.contentCredentials).toMatchObject({
      present: true,
      aiGenerated: true,
      digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
      actions: ['c2pa.created'],
      signedByThisStudio: true,
      watermarkId: null,
    });

    // Fetching media for someone, or anything else, still needs the token.
    const byUri = await fetch(`${stack.url}/api/watermark/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uri: 'https://example.com/x.mp4' }),
    });
    expect(byUri.status).toBe(401);
    expect((await fetch(`${stack.url}/api/projects`)).status).toBe(401);
    const authed = await fetch(`${stack.url}/api/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authed.status).toBe(200);

    // Public uploads are capped.
    const big = new FormData();
    big.set('file', new Blob([Buffer.alloc(2_500_000)], { type: 'video/mp4' }), 'big.mp4');
    const tooBig = await fetch(`${stack.url}/api/watermark/detect`, { method: 'POST', body: big });
    expect(tooBig.status).toBe(422);
  });
});
