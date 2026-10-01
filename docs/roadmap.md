# Roadmap: what to build next

Market research of September 2026. It compares Rideo with the AI filmmaking studios, editors, audio,
review and provenance tools people use today, and turns the gaps into a prioritized feature list. Each item
says **why** (evidence from other products), **how** it fits Rideo's architecture, and a rough effort
(S ≤ 1 week, M 1–3 weeks, L > 3 weeks for one engineer).

## Products surveyed

| Category | Products |
|---|---|
| AI filmmaking studios | Google Flow + Veo 3.1, Runway (Gen-4.5, Aleph 2.0, Workflows, Agent), Kling 3.0 / Omni, Luma Dream Machine (Ray3), LTX Studio + LTX-2, Higgsfield (Popcorn, Cinema Studio), Moonvalley Marey, OpenAI Sora 2 (discontinued) |
| Editors | Adobe Premiere Pro + Firefly video editor, DaVinci Resolve 20, Descript |
| Review and collaboration | Frame.io v4, Runway comments and team plans |
| Audio and localization | ElevenLabs (TTS v3, Dubbing v2, SFX, Music), Adobe Generate Speech / Generate Soundtrack, HeyGen, sync.so, Hedra |
| Previs | LTX storyboard generator, Higgsfield Popcorn, Storyboarder.ai, StoryTribe, Beatboard |
| Provenance and regulation | C2PA Content Credentials, Google SynthID, EU AI Act Article 50 |
| Agents | Google Flow Agent and Flow Tools, Runway Agent / Workflows / MCP, Descript Underlord + MCP, ElevenLabs MCP |

## What the market converged on (2025–2026)

