import type {
  CharacterDescribeInput,
  CharacterDescribeOutput,
  ClipPlanInput,
  ClipPlanOutput,
  FootageAnalyzeInput,
  FootageAnalyzeOutput,
  JudgeInput,
  JudgeOutput,
  LlmCharacter,
  LlmScene,
  MediaDescribeInput,
  MediaDescribeOutput,
  ScreenplayExtendInput,
  ScreenplayExtendOutput,
  ScreenplayGenerateInput,
  ScreenplayGenerateOutput,
} from '@rideo/shared';
import { decodePng, isPng } from './png';
import { allSignatures, colorDistance, presenceRatio, type Rgb } from './signature';

/** Deterministic stand-ins for the LLM tasks (same input → same output). */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const CAST: Omit<LlmCharacter, 'role'>[] = [
  {
    name: 'Mira Vale',
    summary: 'A solitary lighthouse keeper who distrusts easy answers.',
    identity: {
      age: 'early 30s',
      gender: 'woman',
      ethnicity: 'East Asian',
      build: 'slender athletic build',
      height: '170 cm',
      face: 'oval face, high cheekbones, small scar through left eyebrow',
      hair: 'jet-black straight bob with a blunt fringe',
      eyes: 'dark brown almond eyes',
      skin: 'light olive',
      distinguishingMarks: 'silver cuff on right ear',
    },
    wardrobe: [
      { name: 'Keeper coat', description: 'charcoal wool coat over a cream knit sweater, dark trousers' },
    ],
    personality: 'dry, observant, stubborn',
    voice: 'low and measured',
  },
  {
    name: 'Jonah Reed',
    summary: 'A postman with a secret who keeps delivering letters no one sent.',
    identity: {
      age: 'late 40s',
      gender: 'man',
      ethnicity: 'Black British',
      build: 'broad, stocky build',
      height: '182 cm',
      face: 'square jaw, close-cropped grey beard, laugh lines',
      hair: 'short salt-and-pepper curls',
      eyes: 'hazel eyes',
      skin: 'deep brown',
      distinguishingMarks: 'round wire glasses',
    },
    wardrobe: [
      {
        name: 'Post uniform',
        description: 'navy postal jacket with brass buttons, grey scarf, leather satchel',
      },
    ],
    personality: 'warm, evasive',
    voice: 'gravelly, gentle',
  },
  {
    name: 'Ada Quinn',
    summary: 'A marine engineer chasing a signal from the storm.',
    identity: {
      age: 'mid 20s',
      gender: 'woman',
      ethnicity: 'Irish',
      build: 'wiry build',
      height: '165 cm',
      face: 'freckled heart-shaped face, sharp chin',
      hair: 'copper-red hair in a messy braid',
      eyes: 'green eyes',
      skin: 'fair with freckles',
      distinguishingMarks: 'grease smudge on left cheek',
    },
    wardrobe: [{ name: 'Work gear', description: 'yellow oilskin jacket, olive overalls, rubber boots' }],
    personality: 'impatient, brilliant',
    voice: 'quick and bright',
  },
];

function titleCase(words: string[]): string {
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'who',
  'about',
  'from',
  'with',
  'in',
  'on',
  'to',
  'for',
  'at',
  'by',
  'is',
  'that',
]);

function sceneFor(
  index: number,
  beat: { title: string; summary: string; estDurationSec: number },
  names: string[],
): LlmScene {
  const a = names[index % names.length]!;
  const b = names[(index + 1) % names.length]!;
  const place = ['LIGHTHOUSE LAMP ROOM', 'HARBOUR ROAD', 'POST OFFICE', 'ROCKY SHORE', 'KEEPER COTTAGE'][
    index % 5
  ]!;
  const time = index % 2 === 0 ? 'NIGHT' : 'DAY';
  return {
    beatIndex: index,
    heading: `${index % 3 === 1 ? 'EXT.' : 'INT.'} ${place} - ${time}`,
    location: place.toLowerCase(),
    timeOfDay: time.toLowerCase(),
    summary: beat.summary,
    action: `${a} and ${b} face each other as ${beat.summary.charAt(0).toLowerCase()}${beat.summary.slice(1)}`,
    dialogue: [
      { character: a, line: index === 0 ? 'Who keeps sending these?' : 'We are running out of time.' },
      {
        character: b,
        line: index === 0 ? 'Someone who already knows how this ends.' : 'Then read the next one.',
      },
    ],
    characters: [a, b],
    estDurationSec: beat.estDurationSec,
  };
}

