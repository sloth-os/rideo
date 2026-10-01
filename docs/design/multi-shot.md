# Multi-shot generation

Some video models render a whole sequence in one request: several shots separated by hard cuts, described in the
prompt (mm-gateway publishes how many as `limits.max_shots`). One call per scene instead of one per shot keeps
the light, the set and the faces continuous across cuts, and costs fewer calls. Rideo plans shots exactly as before
and, when the clip's video model is multi-shot, generates **groups** of consecutive shots in one request, splits
the result at its cuts with the same scene-cut detection the footage analysis uses, and verifies every shot.

## When

`clip.generate` uses groups when all of these hold (otherwise it generates shot by shot):

| Condition | Why |
|---|---|
| the project's video model has `max_shots ≥ 2` (a pinned model; `auto` resolves to the first model) and `settings.generation.multiShot` is `auto` (default) | the model renders several shots |
| the dialogue mode is not `native` | native audio is conditioned per speaker sample, shot by shot |
| at least two consecutive shots need a take and have no directing controls that need a request of their own (an image start frame, an end frame, a motion reference) | those shots are generated alone |

Groups take consecutive shots while the group has at most `max_shots` shots and its planned length fits
`max_duration_seconds`. A shot that cannot join a group is generated alone. `shot.group` jobs run like `shot.generate`
jobs (lane `video`).

## Request

```
<style header> A multi-shot sequence of 3 shots separated by hard cuts.
Shot 1 (5 s): <description>. Action: <action>. Camera: <framing, movement or move; lens>. Dialogue: ….
Shot 2 (4 s): ….
Shot 3 (6 s): ….
Characters (keep identities exactly as described and as in the reference images): …  Location (…): …
```

The first shot's start frame is its verified keyframe (or its approved storyboard frame), the references are the
union of the group's cast and elements within `max_input_images` (a cast sheet when needed, R3), the duration is the
group's planned total, and the seed is the first shot's.

## Splitting and verification

The result is analysed with the shared scene-change filter (`select='gt(scene,0.3)',showinfo`, parsed by
`parseAnalysisLog`). When it finds exactly one cut fewer than the group has shots, those cuts split the video;
otherwise the planned durations do. Each segment is judged against its own shot's characters and elements (R4).
If any segment fails, the whole group is generated again (seed offset per attempt) up to `maxAttempts`; then every
shot keeps its best segment (a failed one stays failed, for review or override).

Each segment becomes a take of its shot, finished like any take (watermark, C2PA, poster, last frame), with
`take.request.multiShot = {index, of, cut: 'detected' | 'planned'}` and the group's task. TTS dialogue is spoken per
shot and attached as `take.audio` (lip sync `none`); the Dialogue track plays it.

## Surfaces

Nothing new to call: `POST …/clips/:clipId/generate` (and the batch) choose groups. `settings.generation.multiShot`
(`auto` | `off`) turns it off per project; the clip review marks multi-shot takes (`shot 2 of 3`).

## Mock gateway

`mock-multishot-v1` (`max_shots: 4`, up to 20 s) renders the shots of a multi-shot prompt as segments with different
textures and the same identity signatures, separated by hard cuts at the planned durations.
