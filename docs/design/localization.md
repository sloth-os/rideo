# Subtitles and localization

A cut is localized from its dialogue: every spoken line is translated, the translations become subtitles, and
dubbing speaks them with each character's own locked voice. Close-ups get their lips re-rendered to the dubbed
line. Exports are language variants of the cut, with burned-in or sidecar subtitles.

| Feature | What | Where |
|---|---|---|
| **Subtitles** | SRT and WebVTT from the cut's captions, in the original or any translated language | `GET …/subtitles.srt`, `.vtt`, export sidecars |
| **Animated captions** | burned-in captions revealed word by word (`build`) or one word at a time (`pop`), timed to the speech | caption `style.animate`, `words` |
| **Translation** | the dialogue lines of the cut, translated by the LLM with the film's context; editable | `localizations/<lang>.json` |
| **Dubbing** | each translated line spoken with the character's locked voice, mixed per take like the original dialogue | `localize.generate` with `dub` |
| **Lip sync** | close-ups (close-up, extreme close-up, medium close-up) re-rendered to follow the dubbed line, watermarked and signed | `localize.generate` with `lipSync` |
| **Language variants** | exports in a language: translated captions, dubbed or original voices | export `language`, `dubbed`, `captions` |

## Captions and word timing

Assembly turns each take's lines into caption items (preset `caption`, `Speaker: line`). Captions carry
**words**: for each word of the line, its character range in the caption text and its time relative to the item:

```ts
type CaptionWord = { from: number; to: number; start: number; end: number };  // text.slice(from, to)
```

Word times come from the speech: ElevenLabs aligns every character, so a line's words get their own start and end
(`take.audio.lines[].words`). Without an alignment (OpenAI speech, native audio, footage transcripts) the words
share the line's time in proportion to their length. Editing a caption's text drops its words (the caption shows
statically).

`style.animate` chooses how a caption is burned in:

| `animate` | Shows | Size |
|---|---|---|
| `none` (default) | the whole line for its duration | caption size |
| `build` | the line up to the word being spoken: words appear as they are said | caption size |
| `pop` | only the word being spoken | large (`h / 12`) |

`textFrames(item)` lists what a text item shows and when; the ffmpeg chunk graph draws one `drawtext` per frame
of it, the WebCodecs compositor and the preview draw `activeAt(t)`'s text, which comes from the same frames, so
all three show the same word at the same time. `set_caption_style {style}` sets `animate`, `position`, `size` or
`color` on every caption of the cut (MCP `timeline_apply`).

## Subtitle files

`subtitleCues(timeline)` reads the caption items in time order. **SRT** numbers them with
`HH:MM:SS,mmm --> HH:MM:SS,mmm`; **WebVTT** starts with `WEBVTT`, uses `HH:MM:SS.mmm`, and adds the word timings
as cue timestamps (`<00:00:01.250>word`), which players use for karaoke-style highlighting. Text keeps the
speaker prefix; cue text is escaped for VTT (`&`, `<`, `>`).

`GET /api/projects/:id/subtitles.srt` and `.vtt` (`?language=es` for a translation) return the current cut's
subtitles. Every export with captions publishes both files beside the video (`export.subtitles`).

## Translation

A language is a document, `localizations/<lang>.json` (`lang` is a BCP 47 code like `es` or `pt-BR`), so it is
versioned, synced and editable over WebDAV like the screenplay:

```ts
type Localization = {
  id: string;                  // the language code
  name: string;                // "Spanish"
  lines: {                     // one per spoken line of a shot in the cut
    shotId: string; index: number; characterId: string | null;
    source: string;            // the line when it was translated
    text: string;              // the translation
    edited: boolean;           // changed by a person: kept when translating again
  }[];
  dubs: Record<takeId, Dub>;   // see Dubbing
  createdAt: string; updatedAt: string;
};
```

The LLM task `dialogue.translate` gets the film (title, logline, tone), the cast (names stay as they are), the
target language and the lines with their speaker and scene, and returns `{lines: [{key, text}]}` validated with
zod. Lines are translated per scene, so each batch keeps its context. A line is **stale** when the shot's line no
longer matches `source`; translating again replaces stale and missing lines and keeps edited ones whose source is
unchanged. `PATCH …/localizations/:lang/lines` edits one translation (`edited: true`).