export function screenplayGenerate(input: ScreenplayGenerateInput): ScreenplayGenerateOutput {
  const words = input.prompt
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase()));
  const title = words.length ? `The ${titleCase(words.slice(0, 2))}` : 'Untitled';
  const target = Math.max(10, input.targetDurationSec);
  const beatDur = target <= 180 ? Math.min(20, target) : 90;
  const count = Math.max(1, Math.round(target / beatDur));
  const outline = Array.from({ length: count }, (_, i) => ({
    title: i === 0 ? 'The first letter' : i === count - 1 ? 'The last letter' : `Letter ${i + 1}`,
    summary: `${i === 0 ? 'A letter from the future arrives' : i === count - 1 ? 'The final letter reveals its author' : `Letter ${i + 1} predicts the next storm`}.`,
    estDurationSec: i === count - 1 ? target - beatDur * (count - 1) : beatDur,
  }));
  const pick = hash(input.prompt) % CAST.length;
  const cast = [CAST[pick]!, CAST[(pick + 1) % CAST.length]!].map((c, i) => ({
    ...c,
    role: (i === 0 ? 'protagonist' : 'supporting') as LlmCharacter['role'],
  }));
  const names = cast.map((c) => c.name.split(' ')[0]!);
  const scenes: LlmScene[] = [];
  let covered = 0;
  for (let i = 0; i < outline.length && (covered < input.pilotDurationSec || scenes.length === 0); i++) {
    scenes.push(sceneFor(i, outline[i]!, names));
    covered += outline[i]!.estDurationSec;
  }
  return {
    title,
    logline: `${names[0]} receives letters that describe tomorrow — ${input.prompt.slice(0, 120)}`,
    synopsis: outline.map((b) => b.summary).join(' '),
    genre: 'mystery drama',
    tone: 'moody, hopeful',
    style: {
      visual: 'neo-noir realism, 35mm film grain, shallow depth of field',
      palette: 'teal shadows, amber practical lights',
      camera: 'slow deliberate moves, locked-off wides',
      lighting: 'low-key with warm practicals',
    },
    characters: cast.map((c) => ({ ...c, name: c.name.split(' ')[0]! })),
    outline,
    scenes,
    ended: true,
  };
}

export function screenplayExtend(input: ScreenplayExtendInput): ScreenplayExtendOutput {
  const names = input.characters.map((c) => c.name);
  return { scenes: input.beats.map((b) => sceneFor(b.index, b, names.length ? names : ['Someone'])) };
}

export function clipPlan(input: ClipPlanInput): ClipPlanOutput {
  const { minDurationSec: min, maxDurationSec: max } = input.limits;
  const est = Math.max(min, input.targetDurationSec || input.scene.estDurationSec);
  let n = Math.max(1, Math.ceil(est / max));
  while (n > 1 && est / n < min) n--;
  const each = Math.round((est / n) * 100) / 100;
  const names = input.characters.map((c) => c.name);
  const framings = ['wide', 'medium', 'close_up', 'over_shoulder'] as const;
  const movements = ['static', 'dolly_in', 'tracking', 'pan'] as const;
  return {
    shots: Array.from({ length: n }, (_, i) => ({
      description:
        i === 0
          ? `Establishing: ${input.scene.heading.toLowerCase()}, ${input.scene.summary}`
          : `${names[i % Math.max(1, names.length)] ?? 'The room'} reacts — ${input.scene.summary}`,
      action: i === 0 ? 'Wind moves through the space; figures hold still.' : 'A slow turn toward camera.',
      camera: { framing: framings[i % framings.length]!, movement: movements[i % movements.length]! },
      characters: i === 0 ? names : names.length ? [names[i % names.length]!] : [],
      durationSec: each,
      continuity: i > 0 && i % 2 === 1 ? ('continuous' as const) : ('cut' as const),
      dialogue: input.scene.dialogue[i] ? [input.scene.dialogue[i]!] : [],
    })),
  };
}

