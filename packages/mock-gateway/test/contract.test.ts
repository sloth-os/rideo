import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ClipPlanOutputSchema,
  FocusOutputSchema,
  FrameCaptionOutputSchema,
  INPUT_PREFIX,
  JUDGE_FRAME_LABEL,
  JUDGE_REFERENCE_LABEL,
  JudgeOutputSchema,
  ScorePlanOutputSchema,
  ScreenplayGenerateOutputSchema,
  SfxPlanOutputSchema,
  ThumbnailPickOutputSchema,
  TranslateOutputSchema,
} from '@rideo/shared';
import MmGateway from '@sloth-os/mm-gateway-js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningMockGateway, startMockGateway } from '../src';
import { encodePng } from '../src/png';

const spec = JSON.parse(
  readFileSync(join(import.meta.dirname, '../openapi/mm-gateway.openapi.json'), 'utf8'),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'mmg', components: spec.components });

function expectSchema(name: string, data: unknown) {
  const validate = ajv.getSchema(`mmg#/components/schemas/${name}`)!;
  const ok = validate(data);
  if (!ok)
    throw new Error(
      `${name} invalid: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(data).slice(0, 500)}`,
    );
}

let gw: RunningMockGateway;

beforeAll(async () => {
  gw = await startMockGateway({ latencyMs: 40, apiKey: 'test-key' });
});
afterAll(async () => {
  await gw.close();
});

