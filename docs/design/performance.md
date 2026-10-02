# Performance-driven animation

A director acts a shot into a webcam or a phone ("look up, a half smile, then the line") and a locked character
performs it: the expressions, the lips, the head and body motion and the timing come from the performance, the
identity from the character's locked references. Rideo sends it to a gateway model that takes a driving video, when
the gateway has one (Runway Act-Two, Wan Animate and the like, declared with `supports_performance`).

## A performance on a shot

A performance is a shot's [motion reference](directing.md#shot-controls) in `performance` mode:

```ts
shot.motionReference = { resourceId: string, mode: 'motion' | 'pose' | 'camera' | 'performance' } | null;
```

The resource is a video of the project: recorded in the studio, uploaded, or any footage of a person performing.
`motion`, `pose` and `camera` go to the shot's video model as a `reference_video` with a phrase; `performance` goes to
the **performance model** instead:

| | Performance take |
|---|---|
| model | `settings.models.performance`: `auto` (the first gateway video model whose limits say `supports_performance`), a model id, or `off` (`RIDEO_PERFORMANCE_MODEL` sets the default) |
| first frame | the shot's first frame as for any take: the keyframe with the locked cast (verified, R4), the approved board, the previous shot's last frame or the director's start frame |
| reference video | the performance, normalized on the server (H.264, AAC, the project's frame rate) and trimmed to the shot's length |
| prompt | the shot's prompt and `Animate the characters of the first frame with the performance of the reference video: its facial expressions, lip movements, head and body motion and timing.` |
| length | the shot's length, or the performance's when shorter, within the model's limits |
| sound | the performance's own sound (the performer speaks the lines), muxed onto the take; no dialogue voices are generated for it |

The take is verified like every take (R4: the judge compares its frames with the locked references) and records the
performance in `request.motionReference` and the model in `request.videoModel`. A shot with a performance renders
alone, never in a multi-shot group. Without a performance model, generating it fails with `performance_unavailable`
(422 on a regenerate; the shot's error in a batch).

## Recording in the studio

The shot's directing panel has **Record a performance**: the camera and microphone in the browser (`getUserMedia`, the
front camera on phones), a live preview, a 3-2-1 countdown, recording with `MediaRecorder` (WebM, or MP4 where the
browser records it) that stops at the shot's length or on *Stop*, playback of what was recorded, then *Use this
performance*: the recording is uploaded as a video resource (role `reference`, named after the shot) and becomes the
shot's motion reference in `performance` mode. *Record again* discards it. Camera and microphone are asked for only
when the dialog opens and released when it closes; a refused permission says how to allow it.

## Surfaces

| | REST | MCP |
|---|---|---|
| set a performance | `PATCH /api/projects/:id/clips/:clipId/shots/:shotId` `{motionReference: {resourceId, mode: 'performance'}}` | `shot_update` |
| render it | `POST /api/projects/:id/clips/:clipId/shots/:shotId/regenerate` | `shot_regenerate` |
| which model | `GET /api/projects/:id/performance` → `{model, available}` | `performance_model` |

Agents cannot record, but they can use footage of a performance the project has. `rideo_performance_takes_total
{outcome}` counts performance takes; logs carry `projectId`, the job and the model.

## mm-gateway

`ModelLimits.supports_performance` (mm-gateway): models that take a driving `reference_video` (a person's
performance) and a `first_frame` with the character, and return the character performing it for the requested
length. Operators declare theirs in `catalog.models`.

## Mock gateway

`mock-performance-v1` (`supports_performance`, `supports_first_frame`, `supports_reference_video`, 1–10 s) returns the
first frame as it is, so the characters' colours stay and the judge passes, with the performance playing in its
bottom-right corner, for the requested length or the performance's when shorter.
