import type { MediaRef } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { MediaPool } from '../src/features/editor/engine/media-pool';
import { mediaUrl } from '../src/lib/api';

/** The export's media pool (docs/design/editor.md#memory) over a stand-in for mediabunny. */
const { disposed, opened } = vi.hoisted(() => ({ disposed: [] as string[], opened: [] as string[] }));
vi.mock('mediabunny', () => {
  class UrlSource {
    constructor(readonly url: string) {}
  }
  class Input {
    constructor(readonly opts: { source: UrlSource }) {
      opened.push(opts.source.url);
    }
    async getPrimaryVideoTrack() {
      return { canDecode: async () => true };
    }
    async getPrimaryAudioTrack() {
      return null;
    }
    dispose() {
      disposed.push(this.opts.source.url);
    }
  }
  class Sink {}
  return { ALL_FORMATS: [], Input, UrlSource, BlobSource: Sink, CanvasSink: Sink, AudioBufferSink: Sink };
});

describe('the media pool of an export (docs/design/editor.md#memory)', () => {
  it('keeps open only the sources a chunk shows, and opens a closed one again when asked', async () => {
    const project = 'prj_0000000000aaaaaa';
    const pool = new MediaPool(project, { width: 320, height: 180 });
    const a: MediaRef = f.media();
    const b: MediaRef = f.media();
    const c: MediaRef = f.media();
    const first = await pool.get(b);
    await Promise.all([pool.get(a), pool.get(c)]);
    expect(opened).toHaveLength(3);
    pool.retain(new Set([b.hash]));
    await vi.waitFor(() =>
      expect([...disposed].sort()).toEqual([mediaUrl(project, a.path), mediaUrl(project, c.path)].sort()),
    );
    // the kept source is the same entry; a closed one is opened again
    expect(await pool.get(b)).toBe(first);
    await pool.get(a);
    expect(opened.filter((u) => u === mediaUrl(project, a.path))).toHaveLength(2);
    pool.dispose();
  });
});
