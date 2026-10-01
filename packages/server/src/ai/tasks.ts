import {
  type CharacterDescribeInput,
  type CharacterDescribeOutput,
  CharacterDescribeOutputSchema,
  type ClipPlanInput,
  type ClipPlanOutput,
  ClipPlanOutputSchema,
  type FootageAnalyzeInput,
  type FootageAnalyzeOutput,
  FootageAnalyzeOutputSchema,
  INPUT_PREFIX,
  JUDGE_ELEMENT_REFERENCE_LABEL,
  JUDGE_FRAME_LABEL,
  JUDGE_REFERENCE_LABEL,
  type JudgeInput,
  type JudgeOutput,
  JudgeOutputSchema,
  type LlmTaskId,
  type MediaDescribeInput,
  type MediaDescribeOutput,
  MediaDescribeOutputSchema,
  type ScreenplayExtendInput,
  type ScreenplayExtendOutput,
  ScreenplayExtendOutputSchema,
  type ScreenplayGenerateInput,
  type ScreenplayGenerateOutput,
  ScreenplayGenerateOutputSchema,
} from '@rideo/shared';
import type { z } from 'zod';
import { AppError } from '../errors';
import type { Metrics } from '../metrics';
import type { LlmAdapter, LlmPart } from './llm';

const IDENTITY_TEMPLATE =
  '{"age":"early 30s","gender":"woman","ethnicity":"...","build":"...","height":"...","face":"...","hair":"...","eyes":"...","skin":"...","distinguishingMarks":"..."}';

