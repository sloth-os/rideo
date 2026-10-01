import type { ConsistencyReport } from '@rideo/shared';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, GeminiAdapter, type LlmRequest, OpenAiAdapter } from '../../src/ai/llm';
import { SfxClient } from '../../src/ai/sfx';
import { alignedWords, ElevenLabsTts, OpenAiTts } from '../../src/ai/tts';
import { type VoiceJudge, verifyVoices } from '../../src/consistency/voice';
import type { ProxyClient } from '../../src/gateway/proxy-client';
import { Metrics } from '../../src/metrics';

/** Records proxy calls and answers each path from a table (docs/design/dialogue.md#providers). */
class FakeProxy {
  calls: { domain: string; path: string; body: any; form?: FormData }[] = [];
  constructor(private readonly replies: Record<string, () => Response>) {}
  async fetch(domain: string, path: string, init: RequestInit) {
    const form = init.body instanceof FormData ? init.body : undefined;
    this.calls.push({ domain, path, body: form ? null : JSON.parse(String(init.body)), form });
    const key = Object.keys(this.replies).find((k) => path.startsWith(k));
    return key ? this.replies[key]!() : new Response('{"detail":"no"}', { status: 404 });
  }
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const endpoint = (provider: 'elevenlabs' | 'openai') =>
  provider === 'elevenlabs'
    ? { provider, domain: 'api.elevenlabs.io', model: 'eleven_multilingual_v2' }
    : { provider, domain: 'api.openai.com', model: 'gpt-4o-mini-tts' };

describe('ElevenLabs through the gateway proxy', () => {
  const audio = Buffer.from('mp3-bytes');
  const proxy = new FakeProxy({
    'v1/text-to-voice/design': () =>
      json({
        previews: [
          { audio_base_64: audio.toString('base64'), generated_voice_id: 'g1', media_type: 'audio/mpeg' },
          { audio_base_64: audio.toString('base64'), generated_voice_id: 'g2', media_type: 'audio/mpeg' },
        ],
        text: 'x',
      }),
    'v1/text-to-voice': () => json({ voice_id: 'v-saved' }),
    'v1/voices/add': () => json({ voice_id: 'v-clone', requires_verification: false }),
    'v1/text-to-speech/': () =>
      json({
        audio_base64: audio.toString('base64'),
        alignment: {
          characters: ['H', 'i'],
          character_start_times_seconds: [0.12, 0.3],
          character_end_times_seconds: [0.3, 0.55],
        },
      }),
  });
  const metrics = new Metrics();
  const tts = new ElevenLabsTts(proxy as unknown as ProxyClient, endpoint('elevenlabs'), metrics);

  it('designs previews from a padded description; short text lets the provider write it', async () => {
    const previews = await tts.design({ description: 'gravelly', text: 'Hello.', seed: 7 });
    expect(previews).toEqual([
      { voiceId: 'g1', audio, mime: 'audio/mpeg' },
      { voiceId: 'g2', audio, mime: 'audio/mpeg' },
    ]);
    const call = proxy.calls.at(-1)!;
    expect([call.domain, call.path]).toEqual([
      'api.elevenlabs.io',
      'v1/text-to-voice/design?output_format=mp3_44100_128',
    ]);
    expect(call.body).toMatchObject({
      model_id: 'eleven_multilingual_ttv_v2',
      auto_generate_text: true,
      seed: 7,
    });
    expect(call.body.voice_description.length).toBeGreaterThanOrEqual(20);
    expect(call.body.text).toBeUndefined();
    await tts.design({ description: 'a warm alto with a coastal accent', text: 'y'.repeat(150), seed: 1 });
    expect(proxy.calls.at(-1)!.body).toMatchObject({ text: 'y'.repeat(150) });
  });

  it('saves a preview, clones a recording and speaks with timings and a seed (V3)', async () => {
    expect(await tts.save({ previewVoiceId: 'g1', name: 'Mira', description: '' })).toBe('v-saved');
    expect(proxy.calls.at(-1)!.body).toMatchObject({ voice_name: 'Mira', generated_voice_id: 'g1' });
    expect(
      await tts.clone({ name: 'Ada', audio: Buffer.from('wav'), filename: 'ada.wav', mime: 'audio/wav' }),
    ).toBe('v-clone');
    const form = proxy.calls.at(-1)!.form!;
    expect(form.get('name')).toBe('Ada');
    expect((form.get('files') as File).name).toBe('ada.wav');
    const speech = await tts.speak({ voiceId: 'v 1', text: 'Hi', seed: 42, description: '', language: 'en' });
    expect(speech).toEqual({
      audio,
      mime: 'audio/mpeg',
      span: { start: 0.12, end: 0.55 },
      // words for animated captions (docs/design/localization.md)
      words: [{ text: 'Hi', start: 0.12, end: 0.55 }],
    });
    expect(
      alignedWords(
        [' ', 'N', 'o', ',', ' ', 'y', 'o', 'u', '.'],
        [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
      ),
    ).toEqual([
      { text: 'No,', start: 0.1, end: 0.4 },
      { text: 'you.', start: 0.5, end: 0.9 },
    ]);
    const call = proxy.calls.at(-1)!;
    expect(call.path).toBe('v1/text-to-speech/v%201/with-timestamps?output_format=mp3_44100_128');
    // multilingual v2 detects the language itself; only turbo/flash take language_code
    expect(call.body).toEqual({ text: 'Hi', model_id: 'eleven_multilingual_v2', seed: 42 });
    expect(metrics.ttsCharacters.get({ provider: 'elevenlabs' })).toBe(2);
    expect(metrics.tts.get({ provider: 'elevenlabs', op: 'speak', outcome: 'ok' })).toBe(1);
  });

  it('turns upstream failures into retryable gateway errors', async () => {
    const failing = new ElevenLabsTts(
      new FakeProxy({ 'v1/text-to-speech/': () => json({ detail: 'busy' }, 429) }) as unknown as ProxyClient,
      endpoint('elevenlabs'),
      metrics,
    );
    await expect(failing.speak({ voiceId: 'v', text: 'x', seed: 1, description: '' })).rejects.toMatchObject({
      code: 'gateway_error',
      retryable: true,
    });
    expect(metrics.tts.get({ provider: 'elevenlabs', op: 'speak', outcome: 'error' })).toBe(1);
  });
});

describe('sound effects through the gateway proxy (docs/design/post-audio.md)', () => {
  it('asks ElevenLabs sound generation for the length and counts outcomes', async () => {
    const mp3 = Buffer.alloc(2048, 7);
    const proxy = new FakeProxy({
      'v1/sound-generation': () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }),
    });
    const metrics = new Metrics();
    const sfx = new SfxClient(
      proxy as unknown as ProxyClient,
      { provider: 'elevenlabs', domain: 'api.elevenlabs.io', model: 'eleven_text_to_sound_v2' },
      metrics,
    );
    const out = await sfx.generate({ text: 'a door slams in a stone hallway', durationSec: 31 });
    expect(out).toEqual({ audio: mp3, mime: 'audio/mpeg' });
    expect(proxy.calls.at(-1)).toMatchObject({
      domain: 'api.elevenlabs.io',
      path: 'v1/sound-generation?output_format=mp3_44100_128',
      body: {
        text: 'a door slams in a stone hallway',
        duration_seconds: 22,
        prompt_influence: 0.4,
        model_id: 'eleven_text_to_sound_v2',
      },
    });
    const failing = new SfxClient(
      new FakeProxy({ 'v1/sound-generation': () => json({ detail: 'busy' }, 503) }) as unknown as ProxyClient,
      { provider: 'elevenlabs', domain: 'api.elevenlabs.io', model: 'm' },
      metrics,
    );
    await expect(failing.generate({ text: 'rain', durationSec: 2 })).rejects.toMatchObject({
      code: 'gateway_error',
      retryable: true,
    });
    expect(metrics.render()).toContain('rideo_post_audio_total{op="sfx",outcome="ok"} 1');
    expect(metrics.render()).toContain('rideo_post_audio_total{op="sfx",outcome="error"} 1');
  });
});

