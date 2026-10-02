import {
  CommentThreadSchema,
  emptyTimeline,
  type ProjectDocs,
  TimelineSchema,
  type VideoItem,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config';
import type { Deps } from '../../src/domain/deps';
import { InterchangeService } from '../../src/domain/interchange';
import { Metrics } from '../../src/metrics';

/** The interchange service's media locations and review notes (docs/design/interchange.md). */
function service(docs: ProjectDocs, env: Record<string, string> = {}) {
  const config = loadConfig({ RIDEO_PUBLIC_URL: 'https://studio.test', RIDEO_DATA_DIR: '/tmp/x', ...env });
  const metrics = new Metrics();
  const deps = {
    config,
    metrics,
    log: { info: vi.fn(), warn: vi.fn() },
    projects: { docs: async () => docs },
  } as unknown as Deps;
  return { svc: new InterchangeService(deps), metrics };
}

function project(): { docs: ProjectDocs; take: VideoItem } {
  const shot = f.readyShot([]);
  const take = shot.takes[0]!;
  const clip = f.clip({ shots: [shot] });
  const t = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const item: VideoItem = {
    id: 'itm_0000000000a1',
    kind: 'video',
    source: {
      type: 'take',
      clipId: clip.id,
      shotId: shot.id,
      takeId: take.id,
      media: { ...take.video!, durationSec: 5 },
    },
    start: 0,
    in: 0,
    out: 4,
    speed: 1,
    volume: 1,
  };
  t.tracks[0]!.items.push(item);
  const comment = (id: string, at: number | null, status: 'open' | 'resolved', body: string) =>
    CommentThreadSchema.parse({
      id,
      target: { kind: 'take', clipId: clip.id, shotId: shot.id, takeId: take.id },
      at,
      author: { kind: 'guest', id: 'rev_000000000001:ana', name: 'Ana' },
      body,
      status,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  const docs = f.docs({
    clips: { [clip.id]: clip },
    timeline: TimelineSchema.parse(t),
    comments: {
      cmt_000000000001: comment('cmt_000000000001', 2, 'open', 'Bigger logo'),
      cmt_000000000002: comment('cmt_000000000002', 1, 'resolved', 'Done already'),
      cmt_000000000003: comment('cmt_000000000003', null, 'open', 'Overall: warmer'),
    },
  });
  return { docs, take: item };
}

describe('interchange service', () => {
  it('points at the embedded or external WebDAV root by default', () => {
    const { docs } = project();
    expect(service(docs).svc.defaultMediaBase()).toBe('https://studio.test/dav/rideo');
    expect(
      service(docs, {
        RIDEO_WEBDAV_URL: 'https://cloud.test/remote.php/dav/files/me/',
        RIDEO_WEBDAV_ROOT: 'films',
      }).svc.defaultMediaBase(),
    ).toBe('https://cloud.test/remote.php/dav/files/me/films');
  });

  it('carries open, timed review notes on the takes as markers, and counts the hand-off', async () => {
    const { docs, take } = project();
    const { svc, metrics } = service(docs);
    const file = await svc.export(docs.project.id, 'otio', { mediaBase: '/Volumes/dav/rideo' });
    expect(file.filename).toMatch(/\.otio$/);
    const clip = JSON.parse(file.content).tracks.children[0].children[0];
    expect(clip.media_reference.target_url).toBe(
      `file:///Volumes/dav/rideo/projects/${docs.project.id}/${take.source.media.path}`,
    );
    expect(clip.markers.map((m: any) => [m.name, m.comment, m.marked_range.start_time.value])).toEqual([
      ['Ana', 'Bigger logo', 48],
    ]);
    expect(metrics.interchange.get({ format: 'otio', direction: 'export' })).toBe(1);
    await expect(svc.export(docs.project.id, 'edl', { source: 'animatic' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });
});
