/** Test builders shared by the shared, server and web suites (never imported by production code). */
import { newId } from '../ids';
import { characterSeed, elementSeed } from '../prompt';
import type { Character, CharacterReference } from '../schemas/character';
import type { Clip, ConsistencyReport, Shot, Take } from '../schemas/clip';
import type { MediaRef } from '../schemas/common';
import type { ProjectDocs } from '../schemas/documents';
import type { Element, ElementReference } from '../schemas/element';
import { type Project, ProjectSettingsSchema } from '../schemas/project';
import type { Screenplay } from '../schemas/screenplay';

let counter = 0;
export function fakeHash(seed = `${++counter}`): string {
  let h = '';
  let x = 0;
  for (const ch of seed) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  while (h.length < 64) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    h += x.toString(16).padStart(8, '0');
  }
  return h.slice(0, 64);
}

export function media(overrides: Partial<MediaRef> = {}): MediaRef {
  const hash = overrides.hash ?? fakeHash();
  return {
    path: `media/takes/${hash.slice(0, 12)}.mp4`,
    hash,
    mime: 'video/mp4',
    size: 1000,
    width: 320,
    height: 180,
    durationSec: 5,
    hasAudio: true,
    ...overrides,
  };
}

export function imageMedia(overrides: Partial<MediaRef> = {}): MediaRef {
  const hash = overrides.hash ?? fakeHash();
  return {
    path: `media/refs/${hash.slice(0, 12)}.png`,
    hash,
    mime: 'image/png',
    size: 500,
    width: 256,
    height: 256,
    ...overrides,
  };
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    id: newId('project'),
    kind: 'story',
    title: 'Test Film',
    createdAt: '2026-09-30T00:00:00.000Z',
    brief: { prompt: 'A lighthouse keeper receives letters from the future.', attachmentResourceIds: [] },
    settings: ProjectSettingsSchema.parse({ targetDurationSec: 60, pilotDurationSec: 10 }),
    workflow: { stage: 'brief', approvals: {} },
    ...overrides,
  };
}

export function reference(overrides: Partial<CharacterReference> = {}): CharacterReference {
  return {
    id: newId('reference'),
    view: 'front',
    media: imageMedia(),
    source: 'generated',
    approved: true,
    createdAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

export function character(overrides: Partial<Character> = {}): Character {
  const id = overrides.id ?? newId('character');
  return {
    id,
    name: 'Mira',
    role: 'protagonist',
    summary: 'A lighthouse keeper.',
    identity: {
      age: 'early 30s',
      gender: 'woman',
      ethnicity: 'East Asian',
      build: 'slender athletic build',
      face: 'oval face, high cheekbones, small scar through left eyebrow',
      hair: 'jet-black straight bob with blunt fringe',
      eyes: 'dark brown almond eyes',
      skin: 'light olive',
    },
    wardrobe: [
      {
        id: newId('wardrobe'),
        name: 'Field jacket',
        description: 'charcoal field jacket over a white t-shirt',
        default: true,
      },
    ],
    references: [reference()],
    seed: characterSeed(id),
    lock: { locked: true, version: 1, lockedAt: '2026-09-30T00:00:00.000Z' },
    ...overrides,
  };
}

export function elementReference(overrides: Partial<ElementReference> = {}): ElementReference {
  return {
    id: newId('reference'),
    view: 'establishing',
    media: imageMedia(),
    source: 'generated',
    approved: true,
    createdAt: '2026-09-30T00:00:00.000Z',
    ...overrides,
  };
}

/** A locked location with one approved reference (pass `kind`, `lock` or `references` to vary it). */
export function element(overrides: Partial<Element> = {}): Element {
  const id = overrides.id ?? newId('element');
  return {
    id,
    kind: 'location',
    name: 'Lamp room',
    description: 'circular brass-framed lantern room, salt-crusted windows',
    aliases: [],
    references: [elementReference()],
    seed: elementSeed(id),
    lock: { locked: true, version: 1, lockedAt: '2026-09-30T00:00:00.000Z' },
    ...overrides,
  };
}

export function report(overrides: Partial<ConsistencyReport> = {}): ConsistencyReport {
  return {
    status: 'passed',
    judge: 'test',
    threshold: 0.75,
    score: 0.9,
    attempts: 1,
    checkedAt: '2026-09-30T00:00:00.000Z',
    characters: [],
    elements: [],
    voices: [],
    frames: [],
    ...overrides,
  };
}

export function take(overrides: Partial<Take> = {}): Take {
  return {
    id: newId('take'),
    createdAt: '2026-09-30T00:00:00.000Z',
    keyframe: null,
    video: media(),
    lastFrame: null,
    request: {
      prompt: 'p',
      seed: 1,
      durationSec: 5,
      firstFrameSource: 'keyframe',
      referenceCount: 1,
      lastFrameSource: null,
      motionReference: null,
      multiShot: null,
    },
    gatewayTaskIds: [],
    endKeyframe: null,
    variation: 0,
    derivedFrom: null,
    consistency: report(),
    characterLocks: {},
    elementLocks: {},
    audio: null,
    watermarkId: null,
    contentCredentials: null,
    override: null,
    durationSec: 5,
    ...overrides,
  };
}

export function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: newId('shot'),
    index: 0,
    description: 'Mira climbs the lighthouse stairs.',
    action: 'She climbs, breathing hard.',
    camera: { framing: 'medium', movement: 'tracking' },
    characterIds: [],
    elementIds: [],
    wardrobe: {},
    dialogue: [],
    durationSec: 5,
    continuity: 'cut',
    promptOverride: null,
    negativePrompt: null,
    startFrame: { mode: 'auto', resourceId: null },
    endFrame: { mode: 'none', description: '', resourceId: null },
    motionReference: null,
    seed: null,
    status: 'planned',
    takes: [],
    selectedTakeId: null,
    board: null,
    lastError: null,
    ...overrides,
  };
}

/** A shot with one selected, passing take for the given characters. */
export function readyShot(characters: Character[], overrides: Partial<Shot> = {}): Shot {
  const t = take({ characterLocks: Object.fromEntries(characters.map((c) => [c.id, c.lock.version])) });
  return shot({
    characterIds: characters.map((c) => c.id),
    takes: [t],
    selectedTakeId: t.id,
    status: 'ready',
    ...overrides,
  });
}

export function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: newId('clip'),
    index: 0,
    sceneId: null,
    title: 'Clip 1',
    status: 'planned',
    shots: [],
    approvedAt: null,
    approvedBy: null,
    notes: '',
    ...overrides,
  };
}

export function screenplay(overrides: Partial<Screenplay> = {}): Screenplay {
  return {
    title: 'The Keeper',
    logline: 'A keeper and the future.',
    synopsis: '',
    genre: 'drama',
    tone: 'moody',
    language: 'en',
    style: {
      visual: 'neo-noir, 35mm film grain',
      palette: 'teal and amber',
      camera: 'slow, deliberate',
      lighting: 'low key',
    },
    outline: [],
    scenes: [],
    ended: true,
    ...overrides,
  };
}

export function docs(overrides: Partial<ProjectDocs> = {}): ProjectDocs {
  return {
    project: project(),
    screenplay: null,
    timeline: null,
    animatic: null,
    characters: {},
    elements: {},
    clips: {},
    resources: {},
    analyses: {},
    exports: {},
    ...overrides,
  };
}

export function byId<T extends { id: string }>(items: T[]): Record<string, T> {
  return Object.fromEntries(items.map((i) => [i.id, i]));
}
