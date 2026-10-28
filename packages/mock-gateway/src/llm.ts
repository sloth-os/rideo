import {
  INPUT_PREFIX,
  JUDGE_ELEMENT_REFERENCE_LABEL,
  JUDGE_FRAME_LABEL,
  JUDGE_REFERENCE_LABEL,
  JUDGE_SCENE_REFERENCE_LABEL,
  type LlmTaskId,
  TAKE_AUDIO_LABEL,
  TASK_MARKER_PATTERN,
  VOICE_REFERENCE_LABEL,
} from '@rideo/shared';
import { screenplayReview, screenplayRevise, storyboardReview } from './ai-review';
import { feedbackFilm, feedbackListen, feedbackScene, soundCheck } from './feedback';
import {
  characterDescribe,
  clipPlan,
  consistencyJudge,
  footageAnalyze,
  type LabelledImages,
  mediaDescribe,
  reframeFocus,
  scorePlan,
  screenplayExtend,
  screenplayGenerate,
  sfxPlan,
  thumbnailPick,
  translate,
} from './fixtures';
import { parseDataUri } from './png';
import { frameCaption } from './search';
import { voiceJudge } from './speech';

type Part =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: Buffer; mime: string }
  | { kind: 'audio'; data: Buffer; format: string }
  /** A video with its sound (the audio-visual model). */
  | { kind: 'video'; data: Buffer; mime: string };

/** What a chat call may depend on besides its body: the gateway's switches. */
export interface ChatOptions {
  /** True when this sound check hears no speech (muffleSpeech). */
  muffled?: () => boolean;
}

/** A video data URI, typed (`data:video/mp4;base64,…`) or not (`data:;base64,…`, as Qwen-Omni documents it). */
function videoFromUrl(url: unknown): Part | null {
  const m = typeof url === 'string' ? /^data:([^;,]*);base64,(.*)$/s.exec(url) : null;
  return m ? { kind: 'video', data: Buffer.from(m[2]!, 'base64'), mime: m[1] || 'video/mp4' } : null;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface ChatRequest {
  system: string;
  parts: Part[];
  prefill?: string;
}

function imageFromUrl(url: string): Part | null {
  const d = parseDataUri(url);
  return d ? { kind: 'image', data: d.data, mime: d.mime } : null;
}

export function parseOpenAi(body: any): ChatRequest {
  const parts: Part[] = [];
  let system = '';
  for (const m of body.messages ?? []) {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
    for (const c of content) {
      if (m.role === 'system' || m.role === 'developer') {
        if (c.type === 'text') system += `${c.text}\n`;
        continue;
      }
      if (c.type === 'text') parts.push({ kind: 'text', text: c.text });
      else if (c.type === 'input_audio' && c.input_audio?.data)
        parts.push({
          kind: 'audio',
          data: Buffer.from(c.input_audio.data, 'base64'),
          format: c.input_audio.format ?? 'wav',
        });
      else if (c.type === 'image_url') {
        const img = imageFromUrl(typeof c.image_url === 'string' ? c.image_url : c.image_url?.url);
        if (img) parts.push(img);
      } else if (c.type === 'video_url') {
        const video = videoFromUrl(typeof c.video_url === 'string' ? c.video_url : c.video_url?.url);
        if (video) parts.push(video);
      }
    }
  }
  return { system, parts };
}

export function parseGemini(body: any): ChatRequest {
  const system = (body.systemInstruction?.parts ?? body.system_instruction?.parts ?? [])
    .map((p: any) => p.text ?? '')
    .join('\n');
  const parts: Part[] = [];
  for (const c of body.contents ?? []) {
    for (const p of c.parts ?? []) {
      if (typeof p.text === 'string') parts.push({ kind: 'text', text: p.text });
      const inline = p.inline_data ?? p.inlineData;
      const mime = String(inline?.mime_type ?? inline?.mimeType ?? '');
      if (inline?.data && mime.startsWith('audio/'))
        parts.push({ kind: 'audio', data: Buffer.from(inline.data, 'base64'), format: mime.split('/')[1]! });
      else if (inline?.data && mime.startsWith('video/'))
        parts.push({ kind: 'video', data: Buffer.from(inline.data, 'base64'), mime });
      else if (inline?.data) parts.push({ kind: 'image', data: Buffer.from(inline.data, 'base64'), mime });
    }
  }
  return { system, parts };
}

export function parseAnthropic(body: any): ChatRequest {
  const system =
    typeof body.system === 'string'
      ? body.system
      : (body.system ?? []).map((b: any) => b.text ?? '').join('\n');
  const parts: Part[] = [];
  let prefill: string | undefined;
  for (const m of body.messages ?? []) {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []);
    if (m.role === 'assistant') {
      prefill = content.map((c: any) => c.text ?? '').join('');
      continue;
    }
    for (const c of content) {
      if (c.type === 'text') parts.push({ kind: 'text', text: c.text });
      else if (c.type === 'image' && c.source?.type === 'base64') {
        parts.push({ kind: 'image', data: Buffer.from(c.source.data, 'base64'), mime: c.source.media_type });
      }
    }
  }
  return { system, parts, prefill };
}