/** System prompts. The first line is the machine-readable task marker (also routed on by the mock gateway). */
export const SYSTEM_PROMPTS: Record<LlmTaskId, string> = {
  'media.describe': `rideo-task: media.describe
You are a film pre-production assistant. Describe the attached reference images (and video frames) so a screenwriter and a cast designer can use them.
Return only JSON: {"summary":"...","style":"visual style, lighting, palette","setting":"...","people":[{"label":"Person 1","description":"...","identity":${IDENTITY_TEMPLATE}}]}`,

  'screenplay.generate': `rideo-task: screenplay.generate
You are an award-winning screenwriter planning a film that will be generated shot by shot by AI video models.
Rules:
- Write in the requested language.
- "outline" must plan the WHOLE film: the sum of outline[].estDurationSec must be within 5% of targetDurationSec. Use beats of 60–180 s for long films and 10–30 s for short ones.
- Write full "scenes" only for the first outline beats, enough to cover at least pilotDurationSec. Each scene has beatIndex = index of the outline beat it realizes.
- "characters": 1–6 principal characters with precise, visual, stable identities (age, gender, ethnicity, build, height, face, hair, eyes, skin, distinguishing marks) and at least one wardrobe item. Never depict real people.
- Scenes: vivid visual action, short cinematic dialogue, characters listed by name.
- "locations": every distinct place of the WHOLE film (all outline beats, not only the written scenes), each with a precise visual description (architecture, materials, light); each scene's "location" is one of these names. "props": the recurring objects of the whole film that must look the same every time (name + precise visual description); each scene lists the props it shows in "props".
- "style": concrete visual language (film stock/lens, palette, lighting, camera movement).
- Use the attachment descriptions as inspiration for the look and the cast.
Return only JSON: {"title":"...","logline":"...","synopsis":"...","genre":"...","tone":"...","style":{"visual":"...","palette":"...","camera":"...","lighting":"..."},"characters":[{"name":"...","role":"protagonist|antagonist|supporting|minor","summary":"...","identity":${IDENTITY_TEMPLATE},"wardrobe":[{"name":"...","description":"..."}],"personality":"...","voice":"..."}],"locations":[{"name":"...","description":"..."}],"props":[{"name":"...","description":"..."}],"outline":[{"title":"...","summary":"...","estDurationSec":90}],"scenes":[{"beatIndex":0,"heading":"INT. PLACE - NIGHT","location":"location name","timeOfDay":"...","summary":"...","action":"...","dialogue":[{"character":"Name","line":"...","parenthetical":"..."}],"characters":["Name"],"props":["prop name"],"estDurationSec":90}],"ended":true}`,

  'screenplay.extend': `rideo-task: screenplay.extend
You are the screenwriter continuing an AI-generated film. Write one full scene for each requested outline beat, in order, consistent with the story so far, the cast (use only these names) and the tone.
Each scene's beatIndex must equal the beat's index and estDurationSec should match the beat estimate.
Reuse the names in "locations" and "props" for places and objects the story already has; list only new places and objects (name + precise visual description) in the answer's "locations" and "props".
Return only JSON: {"scenes":[{"beatIndex":0,"heading":"INT. PLACE - NIGHT","location":"location name","timeOfDay":"...","summary":"...","action":"...","dialogue":[{"character":"Name","line":"..."}],"characters":["Name"],"props":["prop name"],"estDurationSec":90}],"locations":[{"name":"...","description":"..."}],"props":[{"name":"...","description":"..."}]}`,

  'clip.plan': `rideo-task: clip.plan
You are a director breaking one scene into shots for an AI video model.
Rules:
- Every shot durationSec must be within [limits.minDurationSec, limits.maxDurationSec]; the shot durations should sum to targetDurationSec.
- A shot is one continuous camera setup: describe what is visible in the first frame ("description") and what moves ("action").
- "characters": names of the characters visible in the shot (only from the cast list).
- "props": names of the scene's props visible in the shot (only from scene.props).
- Use "continuity":"continuous" only when the shot continues the previous shot's final frame without a cut; the first shot is always "cut".
- camera.framing: extreme_wide|wide|medium|medium_close|close_up|extreme_close_up|over_shoulder|pov|insert; camera.movement: static|pan|tilt|dolly_in|dolly_out|tracking|handheld|crane|zoom|orbit.
Return only JSON: {"shots":[{"description":"...","action":"...","camera":{"framing":"wide","movement":"static"},"characters":["Name"],"props":["prop name"],"durationSec":6,"continuity":"cut","dialogue":[{"character":"Name","line":"..."}]}]}`,

  'character.describe': `rideo-task: character.describe
You are a cast designer. Describe the person in the photo as a stable, visual identity for AI image generation. Do not identify real people by name.
Return only JSON: {"summary":"...","identity":${IDENTITY_TEMPLATE},"wardrobe":[{"name":"...","description":"..."}]}`,

  'consistency.judge': `rideo-task: consistency.judge
You are a strict continuity supervisor verifying character identity in AI-generated film frames.
For every candidate frame and every character, compare the frame against that character's reference images:
- present: is this character visible in the frame?
- identityScore (0–1): same person? Judge face shape, features, hair, skin, age, build. 1 = certainly the same person, below 0.5 = different person.
- outfitScore (0–1): same wardrobe as the references?
- issues: short concrete differences (e.g. "hair is blonde instead of black").
Be critical: different faces, age changes, or hair changes must score low.
When the input lists "elements" (locations and props), also judge each one per frame against its reference images: present (is it visible?), score (0–1: the same place or object, same design, materials and colours), issues.
Return only JSON: {"frames":[{"index":0,"characters":[{"characterId":"...","present":true,"identityScore":0.9,"outfitScore":0.9,"issues":[]}],"elements":[{"elementId":"...","present":true,"score":0.9,"issues":[]}]}]}`,

  'footage.analyze': `rideo-task: footage.analyze
You are a senior film editor. From the footage statistics, scene thumbnails and transcript, summarize the footage and suggest concrete edits.
Allowed suggestion kinds and fields (times in seconds of the source video):
- {"kind":"cut","start":0,"end":1}
- {"kind":"tighten_silence","start":0,"end":1,"keepSec":0.4}
- {"kind":"highlight","segments":[{"start":0,"end":1}],"targetDurationSec":60}
- {"kind":"transition","at":12.5,"type":"crossfade|wipe|dip_to_black","duration":0.5}
- {"kind":"title","text":"...","start":0,"duration":2}
- {"kind":"caption","start":0,"end":2,"text":"..."}
- {"kind":"speed","start":0,"end":4,"factor":1.5}
- {"kind":"fade","in":0.5,"out":1}
- {"kind":"color","brightness":0,"contrast":1.05,"saturation":1.1}
Each suggestion also has "description", "rationale" and "confidence" (0–1).
Return only JSON: {"summary":"...","suggestions":[{"kind":"cut","start":0,"end":1,"description":"...","rationale":"...","confidence":0.8}]}`,
};

export interface LabelledImage {
  label?: string;
  data: Buffer;
  mime: string;
}

/** Extracts the JSON object from a model answer (tolerates code fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('no JSON object in the answer');
  }
}

function tryParse<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const res = schema.safeParse(extractJson(text));
    if (res.success) return { ok: true, value: res.data };
    return {
      ok: false,
      error: res.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Structured LLM tasks with schema validation and one repair round (docs/design/ai-gateway.md#structured-tasks). */
export class LlmTasks {
  constructor(
    readonly text: LlmAdapter,
    readonly vision: LlmAdapter,
    private readonly deps: { metrics?: Metrics; log?: { info: (o: unknown, m?: string) => void } } = {},
  ) {}

