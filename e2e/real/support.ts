import { execFileSync } from 'node:child_process';
import type { APIRequestContext } from '@playwright/test';

const ffmpeg = (args: string[]) =>
  execFileSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', ['-y', '-v', 'error', ...args]);

/** A drawn lighthouse at dusk (sky, sea, a striped tower and its lamp on a rock): a picture to attach to a brief. */
export function drawLighthouse(out: string): string {
  const boxes = [
    [0, 0, 768, 170, '0xf4a261'],
    [0, 170, 768, 80, '0xe76f51'],
    [0, 250, 768, 182, '0x1d3557'],
    [300, 292, 168, 44, '0x6c757d'],
    [344, 120, 80, 180, '0xf1faee'],
    [344, 160, 80, 24, '0xe63946'],
    [344, 220, 80, 24, '0xe63946'],
    [340, 84, 88, 10, '0x2b2d42'],
    [354, 94, 60, 26, '0xffd166'],
  ] as const;
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x264653:s=768x432',
    '-vf',
    boxes.map(([x, y, w, h, c]) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${c}:t=fill`).join(','),
    '-frames:v',
    '1',
    out,
  ]);
  return out;
}

/** Three seconds of a rolling sea under a dusk sky: a video to attach to a brief. */
export function filmSea(out: string): string {
  // Above y = 140 a sky graded from orange to violet, below it waves moving at different speeds.
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=640x360:r=24:d=3',
    '-vf',
    "geq=r='if(lt(Y,140),230-Y/2,20)'" +
      ":g='if(lt(Y,140),140-Y/3,70+30*sin(X/18+T*4)+20*sin(Y/7-T*3))'" +
      ":b='if(lt(Y,140),90+Y/2,130+50*sin(X/25-T*2)+30*sin(Y/9+T*5))',format=yuv420p",
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-movflags',
    '+faststart',
    out,
  ]);
  return out;
}

/** The studio's counters (`/metrics`): how many calls of a kind were made, by their labels. */
export async function counters(
  request: APIRequestContext,
): Promise<(name: string, labels: Record<string, string>) => number> {
  const text = await (await request.get('/metrics')).text();
  return (name, labels) => {
    const want = Object.keys(labels)
      .sort()
      .map((k) => `${k}="${labels[k]}"`)
      .join(',');
    const line = text.split('\n').find((l) => l.startsWith(`${name}{${want}} `));
    return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
  };
}

/**
 * The suite's projects (docs/testing.md#real-models-e2ereal): a ten-second film whose pilot is its only scene, no
 * storyboard, and a gate of 0.5 with two attempts per keyframe and per video, so the cost stays bounded.
 */
export const REAL_PROJECT_SETTINGS = {
  targetDurationSec: 10,
  pilotDurationSec: 10,
  storyboard: { enabled: false },
  consistency: { threshold: 0.5, maxAttempts: 2 },
  // One review of the screenplay and no automatic revisions: the suite checks the review runs, not the story
  review: { maxRounds: 0 },
};
