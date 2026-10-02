import { type MediaRef, TimelineSchema, toFcpxml, toXmeml, type VideoItem } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { interchangeUrl, setToken } from '../src/lib/api';

/** The XML formats parse as XML (docs/design/interchange.md), whatever the titles and labels hold. */
function cut() {
  const m = (name: string): MediaRef =>
    f.media({ path: `media/takes/${name}.mp4`, durationSec: 6, hasAudio: true });
  const items: VideoItem[] = [
    {
      id: 'itm_0000000000a1',
      kind: 'video',
      source: { type: 'media', media: m('a') },
      start: 0,
      in: 0,
      out: 3,
      speed: 1,
      volume: 1,
      label: 'Mira & <Jonah> "at sea"',
    },
    {
      id: 'itm_0000000000a2',
      kind: 'video',
      source: { type: 'media', media: m('b') },
      start: 2.5,
      in: 1,
      out: 4,
      speed: 2,
      volume: 0.5,
      transitionIn: { type: 'dip_to_black', duration: 0.5 },
    },
  ];
  return TimelineSchema.parse({
    version: 1,
    fps: 25,
    width: 1280,
    height: 720,
    tracks: [
      { id: 'trk_primaryvideo01', kind: 'video', name: 'Video', items },
      {
        id: 'trk_titles00000001',
        kind: 'text',
        name: 'Titles',
        items: [
          {
            id: 'itm_0000000000t1',
            kind: 'text',
            start: 0,
            duration: 2,
            text: "L'été — <1984> & co",
            style: { preset: 'lower_third' },
          },
        ],
      },
    ],
  });
}
const ctx = {
  title: 'Seaside & <sons>',
  mediaUrl: (m: MediaRef) => `file:///Volumes/dav/rideo/projects/prj_000000000001/${m.path}`,
  notes: () => [{ at: 1, author: 'Ana "the client"', body: 'Logo <bigger> & brighter' }],
};
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

describe('interchange XML', () => {
  afterEach(() => setToken(null));

  it('FCPXML is well-formed and keeps the text it carries', () => {
    const doc = parse(toFcpxml(cut(), ctx));
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.getAttribute('version')).toBe('1.10');
    expect(doc.querySelector('project')?.getAttribute('name')).toBe('Seaside & <sons>');
    expect([...doc.querySelectorAll('spine > asset-clip')].map((c) => c.getAttribute('name'))).toEqual([
      'Mira & <Jonah> "at sea"',
      'b.mp4',
    ]);
    expect(doc.querySelector('spine > transition')?.getAttribute('name')).toBe('Dip to Black');
    expect(doc.querySelector('title text-style')?.textContent).toBe("L'été — <1984> & co");
    expect(doc.querySelector('marker')?.getAttribute('value')).toBe(
      'Ana "the client": Logo <bigger> & brighter',
    );
  });

  it('Final Cut Pro 7 XML is well-formed, with each file described once', () => {
    const doc = parse(toXmeml(cut(), ctx));
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.querySelector('sequence > name')?.textContent).toBe('Seaside & <sons>');
    expect(doc.querySelectorAll('file > pathurl')).toHaveLength(2);
    expect(doc.querySelector('transitionitem effect name')?.textContent).toBe('Dip to Color Dissolve');
    expect(doc.querySelector('clipitem marker comment')?.textContent).toBe('Logo <bigger> & brighter');
    expect(doc.querySelectorAll('audio > track > clipitem')).toHaveLength(2);
  });

  it('builds download URLs with the media location, the source and the token', () => {
    expect(interchangeUrl('prj_000000000001', 'otio')).toBe(
      '/api/projects/prj_000000000001/interchange.otio',
    );
    setToken('t0k');
    expect(
      interchangeUrl('prj_000000000001', 'fcpxml', { mediaBase: ' /Volumes/dav/rideo ', source: 'animatic' }),
    ).toBe(
      '/api/projects/prj_000000000001/interchange.fcpxml?mediaBase=%2FVolumes%2Fdav%2Frideo&source=animatic&token=t0k',
    );
  });
});
