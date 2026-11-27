# Brand and UI design

Rideo is a film studio in the browser. The UI is dark-first (media reads best on dark surfaces), calm, and
dense where editors need density (timeline, storyboard), with a single warm accent reserved for primary
actions and the playhead.

## Tokens

Defined as CSS custom properties in `packages/web/src/styles/index.css` (and as data in
`packages/shared/src/theme`, `BRAND_TOKENS`) and exposed to Tailwind v4 via `@theme`. Light mode swaps the values under
`[data-theme="light"]`. The default follows `prefers-color-scheme`. A **theme** (the studio's, set in Settings →
Appearance, or a host app's, given to the library) overrides any of them on the studio's root element; see
[themes](design/embedding.md#themes).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--color-bg` | `#0B0D12` | `#F6F7FA` | app background |
| `--color-surface` | `#12151C` | `#FFFFFF` | panels, cards |
| `--color-surface-2` | `#1A1E28` | `#EEF0F5` | inputs, nested panels, timeline lanes |
| `--color-border` | `#272C38` | `#D9DDE6` | hairlines |
| `--color-text` | `#E9EBF1` | `#141821` | primary text |
| `--color-muted` | `#9AA2B4` | `#586072` | secondary text |
| `--color-accent` | `#FF6B3D` (Ember) | `#E4521F` | primary buttons, playhead, focus ring |
| `--color-accent-contrast` | `#1A0C06` | `#FFFFFF` | text on accent |
| `--color-success` | `#2EC4B6` (Reel teal) | `#10877C` | consistency passed, approved |
| `--color-warning` | `#F4B740` | `#A86B00` | unverified, needs review |
| `--color-danger` | `#FF4D5E` | `#C8283A` | failed, destructive |
| `--color-info` | `#5B8CFF` | `#2C5FD9` | agent activity, overrides |

Text/background pairs meet WCAG AA (4.5:1 for body text, 3:1 for large text and UI glyphs).

## Type

- UI: `Inter`, falling back to `system-ui`. Sizes 12 / 13 / 14 (body) / 16 / 20 / 28.
- Timecodes and ids: `JetBrains Mono`, falling back to `ui-monospace`, with tabular numbers.
- Headings are semibold. Body is regular. No all-caps except 11px overline labels.

## Shape, space, motion

- Radius: 6px (controls), 10px (cards), 14px (dialogs).
- Spacing on a 4px grid. Panels use 16px padding (12px on mobile).
- Motion: 120 ms ease-out for hovers and toggles, 200 ms for panels. The live-update pulse (entity
  highlight on remote change or `ui_focus`) is a 1.2 s accent outline fade. Motion is disabled under
  `prefers-reduced-motion`.

## Components

Buttons (`primary` = accent, `secondary` = surface-2, `ghost`, `danger`), Badge (status colours above; a display class
given to it, such as `hidden` below a breakpoint, replaces its own `inline-flex`), Card, Tabs, Dialog (Escape closes the
one on top: a plan opened over a picker leaves the picker open), Toast (bottom-right on desktop, top on mobile),
Progress (linear, with a job message), EmptyState, the workflow Stepper, and ConsistencyBadge (`passed 0.92` / `failed`
/ `unverified` / `stale` / `override`). Icons come from `lucide-react`: 16px in dense UI, 20px in navigation.

## Layout and responsiveness

| Breakpoint | Layout |
|---|---|
| `< 768px` (mobile) | top bar and a bottom navigation sheet; single column; editor = preview + vertical item list |
| `768–1279px` (tablet) | collapsible icon rail and content |
| `≥ 1280px` (desktop) | sidebar navigation (workflow stages), content, and a context panel (activity, jobs) |

No view may scroll horizontally at 360px width, except the timeline lane, which scrolls inside its own
container.

The project header keeps the project's title, its stage and its branch apart from the header's controls at every
width from 360px, signed in or not:

- The title gives way to its badges with an ellipsis (its full text in its tooltip), but never below the smaller of
  its own width and 3rem, and it is never wider than its text: a short title is followed by its badges, not by a gap.
- The stage badge waits for `sm` (640px); from there it shows whole.
- A branch other than `main` shows as a badge whose name gives way down to the badge's icon, the branch named in its
  tooltip ("Branch alt-ending"), at every width.
- While the project's bottom bar and its **More** menu show (below `md`, 768px), the header's studio links (Library,
  Brand kits, and Settings for an administrator) are under **More**; the header keeps the engine state, the live dot,
  the theme, the Inbox, the notifications and the account. The engine state's label shows from `lg` (1024px), its icon
  always.
- The title row cuts only what the header's room cannot hold, so nothing runs under the header's controls, and
  nothing scrolls sideways.

A card names its character, element or resource in full: a name longer than the card's line wraps onto the next line,
never cut with an ellipsis, so a phone shows the whole name whatever the font.

## Logo

A play triangle whose left edge forms the stem of an "R", in Ember on a dark tile
(`packages/web/public/logo.svg`). Wordmark: "Rideo" in Inter Semibold, letter-spacing −0.01em.

## Voice

Direct and production-minded: "Lock Mira to start generating", "3 shots need review", "Rendered 45:12 ·
watermarked". Say what happens, never hype it.

A count agrees with its noun and its verb: "1 shot needs review", "3 shots need review", "1 of 4 lines is not
heard", never "shot(s)" or "1 shots". Every message that shows a count, in the studio, the server's messages, job
progress, commit messages and the MCP tools' answers, writes it with `plural` and chooses the verb or pronoun after it
with `byCount` (`@rideo/shared`).