describe('OpenAI speech through the gateway proxy', () => {
  it('designs three presets steered by the description and cannot clone', async () => {
    const proxy = new FakeProxy({
      'v1/audio/speech': () => new Response(Buffer.from('mp3'), { status: 200 }),
    });
    const tts = new OpenAiTts(proxy as unknown as ProxyClient, endpoint('openai'));
    const previews = await tts.design({ description: 'calm and low', text: 'Hello there', seed: 3 });
    expect(previews.map((p) => p.voiceId)).toEqual(['coral', 'onyx', 'verse']);
    expect(proxy.calls[0]!.body).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: 'Hello there',
      instructions: 'calm and low',
      response_format: 'mp3',
    });
    expect(await tts.save({ previewVoiceId: 'nova' })).toBe('nova');
    await expect(tts.clone()).rejects.toMatchObject({ code: 'tts_unavailable' });
  });
});

describe('LLM adapters carry audio for the speaker check', () => {
  const req: LlmRequest = {
    system: 'rideo-task: voice.judge',
    parts: [
      { type: 'text', text: 'INPUT:\n{}' },
      { type: 'audio', data: Buffer.from('wav'), format: 'wav' },
    ],
    json: true,
    temperature: 0,
  };
  it('OpenAI input_audio and Gemini inline audio; Anthropic refuses', async () => {
    const openai = new FakeProxy({
      'v1/chat/completions': () => json({ choices: [{ message: { content: '{}' } }] }),
    });
    await new OpenAiAdapter(
      openai as unknown as ProxyClient,
      'api.openai.com',
      'gpt-4o-audio-preview',
    ).complete(req);
    expect(openai.calls[0]!.body.messages[1].content[1]).toEqual({
      type: 'input_audio',
      input_audio: { data: Buffer.from('wav').toString('base64'), format: 'wav' },
    });
    const gemini = new FakeProxy({
      'v1beta/': () => json({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
    });
    await new GeminiAdapter(gemini as unknown as ProxyClient, 'g', 'gemini-2.5-flash').complete(req);
    expect(gemini.calls[0]!.body.contents[0].parts[1]).toEqual({
      inline_data: { mime_type: 'audio/wav', data: Buffer.from('wav').toString('base64') },
    });
    await expect(
      new AnthropicAdapter(new FakeProxy({}) as unknown as ProxyClient, 'a', 'claude').complete(req),
    ).rejects.toMatchObject({ code: 'llm_error', retryable: false });
  });
});

describe('speaker check (rule V4)', () => {
  const report: ConsistencyReport = {
    status: 'passed',
    judge: 'test',
    threshold: 0.75,
    score: 0.9,
    attempts: 1,
    checkedAt: '2026-10-01T00:00:00.000Z',
    characters: [],
    elements: [],
    voices: [],
    frames: [],
  };
  const speakers = [
    { id: 'chr_0000000000aaaaaa', name: 'Mira', description: '', sample: Buffer.from('ref') },
  ];
  const judge = (verdict: { present: boolean; score: number }): VoiceJudge => ({
    id: 'fake',
    judge: async () => [{ characterId: speakers[0]!.id, issues: [], ...verdict }],
  });
  const run = (j: VoiceJudge | null, audio: Buffer | null = Buffer.from('take'), base = report) =>
    verifyVoices({
      judge: j,
      report: base,
      speakers,
      audio,
      lines: [],
      threshold: 0.75,
      metrics: new Metrics(),
    });

  it('passes the same voice, fails a different or missing one, and fails closed without a judge', async () => {
    expect(await run(judge({ present: true, score: 0.9 }))).toMatchObject({ status: 'passed', score: 0.9 });
    expect(await run(judge({ present: true, score: 0.3 }))).toMatchObject({ status: 'failed', score: 0.3 });
    expect(await run(judge({ present: false, score: 0.9 }))).toMatchObject({ status: 'failed', score: 0 });
    const silent = await run(judge({ present: true, score: 1 }), null);
    expect(silent).toMatchObject({
      status: 'failed',
      voices: [{ present: false, issues: ['the take has no sound'] }],
    });
    expect(await run(null)).toMatchObject({ status: 'unverified' });
    const broken: VoiceJudge = {
      id: 'x',
      judge: async () => {
        throw new Error('upstream down');
      },
    };
    expect((await run(broken)).note).toMatch(/voice judge unavailable: upstream down/);
    // A failed identity check stays failed whatever the voices say.
    expect(await run(null, Buffer.from('take'), { ...report, status: 'failed' })).toMatchObject({
      status: 'failed',
    });
    // Shots without speakers are untouched.
    expect(
      await verifyVoices({ judge: null, report, speakers: [], audio: null, lines: [], threshold: 0.75 }),
    ).toBe(report);
  });
});