export function mediaDescribe(input: MediaDescribeInput): MediaDescribeOutput {
  return {
    summary: `${input.imageCount} image(s) and ${input.videoFrameCount} video frame(s) of a stormy coastline at dusk.`,
    style: 'overcast, desaturated, handheld documentary feel',
    setting: 'windswept coast with a white lighthouse',
    people: Array.from({ length: Math.min(3, input.imageCount) }, (_, i) => ({
      label: `Person ${i + 1}`,
      description: 'a figure in a dark coat looking out to sea',
      identity: { age: 'adult', build: 'average build', hair: 'dark hair' },
    })),
  };
}

export function characterDescribe(input: CharacterDescribeInput): CharacterDescribeOutput {
  const base = CAST[hash(input.name) % CAST.length]!;
  return {
    summary: `${input.name}, as seen in the uploaded photo.`,
    identity: base.identity,
    wardrobe: base.wardrobe,
  };
}

export interface LabelledImages {
  references: Map<string, Buffer[]>;
  frames: Map<number, Buffer>;
}

/** The judge: signature colours of each character's references must be visible in each frame. */
export function consistencyJudge(input: JudgeInput, images: LabelledImages): JudgeOutput {
  const sigs = new Map<string, Rgb[]>();
  for (const c of input.characters) {
    const colours: Rgb[] = [];
    for (const buf of images.references.get(c.id) ?? []) {
      if (!isPng(buf)) continue;
      for (const s of allSignatures(decodePng(buf)))
        if (!colours.some((x) => colorDistance(x, s) < 40)) colours.push(s);
    }
    sigs.set(c.id, colours.slice(0, 1));
  }
  const frames = [...images.frames.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, buf]) => {
      const img = isPng(buf) ? decodePng(buf) : null;
      return {
        index,
        characters: input.characters.map((c) => {
          const colours = sigs.get(c.id) ?? [];
          const ratio =
            img && colours.length ? Math.max(...colours.map((s) => presenceRatio(img, s, 55))) : 0;
          const present = ratio > 0.002;
          return {
            characterId: c.id,
            present,
            identityScore: present ? 0.93 : 0.1,
            outfitScore: present ? 0.9 : 0.1,
            issues: present ? [] : [`${c.name} does not match the reference (identity drift)`],
          };
        }),
      };
    });
  return { frames: frames.length ? frames : [{ index: 0, characters: [] }] };
}

export function footageAnalyze(input: FootageAnalyzeInput): FootageAnalyzeOutput {
  const suggestions: FootageAnalyzeOutput['suggestions'] = [
    {
      kind: 'title',
      text: 'Chapter One',
      start: 0,
      duration: Math.min(2.5, input.durationSec / 3),
      description: 'Open with a title card',
      rationale: 'Sets context in the first seconds.',
      confidence: 0.7,
    },
    {
      kind: 'color',
      saturation: 1.1,
      contrast: 1.05,
      description: 'Warm up the grade slightly',
      rationale: 'The footage reads flat.',
      confidence: 0.6,
    },
  ];
  for (const s of input.scenes.slice(1, 4)) {
    suggestions.push({
      kind: 'transition',
      at: s.start,
      type: 'crossfade',
      duration: 0.5,
      description: `Soften the cut at ${s.start.toFixed(1)}s`,
      rationale: 'Hard scene change.',
      confidence: 0.55,
    });
  }
  for (const seg of input.transcript.slice(0, 5)) {
    suggestions.push({
      kind: 'caption',
      start: seg.start,
      end: seg.end,
      text: seg.text,
      description: 'Caption the line',
      rationale: 'Accessibility.',
      confidence: 0.8,
    });
  }
  return {
    summary: `${Math.round(input.durationSec)}s of footage in ${input.scenes.length} scene(s) with ${input.silences.length} silence(s) and ${input.blackSegments.length} black segment(s).`,
    suggestions,
  };
}
