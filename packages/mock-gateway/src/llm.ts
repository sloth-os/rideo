import {
  INPUT_PREFIX,
  JUDGE_ELEMENT_REFERENCE_LABEL,
  JUDGE_FRAME_LABEL,
  JUDGE_REFERENCE_LABEL,
  type LlmTaskId,
  TAKE_AUDIO_LABEL,
  TASK_MARKER_PATTERN,
  VOICE_REFERENCE_LABEL,
} from '@rideo/shared';
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
  | { kind: 'audio'; data: Buffer; format: string };

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
export function answer(req: ChatRequest): string {
  const text = [
    req.system,
    ...req.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text),
  ].join('\n');
  const task = TASK_MARKER_PATTERN.exec(text)?.[1] as LlmTaskId | undefined;
  const inputText = req.parts.find((p) => p.kind === 'text' && p.text.startsWith(INPUT_PREFIX)) as
    | { text: string }
    | undefined;
  const input = inputText ? JSON.parse(inputText.text.slice(INPUT_PREFIX.length)) : {};
  const imageCount = req.parts.filter((p) => p.kind === 'image').length;
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
    default:
      out = { ok: true, echo: text.slice(0, 200) };
  }
  return JSON.stringify(out);
}

function usage(req: ChatRequest, out: string) {
  const inTokens =
    Math.ceil(JSON.stringify(req.parts.filter((p) => p.kind === 'text')).length / 4) +
    req.parts.filter((p) => p.kind === 'image').length * 258;
  return { input: inTokens, output: Math.ceil(out.length / 4) };
}

export function handleChat(path: string, body: any): ProxyResponse {
  const json = (payload: unknown): ProxyResponse => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (/chat\/completions$/.test(path)) {
    const req = parseOpenAi(body);
    const content = answer(req);
    const u = usage(req, content);
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
    const text = answer(req);
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
    let text = answer(req);
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
