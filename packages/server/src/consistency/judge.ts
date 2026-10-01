import type { ElementFrameVerdict, FrameVerdict } from '@rideo/shared';
import type { LlmTasks } from '../ai/tasks';

export interface JudgeCharacter {
  id: string;
  name: string;
  identity: string;
  references: Buffer[];
}

/** A location or prop to verify too (rule E4, docs/design/elements.md). */
export interface JudgeElement {
  id: string;
  kind: string;
  name: string;
  description: string;
  references: Buffer[];
}

export interface JudgeRequest {
  characters: JudgeCharacter[];
  elements?: JudgeElement[];
  frames: Buffer[];
  shotDescription: string;
  signal?: AbortSignal;
}

/** Per frame (request order): character verdicts, and element verdicts when elements were asked for. */
export interface JudgeVerdicts {
  characters: FrameVerdict[][];
  elements: ElementFrameVerdict[][];
}

/** Pluggable identity verifier (docs/design/character-consistency.md#judges). */
export interface ConsistencyJudge {
  readonly id: string;
  judge(req: JudgeRequest): Promise<JudgeVerdicts>;
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

  async judge(req: JudgeRequest): Promise<JudgeVerdicts> {
    const elements = req.elements ?? [];
    const refs = new Map<string, Buffer[]>([
      ...req.characters.map((c) => [c.id, c.references] as const),
      ...elements.map((e) => [e.id, e.references] as const),
    ]);
    const out = await this.llm.judge(
      {
        characters: req.characters.map((c) => ({
          id: c.id,
          name: c.name,
          identity: c.identity,
          referenceCount: c.references.length,
        })),
        ...(elements.length
          ? {
              elements: elements.map((e) => ({
                id: e.id,
                kind: e.kind,
                name: e.name,
                description: e.description,
                referenceCount: e.references.length,
              })),
            }
          : {}),
        frameCount: req.frames.length,
        shotDescription: req.shotDescription,
      },
      refs,
      req.frames,
      req.signal,
    );
    const knownCharacters = new Set(req.characters.map((c) => c.id));
    const knownElements = new Set(elements.map((e) => e.id));
    const frames = req.frames.map((_, i) => out.frames.find((f) => f.index === i));
    return {
      characters: frames.map((frame) =>
        (frame?.characters ?? [])
          .filter((c) => knownCharacters.has(c.characterId))
          .map((c) => ({
            characterId: c.characterId,
            present: c.present,
            identityScore: c.identityScore,
            outfitScore: c.outfitScore,
            issues: c.issues,
          })),
      ),
      elements: frames.map((frame) =>
        (frame?.elements ?? [])
          .filter((e) => knownElements.has(e.elementId))
          .map((e) => ({ elementId: e.elementId, present: e.present, score: e.score, issues: e.issues })),
      ),
    };
  }
}

/** RIDEO_CONSISTENCY_JUDGE=off — every take stays unverified (fail closed, rule R9). */
export class OffJudge implements ConsistencyJudge {
  readonly id = 'none';
  async judge(): Promise<JudgeVerdicts> {
    throw new JudgeUnavailableError('consistency judge disabled');
  }
}