1. **Sound comes with the picture.** Veo 3.1, Kling 3.0, LTX-2 and Seedance 2.5 generate dialogue, effects and
   music in the same pass, lip-synced ([Flow](https://www.solidaitech.com/2026/05/google-flow.html),
   [Kling 3.0](https://kling.ai/feature/kling-video-3), [LTX-2](https://huggingface.co/Lightricks/LTX-2),
   [Runway changelog](https://runway.com/changelog)). Kling 3.0 Omni **binds a voice to a character** from a
   reference clip so every line keeps the same voice
   ([Kling Omni guide](https://kling.ai/quickstart/klingai-video-3-omni-model-user-guide)).
2. **Consistency covers more than faces.** Characters, objects, locations and styles are saved assets:
   LTX *Elements*, Flow *ingredients*, Kling multi-element binding, Seedream 5.0 with up to 14 references
   ([LTX Studio](https://ltx.studio/blog/ltx-storyboard-generator-update), [Kling 3.0](https://morphic.com/resources/how-to/kling-3.0),
   [Runway changelog](https://runway.com/changelog)).
3. **Storyboard first.** Script → shot list → consistent storyboard → animatic before paying for video
   (LTX, [Higgsfield Popcorn](https://higgsfield.ai/blog/script-to-ai-storyboard-shot-list)); previs tools import
   Final Draft `.fdx` and Fountain and export shot lists and animatics
   ([Storyboarder.ai](https://www.storyboarder.ai/), [StoryTribe](https://storytribeapp.com/videoproduction)).
4. **Directing controls.** First/last frame and scene extension to 148 s continuous takes in Veo 3.1
   ([extend](https://www.eachlabs.ai/google/veo3-1/veo3-1-extend-video)), up to 16 keyframes in Ray3
   ([Luma](https://lumalabs.ai/news/ray3-modify)), lens, focal length, aperture and 30+ camera-move presets in
   Higgsfield Cinema Studio ([Cinema Studio 4](https://alphasignal.ai/news/higgsfield-s-cinema-studio-4-gives-solo-creators-full-film-set-control)),
   motion and pose transfer in Marey ([Moonvalley](https://petapixel.com/2025/07/09/moonvalley-releases-marey-an-ethical-ai-video-tool-built-for-pro-filmmakers/)),
   webcam performance capture in Runway Act-Two ([Act-Two](https://www.cometapi.com/runway-act-two/)).
5. **Multi-shot generation.** Kling 3.0 plans and renders up to six connected shots in one pass
   ([Kling](https://lumalabs.ai/news/kling-review)); Seedance 2.5 renders 30 s with audio.
6. **Editing generated video, not only generating it.** Edit one frame and propagate, replace objects or
   backgrounds, new camera angles (Runway Aleph 2.0 in Edit Studio), video-to-video with character references
   and start/end frames (Luma Ray3 Modify), object insertion and removal (Flow, Premiere), Generative Extend
   (Premiere) ([Runway Gen-4.5](https://www.therundown.ai/tools/runway-gen-4-5),
   [Premiere](https://www.adobe.com/products/premiere/extend-video.html)).
7. **Finishing.** Frame-rate enhancement to 25–120 fps and 4K, SDR→HDR grading (Runway), native 16-bit HDR with
   EXR (Ray3), ProRes and image-sequence exports.
8. **Post audio and localization.** Automatic mix (Resolve Audio Assistant), soundtrack generated to fit the cut
   (Firefly Generate Soundtrack), expressive voice-over with emotion and pacing (Firefly Generate Speech, Aug
   2026), word-level animated subtitles (Resolve 20), dubbing with lip sync in 90–175 languages (ElevenLabs
   Dubbing v2, HeyGen) ([Resolve 20](https://www.cined.com/davinci-resolve-20-released-with-handful-of-ai-assisted-features/),
   [Firefly](https://www.engadget.com/apps/adobes-firefly-can-now-use-ai-to-generate-soundtracks-speech-and-video-120018593.html),
   [ElevenLabs dubbing](https://elevenlabs.io/blog/dubbing-api), [HeyGen](https://www.heygen.com/blog/best-ai-dubbing-tools)).
9. **Agents everywhere.** Flow Agent keeps project memory, brainstorms dialogue, makes variations and batch edits;
   Flow Tools builds custom tools from natural language
   ([SiliconANGLE](https://siliconangle.com/2026/05/19/google-flow-adds-agentic-brainstorming-precise-editing-tools-sharing-features/)).
   Runway has Agent Timeline, Skills, Brand Kits, node Workflows and an MCP server; Descript and ElevenLabs ship
   MCP servers ([valmera](https://valmera.io/mcp/video-editing-mcp-servers)).
10. **Model churn is normal, so routing matters.** OpenAI ended the Sora app on 26 April 2026 and the Sora API on
    24 September 2026 ([c2paviewer](https://c2paviewer.com/articles/openai-google-c2pa-synthid-2026)).
    Runway added a Model Router, capacity fallbacks and per-task cost reporting ([changelog](https://runway.com/changelog)).
11. **Review and teams.** Timecoded comments and annotations, approval stages, share links without accounts
    (Frame.io v4), comments on assets with @-mentions, team plans and SSO (Runway)
    ([Frame.io v4](https://www.redsharknews.com/frame.io-v4-gets-smarter-search-interactive-html-reviews-built-in-content-credentials-and-more)).
12. **Interchange with NLEs.** AI editors export FCPXML, Premiere XML, OTIO and EDL that relink to the originals
    (Descript, [Eddie AI](https://www.heyeddie.ai/help/export-to-your-nle)); Runway ships Premiere, After Effects and
    Resolve plugins.
13. **Provenance is now a compliance requirement.** Runway, Adobe and Synthesia attach C2PA Content Credentials;
    Google marks with SynthID; OpenAI joined the C2PA steering committee and adopted SynthID in May 2026. The
    **EU AI Act Article 50** applies from 2 August 2026: providers must mark generated audio, image and video in a
    machine-readable way and offer a free detection tool; deployers must disclose deepfakes. Systems already on the
    market have until 2 December 2026 for the marking
    ([Article 50 guide](https://artificialintelligenceact.eu/transparency-rules-article-50/),
    [provenance 2026](https://sesamedisk.com/ai-content-provenance-2026-c2pa-watermarking/)).

## Where Rideo stands

| Capability | Rideo today | Market leaders |
|---|---|---|
| Long-form pipeline (script → 40–60 min film with approvals) | **Yes**: staged workflow, pilot, batch to target length | Clips and sequences (Veo 148 s, Kling 6 shots, Seedance 30 s); Flow/LTX assemble many clips by hand |
| Character consistency | **Verified**: identity locks, judge gate with evidence, overrides, stale detection | Reference-based, no verification gate |
| Locations, props, styles as locked references | Scene `location` is text only | LTX Elements, Flow ingredients, Kling elements |
| Dialogue audio, character voices | Dialogue exists as screenplay text only; `voice.description` field only | Native lip-synced dialogue, voice binding |
| Storyboard / animatic | Keyframes exist per shot, no storyboard stage | LTX, Higgsfield, previs tools with FDX/Fountain |
| Directing controls | Framing + movement enums; first frame from continuity | First/last frame, 16 keyframes, lens presets, motion/pose transfer |
| Editing generated takes | Regenerate only | Aleph 2.0, Ray3 Modify, extend, object insert/remove |
| Editor | Single video track + audio/text tracks, transitions, speed, fades, color, titles; browser engine (ffmpeg.wasm + WebCodecs) | Multitrack, transcript editing, generative extend, auto mix, animated subtitles |
| Footage → edit | Analysis signals + AI suggestions + auto edit | Descript Underlord, Resolve IntelliScript |
| Assets and versioning | **WebDAV + git-like history, branches, tags** | Project libraries, versions per asset |
| Agents | **MCP with 58+ tools and live UI control** | Flow Agent, Runway Agent/MCP, Descript MCP |
| Provenance | **Invisible keyed watermark + registry + detector**, container metadata | C2PA + SynthID |
| Review and teams | Single-studio, optional bearer token, presence | Share links, timecoded comments, approvals, SSO |
| Interchange | MP4 exports | FCPXML / XML / OTIO / EDL, NLE plugins |
| Model routing and cost | Per-project model settings, `maxGenerations` budget | Router, fallbacks, cost per task, credit analytics |

Rideo's differentiators are the verified consistency gate, the long-form stage machine, versioned open storage,
agent control of the live UI and the in-browser editor engine. The gaps are sound, elements beyond characters,
previs, directing and editing controls on takes, compliance-grade provenance, and team review.

**Leverage we already have:** mm-gateway's video API accepts `last_frame`, `reference_audio`, `reference_video`,
`camera_motion` and `include_audio` (see the mm-gateway README), and none of them is used by Rideo yet. Several
items below are mostly Rideo-side work.

## Prioritized features

### P0 — next milestone

**1. Dialogue and character voices** (L) — *done:* [design/dialogue.md](design/dialogue.md)
- *Why:* every leading model now ships lip-synced dialogue; a feature film without dialogue audio is not
  deliverable. Kling binds voices to characters; Firefly and ElevenLabs offer expressive, directable speech.
- *What:* a **voice lock** per character (designed or cloned voice, reference clip) next to the identity lock;
  dialogue lines become audio: shots with dialogue go to native-audio models with `include_audio` and the voice as
  `reference_audio`; otherwise TTS through the gateway proxy (ElevenLabs v3) plus a lip-sync pass. Dialogue lands on a
  dialogue track in the timeline; captions come from the same lines.
- *Consistency:* extend the judge with a speaker-similarity check against the voice lock (R1/R6 apply to voices:
  relocking a voice marks dependent takes stale).
- *Fits:* `CharacterSchema.voice` grows into a locked voice asset; `ShotSchema` gains `dialogueLineIds`; new TTS task
  in `ai/` via the proxy; `Take` gains an audio stream flag; docs: character-consistency, generation-pipeline.

**2. Elements library: locations, props, wardrobe states** (M) — *done:* [design/elements.md](design/elements.md)
- *Why:* LTX Elements, Flow ingredients and Kling elements treat places and objects as saved references;
  continuity errors in long films are as often about sets and props as faces.
- *What:* `elements/<id>.json` documents (kind `location` | `prop` | `style`) with reference sheets, the same
  approve → lock → verify rules as characters; scenes reference a location element; the prompt compiler adds element
  references within `max_input_images`; the judge scores location/prop consistency when configured.
- *Fits:* generalize `lock`/`references` from characters; workflow requirement `elements.allLocked` for elements
  used by scheduled shots; MCP `element_*` tools.

**3. Storyboard and animatic stage** (M) — *done:* [design/storyboard.md](design/storyboard.md)
- *Why:* storyboard-first is the standard pre-production flow (LTX, Higgsfield Popcorn, previs tools) and it saves
  money: images are far cheaper than video.
- *What:* a `storyboard` stage between cast and pilot: generate the verified keyframe of every shot of the first N
  scenes (Rideo already generates keyframes), a grid view to reorder, regenerate and approve, and an animatic
  (keyframes + TTS dialogue + temp music) played by the browser engine. Import `.fdx` / Fountain / PDF screenplays;
  export shot lists (CSV/PDF) and the animatic (MP4).
- *Fits:* workflow stage table + gate `storyboard_approved`; keyframes become reusable first frames for the video
  pass (no second image generation); parsing in `shared/screenplay`.

**4. Provenance compliance: C2PA manifests and disclosure** (M) — *done:*
[design/provenance.md](design/provenance.md)
- *Why:* EU AI Act Article 50 (2 Aug 2026; 2 Dec 2026 for systems already on the market) requires machine-readable
  marking and a free detection tool; C2PA is what Adobe, Runway, OpenAI and Frame.io use.
- *What:* sign every take and export with a C2PA manifest (AI-generated assertion, generator, ingredients = source
  takes/resources, the Rideo watermark id) using `c2pa-node`/`c2pa-rs` on the server (the key stays server-side, like
  the watermark key); verify page reads C2PA as well as the invisible mark; optional visible "AI-generated" label
  preset for deepfake disclosure; consent records for uploaded references of real people (cf. Sora cameos'
  permission model); document `/api/watermark/detect` as the public detection endpoint.
- *Fits:* finishing pass (`export.finish`) and shot pipeline; `docs/design/watermark.md`; settings for label policy.

**5. Model routing, fallbacks and cost control** (M) — *done in mm-gateway's auto mode*
(mm-gateway `docs/design/auto-mode.md`)
- *Why:* models appear and disappear (Sora); Runway routes automatically, falls back on capacity limits and reports
  cost per task.
- *What:* per-shot routing rules (dialogue → native-audio model, fast action → motion-strong model, long take →
  extend-capable model) with pinned pilot models preserved; automatic fallback on retirement or capacity errors
  (re-verified by the judge); pre-batch cost estimate, per-project cost ledger from gateway usage, budget caps that
  pause the batch.
- *Fits:* `gateway/` limits cache already knows models; `batch.generate` budget becomes money-aware; metrics +
  a cost panel in Overview; MCP `budget_*`.

### P1 — quality and control

**6. Directing controls in the shot editor** (M) — *done:* [design/directing.md](design/directing.md) — first/last frame (`last_frame`), several keyframes, camera
presets (lens, focal length, aperture, move library mapped to `camera_motion`), motion reference and pose reference
from a video (`reference_video`), seeds and N variations per shot with an A/B compare view. *Why:* Veo 3.1, Ray3,
Higgsfield, Marey. *Fits:* `ShotSchema`, prompt compiler, clips view.

**7. Editing takes and extending them** (L) — *done:* [design/take-editing.md](design/take-editing.md) — video-to-video edits of a take (restyle, relight, replace
object/background, new angle) re-verified by the judge; "extend take" (+N s continuation keeping audio);
**generative extend** in the editor to fill a trim gap; object removal. *Why:* Aleph 2.0, Ray3 Modify, Flow object
insertion/removal, Veo extend, Premiere Generative Extend. *Fits:* new job `take.edit`, takes keep lineage
(`derivedFrom`), watermark/C2PA on every derived take.

**8. Multi-shot generation** (M) — *done:* [design/multi-shot.md](design/multi-shot.md) (models publish `max_shots` in mm-gateway) — for models that render several shots per call (Kling 3.0, Seedance 2.5), plan
and generate a scene in one request, split it into shots with the existing scene-cut detection, verify each shot.
Better continuity and fewer calls. *Fits:* `clip.generate` chooses single- vs multi-shot per model limits.

**9. Post audio: mix, score, effects** (M) — *done:* [design/post-audio.md](design/post-audio.md) — dialogue/music/effects stems, ducking and loudness normalization
(EBU R128) in the shared soundtrack graph; a score generated to fit the cut (per-scene cues with music composition
plans); sound effects generated from the action lines. *Why:* Resolve Audio Assistant, Firefly Generate Soundtrack,
ElevenLabs SFX/Music, Runway Seed Audio. *Fits:* `shared/media/render-plan.ts` soundtrack graph, `music.generate`.

**10. Subtitles and localization** (M–L) — *done:* [design/localization.md](design/localization.md) — SRT/VTT export, burn-in styles including word-level animated captions;
dialogue translation; dubbed audio tracks per language with the character's voice and lip-sync re-render of
close-ups. *Why:* Resolve animated subtitles, Premiere caption translation, ElevenLabs Dubbing v2, HeyGen.
*Fits:* timeline text items from dialogue timing; exports gain language variants.

**11. Finishing and deliverables** (M) — *done:* [design/finishing.md](design/finishing.md) — 4K upscale and 24→48/60 fps interpolation through gateway models, ProRes
and image-sequence masters, delivery presets (YouTube, broadcast), social cut-downs with auto-reframe to 9:16 and
1:1, thumbnails. *Why:* Runway Enhance Frame Rate/Ruby HDR, Ray3 EXR, Premiere auto reframe. *Fits:* export options
+ server finishing presets.

### P2 — teams, ecosystem, scale

**12. Review and approvals with outside reviewers** (M) — share links without accounts, timecoded comments and
frame annotations on takes and cuts, approval stages mapped to Rideo gates, @-mentions and notifications; comments
are versioned documents; MCP tools let agents read and resolve notes. *Why:* Frame.io v4, Runway comments on assets.

**13. Accounts, roles and teams** (M) — OIDC/SSO login, roles (director, editor, reviewer, agent), per-project
permissions, audit log, scoped agent tokens. Lifts the single-studio non-goal.

**14. NLE interchange** (S–M) — export OTIO, FCPXML, Premiere XML and EDL that relink to the originals on WebDAV;
import OTIO. *Why:* Descript, Eddie AI, Runway NLE plugins.

**15. Editor depth** (L) — multitrack video (B-roll, picture-in-picture, overlays), keyframed transform and
opacity, speed ramps, LUTs, segmentation masks ("remove the background"), transcript-based editing for footage
projects with filler-word removal, waveforms and filmstrips. Requires relaxing the one-video-track rule in both
engines. *Why:* Descript, Firefly video editor, Resolve IntelliScript, Runway SAM3 segmentation.

**16. Agent upgrades** (S–M) — MCP prompts and resources for common jobs ("direct this scene", "address the review
notes"), reusable recipes (cf. Runway Skills, Flow Tools), batch variations, tools for storyboard, voice casting
and dubbing. *Why:* Flow Agent, Runway Agent, Descript Underlord.

**17. Brand kits and templates** (S) — fonts, logos, colors for titles; intro/outro bumpers; lower-third templates;
optional visible brand bug. *Why:* Runway Brand Kits, Firefly title templates.

**18. Semantic media search** (M) — natural-language search over takes, footage and resources ("close-ups of Mira at
night") from vision captions/embeddings through the proxy. *Why:* Premiere Media Intelligence, Frame.io search.

**19. Performance-driven animation** (M) — drive a locked character from a webcam or phone performance, or a
motion/pose reference, when the gateway exposes such a model. *Why:* Runway Act-Two, Marey pose transfer.

**20. Editor engine performance** (M) — multi-threaded ffmpeg.wasm (core-mt under cross-origin isolation where
available), WebGPU compositing, rendering that survives a backgrounded tab, local proxies made with WebCodecs when
the source decodes.

**21. Self-hosted open-weight models** (S–M) — LTX-2 (open weights, native audio, 4K/50 fps, 20 s) and Wan 2.2 as
mm-gateway backends for cost and privacy, with a documented GPU setup. *Why:* [LTX-2](https://huggingface.co/Lightricks/LTX-2).

**22. Installable mobile app (PWA)** (S) — review, approvals and agent monitoring on phones. *Why:* Flow mobile apps.

## Suggested sequencing

| Milestone | Items | Outcome |
|---|---|---|
| M1 "Talking pictures, compliant" (by 2 Dec 2026) | 4, 1, 5 | Films with consistent character voices; C2PA + disclosure for EU AI Act Article 50; routing that survives model churn |
| M2 "Previs and control" | 3, 2, 6, 8 | Storyboard/animatic gate, locations and props locked, directing controls, multi-shot scenes |
| M3 "Post and team" | 7, 9, 10, 12, 14, 11 | Take editing and extend, mixed and scored soundtrack, subtitles and dubbing, review links, NLE hand-off, finishing |
| Later | 13, 15–22 | Teams and SSO, multitrack editor, agent recipes, search, performance capture, engine speed, open models, PWA |

## Deliberately not planned

- A social feed of generated clips (the Sora app model) — Rideo is a production tool.
- Presenter avatars and real-time conversational characters (Synthesia, HeyGen, Runway Characters) — a different
  product category; lip-synced dialogue (item 1) covers what films need.
- Training our own foundation models — Rideo stays model-agnostic through mm-gateway.
