# NLE interchange

Editors finish films in Premiere Pro, DaVinci Resolve, Final Cut Pro or Avid. Rideo hands them the cut as an
interchange file whose clips point at the **originals on WebDAV** (the same immutable, content-addressed media the
studio uses), and takes a re-edited cut back as OpenTimelineIO.

| Format | File | For | Export | Import |
|---|---|---|---|---|
| OpenTimelineIO | `<title>.otio` (JSON, `Timeline.1`) | Resolve, Premiere (via OTIO), Avid (via adapters), pipelines | yes | yes |
| FCPXML 1.10 | `<title>.fcpxml` | Final Cut Pro, Resolve | yes | – |
| Final Cut Pro 7 XML (`xmeml` 5) | `<title>.xml` | Premiere Pro, Resolve, Avid (via conversion) | yes | – |
| CMX 3600 EDL | `<title>.edl` | Avid, Resolve, conform and online | yes (picture) | – |

The cut (`timeline`, or `animatic` for previs) is converted by pure functions in `packages/shared/src/interchange`
(no I/O, the same code in tests); the server adds media locations and review notes and serves the file.

## Where the media is

Every clip references its media file by URL: `<mediaBase>/projects/<projectId>/<media.path>`, where `mediaBase`
is the WebDAV root as the editing machine sees it:

| mediaBase | When |
|---|---|
| default: `${RIDEO_WEBDAV_URL}${RIDEO_WEBDAV_ROOT}`, or `${RIDEO_PUBLIC_URL}/dav${RIDEO_WEBDAV_ROOT}` with the embedded server | tools that read media over HTTP (OTIO pipelines) |
| `file:///Volumes/dav/rideo` | the share mounted in Finder (Connect to Server → `http://HOST:8787/dav/`) — what FCP and Premiere need |
| `file:///Z:/rideo` | the share mapped to a drive on Windows |
| `file:///mnt/rideo/rideo` | `mount -t davfs` or `rclone mount` on Linux |

Media files keep readable names (`media/<kind>/<name>-<hash12>.<ext>`), so an NLE that lost the path relinks by
file name in that folder. The studio remembers the last `mediaBase` per viewer.

## Mapping

