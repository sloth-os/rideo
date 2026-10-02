import { z } from 'zod';

/**
 * Directing controls (docs/design/directing.md): the camera move library, lens presets and the prompt fragments
 * they compile to. Declarative tables shared by the prompt compiler, the studio and agents.
 */

export const CAMERA_MOVES = [
  { id: 'locked_off', label: 'Locked off', phrase: 'locked-off static camera', cameraMotion: 'fixed' },
  { id: 'push_in', label: 'Push in', phrase: 'slow push-in toward the subject', cameraMotion: 'auto' },
  { id: 'pull_out', label: 'Pull out', phrase: 'slow pull-out revealing the space', cameraMotion: 'auto' },
  { id: 'dolly_left', label: 'Dolly left', phrase: 'lateral dolly to the left', cameraMotion: 'auto' },
  { id: 'dolly_right', label: 'Dolly right', phrase: 'lateral dolly to the right', cameraMotion: 'auto' },
  { id: 'pan_left', label: 'Pan left', phrase: 'slow pan to the left', cameraMotion: 'auto' },
  { id: 'pan_right', label: 'Pan right', phrase: 'slow pan to the right', cameraMotion: 'auto' },
  { id: 'tilt_up', label: 'Tilt up', phrase: 'slow tilt up', cameraMotion: 'auto' },
  { id: 'tilt_down', label: 'Tilt down', phrase: 'slow tilt down', cameraMotion: 'auto' },
  {
    id: 'tracking_follow',
    label: 'Tracking',
    phrase: 'tracking shot following the subject',
    cameraMotion: 'auto',
  },
  {
    id: 'steadicam_walk',
    label: 'Steadicam walk',
    phrase: 'steadicam walking with the subject',
    cameraMotion: 'auto',
  },
  {
    id: 'orbit_left',
    label: 'Orbit left',
    phrase: 'orbit around the subject to the left',
    cameraMotion: 'auto',
  },
  {
    id: 'orbit_right',
    label: 'Orbit right',
    phrase: 'orbit around the subject to the right',
    cameraMotion: 'auto',
  },
  { id: 'crane_up', label: 'Crane up', phrase: 'crane rising above the scene', cameraMotion: 'auto' },
  { id: 'crane_down', label: 'Crane down', phrase: 'crane descending into the scene', cameraMotion: 'auto' },
  { id: 'whip_pan', label: 'Whip pan', phrase: 'fast whip pan', cameraMotion: 'auto' },
  { id: 'handheld', label: 'Handheld', phrase: 'handheld camera with a subtle shake', cameraMotion: 'auto' },
  {
    id: 'dolly_zoom',
    label: 'Dolly zoom',
    phrase: 'dolly zoom, the background stretching behind the subject',
    cameraMotion: 'auto',
  },
  { id: 'drone_flyover', label: 'Drone flyover', phrase: 'aerial drone flyover', cameraMotion: 'auto' },
  {
    id: 'rack_focus',
    label: 'Rack focus',
    phrase: 'rack focus from the foreground to the background',
    cameraMotion: 'fixed',
  },
] as const satisfies readonly { id: string; label: string; phrase: string; cameraMotion: 'auto' | 'fixed' }[];

export type CameraMoveId = (typeof CAMERA_MOVES)[number]['id'];
export const CameraMoveIdSchema = z.enum(CAMERA_MOVES.map((m) => m.id) as [CameraMoveId, ...CameraMoveId[]]);

export function cameraMove(id: string | null | undefined) {
  return CAMERA_MOVES.find((m) => m.id === id) ?? null;
}

/** Common focal lengths for the lens picker (any 8–800 mm value is valid). */
export const LENS_PRESETS = [
  { mm: 14, label: '14 mm ultra wide' },
  { mm: 24, label: '24 mm wide' },
  { mm: 35, label: '35 mm' },
  { mm: 50, label: '50 mm normal' },
  { mm: 85, label: '85 mm portrait' },
  { mm: 135, label: '135 mm telephoto' },
] as const;

export const APERTURE_PRESETS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16] as const;

/** `85mm lens, f/1.8 shallow depth of field` (empty when neither is set). */
export function lensFragment(camera: { lensMm?: number | null; aperture?: number | null }): string {
  const parts: string[] = [];
  if (camera.lensMm) parts.push(`${camera.lensMm}mm lens`);
  if (camera.aperture) {
    const f = `f/${Number(camera.aperture.toFixed(1))}`;
    parts.push(
      camera.aperture <= 2.8 ? `${f} shallow depth of field` : camera.aperture >= 8 ? `${f} deep focus` : f,
    );
  }
  return parts.join(', ');
}

export const MOTION_REFERENCE_PHRASES = {
  motion: 'Reproduce the motion of the reference video.',
  pose: 'Match the body poses and blocking of the reference video.',
  camera: 'Reproduce the camera movement of the reference video.',
  performance:
    'Animate the characters of the first frame with the performance of the reference video: its facial expressions, lip movements, head and body motion and timing.',
} as const;

/** Seeds of variation `k` are offset by a prime: variations differ and stay reproducible. */
export const VARIATION_SEED_STEP = 104_729;
