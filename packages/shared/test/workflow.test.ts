import { describe, expect, it } from 'vitest';
import { checkRequirement, evaluateWorkflow, initialStage, newId, stageOfGate } from '../src';
import * as f from '../src/testing/fixtures';

describe('workflow evaluation', () => {
  it('starts story projects at brief and edit projects at ingest', () => {
    expect(initialStage('story')).toBe('brief');
    expect(initialStage('edit')).toBe('ingest');
  });

  it('reports unmet requirements for the current gate', () => {
    const d = f.docs();
    const ev = evaluateWorkflow(d);
    expect(ev.stage).toBe('brief');
    expect(ev.stages[0]!.gate!.satisfied).toBe(true);
    const sp = evaluateWorkflow({
      ...d,
      project: { ...d.project, workflow: { stage: 'screenplay', approvals: {} } },
    });
    const gate = sp.stages[1]!.gate!;
    expect(gate.satisfied).toBe(false);
    expect(gate.requirements.filter((r) => !r.ok).map((r) => r.id)).toEqual([
      'screenplay.hasScenes',
      'characters.nonEmpty',
      'screenplay.outlineCoversTarget',
    ]);
  });

  it('checks cast locks and approved references', () => {
    const locked = f.character();
    const unlocked = f.character({ name: 'Jonah', lock: { locked: false, version: 0 }, references: [] });
    const d = f.docs({ characters: f.byId([locked, unlocked]) });
    const r = checkRequirement('characters.allLocked', d);
    expect(r.ok).toBe(false);
    expect(r.details).toEqual(['Jonah']);
    expect(checkRequirement('characters.allHaveApprovedRefs', d).details).toEqual(['Jonah']);
  });

  it('measures the target length and story completion', () => {
    const mira = f.character();
    const approved = f.clip({
      index: 0,
      status: 'approved',
      shots: [f.readyShot([mira], { durationSec: 30 })],
    });
    const review = f.clip({ index: 1, status: 'review', shots: [f.readyShot([mira], { durationSec: 30 })] });
    const d = f.docs({ clips: f.byId([approved, review]), characters: f.byId([mira]) });
    expect(checkRequirement('duration.targetReached', d).ok).toBe(false);
    const both = f.docs({
      clips: f.byId([approved, { ...review, status: 'approved' }]),
      characters: f.byId([mira]),
    });
    expect(checkRequirement('duration.targetReached', both).ok).toBe(true);
    expect(evaluateWorkflow(both).approvedDurationSec).toBe(60);
  });

  it('verifies timeline consistency', () => {
    const mira = f.character();
    const shot = f.readyShot([mira]);
    shot.takes[0]!.consistency = f.report({ status: 'unverified' });
    const clip = f.clip({ shots: [shot] });
    const timeline = {
      version: 1 as const,
      fps: 24,
      width: 320,
      height: 180,
      tracks: [
        {
          id: newId('track'),
          kind: 'video' as const,
          name: 'Video',
          items: [
            {
              id: newId('item'),
              kind: 'video' as const,
              source: {
                type: 'take' as const,
                clipId: clip.id,
                shotId: shot.id,
                takeId: shot.takes[0]!.id,
                media: f.media(),
              },
              start: 0,
              in: 0,
              out: 5,
              speed: 1,
              volume: 1,
            },
          ],
        },
      ],
    };
    const d = f.docs({ clips: f.byId([clip]), characters: f.byId([mira]), timeline });
    const r = checkRequirement('timeline.consistencyVerified', d);
    expect(r.ok).toBe(false);
    expect(r.details![0]).toContain('unverified');
  });

  it('maps gates back to stages', () => {
    expect(stageOfGate('story', 'pilot_approved')?.stage.id).toBe('pilot');
    expect(stageOfGate('edit', 'pilot_approved')).toBeNull();
  });
});