function labelledImages(parts: Part[]): LabelledImages {
  const references = new Map<string, Buffer[]>();
  const frames = new Map<number, Buffer>();
  let refOwner: string | null = null;
  let frameIndex: number | null = null;
  for (const p of parts) {
    if (p.kind === 'text') {
      const ref = new RegExp(`(?:${JUDGE_REFERENCE_LABEL}|${JUDGE_ELEMENT_REFERENCE_LABEL})\\s+(\\S+)`).exec(
        p.text,
      );
      const frame = new RegExp(`${JUDGE_FRAME_LABEL}\\s+(\\d+)`).exec(p.text);
      if (ref) {
        refOwner = ref[1]!.replace(/[^a-z0-9_]/gi, '');
        frameIndex = null;
      } else if (frame) {
        frameIndex = Number(frame[1]);
        refOwner = null;
      } else if (p.text.startsWith(JUDGE_SCENE_REFERENCE_LABEL)) {
        // The scene reference frame is neither a reference of the cast nor a candidate.
        refOwner = null;
        frameIndex = null;
      }
      continue;
    }
    if (p.kind !== 'image') continue;
    if (refOwner) references.set(refOwner, [...(references.get(refOwner) ?? []), p.data]);
    else if (frameIndex !== null) frames.set(frameIndex, p.data);
  }
  return { references, frames };
}

/** The speaker check's audio: each character's reference voice, then the take (docs/design/dialogue.md). */
function labelledAudio(parts: Part[]): { references: Map<string, Buffer>; take: Buffer | null } {
  const references = new Map<string, Buffer>();
  let take: Buffer | null = null;
  let owner: string | null = null;
  let isTake = false;
  for (const p of parts) {
    if (p.kind === 'text') {
      const ref = new RegExp(`${VOICE_REFERENCE_LABEL}\\s+(\\S+)`).exec(p.text);
      if (ref) {
        owner = ref[1]!.replace(/[^a-z0-9_]/gi, '');
        isTake = false;
      } else if (p.text.startsWith(TAKE_AUDIO_LABEL)) {
        owner = null;
        isTake = true;
      }
      continue;
    }
    if (p.kind !== 'audio') continue;
    if (owner) references.set(owner, p.data);
    else if (isTake) take = p.data;
  }
  return { references, take };
}

const imagesOf = (parts: Part[]) =>
  parts.filter((p): p is Extract<Part, { kind: 'image' }> => p.kind === 'image').map((p) => p.data);