const auth = { authorization: 'Bearer test-key', 'content-type': 'application/json' };

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${gw.url}${path}`, {
    method: 'POST',
    headers: { ...auth, ...headers },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as any };
}

async function waitTask(path: string): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const res = await fetch(`${gw.url}${path}`, { headers: auth });
    const json = (await res.json()) as any;
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(json.status)) return json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('task did not finish');
}

async function chat(task: string, input: unknown, extra: object[] = []) {
  const { json } = await post('/proxy/api.openai.com/v1/chat/completions', {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: `rideo-task: ${task}\nReturn JSON.` },
      {
        role: 'user',
        content: [{ type: 'text', text: `${INPUT_PREFIX}${JSON.stringify(input)}` }, ...extra],
      },
    ],
  });
  return JSON.parse(json.choices[0].message.content);
}

describe('public contract', () => {
  it('lists models and limits per modality', async () => {
    const models = (await (
      await fetch(`${gw.url}/v1/models?modality=video`, { headers: auth })
    ).json()) as any;
    expectSchema('ModelListResponse', models);
    expect(models.data.map((m: any) => m.id)).toEqual([
      'mock-video-v1',
      'mock-video-lite-v1',
      'mock-multishot-v1',
      'mock-enhance-v1',
      'mock-segment-v1',
      'mock-lipsync-v1',
    ]);
    const limits = (await (await fetch(`${gw.url}/v1/models/limits`, { headers: auth })).json()) as any;
    expectSchema('ModelLimitsListResponse', limits);
    expect(limits.data.find((m: any) => m.id === 'mock-video-v1').limits.max_duration_seconds).toBe(10);
    // a segmentation model (docs/design/editor.md#segmentation-masks-remove-the-background)
    expect(limits.data.find((m: any) => m.id === 'mock-segment-v1').limits.supports_segmentation).toBe(true);
  });

  it('runs an image task with Location, ETag and 304 revalidation', async () => {
    const { res, json } = await post('/v1/images', {
      input: [{ type: 'text', text: 'a lighthouse at night' }],
      parameters: { dimensions: { width: 128, height: 96 }, output_count: 1 },
    });
    expect(res.status).toBe(202);
    expect(res.headers.get('location')).toBe(`${gw.url}/v1/images/${json.id}`);
    expectSchema('ImageTaskResponse', json);
    const done = await waitTask(`/v1/images/${json.id}`);
    expectSchema('ImageTaskResponse', done);
    expect(done.status).toBe('succeeded');
    const png = Buffer.from(await (await fetch(done.outputs[0].uri)).arrayBuffer());
    expect(png.readUInt32BE(0)).toBe(0x89504e47);
    const first = await fetch(`${gw.url}/v1/images/${json.id}`, { headers: auth });
    const again = await fetch(`${gw.url}/v1/images/${json.id}`, {
      headers: { ...auth, 'if-none-match': first.headers.get('etag')! },
    });
    expect(again.status).toBe(304);
  });

  it('runs video and music tasks that produce real media', async () => {
    const { json } = await post('/v1/videos', {
      input: [{ type: 'text', text: 'waves' }],
      parameters: { duration_seconds: 2, dimensions: { width: 160, height: 96 }, include_audio: true },
    });
    const video = await waitTask(`/v1/videos/${json.id}`);
    expectSchema('VideoTaskResponse', video);
    const mp4 = Buffer.from(await (await fetch(video.outputs[0].uri)).arrayBuffer());
    expect(mp4.subarray(4, 8).toString()).toBe('ftyp');
    const music = await post('/v1/music', {
      input: [{ type: 'text', text: 'calm piano' }],
      parameters: { duration_seconds: 5 },
    });
    const done = await waitTask(`/v1/music/${music.json.id}`);
    expectSchema('MusicTaskResponse', done);
    expect(done.outputs[0].mime_type).toBe('audio/mpeg');
  });

  it('rejects unknown fields, parts and roles with problem details', async () => {
    for (const body of [
      { input: [{ type: 'text', text: 'x' }], provider: 'openai' },
      { input: [{ type: 'text', text: 'x' }], parameters: { size: '1024x1024' } },
      { input: [] },
      { input: [{ type: 'image', uri: 'https://x/a.png', role: 'first_frame' }] },
    ]) {
      const { res, json } = await post('/v1/images', body);
      expect(res.status).toBe(422);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expectSchema('ProblemDetail', json);
      expect(json.code).toBe('validation_error');
    }
  });

  it('replays idempotent creates and rejects key reuse with another body', async () => {
    const body = {
      input: [{ type: 'text', text: 'same' }],
      parameters: { dimensions: { width: 64, height: 64 } },
    };
    const a = await post('/v1/images', body, { 'idempotency-key': 'k1' });
    const b = await post('/v1/images', body, { 'idempotency-key': 'k1' });
    expect(b.json.id).toBe(a.json.id);
    const c = await post(
      '/v1/images',
      { ...body, parameters: { dimensions: { width: 96, height: 64 } } },
      { 'idempotency-key': 'k1' },
    );
    expect(c.res.status).toBe(409);
  });

  it('requires the bearer key', async () => {
    const res = await fetch(`${gw.url}/v1/models`);
    expect(res.status).toBe(401);
    expect((await fetch(`${gw.url}/health`)).status).toBe(200);
  });
});

describe('SDK compatibility (@sloth-os/mm-gateway-js)', () => {
  it('creates and polls tasks through the generated client', async () => {
    const client = new MmGateway.ApiClient(gw.url);
    client.authentications.BearerAuth.accessToken = 'test-key';
    const images = new MmGateway.ImagesApi(client);
    const created = await images.createImageWithHttpInfo(
      { input: [{ type: 'text', text: 'sdk image' }], parameters: { dimensions: { width: 64, height: 64 } } },
      { idempotencyKey: 'sdk-1' },
    );
    expect(created.response.status).toBe(202);
    expect(created.data.id).toMatch(/^img_/);
    let task = created.data;
    for (let i = 0; i < 200 && !['succeeded', 'failed'].includes(task.status); i++) {
      await new Promise((r) => setTimeout(r, 30));
      task = await images.getImage(task.id);
    }
    expect(task.status).toBe('succeeded');
    expect(task.outputs?.[0]?.uri).toContain('/files/');
    const meta = new MmGateway.MetaApi(client);
    const limits = await meta.listModelLimits({ modality: 'image' });
    expect(limits.data[0]?.id).toBe('mock-image-v1');
  });
});

describe('deterministic consistency model', () => {
  async function generate(path: string, body: unknown) {
    const { json } = await post(path, body);
    const done = await waitTask(`${path}/${json.id}`);
    return Buffer.from(await (await fetch(done.outputs[0].uri)).arrayBuffer());
  }

  it('copies reference signatures into keyframes and the judge detects drift', async () => {
    const ref = await generate('/v1/images', {
      input: [
        {
          type: 'text',
          text: 'Character reference sheet, front view; neutral background, no text. Mira: early 30s woman.',
        },
      ],
      parameters: { dimensions: { width: 128, height: 128 } },
    });
    const dataUri = `data:image/png;base64,${ref.toString('base64')}`;
    const keyframe = await generate('/v1/images', {
      input: [
        { type: 'text', text: 'Mira at the window' },
        { type: 'image', uri: dataUri },
      ],
      parameters: { dimensions: { width: 160, height: 96 } },
    });
    const drifted = await generate('/v1/images', {
      input: [
        { type: 'text', text: 'Mira at the window' },
        { type: 'image', uri: dataUri },
      ],
      parameters: { dimensions: { width: 160, height: 96 } },
      metadata: { mock_flaky: true },
    });
    const img = (buf: Buffer) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${buf.toString('base64')}` },
    });
    const verdict = JudgeOutputSchema.parse(
      await chat(
        'consistency.judge',
        {
          characters: [{ id: 'chr_mira', name: 'Mira', identity: '', referenceCount: 1 }],
          frameCount: 2,
          shotDescription: 'x',
        },
        [
          { type: 'text', text: `${JUDGE_REFERENCE_LABEL} chr_mira (Mira):` },
          img(ref),
          { type: 'text', text: `${JUDGE_FRAME_LABEL} 0:` },
          img(keyframe),
          { type: 'text', text: `${JUDGE_FRAME_LABEL} 1:` },
          img(drifted),
        ],
      ),
    );
    expect(verdict.frames[0]!.characters[0]).toMatchObject({ present: true });
    expect(verdict.frames[1]!.characters[0]).toMatchObject({ present: false });
  });
});