Times are seconds in Rideo. OTIO keeps them exact (`RationalTime` at the cut's fps, fractional values allowed);
FCPXML, XML and EDL use whole frames at the cut's fps (`round(seconds × fps)`, boundaries rounded once so clips
stay adjacent). Record timecode starts at `01:00:00:00`; source timecode is the media time from `00:00:00:00`
(generated media carries no timecode), non-drop-frame (Rideo's frame rates are integers).

| Rideo | OTIO | FCPXML | XML (`xmeml`) | EDL |
|---|---|---|---|---|
| cut (fps, size, title) | `Timeline` + `Stack`, `global_start_time` 01:00:00:00, metadata `rideo` | `format`, `project` → `sequence` → `spine` | `sequence` with `rate`, `format` | `TITLE:`, `FCM: NON-DROP FRAME` |
| primary video track | `Track` (Video) "Picture" | the spine | `video/track` 1 | events `V` (or `B` with its sound) |
| a video item | `Clip` with `ExternalReference(target_url)` and `source_range` | `asset-clip` (`ref` to an `asset` with `media-rep src`) | `clipitem` with `file/pathurl` | event, `* FROM CLIP NAME:`, `* SOURCE FILE:` |
| the video items' own sound | `Track` (Audio) "Production sound" with the same clips (metadata `rideo.linked`) | carried by the `asset-clip` | `audio/track` 1 linked to the video clipitems | `B` events |
| audio tracks (Dialogue, Music, Effects, …) | `Track` (Audio) per track, `Gap`s between items | connected `asset-clip`s (`lane` −1, −2, …) | `audio/track` 2… | – |
| `transitionIn` (crossfade, wipe, dip to black) | `Transition` (`SMPTE_Dissolve`, or `Custom_Transition` named `wipe`/`dip_to_black`), `in_offset` 0, `out_offset` = duration | `transition` "Cross Dissolve" (name keeps the type) | `transitionitem` "Cross Dissolve", "Edge Wipe" or "Dip to Color Dissolve", alignment `start` | `D` (dissolve, dip) or `W001` (wipe) with the duration in frames |
| `speed` | `LinearTimeWarp(time_scalar)` | `timeMap` (two points) | `Time Remap` filter (`speed` %) | `M2` line |
| `volume`, `muted` | metadata `rideo.volume`, `rideo.muted` | `adjust-volume` (dB) | `Audio Levels` filter | – |
| text items (titles, captions, the disclosure label) | `Marker`s on the stack with metadata `rideo.text` | `title` (Basic Title) on lane 1 | sequence `marker`s | `* TITLE:` comments |
| open review comments on a take or the export ([review](review.md)) | `Marker`s on the clip (source time) | `marker` in the `asset-clip` | `marker` in the `clipitem` | `* COMMENT:` lines |
| fades, color effects, reframing (`crop`) | metadata `rideo.item` (restored on import) | – | – | – |

The transition overlap of the magnetic track (an item with `transitionIn` starts `d` before the previous one ends)
becomes a cut at the incoming item's start with the outgoing clip's last `d` seconds as its handle, which is how
OTIO, FCPXML and XML describe transitions.

## Import (OpenTimelineIO)

`POST /api/projects/:id/interchange/import` with an `.otio` file (JSON) replaces the cut in one commit
(`Import <name> from OTIO`; history restores the previous cut):

1. The OTIO is validated (zod schemas for the `Timeline.1`, `Stack.1`, `Track.1`, `Clip.1`/`Clip.2`, `Gap.1`,
   `Transition.1`, `ExternalReference.1`, `MissingReference.1`, `GeneratorReference.1`, `LinearTimeWarp.1` and
   `Marker.1`/`Marker.2` subset Rideo reads; other schemas and unknown fields are ignored).
2. Each clip finds its media: the `rideo.source` metadata Rideo wrote (a take or a resource of this project), else
   its `target_url` ending in `projects/<this project>/media/…`, else a project media file with the same file name.
   Unresolved clips become nothing: on the picture track the following clips move up (Rideo's picture track has no
   gaps), on audio tracks their time stays empty; the result lists them.
3. The first video track becomes the picture track (more video tracks are listed as skipped until the editor has
   several, [roadmap item 15](../roadmap.md)); `Transition`s become `transitionIn` (`in_offset + out_offset`, the
   handles moved back into the clips); `LinearTimeWarp` becomes `speed` (0.25–4×; other warps are listed);
   audio tracks marked `rideo.linked` are skipped (the picture's own sound), other audio tracks map by name to the
   cut's tracks (else new audio tracks); stack markers with `rideo.text` become the text items (without them the
   cut's text tracks stay as they are).
4. The new timeline is validated (`TimelineSchema`) and written; items keep their ids from `rideo.item` when they
   are unique.

A cut exported to OTIO and imported back is the same cut.

## Surfaces

| Surface | REST | MCP |
|---|---|---|
| export | `GET /api/projects/:id/interchange.{otio,fcpxml,xml,edl}?mediaBase&source=timeline\|animatic` (a download; `?token=` like media URLs) | `interchange_export` (`projectId`, `format`, `mediaBase?`, `source?`) → `{filename, mime, content}` |
| import | `POST /api/projects/:id/interchange/import` (an `.otio` file, multipart, or the OTIO JSON) → `{items, unresolved[], skipped[], commit}` | `interchange_import` (`projectId`, `otio`) |

The Exports view has a **Hand off to an NLE** card: the media location (the default, or a mounted path), the four
downloads, and *Import OTIO…*. Exports need `project.read`; import needs `project.edit`. An empty cut is
`409 conflict`; an unreadable OTIO is `422 validation_error`.

Logs carry `projectId`, the format and the number of clips; `rideo_interchange_total{format, direction}` counts
exports and imports.
