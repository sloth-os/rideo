# Brand kits and templates

A studio keeps its look in **brand kits**: the fonts and colors of titles, a logo, intro and outro bumpers, lower-third
templates and an optional visible **brand bug** (the logo in a corner of the picture). A project takes a kit; its
titles, lower thirds and exports then look like the brand without anyone setting styles by hand. (The studio UI's
own design system is [docs/brand.md](../brand.md); this document is about the films.)

## A kit

Kits belong to the studio and are kept on the storage backend: `<root>/brand-kits/<id>.json` and their files in
`<root>/brand-kits/<id>/` (content-addressed names).

```ts
type BrandKit = {
  id: string;                         // bkt_…
  name: string;
  colors: { text: Hex; accent: Hex; box: Hex; boxOpacity: number };    // titles, lower thirds, the box behind
  fonts: { title: Asset | null; body: Asset | null };                  // TTF or OTF; DejaVu Sans when null
  logo: Asset | null;                 // PNG, JPEG or WebP
  bug: { enabled: boolean; corner: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
         size: number;                // fraction of the frame's width, 0.04–0.3
         opacity: number; margin: number };
  intro: Bumper | null; outro: Bumper | null;                          // a video, or a still for `durationSec`
  lowerThirds: { id: string; name: string; position: 'left' | 'center' | 'right';
                 size: number; font: 'title' | 'body'; color: 'text' | 'accent'; box: boolean }[];
  createdBy: Author; createdAt: string; updatedAt: string;
};
type Asset = { name: string; file: string; hash: string; mime: string; size: number; width?; height?; durationSec? };
type Bumper = { asset: Asset; durationSec: number };
```

Files are validated when they are added: fonts by their signature (`OTTO`, `true`, 0x00010000) and size (≤ 20 MB),
images and videos by a probe (≤ 500 MB, a video bumper ≤ 30 s).

## A project's brand

`PUT /api/projects/:id/brand {kitId}` (`project.manage`) **applies** a kit: its files are copied into the project's
media (`media/brand/<name>-<hash12>.<ext>`, so renders, WebDAV and history only ever see project media) and the
resolved kit is written to `project.settings.brand` (`{kitId, name, colors, fonts: {title, body} as MediaRefs, logo,
bug, intro, outro, lowerThirds}`) in one commit. Applying again after the kit changed brings the change; `{kitId:
null}` removes the brand. Nothing in the cut changes when a brand is applied; what uses it:

| Where | What the brand gives |
|---|---|
| Titles (`add_text` with the `title` preset), captions | the title font, text color and box (color, opacity); an item's own style wins |
| Lower thirds | **templates**: *Add lower third* creates a text item `preset: "lower_third"` with two lines (name, role) in the template's position, size, font, color and box |
| Text styles | `style.font: "title" \| "body"` (the project's brand fonts), `style.box: Hex \| null`, `style.boxOpacity` |
| Bumpers | *Add intro* / *Add outro*: one `add_bumper {position, source}` op inserts the bumper at the start or end of the picture track and, for an intro, moves every item of the other tracks later by the bumper's length, so the cut stays in sync |
| Brand bug | the export dialog's *Brand bug* (default: the kit's `bug.enabled`) and the preview: `withBrand(timeline, brand)` adds the logo as an overlay item over the whole film, in its corner, at its size and opacity ([multitrack](editor.md#multitrack-transforms-and-keyframes)); like the disclosure label it is drawn at render time and never stored in the cut |

Both engines draw brand fonts the same way: ffmpeg's `drawtext` gets the font's file (`fontfile`) per text item, and
the compositor loads it as a `FontFace` named after its hash.

## Surfaces

| Surface | REST | MCP |
|---|---|---|
| kits | `GET /api/brand-kits`, `POST /api/brand-kits` `{name, colors?, bug?, lowerThirds?}`, `PATCH /api/brand-kits/:id`, `DELETE /api/brand-kits/:id` | `brand_kits_list`, `brand_kit_create`, `brand_kit_update` |
| kit files | `PUT /api/brand-kits/:id/files/:slot` (multipart; `slot`: `title_font`, `body_font`, `logo`, `intro`, `outro`), `GET /api/brand-kits/:id/files/:file` | – |
| a project's brand | `PUT /api/projects/:id/brand` `{kitId \| null}` | `project_brand` |
| bumpers, lower thirds | the timeline ops `add_bumper`, `add_text` with a template's style | `timeline_apply` |

The studio has a **Brand kits** page (from the user menu): kits with their colors, fonts, logo, bumpers, bug and
lower-third templates, editable by admins and directors. The project's settings choose the kit; the editor's toolbar
adds a lower third from a template and the intro and outro; the export dialog has the brand bug switch.

Creating, changing and deleting kits needs a signed-in person (any studio member creates; the author or an admin
changes and deletes); applying one needs `project.manage`. Logs carry the kit and project ids;
`rideo_brand_total{event}` counts kits created, applied and files added.
