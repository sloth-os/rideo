# Directing controls

The planner writes a shot as framing, movement and a description. Directors need more: the lens and the
aperture, a named camera move, the frame the shot must **end** on, the motion or the poses of a reference video,
a fixed seed, and several variations to compare side by side. These controls live on the shot, are compiled into
the prompt and the video request deterministically (R3), and every frame the model is given is verified like the
start keyframe (R4).

## Shot controls

```ts
shot.camera = {
  framing, movement,                    // as before
  lensMm: number | null,                // focal length, 8–800 mm ("85mm lens")
  aperture: number | null,              // f-number, 0.7–32 (≤ 2.8 shallow depth of field, ≥ 8 deep focus)
  move: CameraMoveId | null,            // a move of the library; replaces the movement phrase
};
shot.startFrame = { mode: 'auto' | 'resource', resourceId: string | null };
shot.endFrame = { mode: 'none' | 'generate' | 'resource', description: string, resourceId: string | null };
shot.motionReference = { resourceId: string, mode: 'motion' | 'pose' | 'camera' } | null;
shot.seed = number | null;              // fixed seed for the keyframes and the video (null: derived, R3)
```

| Control | Prompt | Video request |
|---|---|---|
| lens, aperture | `Camera: close-up, slow push-in toward the subject; 85mm lens, f/1.8 shallow depth of field.` (keyframes get the framing and the lens) | – |
| move | the move's phrase instead of the movement's | `camera_motion`: the move's (`fixed` for locked-off moves) |
| start frame `resource` | – | the image resource is the `first_frame` (instead of the keyframe, the board or the previous shot) |
| end frame `generate` | the end frame is a second keyframe compiled from `description` with the shot's references | `last_frame` |
| end frame `resource` | – | the image resource is the `last_frame` |
| motion reference | `Reproduce the motion of the reference video.` / `Match the body poses and blocking of the reference video.` / `Reproduce the camera movement of the reference video.` | the video resource as `reference_video` |
| seed | – | `seed` (attempts and variations still offset it) |

Inputs a model does not accept (`supports_last_frame: false`, `supports_reference_video: false`) are not sent, and
the take records what was: `request.lastFrameSource` (`generated`, `resource` or null) and
`request.motionReference`. In auto mode mm-gateway routes requests with a last frame or a reference video to
models that accept them ([mm-gateway auto mode](https://github.com/sloth-os/mm-gateway/blob/main/docs/design/auto-mode.md)).

### Move library

The moves are a declarative table (`shared/directing/moves.ts`): id, label, prompt phrase, base movement and
`camera_motion`.

| Move | Phrase | `camera_motion` |
|---|---|---|
| `locked_off` | locked-off static camera | fixed |
| `push_in` / `pull_out` | slow push-in toward the subject / slow pull-out revealing the space | auto |
| `dolly_left` / `dolly_right` | lateral dolly to the left / right | auto |
| `pan_left` / `pan_right`, `tilt_up` / `tilt_down` | slow pan / tilt | auto |
| `tracking_follow`, `steadicam_walk` | tracking shot following the subject / steadicam walking with the subject | auto |
| `orbit_left` / `orbit_right` | orbit around the subject | auto |
| `crane_up` / `crane_down` | crane rising above / descending to the scene | auto |
| `whip_pan` | fast whip pan | auto |
| `handheld` | handheld camera with a subtle shake | auto |
| `dolly_zoom` | dolly zoom, the background stretching behind the subject | auto |
| `drone_flyover` | aerial drone flyover | auto |
| `rack_focus` | rack focus from the foreground to the background | fixed |

## Frames are verified (R4)

A generated end frame goes through the keyframe step: image task with the shot's references, judge, retries. If it
fails every attempt, no video is generated and the take keeps the evidence (`take.endKeyframe`, a failed report),
exactly like a failed start keyframe. Resource frames are the user's images and are not judged; the video's
sampled frames still are.

## Variations and comparison

`POST …/shots/:shotId/variations {count: 2–4}` enqueues `count` shot generations with `variation: 1…count`; the
seed of variation `k` is offset by a fixed prime, so variations differ and stay reproducible. Takes record their
`variation`. The clip review compares two takes **A/B**: both videos side by side, played, paused and seeked
together, with their consistency scores, seeds, variations and frame sources; "Use A" or "Use B" selects the take.

## Surfaces

| REST | MCP |
|---|---|
| `PATCH /api/projects/:id/clips/:clipId/shots/:shotId` (`camera`, `startFrame`, `endFrame`, `motionReference`, `seed`, …) | `shot_update` |
| `POST /api/projects/:id/clips/:clipId/shots/:shotId/variations` `{count}` → jobs | `shot_variations` |
| `GET /api/config` → `directing.moves` (the library) | `camera_moves` |

The clip review's **Direct** panel per shot edits the camera (move, lens, aperture), the start and end frames, the
motion reference and the seed, and starts variations; takes have a compare toggle.

Frame and motion references must be resources of the project (images for frames, videos for motion): a missing
or wrong-kind resource is a `validation_error` when the shot is saved and when it is generated.
