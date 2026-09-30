import type { FrameVerdict } from '@rideo/shared';
import type { LlmTasks } from '../ai/tasks';

export interface JudgeCharacter {
  id: string;
  name: string;
  identity: string;
  references: Buffer[];
}

export interface JudgeRequest {
  characters: JudgeCharacter[];
  frames: Buffer[];
  shotDescription: string;
  signal?: AbortSignal;
}

/** Pluggable identity verifier (docs/design/character-consistency.md#judges). */
export interface ConsistencyJudge {
  readonly id: string;
  /** Per frame, per character verdicts (frames in request order). */
  judge(req: JudgeRequest): Promise<FrameVerdict[][]>;
}

export class JudgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeUnavailableError';
  }
}

export class VisionLlmJudge implements ConsistencyJudge {
  readonly id: string;
  constructor(private readonly llm: LlmTasks) {
    this.id = `vision-llm:${llm.vision.model}`;
  }

  async judge(req: JudgeRequest): Promise<FrameVerdict[][]> {
    const refs = new Map(req.characters.map((c) => [c.id, c.references]));
    const out = await this.llm.judge(
      {
        characters: req.characters.map((c) => ({
          id: c.id,
          name: c.name,
          identity: c.identity,
          referenceCount: c.references.length,
        })),
        frameCount: req.frames.length,
        shotDescription: req.shotDescription,
      },
      refs,
      req.frames,
      req.signal,
    );
    const known = new Set(req.characters.map((c) => c.id));
    return req.frames.map((_, i) => {
      const frame = out.frames.find((f) => f.index === i);
      return (frame?.characters ?? [])
        .filter((c) => known.has(c.characterId))
        .map((c) => ({
          characterId: c.characterId,
          present: c.present,
          identityScore: c.identityScore,
          outfitScore: c.outfitScore,
          issues: c.issues,
        }));
    });
  }
}

/** RIDEO_CONSISTENCY_JUDGE=off — every take stays unverified (fail closed, rule R9). */
export class OffJudge implements ConsistencyJudge {
  readonly id = 'none';
  async judge(): Promise<FrameVerdict[][]> {
    throw new JudgeUnavailableError('consistency judge disabled');
  }
}
