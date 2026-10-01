import type { ConsistencyReport, VoiceVerdict } from '@rideo/shared';
import type { LlmTasks } from '../ai/tasks';
import type { Metrics } from '../metrics';

/** A speaker of the shot with the reference recording of their locked voice (WAV). */
export interface VoiceSpeaker {
  id: string;
  name: string;
  description: string;
  sample: Buffer;
}

export interface VoiceJudgeRequest {
  speakers: VoiceSpeaker[];
  /** The take's audio (WAV). */
  audio: Buffer;
  lines: { speaker: string; text: string }[];
  signal?: AbortSignal;
}

/** Pluggable speaker verifier for native-audio takes (rule V4, docs/design/dialogue.md#rules). */
export interface VoiceJudge {
  readonly id: string;
  judge(req: VoiceJudgeRequest): Promise<VoiceVerdict[]>;
}

/** An audio-capable LLM (OpenAI audio models, Gemini) through the gateway proxy. */
export class LlmVoiceJudge implements VoiceJudge {
  readonly id: string;
  constructor(private readonly llm: LlmTasks) {
    this.id = `audio-llm:${llm.audio?.model ?? 'none'}`;
  }

  async judge(req: VoiceJudgeRequest): Promise<VoiceVerdict[]> {
    const out = await this.llm.judgeVoices(
      {
        speakers: req.speakers.map((s) => ({ characterId: s.id, name: s.name, description: s.description })),
        lines: req.lines,
      },
      new Map(req.speakers.map((s) => [s.id, s.sample])),
      req.audio,
      req.signal,
    );
    return req.speakers.map((s) => {
      const v = out.speakers.find((x) => x.characterId === s.id);
      return v
        ? { characterId: s.id, present: v.present, score: v.score, issues: v.issues }
        : { characterId: s.id, present: false, score: 0, issues: ['the judge did not rate this speaker'] };
    });
  }
}

/**
 * Rule V4: merges the speaker check into a take's report. A speaker who is missing or sounds different fails the
 * take; a missing or failing judge leaves it unverified (R9). A failed identity check stays failed.
 */
export async function verifyVoices(input: {
  judge: VoiceJudge | null;
  report: ConsistencyReport;
  speakers: VoiceSpeaker[];
  /** The take's audio as WAV, or null when the take is silent. */
  audio: Buffer | null;
  lines: { speaker: string; text: string }[];
  threshold: number;
  metrics?: Metrics;
  log?: { warn: (o: unknown, m?: string) => void };
  signal?: AbortSignal;
}): Promise<ConsistencyReport> {
  const { report, speakers } = input;
  if (speakers.length === 0) return report;
  const unverified = (note: string): ConsistencyReport => {
    input.metrics?.voiceChecks.inc({ result: 'unverified' });
    return {
      ...report,
      status: report.status === 'failed' ? 'failed' : 'unverified',
      voices: speakers.map((s) => ({ characterId: s.id, present: false, score: 0, issues: [] })),
      note: [report.note, note].filter(Boolean).join('; '),
    };
  };
  let voices: VoiceVerdict[];
  if (!input.audio) {
    voices = speakers.map((s) => ({
      characterId: s.id,
      present: false,
      score: 0,
      issues: ['the take has no sound'],
    }));
  } else if (!input.judge) {
    return unverified('no audio-capable judge is configured for the speaker check');
  } else {
    try {
      voices = await input.judge.judge({
        speakers,
        audio: input.audio,
        lines: input.lines,
        signal: input.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      input.log?.warn({ err: (err as Error).message }, 'voice judge unavailable; take stays unverified');
      return unverified(`voice judge unavailable: ${(err as Error).message.slice(0, 300)}`);
    }
  }
  const passed = voices.every((v) => v.present && v.score >= input.threshold);
  input.metrics?.voiceChecks.inc({ result: passed ? 'passed' : 'failed' });
  const voiceScore = Math.min(...voices.map((v) => (v.present ? v.score : 0)));
  return {
    ...report,
    status: !passed ? 'failed' : report.status,
    score: Math.min(report.score, voiceScore),
    voices,
  };
}