## Dubbing

With `dub`, every take of the cut with voiced lines is spoken in the language:

1. Each translated line is spoken with the speaker's locked voice (rule V1: `voice_not_locked` otherwise; no TTS
   provider: `tts_unavailable`), the line seed and the language, then laid out and mixed exactly like the
   original dialogue ([dialogue](dialogue.md#from-lines-to-audio)).
2. The dub is stored per take: `{takeId, shotId, clipId, dialogue (the mix), lines (translated, timed, with
   words), voiceLocks, video, watermarkId, contentCredentials}`.
3. With `lipSync`, a close-up whose shot speaks (framing `close_up`, `extreme_close_up` or `medium_close`) goes
   through the lip-sync pass with the dubbed mix (`settings.models.lipSync`). The result is a new video of the
   take: watermarked (registry asset `dub`) and signed as an AI edit of the take (`c2pa.opened` + `c2pa.edited`,
   the take as parent ingredient, [provenance](provenance.md)).

A dub is **current** when its lines are the current translations of its shot and its speakers' voice locks are
unchanged (V6); dubbing again redoes only the others.

## Language variants

`POST /api/projects/:id/exports` takes `language` (default: the original), `dubbed` (default false) and
`captions` (`burn`, default, or `sidecar`):

| | Captions | Voices | Picture |
|---|---|---|---|
| original | the cut's | the cut's | the cut's |
| `language` | translated (original line timings) | original | the cut's |
| `language` + `dubbed` | translated (dub timings and words) | the dubs on the Dialogue track | lip-synced close-ups |

The server derives the variant from the cut with `localizeTimeline()` (shared, pure): captions and Dialogue items
belong to the primary item whose span they start in; for each take they are replaced by the translated captions
and, when dubbed, by the dub mix (the take's own sound muted, as for TTS takes) and the lip-synced video. With
`captions: sidecar` the captions are left out of the picture. The derived timeline is stored as
`renders/<exportId>.json` and rendered like the cut (the tab reads it at the export's commit), and its captions
are published as SRT and VTT. A variant fails with `localization_incomplete` (409) when a line of the cut has no
current translation, or, dubbed, a speaking take has no current dub.

The export records `language`, `dubbed`, `captions` and `subtitles: {language, srt, vtt}`.

## Surfaces

| Surface | REST | MCP |
|---|---|---|
| subtitles | `GET /api/projects/:id/subtitles.srt` / `.vtt` `?language=` | `subtitles_get` |
| caption style | `POST …/timeline/ops` `{op: "set_caption_style", style: {animate?, position?, size?, color?}}` | `timeline_apply` |
| localize | `POST /api/projects/:id/localizations` `{language, dub?, lipSync?}` → `202 Job` (`localize.generate`) | `localize` |
| read | `GET /api/projects/:id/localizations` | `localization_get` |
| edit a line | `PATCH /api/projects/:id/localizations/:lang/lines` `{shotId, index, text}` | `translation_update` |
| remove | `DELETE /api/projects/:id/localizations/:lang` | – |
| export | `POST /api/projects/:id/exports` `{…, language?, dubbed?, captions?}` | `export_render` |

The editor's **Captions & languages** card holds the caption style, the SRT/VTT downloads, every language with
its progress (lines translated, takes dubbed, close-ups lip-synced) and its actions (translate, dub, edit the
translations, subtitles), and adding a language. The export dialog chooses the language, dubbed voices and burned
or sidecar captions; export cards show the language and the subtitle downloads.

Jobs log `projectId`, `jobId` and the language; `rideo_localization_total{op, outcome}` counts translated lines,
dubbed takes and lip-sync passes (`op` = `translate`, `dub`, `lipsync`).

## Mock gateway

`dialogue.translate` answers `«<lang>» <line>` for every line, so tests can see which language a caption or a dub
speaks. The mock's speech and lip-sync models handle the dubs as they handle the original dialogue.
