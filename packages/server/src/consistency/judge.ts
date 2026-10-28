import type { ElementFrameVerdict, FrameVerdict, QualityFrame } from '@rideo/shared';
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
  /** Physics too, and continuity against the scene reference frame (docs/design/continuity.md#quality-checks-in-the-gate). */
  qualityChecks?: boolean;
  sceneReference?: Buffer;
  /** Cast members who must not be in the frames, with how they look (quality checks). */
  absent?: { name: string; look: string }[];
}

/** Per frame (request order): character verdicts, and element verdicts when elements were asked for. */
export interface JudgeVerdicts {
  characters: FrameVerdict[][];
  elements: ElementFrameVerdict[][];
  /** Per frame, when quality checks were asked for. */
  quality?: QualityFrame[];
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
        ...(req.qualityChecks ? { qualityChecks: true, sceneReference: !!req.sceneReference } : {}),
        ...(req.qualityChecks && req.absent?.length ? { absent: req.absent } : {}),
      },
      refs,
      req.frames,
      req.signal,
      req.qualityChecks ? req.sceneReference : undefined,
    );
    // Verdicts name their character or element by id, or by name when the model gave only that
    const characterIdOf = new Map<string, string>([
      ...req.characters.map((c) => [c.id, c.id] as const),
      ...req.characters.map((c) => [c.name.toLowerCase(), c.id] as const),
    ]);
    const elementIdOf = new Map<string, string>([
      ...elements.map((e) => [e.id, e.id] as const),
      ...elements.map((e) => [e.name.toLowerCase(), e.id] as const),
    ]);
    const idOf = (ids: Map<string, string>, id?: string, name?: string) =>
      (id && ids.get(id)) ?? (name ? ids.get(name.trim().toLowerCase()) : undefined);
    // Only the names the judge was told to look for count as extras
    const absent = new Map((req.absent ?? []).map((a) => [a.name.toLowerCase(), a.name]));
    const frames = req.frames.map((_, i) => out.frames.find((f) => f.index === i));
    return {
      characters: frames.map((frame) =>
        (frame?.characters ?? []).flatMap((c) => {
          const characterId = idOf(characterIdOf, c.characterId, c.name);
          return characterId
            ? [
                {
                  characterId,
                  present: c.present,
                  identityScore: c.identityScore,
                  outfitScore: c.outfitScore,
                  issues: c.issues,
                },
              ]
            : [];
        }),
      ),
      elements: frames.map((frame) =>
        (frame?.elements ?? []).flatMap((e) => {
          const elementId = idOf(elementIdOf, e.elementId, e.name);
          return elementId ? [{ elementId, present: e.present, score: e.score, issues: e.issues }] : [];
        }),
      ),
      ...(req.qualityChecks
        ? {
            quality: frames.map((frame) => {
              const extras = (frame?.extras ?? []).flatMap((n) => {
                const name = absent.get(n.trim().toLowerCase());
                return name ? [name] : [];
              });
              return {
                ...(frame?.physics ? { physics: frame.physics } : {}),
                ...(frame?.continuity && req.sceneReference ? { continuity: frame.continuity } : {}),
                ...(extras.length ? { extras } : {}),
                ...(frame?.others?.length ? { others: frame.others } : {}),
                ...(frame?.duplicates?.length ? { duplicates: frame.duplicates } : {}),
              };
            }),
          }
        : {}),
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