describe('proxy LLM formats', () => {
  const input = {
    prompt: 'A lighthouse keeper receives letters from the future',
    targetDurationSec: 60,
    pilotDurationSec: 20,
    language: 'en',
    aspectRatio: '16:9',
    attachments: [],
  };

  it('answers OpenAI, Gemini and Anthropic shapes with schema-valid JSON', async () => {
    const openai = ScreenplayGenerateOutputSchema.parse(await chat('screenplay.generate', input));
    expect(openai.outline.reduce((s, b) => s + b.estDurationSec, 0)).toBe(60);
    expect(openai.scenes.length).toBeGreaterThan(0);
    const gem = await post(
      '/proxy/generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent',
      {
        systemInstruction: { parts: [{ text: 'rideo-task: clip.plan' }] },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${INPUT_PREFIX}${JSON.stringify({ scene: { heading: 'INT. ROOM', summary: 's', action: 'a', dialogue: [], estDurationSec: 18 }, characters: [{ name: 'Mira', summary: '' }], style: '', limits: { minDurationSec: 2, maxDurationSec: 10 }, targetDurationSec: 18 })}`,
              },
            ],
          },
        ],
      },
    );
    const plan = ClipPlanOutputSchema.parse(JSON.parse(gem.json.candidates[0].content.parts[0].text));
    expect(plan.shots.reduce((s, x) => s + x.durationSec, 0)).toBeCloseTo(18);
    const claude = await post('/proxy/api.anthropic.com/v1/messages', {
      model: 'claude-test',
      max_tokens: 1000,
      system: 'rideo-task: screenplay.generate',
      messages: [
        { role: 'user', content: [{ type: 'text', text: `${INPUT_PREFIX}${JSON.stringify(input)}` }] },
        { role: 'assistant', content: '{' },
      ],
    });
    expect(ScreenplayGenerateOutputSchema.parse(JSON.parse(`{${claude.json.content[0].text}`)).title).toBe(
      openai.title,
    );
  });
});

describe('post audio (docs/design/post-audio.md#mock-gateway)', () => {
  it('plans a cue per scene and a spot effect per shot', async () => {
    const score = ScorePlanOutputSchema.parse(
      await chat('score.plan', {
        film: { title: 'T', logline: '', genre: 'drama', tone: 'melancholic', style: '' },
        direction: 'sparse piano',
        cues: [
          {
            index: 0,
            durationSec: 12,
            heading: 'INT. LIGHTHOUSE - NIGHT',
            summary: '',
            action: '',
            dialogue: true,
          },
          {
            index: 1,
            durationSec: 9,
            heading: 'EXT. CLIFF - DAWN',
            summary: '',
            action: '',
            dialogue: false,
          },
        ],
      }),
    );
    expect(score.cues.map((c) => c.index)).toEqual([0, 1]);
    expect(score.cues[0]!.prompt).toContain('INT. LIGHTHOUSE - NIGHT');
    expect(score.cues[0]!.prompt).toContain('sparse piano');
    const sfx = SfxPlanOutputSchema.parse(
      await chat('sfx.plan', {
        maxPerShot: 3,
        shots: [{ index: 0, durationSec: 5, description: 'd', action: 'The door slams shut.', location: '' }],
      }),
    );
    expect(sfx.effects).toEqual([
      { shot: 0, description: 'the sound of the door slams shut', at: 1.5, durationSec: 2, kind: 'spot' },
    ]);
  });

  it('translates every line with the language marker (docs/design/localization.md#mock-gateway)', async () => {
    const out = TranslateOutputSchema.parse(
      await chat('dialogue.translate', {
        language: 'es',
        languageName: 'Spanish',
        film: { title: 'T', logline: '', tone: '' },
        characters: [{ name: 'Mira', summary: '' }],
        scene: 'INT. LIGHTHOUSE - NIGHT',
        lines: [{ key: 'sht_0000000001:0', speaker: 'Mira', text: 'Who writes?' }],
      }),
    );
    expect(out.lines).toEqual([{ key: 'sht_0000000001:0', text: '«es» Who writes?' }]);
  });

  it('finds the subject and ranks thumbnails by saturation (docs/design/finishing.md#mock-gateway)', async () => {
    // grey frames with a saturated patch on the right (frame 0) or on the left (frame 1)
    const frame = (right: boolean, patch: number) => {
      const width = 40;
      const height = 20;
      const data = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const inPatch = (right ? x >= width - patch : x < patch) && y < patch;
          data.set(inPatch ? [220, 30, 30, 255] : [120, 120, 120, 255], i);
        }
      return encodePng({ width, height, data });
    };
    const image = (png: Buffer) => ({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
    });
    const focus = FocusOutputSchema.parse(
      await chat(
        'reframe.focus',
        {
          shot: 's',
          characters: [],
          frames: [
            { index: 0, t: 0 },
            { index: 1, t: 1 },
          ],
        },
        [image(frame(true, 8)), image(frame(false, 8))],
      ),
    );
    expect(focus.frames[0]!.x).toBeGreaterThan(0.8);
    expect(focus.frames[1]!.x).toBeLessThan(0.2);
    expect(focus.frames[0]!.y).toBeLessThan(0.3);
    const picks = ThumbnailPickOutputSchema.parse(
      await chat(
        'thumbnail.pick',
        {
          title: 't',
          count: 1,
          frames: [
            { index: 0, t: 0 },
            { index: 1, t: 1 },
          ],
        },
        [image(frame(true, 2)), image(frame(false, 12))],
      ),
    );
    expect(picks.picks.map((p) => p.index)).toEqual([1]);
  });

  it('upscales and interpolates a reference video with the enhancement model', async () => {
    const { json } = await post('/v1/videos', {
      input: [{ type: 'text', text: 'waves' }],
      parameters: { duration_seconds: 2, dimensions: { width: 160, height: 96 } },
    });
    const source = await waitTask(`/v1/videos/${json.id}`);
    const mp4 = Buffer.from(await (await fetch(source.outputs[0].uri)).arrayBuffer());
    const enhanced = await post('/v1/videos', {
      model: 'mock-enhance-v1',
      input: [
        { type: 'text', text: 'Enhance' },
        { type: 'video', uri: `data:video/mp4;base64,${mp4.toString('base64')}`, role: 'reference_video' },
      ],
      parameters: { dimensions: { width: 320, height: 192 }, fps: 48 },
    });
    const done = await waitTask(`/v1/videos/${enhanced.json.id}`);
    expect(done.status).toBe('succeeded');
    const out = Buffer.from(await (await fetch(done.outputs[0].uri)).arrayBuffer());
    const { execFileSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = join(tmpdir(), `mock-enhanced-${enhanced.json.id}.mp4`);
    writeFileSync(path, out);
    const probe = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height,r_frame_rate',
        '-of',
        'json',
        path,
      ]).toString(),
    ).streams[0];
    expect(probe).toMatchObject({ width: 320, height: 192, r_frame_rate: '48/1' });
  });

  it('generates a sound effect of the asked length through the ElevenLabs proxy', async () => {
    const res = await fetch(
      `${gw.url}/proxy/api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ text: 'a door slams', duration_seconds: 1.5 }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    const bad = await post('/proxy/api.elevenlabs.io/v1/sound-generation', { duration_seconds: 1 });
    expect(bad.res.status).toBe(422);
  });
});

describe('semantic search (docs/design/search.md#mock-gateway)', () => {
  const solid = (rgb: [number, number, number]) => {
    const data = Buffer.alloc(16 * 8 * 4);
    for (let i = 0; i < 16 * 8; i++) data.set([...rgb, 255], i * 4);
    return {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${encodePng({ width: 16, height: 8, data }).toString('base64')}`,
      },
    };
  };

  it('captions a frame by its colour and light, naming who the input says it shows', async () => {
    const night = FrameCaptionOutputSchema.parse(
      await chat(
        'frame.caption',
        { kind: 'take', known: [{ name: 'Mira', description: '' }], cast: ['Mira'] },
        [solid([0, 0, 96])],
      ),
    );
    expect(night.caption).toBe('Mira in a blue scene at night, medium shot.');
    const day = FrameCaptionOutputSchema.parse(
      await chat('frame.caption', { kind: 'footage', known: [], cast: [] }, [solid([250, 240, 10])]),
    );
    expect(day.caption).toBe('A yellow scene in bright daylight, wide shot.');
  });

  it('embeds texts in order, synonyms close together', async () => {
    const { res, json } = await post('/proxy/api.openai.com/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: ['crimson at night', 'A red scene at night, still frame.', 'A yellow scene in bright daylight.'],
    });
    expect(res.status).toBe(200);
    expect(json.data.map((d: { index: number }) => d.index)).toEqual([0, 1, 2]);
    const [q, red, yellow] = json.data.map((d: { embedding: number[] }) => d.embedding);
    const dot = (a: number[], b: number[]) => a.reduce((n, x, i) => n + x * b[i]!, 0);
    expect(dot(q, red)).toBeGreaterThan(0.6);
    expect(dot(q, yellow)).toBeLessThan(0.2);
    expect((await post('/proxy/api.openai.com/v1/embeddings', { input: [] })).res.status).toBe(400);
  });
});
