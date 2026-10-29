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
| a shot that joins a group has no approved storyboard frame (one may open a group: the frame starts the sequence) | an approved frame is where its shot starts, and a sequence starts only from its first shot's frame |
| for a model whose limits say `exclusive_frames_and_references` (Wan 3.0): every shot of the group shows only characters of its first shot, and lasts at most 5 s | the request carries the first shot's frame and no references, so the model knows only the faces in that frame; Wan 3.0's guide gives each shot of a sequence 2–5 s |

Groups take consecutive shots while the group has at most `max_shots` shots and its planned length fits
`max_duration_seconds`. A shot that cannot join a group is generated alone. `shot.group` jobs run like `shot.generate`
jobs (lane `video`).

## Planning for sequences

A sequence can only form from shots that can join it, so when the project's video model renders sequences from a
first frame (`max_shots ≥ 2` and `exclusive_frames_and_references`: Wan 3.0) and multi-shot is `auto` and the
dialogue is not `native` (`plansForSequences`), the plan is made for them: `clip.plan` plans shots of at most 5 s
(`plannedShotRange(limits, {sequences: true})`; the writer's longest line follows) and is told so
(`sequence: {maxShots, maxDurationSec}`), and it opens the scene with a shot that shows every character in it, so the
shots after it show only faces its first frame has. Planned for single takes, the swimming film's scene 7 was made
again as six shots, four of them single takes (longer than 5 s, or opening on one panda), and only one sequence of
two shots formed.

## Request

```
<style header> A multi-shot sequence of 3 shots separated by hard cuts.
Shot 1 [0-5s]: <description>. Action: <action>. Camera: <framing, movement or move; lens>. Dialogue: …. Hard cut.
Shot 2 [5-9s]: …. Hard cut.
Shot 3 [9-15s]: ….
Characters (keep identities exactly as described and as in the reference images): …  Location (…): …
```

The shot labels carry their time in the sequence, contiguous from 0, as Wan 3.0's guide writes them
(`Shot N [start-end s]:`), so the cuts land where the plan puts them.

The first shot's start frame is its verified keyframe (or its approved storyboard frame), the references are the
union of the group's cast and elements within `max_input_images` (a cast sheet when needed, R3), the duration is the
group's planned total, and the seed is the first shot's.

A sequence carries sound when its takes carry the model's own voices (`dialogue.mode: off` with
`generation.includeAudio`): each shot's lines are in its shot line, in its speaker's voice (`Rosie says, in a clear,
bright voice: "…" Lip sync.`), and the sound line follows the cast ("No BGM, no music…"). With TTS dialogue the
sequence is silent and each shot's lines are spoken by TTS (below). One voiced Wan 3.0 sequence of five shots and five
lines put every line, word for word and in the right voice, inside its own shot ([improvement 50](../improvements.md)).

## Splitting and verification

The result is analysed with the shared scene-change filter (`select='gt(scene,0.3)',showinfo`, parsed by
`parseAnalysisLog`). When it finds exactly one cut fewer than the group has shots, those cuts split the video;
otherwise the planned durations do. The model keeps its own timing: Wan 3.0 cut a 3/4/3/4/3 s plan at 3.3, 8.1, 10.5
and 14.2 s, and each take keeps its segment's length. A detected cut is its new shot's first frame, rounded to the
millisecond (10.042 for 10.0417), so a segment ends, and the next begins, half a frame before it: cut at the rounded
time, a take ended on one frame of the next shot, which the jump check saw.

Each segment is cut with its sound and checked like a single take
([quality checks](continuity.md#quality-checks-in-the-gate)): its identity against its own shot's characters and
elements (R4) and, with the quality checks, the judge's physics and cast-in-frame verdict, its own jumps (a segment
split at the planned durations may hold a cut) and, when it carries voices and an audio-visual model is set, its
shot's lines heard (`sound.check`). A render whose every segment passes is used whole (continuity across its cuts).

- An identity-only group (silent, without the quality checks) is generated again (seed offset per attempt) up to
  `maxAttempts`; then every shot keeps its best segment (a failed one stays failed, for review or override).
- A voiced or checked group is rendered once. Every segment must pass, so a whole render passes less often than one
  shot does (at the swimming film's 94 % first-attempt rate, eight shots pass together 61 % of the time), and another
  render costs the whole sequence again. A shot whose segment fails keeps it as a failed take and is made again
  alone (`shot.generate`, with its own attempts and the scene's reference frame), starting from the segment's first
  frame (`startFrame`; `firstFrameSource: sequence`), so the remake keeps the sequence's light, water and props: made
  from new keyframes, scene 7's two remakes came back at sunset and among rocks that the sequence did not have. A
  continuous shot starts from the shot before it, as any continuous shot does (that last frame is the sequence's
  too). The first frame is trusted only when what failed was the segment's sound or its physics: a segment whose
  identity failed, that showed someone who is not in the shot, or that jumped may open on the wrong picture (scene 7's
  fourth segment opened on Sammy before cutting to Rosie, and its remake from that frame failed the same way), so
  it is made again from a new keyframe. The group's job waits for the remakes.

The segments are checked at the same time, four at once: each check waits on the judge and the listener, and eight
segments checked one after another made a scene take 30 minutes against 16 for single takes.

`rideo_sequence_segments_total{outcome}` counts the segments that passed and failed.

Each segment becomes a take of its shot, finished like any take (watermark, C2PA, poster, last frame), with
`take.request.multiShot = {index, of, cut: 'detected' | 'planned'}` and the group's task. TTS dialogue is spoken per
shot and attached as `take.audio` (lip sync `none`); the Dialogue track plays it.

## Surfaces

Nothing new to call: `POST …/clips/:clipId/generate` (and the batch) choose groups. `settings.generation.multiShot`
(`auto` | `off`) turns it off per project; the clip review marks multi-shot takes (`shot 2 of 3`).

## Mock gateway

`mock-multishot-v1` (`max_shots: 4`, up to 20 s) renders the shots of a multi-shot prompt as segments with different
textures and the same identity signatures, separated by hard cuts at the planned durations, with sound when asked
(`include_audio`), so the sound check hears each segment's lines.
