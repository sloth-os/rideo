# Dialogue and character voices

Every leading video model now renders sound, and a feature film without dialogue audio is not deliverable.
Rideo treats a character's **voice** like its face: designed or cloned once, approved, **locked**, and then
used for every line the character speaks. This document covers voices, how screenplay lines become audio,
lip sync, the speaker check, and how dialogue reaches the timeline.

## Voice of a character

`Character.voice` (characters saved before voices existed have none; `voiceOf(c)` reads it as an empty voice):

```ts
type Voice = {
  description: string;                  // "gravelly, gentle, Scottish lilt" — written by the screenwriter
  provider: string | null;              // the TTS service that owns voiceId (elevenlabs, openai)
  voiceId: string | null;               // the provider's voice id (designed, cloned or a preset)
  source: 'designed' | 'cloned' | 'preset' | null;
  sample: MediaRef | null;              // a few seconds of this voice: reference audio and the speaker check's reference
  candidates: { id: string; voiceId: string; sample: MediaRef; createdAt: string }[];   // designed previews
  consent?: Consent;                    // cloned voices (docs/design/provenance.md#consent-records)
  lock: { locked: boolean; version: number; lockedAt?: string; lockedBy?: Actor; identityHash?: string };
};
```

| Action | What happens |
|---|---|
| **Design** (`voice.design` job, lane `music`) | The TTS provider designs three previews from the description (or, without one, from the identity's age and gender and the personality), speaking the character's own lines padded to the provider minimum. They replace `voice.candidates`. |
| **Pick** | The chosen preview becomes the voice (ElevenLabs saves it to the voice library with `POST /v1/text-to-voice`); its audio becomes `voice.sample`. The candidates stay, so the user can pick again until the voice is locked. |
| **Clone** | An uploaded recording, with a consent record (`consent_required` otherwise), becomes an instant voice clone (`POST /v1/voices/add`, the whole recording). The sample is its first 20 s as mono WAV. A clone that `depictsRealPerson` turns on the export's [disclosure label](provenance.md#disclosure-label) like a real person's likeness. |
| **Lock** | Needs a sample, and the provider's voice when the project uses TTS. `identityHash` covers the provider, voice id, sample hash and description, so relocking an unchanged voice keeps its version. |

The voice lock is independent of the face lock: relocking the voice does not touch takes where the character is
silent, and the identity can be edited while the voice stays locked.

### Providers

| `RIDEO_TTS_PROVIDER` | Proxy domain | Design | Clone | Speech |
|---|---|---|---|---|
| `elevenlabs` | `api.elevenlabs.io` | `POST v1/text-to-voice/design` (`eleven_multilingual_ttv_v2`, three previews) → `POST v1/text-to-voice` | `POST v1/voices/add` | `POST v1/text-to-speech/{voice_id}/with-timestamps` (`RIDEO_TTS_MODEL`, default `eleven_multilingual_v2`): audio and per-character timings |
| `openai` | `api.openai.com` | three preset voices chosen from the seed, steered by the description as `instructions` | – (`tts_unavailable`) | `POST v1/audio/speech` (`gpt-4o-mini-tts`) |
| `off` (default) | – | – | – | no dialogue audio |

All TTS traffic goes through the gateway proxy like every other non-generation AI call
([ai-gateway](ai-gateway.md)); upstream keys stay in the gateway. Failures are `gateway_error` (retryable for
429 and 5xx).

## From lines to audio

`settings.dialogue = { mode: 'tts' | 'native' | 'off', lipSync: boolean }`. The schema default is `off` (so
projects created before voices behave as before); a server with a TTS provider creates new projects with
`tts`. A line is **voiced** when its `characterId` names a character; other lines stay captions.

| Mode | The video model gets | The film's dialogue is |
|---|---|---|
| `tts` | the lines in the prompt (so the speakers' lips move) and, when the model accepts reference audio (`supports_reference_audio: true`), **the shot's dialogue mix as `reference_audio`** with `include_audio: true`. Otherwise no sound is requested: the model's own voices would double the TTS. | the TTS mix: exactly the locked voices, on the timeline's *Dialogue* track |
| `native` | the lines in the prompt, `include_audio: true`, and **the speakers' voice samples as `reference_audio`** (in speaking order) when the model accepts reference audio | the take's own sound, checked against the voice locks (V4) |
| `off` | the lines only when `generation.includeAudio` is on | – |

In auto mode mm-gateway routes requests with `reference_audio` only to models that accept it
([mm-gateway auto mode](https://github.com/sloth-os/mm-gateway/blob/main/docs/design/auto-mode.md)).

**Shot dialogue mix (`tts`).** In the shot pipeline, after the keyframe and before the video: every voiced line
is spoken with its speaker's locked voice and a fixed seed (V3); the lines are placed one after another from
0.4 s, 0.3 s apart, and the mix ends 0.5 s after the last line (`layoutDialogue`). The mix is a 48 kHz mono WAV
made with ffmpeg. The video is asked for `max(planned duration, mix length)`, within the model's limits. Line
audio and the mix are stored under `media/dialogue/`.

**Lip-sync pass.** In `tts` mode with `lipSync`, when the model could not take the mix and a speaker is on
screen, the passing (or unverified) take is re-rendered by a second video request: the instruction to move the
speakers' lips in sync, the take as `reference_video`, the mix as `reference_audio`, `include_audio: true`, and
the model `settings.models.lipSync` (`RIDEO_LIPSYNC_MODEL`, default `auto`). The result is judged again like any
take (R4) and replaces the first render only if it does not fail; when no model can do it, the take keeps its
first render. The take records `audio.lipSync: 'conditioned' | 'pass' | 'none'`.

## Rules

| # | Rule | Where |
|---|---|---|
| V1 | **Lock before use.** With dialogue on, generating a shot or clip fails with `voice_not_locked` if a speaker of the shot has no ready voice (locked with a sample; TTS also needs the provider's voice). TTS without a configured provider fails with `tts_unavailable`. | `assertVoicesReady` in `clip.generate`, `shot.generate`, `batch.generate` and the REST/MCP services |
| V2 | **Locked is immutable.** Designing, picking, cloning or changing the description of a locked voice fails with `voice_locked`. Unlock → change → lock increments `voice.lock.version`. | `VoiceService`, `StoryService.updateCharacter` |
| V3 | **Deterministic speech.** Lines are spoken with the locked voice id and a fixed seed per line (`lineSeed(shot, line)`), so a regenerated shot speaks the same way. | `prepareDialogue` |
| V4 | **Speaker check (`native`).** With `settings.consistency.judgeVoices` (default on), the take's sound is compared with each speaker's sample by the `voice.judge` task, an audio-capable LLM through the proxy (`RIDEO_VOICE_JUDGE_PROVIDER`: `openai` with `gpt-4o-audio-preview` or `gemini` with `gemini-2.5-flash`; by default the vision provider, none for Anthropic). A speaker who is missing or sounds different (score below the threshold) fails the take, which is retried like an identity failure; a silent take fails. Without a judge the take stays `unverified` (R9). TTS takes are the locked voices by construction and are not checked. | `verifyVoices` in the shot pipeline |
| V6 | **Drift detection.** A take stores `audio.voiceLocks: {characterId: version}` for its speakers; relocking a voice with changes marks those takes stale. | shared `takeState()` / `staleVoices()` |

R7–R9 apply unchanged: stale or failed takes block clip approval and export. Speaker verdicts are part of the
take's consistency report (`consistency.voices`).

## Take audio

```ts
take.audio = {
  mode: 'tts' | 'native';
  dialogue: MediaRef | null;            // the TTS mix (tts mode)
  lines: { index: number; characterId: string | null; text: string; start: number; end: number; media: MediaRef | null }[];
  voiceLocks: Record<string, number>;
  lipSync: 'conditioned' | 'pass' | 'none';
} | null;                               // null when the shot has no voiced line or dialogue is off
```

Line times are on the take's clock: the line's offset in the mix plus the provider's alignment (the first and
last character) when it returns one. Native takes have no `lines` (their timing is the model's).

## Timeline

`timeline.assemble` adds a **Dialogue** audio track (`trk_dialoguetrack01`, after the music bed) with one item
per take that has a TTS mix, starting with its video item. The take's own sound is muted (`volume: 0`) under its
mix so voices never double. Captions use the real line timings (`audio.lines`); shots without them keep evenly
spread captions. Both editing engines and the export mix every audio track, and the export's C2PA manifest lists
the mixes as AI-generated ingredients.

## Workflow

| Requirement (cast gate) | Satisfied when |
|---|---|
| `voices.speakingLocked` | dialogue is off, or every character with a line in a written scene or a planned shot has a ready voice |

The auto action `voices.design` (autopilot, on entering `cast`) designs voices for speaking characters that have no
voice, sample or candidates. If a screenplay extension brings in a new speaker, the batch designs their voice and
stops with `stopReason: "voices need approval: …"` instead of generating the clip; it continues after the voice is
locked.

## Surfaces

| REST | MCP |
|---|---|
| `POST /api/projects/:id/characters/:cid/voice/design` → job | `character_voice_design` |
| `POST /api/projects/:id/characters/:cid/voice/select` `{candidateId}` | `character_voice_select` |
| `POST /api/projects/:id/characters/:cid/voice/clone` (multipart `file` + `consent`, or `{uri, consent}`) | `character_voice_clone` |
| `POST /api/projects/:id/characters/:cid/voice/lock` / `unlock` | `character_voice_lock` / `character_voice_unlock` |
| `PATCH /api/projects/:id/characters/:cid` `{voice: {description}}` | `character_update` |

`GET /api/config` reports `features.tts` (`{provider, clone}` or null) and `features.voiceJudge`. The MCP project
snapshot shows each character's voice status, lock and candidates.

The Cast view has a **Voice** panel per character (description, design, listen to the previews, pick, clone with
consent, lock); clip review shows each take's dialogue badge, its mix, line timings, lip-sync state and speaker
verdicts; the editor shows the Dialogue track; project settings choose the mode, the lip-sync pass and the
speaker check.

## Observability

Metrics: `rideo_tts_requests_total{provider,op,outcome}`, `rideo_tts_characters_total{provider}`,
`rideo_lipsync_passes_total{outcome}`, `rideo_voice_checks_total{result}`. Errors: `voice_not_locked`,
`voice_locked`, `tts_unavailable` (409, 409, 422). Lip-sync failures and judge outages are logged with the job and
project ids.

## Mock gateway

The mock implements the ElevenLabs and OpenAI speech endpoints under its proxy. Every voice has a signature pitch
(110–300 Hz) written into its id (`gv217x…` previews, `mv217x…` saved and cloned voices; a clone's pitch is
measured from the recording); speech is a syllable-modulated tone at that pitch whose length follows the text,
with linear character timings. `mock-video-v1` accepts reference audio and plays it as the video's sound;
`mock-video-lite-v1` does not (its sound is a 330 Hz tone), so its TTS takes go through the lip-sync pass and its
native takes fail the speaker check; `mock-lipsync-v1` (chosen by auto routing for `reference_video`) keeps the
reference video and plays the reference audio. The mock `voice.judge` compares the reference pitch with the
pitch of every 0.2 s window of the take.