/** Routes a chat request to the fixture for its `rideo-task:` marker; unknown tasks get a small echo. */
export function answer(req: ChatRequest, opts: ChatOptions = {}): string {
  const text = [
    req.system,
    ...req.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text),
  ].join('\n');
  const task = TASK_MARKER_PATTERN.exec(text)?.[1] as LlmTaskId | 'settings.test' | undefined;
  // The Settings page's endpoint test (docs/design/settings.md#endpoint-status-and-tests)
  if (task === 'settings.test') return 'OK';
  const inputText = req.parts.find((p) => p.kind === 'text' && p.text.startsWith(INPUT_PREFIX)) as
    | { text: string }
    | undefined;
  const input = inputText ? JSON.parse(inputText.text.slice(INPUT_PREFIX.length)) : {};
  const imageCount = req.parts.filter((p) => p.kind === 'image').length;
  const videoCount = req.parts.filter((p) => p.kind === 'video').length;
  let out: unknown;
  switch (task) {
    case 'screenplay.generate':
      out = screenplayGenerate(input);
      break;
    case 'screenplay.extend':
      out = screenplayExtend(input);
      break;
    case 'clip.plan':
      out = clipPlan(input);
      break;
    case 'media.describe':
      out = mediaDescribe({ imageCount, videoFrameCount: 0, prompt: '', ...input });
      break;
    case 'character.describe':
      out = characterDescribe(input);
      break;
    case 'consistency.judge':
      out = consistencyJudge(input, labelledImages(req.parts));
      break;
    case 'voice.judge':
      out = voiceJudge(input, labelledAudio(req.parts));
      break;
    case 'footage.analyze':
      out = footageAnalyze(input);
      break;
    case 'score.plan':
      out = scorePlan(input);
      break;
    case 'sfx.plan':
      out = sfxPlan(input);
      break;
    case 'dialogue.translate':
      out = translate(input);
      break;
    case 'reframe.focus':
      out = reframeFocus(input, imagesOf(req.parts));
      break;
    case 'thumbnail.pick':
      out = thumbnailPick(input, imagesOf(req.parts));
      break;
    case 'frame.caption':
      out = frameCaption(input, imagesOf(req.parts));
      break;
    case 'feedback.scene':
      out = feedbackScene(input, imagesOf(req.parts).length);
      break;
    case 'feedback.listen':
      out = feedbackListen(input, videoCount > 0);
      break;
    case 'sound.check':
      out = soundCheck(input, { watched: videoCount > 0, muffled: opts.muffled?.() ?? false });
      break;
    case 'feedback.film':
      out = feedbackFilm(input);
      break;
    case 'screenplay.review':
      out = screenplayReview(input);
      break;
    case 'screenplay.revise':
      out = screenplayRevise(input);
      break;
    case 'storyboard.review':
      out = storyboardReview(input, imagesOf(req.parts).length);
      break;
    default:
      out = { ok: true, echo: text.slice(0, 200) };
  }
  return JSON.stringify(out);
}

function usage(req: ChatRequest, out: string) {
  const inTokens =
    Math.ceil(JSON.stringify(req.parts.filter((p) => p.kind === 'text')).length / 4) +
    req.parts.filter((p) => p.kind === 'image').length * 258 +
    req.parts.filter((p) => p.kind === 'video').length * 1300;
  return { input: inTokens, output: Math.ceil(out.length / 4) };
}

/**
 * A streamed chat completion as OpenAI sends it (docs/design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings): the
 * content in three deltas, the usage in a last event when `stream_options.include_usage` asks for it, then `[DONE]`.
 */
function chatStream(body: any, content: string, u: { input: number; output: number }): ProxyResponse {
  const id = `chatcmpl-mock-${Date.now()}`;
  const event = (payload: object) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model ?? 'mock-llm', ...payload })}\n\n`;
  const third = Math.ceil(content.length / 3);
  const pieces = [content.slice(0, third), content.slice(third, 2 * third), content.slice(2 * third)];
  let out = event({
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  for (const piece of pieces)
    out += event({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  out += event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  if (body.stream_options?.include_usage)
    out += event({
      choices: [],
      usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output },
    });
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    body: `${out}data: [DONE]\n\n`,
  };
}

export function handleChat(path: string, body: any, opts: ChatOptions = {}): ProxyResponse {
  const json = (payload: unknown): ProxyResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (/chat\/completions$/.test(path)) {
    const req = parseOpenAi(body);
    const content = answer(req, opts);
    const u = usage(req, content);
    if (body.stream === true) return chatStream(body, content, u);
    return json({
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'mock-llm',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output },
    });
  }
  if (/:generateContent$/.test(path)) {
    const req = parseGemini(body);
    const text = answer(req, opts);
    const u = usage(req, text);
    return json({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: u.input,
        candidatesTokenCount: u.output,
        totalTokenCount: u.input + u.output,
      },
      modelVersion: 'mock-gemini',
    });
  }
  if (/\/messages$/.test(path)) {
    const req = parseAnthropic(body);
    let text = answer(req, opts);
    if (req.prefill && text.startsWith(req.prefill)) text = text.slice(req.prefill.length);
    const u = usage(req, text);
    return json({
      id: `msg_mock_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: body.model ?? 'mock-claude',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: u.input, output_tokens: u.output },
    });
  }
  return {
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'unknown mock proxy path' }),
  };
}

/** Minimal multipart reader (transcription uploads): returns the named file part. */
export function multipartFile(body: Buffer, contentType: string, field = 'file'): Buffer | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let start = body.indexOf(marker);
  while (start >= 0) {
    const next = body.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = body.subarray(start + marker.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headerEnd).toString();
    if (new RegExp(`name="${field}"`).test(headers)) return part.subarray(headerEnd + 4, part.length - 2);
    start = next;
  }
  return null;
}
