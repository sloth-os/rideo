# Rideo documentation

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | System overview, components, data flow, repository layout, technology choices |
| [design/workflows.md](design/workflows.md) | Declarative stage machines for the story → movie and footage → edit workflows |
| [design/storage-webdav.md](design/storage-webdav.md) | WebDAV asset layout, storage backends, embedded `/dav` server, external edits and the inbox |
| [design/version-control.md](design/version-control.md) | Content-addressed objects, commits, branches, tags, coalescing, diff, restore |
| [design/elements.md](design/elements.md) | Locations, props and styles as locked references, with the same lock and verification rules as characters |
| [design/take-editing.md](design/take-editing.md) | Derived takes: video-to-video edits (restyle, relight, replace, angle, remove), extensions, generative extend in the cut |
| [design/localization.md](design/localization.md) | Subtitles (SRT, WebVTT), word-level animated captions, translation, dubbing with the characters' voices, lip-synced close-ups, language-variant exports |
| [design/post-audio.md](design/post-audio.md) | Post audio: dialogue, music and effects stems, ducking, EBU R128 loudness, a score of one cue per scene, sound effects from action lines |
| [design/multi-shot.md](design/multi-shot.md) | Multi-shot generation: consecutive shots in one request for models that render several shots, split at the cuts and verified shot by shot |
| [design/directing.md](design/directing.md) | Directing controls: camera moves, lens and aperture, start and end frames, motion references, seeds, variations and A/B comparison |
| [design/storyboard.md](design/storyboard.md) | The storyboard stage, board frames reused by the video pass, the animatic, screenplay import (Fountain, FDX, PDF), shot lists |
| [design/dialogue.md](design/dialogue.md) | Character voices (designed or cloned, locked), TTS or native dialogue, lip sync, the speaker check, the Dialogue track |
| [design/character-consistency.md](design/character-consistency.md) | How consistency is guaranteed: identity lock, deterministic conditioning, judge gate, continuity, drift |
| [design/generation-pipeline.md](design/generation-pipeline.md) | Job queue, shot pipeline, batch generation to target length, retries, idempotency |
| [design/ai-gateway.md](design/ai-gateway.md) | mm-gateway SDK usage, the LLM/vision/STT proxy, prompts and structured output, the mock gateway |
| [design/mcp.md](design/mcp.md) | MCP server, transport, tool catalogue, UI control, agent attribution |
| [design/realtime-sync.md](design/realtime-sync.md) | Live WebSocket protocol, events, sequence/replay, presence, UI commands |
| [design/watermark.md](design/watermark.md) | Invisible watermark algorithm, payload, registry, detection, robustness |
| [design/provenance.md](design/provenance.md) | C2PA Content Credentials, the public detection tool, the disclosure label, consent records (EU AI Act Article 50) |
| [design/editor.md](design/editor.md) | Timeline model and ops, the browser media engine (ffmpeg.wasm + WebCodecs), local proxies, analysis, chunked rendering, editor jobs |
| [api/rest.md](api/rest.md) | REST API reference |
| [testing.md](testing.md) | Test pyramid, suites, fixtures, CI jobs |
| [deployment.md](deployment.md) | Configuration, Docker, connecting mm-gateway and an external WebDAV server |
| [brand.md](brand.md) | Brand and UI design tokens |
| [roadmap.md](roadmap.md) | Market research (Sept 2026) and the prioritized list of features to build next |

## Glossary

| Term | Meaning |
|---|---|
| Project | One production. `kind: story` (generated movie) or `kind: edit` (footage edit). |
| Screenplay | Title, style bible, full-length outline, and fully written scenes. |
| Outline beat | One planned scene of the full-length story; it becomes a written scene on demand. |
| Character | A cast member with a locked identity and approved reference images. |
| Clip | 10 s–3 min of the movie, usually one scene. The unit of user review and approval. |
| Shot | One generation unit inside a clip (a model-sized duration, e.g. 4–10 s). |
| Take | One generated attempt of a shot: keyframe, watermarked video, poster, consistency report, watermark id. |
| Timeline | Tracks of items that reference takes or media, edited with pure operations. |
| Gate | An approval that moves a workflow to its next stage. |
| Actor | Who made a change: `user`, `agent` (MCP client), `system` (jobs), or `webdav` (external edit). |
