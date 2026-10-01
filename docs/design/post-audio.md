# Post audio: stems, ducking, loudness, score and effects

The soundtrack of a cut is planned once in `packages/shared` and played the same way by the preview (WebAudio) and
the render (the ffmpeg soundtrack graph, [editor](editor.md#soundtrack)). Post audio adds four things to it:

| Feature | What | Where |
|---|---|---|
| **Stems** | every audio source belongs to a stem: dialogue, music or effects; exports can deliver the three stems | track `role`, soundtrack buses |
| **Ducking** | the music bus dips under speech, with attack and release ramps | `timeline.mix.ducking`, speech spans |
| **Loudness** | exports are normalized to a target: streaming (−14 LUFS) or broadcast (EBU R128, −23 LUFS), both −1 dBTP | export option, `export.finish` |
| **Score** | one music cue per scene of the cut, planned from the screenplay and generated to the scene's length | `score.generate` job |
| **Effects** | sound effects planned from the shots' action lines, generated and placed at their moments | `sfx.generate` job |

## Stems

An audio source's stem is its track's `role`:

| Source | Default role |
|---|---|
| the primary video track's own sound (production sound, a take's native audio) | `dialogue` (`track.role` can say otherwise) |
| the Dialogue track (`trk_dialoguetrack01`, the takes' TTS mixes) | `dialogue` |
| the Music track (`trk_musicbed000001`, beds and the score) | `music` |
| the Effects track (`trk_effectstrack01`, generated effects) | `effects` |
| any other audio track without a role | `effects` |

Production sound counts as dialogue because it carries the native lines: the music and effects stems together are
then an M&E mix, which [localization](localization.md#dubbing) dubs over. `add_track` and `set_track` take a `role`.

The soundtrack graph mixes each stem on its own bus and then the buses (`amix normalize=0` all the way, so the stems
sum to the mix):

```
item chains of role r → amix → apad,atrim=0:LEN → [bus_r]     (anullsrc when the stem is silent)
[bus_music] → asetnsamples=n=480,volume='<duck expression>':eval=frame   (ducking; 10 ms frames keep ramps smooth)
[bus_dialogue][bus_music][bus_effects] → amix=inputs=3:normalize=0 → [aout]
```

With `stems` on, `asplit` gives each bus a second output (`[stem_dialogue]`, `[stem_music]`, `[stem_effects]`),
rendered in the same ffmpeg run as the mix.

## Ducking

`timeline.mix.ducking = {enabled, depthDb, attackSec, releaseSec}` (defaults on, −12 dB, 0.25 s, 0.6 s). A cut
without `mix` (older cuts) does not duck. Assembly and the auto edit write the defaults; the editor's Mix panel and
the `set_mix` op change them.

**Where speech is.** Items carry `speech`: spans of speech in source time (seconds of the media), written when the
cut is built:

| Item | Speech spans |
|---|---|
| a Dialogue track item (TTS mix) | the mix's line timings (`take.audio.lines[].start/end`) |
| a primary item of a native-audio take with lines | the whole item |
| a primary item of the auto edit | the transcript segments of the footage |
| an item on a dialogue-role audio track without `speech` | the whole item (a voice-over) |
| any other item | none |

The keys are the speech spans of every audible dialogue-role source, mapped to timeline time (`start + (s − in) /
speed`, clipped to the item). Spans closer than `attack + release` are merged, so the music does not pump between
lines. The music gain is

```
g(t) = 1 − (1 − 10^(depthDb/20)) · Σ ramp_in(t) · ramp_out(t)       per merged span [a, b]:
ramp_in = clip((t − (a − attack)) / attack, 0, 1),  ramp_out = clip(((b + release) − t) / release, 0, 1)
```

The same breakpoints drive the preview (`linearRampToValueAtTime` on the music bus's `GainNode`) and the render
(`volume=eval=frame`), so the preview sounds like the export. `duckGainAt(t)` is the reference both are tested
against.

## Loudness

Exports take `loudness`:

| Target | Integrated | True peak | Use |
|---|---|---|---|
| `streaming` (default) | −14 LUFS | −1 dBTP | YouTube, Spotify, the web |
| `broadcast` | −23 LUFS (EBU R128) | −1 dBTP | TV, festivals |
| `off` | – | – | the mix as it is |

The tab renders the soundtrack losslessly (`soundtrack.flac`, and `stem-<role>.flac`). `export.finish` measures it
(`loudnorm` first pass, `print_format=json`) and normalizes it in a second, linear pass with the measured values
(`linear=true`); when the gain would push the true peak over the target, `loudnorm` switches to its dynamic mode and
says so. Stems get the linear gain of the mix (`volume=<output_i − input_i>dB`), so they still sum to the normalized
mix in linear mode. A silent soundtrack (below −70 LUFS) is not normalized. The final soundtrack is AAC 192 kb/s;
stems are published as 24-bit, 48 kHz WAV files.

The export records `loudness = {target, integratedLufs, truePeakDb, lra, inputLufs, mode}` where
`mode` is `linear`, `dynamic` or `silent`, plus `stems = {dialogue, music, effects}` (media) when asked for. Each
stem carries C2PA Content Credentials ([provenance](provenance.md)): a composite placing that stem's sources (the
takes, TTS mixes, cues or effects it mixes); stems have no invisible watermark, which lives in the picture.

The final mux is bounded by the film's length (`-t`), not `-shortest`: with `-shortest` the file ends when the
sound runs out first, dropping the frames still in x264's lookahead (up to half a second). Watermarking takes uses
the same bound.

## Score: one cue per scene

`score.generate` (lane `music`) scores the current cut:

1. **Cues.** The primary items are grouped by scene (a take's clip's `sceneId`; consecutive clips of one scene are
   one cue; items that are not takes join the cue before them). A cue shorter than the music model's
   `min_duration_seconds` joins its neighbour. Without scenes (a footage cut) the whole cut is one cue.
2. **Plan.** The LLM task `score.plan` gets the film (title, genre, tone, the screenplay's visual style), the
   user's direction (optional, ≤ 300 characters) and the cues (length, scene heading, summary, action, whether
   people speak) and returns one composition per cue: a prompt with instrumentation, mood and dynamics, a `bpm`,
   and the arc of the cue (how it starts and ends). The answer is validated with zod (`ScorePlanOutputSchema`).
3. **Generate.** Every cue is a `music.generate` request through `@sloth-os/mm-gateway-js` (instrumental, the cue's
   length plus a 2 s tail for the crossfade, within the model's limits; `bpm`; a seed from the project and the cue)
   imported as a `music` resource with its generation (prompt, model, task).
4. **Lay.** One commit replaces the Music track's items with the cues: cue *k* starts at its scene, overlaps the
   next cue by up to 2 s (crossfade with `fadeIn`/`fadeOut`), first fade-in 2 s, last fade-out 3 s, volume 0.5. A
   cue longer than the model's maximum repeats like a music bed.

## Effects from action lines

`sfx.generate` (lane `music`) adds sound effects to the cut:

1. **Plan.** The LLM task `sfx.plan` gets every take of the cut (index, length, description, action, location)
   and returns at most three effects per shot: a description (what is heard, concrete: "a heavy wooden door creaks
   open"), the moment in the shot (`at`, seconds), a length (0.5–10 s), and `kind`: `spot` (a moment) or
   `ambience` (under the whole shot).
2. **Generate.** Each distinct description and length is one sound-generation request, made through the
   mm-gateway proxy ([AI gateway](ai-gateway.md#sound-effects)): ElevenLabs
   `POST /proxy/api.elevenlabs.io/v1/sound-generation` `{text, duration_seconds, prompt_influence: 0.4}` → MP3.
   The audio is imported as an `sfx` resource with its generation. `RIDEO_SFX_PROVIDER=off` (the default without
   a provider) makes the job fail with `sfx_unavailable`.
3. **Place.** One commit replaces the Effects track's items (the track is created after the Dialogue track):
   a spot effect at `item.start + at / speed` (moved earlier when it would run past the item), an ambience under
   the whole item at volume 0.35 with 0.5 s fades; spot effects at volume 0.8.

## Surfaces

| Surface | REST | MCP |
|---|---|---|
| ducking | `POST …/timeline/ops` `{op: "set_mix", ducking: {enabled?, depthDb?, attackSec?, releaseSec?}}` | `timeline_apply` |
| track roles | `add_track {track: {role}}`, `set_track {role}` | `timeline_apply` |
| score | `POST /api/projects/:id/timeline/score` `{direction?}` → `Job` | `score_generate` |
| effects | `POST /api/projects/:id/timeline/effects` → `Job` | `effects_generate` |
| export | `POST /api/projects/:id/exports` `{…, loudness?, stems?}` | `export_render` |

The editor's **Mix** card (desktop and phones) holds ducking (on/off, depth), *Score the cut* (with an optional
direction) and *Add sound effects*; the lanes show each audio track's stem. The export dialog has the loudness target
and *Stems*. Export cards show the measured loudness and the stem downloads.

Errors: `sfx_unavailable` (422) when no sound-effects provider is configured; `validation_error` when the cut has no
picture. Logs carry `projectId` and `jobId`; `rideo_post_audio_total{op, outcome}` counts score cues, effects and
loudness passes (`op` = `score_cue`, `sfx`, `loudness`).

## Mock gateway

`score.plan` and `sfx.plan` answer deterministically from their input (a cue prompt from the heading and tone; one
spot effect per shot at 30% of it, named after the action's first words). `POST v1/sound-generation` returns a pink
noise burst of the requested length (MP3), so tests can hear where effects land.