  async run<T>(
    task: LlmTaskId,
    schema: z.ZodType<T>,
    input: object,
    opts: { images?: LabelledImage[]; temperature?: number; signal?: AbortSignal; maxTokens?: number } = {},
  ): Promise<T> {
    const adapter = opts.images?.length ? this.vision : this.text;
    const parts: LlmPart[] = [{ type: 'text', text: `${INPUT_PREFIX}${JSON.stringify(input)}` }];
    for (const img of opts.images ?? []) {
      if (img.label) parts.push({ type: 'text', text: img.label });
      parts.push({ type: 'image', data: img.data, mime: img.mime });
    }
    const started = performance.now();
    const temperature = opts.temperature ?? 0.7;
    let res = await adapter.complete({
      system: SYSTEM_PROMPTS[task],
      parts,
      json: true,
      temperature,
      signal: opts.signal,
      maxTokens: opts.maxTokens,
    });
    let parsed = tryParse(schema, res.text);
    if (!parsed.ok) {
      this.deps.log?.info({ task, error: parsed.error }, 'LLM output invalid, repairing');
      res = await adapter.complete({
        system: SYSTEM_PROMPTS[task],
        parts: [
          ...parts,
          {
            type: 'text',
            text: `Your previous answer did not match the required JSON shape (${parsed.error}). Previous answer:\n${res.text.slice(0, 12000)}\nReturn the corrected JSON only.`,
          },
        ],
        json: true,
        temperature: 0,
        signal: opts.signal,
        maxTokens: opts.maxTokens,
      });
      parsed = tryParse(schema, res.text);
      if (!parsed.ok) {
        this.deps.metrics?.llmCalls.inc({ task, status: 'invalid' });
        throw new AppError('llm_invalid_output', `${task}: ${parsed.error}`, [], true);
      }
    }
    this.deps.metrics?.llmCalls.inc({ task, status: 'ok' });
    this.deps.log?.info(
      {
        task,
        provider: adapter.provider,
        model: adapter.model,
        ms: Math.round(performance.now() - started),
        usage: res.usage,
      },
      'LLM task completed',
    );
    return parsed.value;
  }

  describeMedia(
    input: MediaDescribeInput,
    images: LabelledImage[],
    signal?: AbortSignal,
  ): Promise<MediaDescribeOutput> {
    return this.run('media.describe', MediaDescribeOutputSchema, input, { images, temperature: 0.3, signal });
  }

  generateScreenplay(
    input: ScreenplayGenerateInput,
    signal?: AbortSignal,
  ): Promise<ScreenplayGenerateOutput> {
    return this.run('screenplay.generate', ScreenplayGenerateOutputSchema, input, {
      temperature: 0.8,
      signal,
      maxTokens: 16000,
    });
  }

  extendScreenplay(input: ScreenplayExtendInput, signal?: AbortSignal): Promise<ScreenplayExtendOutput> {
    return this.run('screenplay.extend', ScreenplayExtendOutputSchema, input, {
      temperature: 0.8,
      signal,
      maxTokens: 16000,
    });
  }

  planClip(input: ClipPlanInput, signal?: AbortSignal): Promise<ClipPlanOutput> {
    return this.run('clip.plan', ClipPlanOutputSchema, input, { temperature: 0.5, signal });
  }

  describeCharacter(
    input: CharacterDescribeInput,
    image: LabelledImage,
    signal?: AbortSignal,
  ): Promise<CharacterDescribeOutput> {
    return this.run('character.describe', CharacterDescribeOutputSchema, input, {
      images: [image],
      temperature: 0.2,
      signal,
    });
  }

  judge(
    input: JudgeInput,
    references: Map<string, Buffer[]>,
    frames: Buffer[],
    signal?: AbortSignal,
  ): Promise<JudgeOutput> {
    const images: LabelledImage[] = [];
    // Characters, then elements (docs/design/elements.md#prompt-and-references), each labelled with its id.
    const owners = [
      ...input.characters.map((c) => ({ id: c.id, name: c.name, label: JUDGE_REFERENCE_LABEL })),
      ...(input.elements ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        label: JUDGE_ELEMENT_REFERENCE_LABEL,
      })),
    ];
    for (const o of owners) {
      (references.get(o.id) ?? []).forEach((data, i) => {
        images.push({
          label: i === 0 ? `${o.label} ${o.id} (${o.name}):` : undefined,
          data,
          mime: 'image/png',
        });
      });
    }
    for (const [i, data] of frames.entries())
      images.push({ label: `${JUDGE_FRAME_LABEL} ${i}:`, data, mime: 'image/png' });
    return this.run('consistency.judge', JudgeOutputSchema, input, { images, temperature: 0, signal });
  }

  analyzeFootage(
    input: FootageAnalyzeInput,
    thumbnails: LabelledImage[],
    signal?: AbortSignal,
  ): Promise<FootageAnalyzeOutput> {
    return this.run('footage.analyze', FootageAnalyzeOutputSchema, input, {
      images: thumbnails,
      temperature: 0.4,
      signal,
    });
  }
}
