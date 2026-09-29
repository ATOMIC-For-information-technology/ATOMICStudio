---
name: ATOMIC Studio
description: The AI-native IDE for non-coders and pros — mission-control calm, never surprises you
colors:
  void-black: "#0f1115"
  console-panel: "#171a21"
  raised-console: "#1e222b"
  hairline-steel: "#2a2f3a"
  signal-white: "#e6e9ef"
  instrument-gray: "#8b93a3"
  telemetry-blue: "#3b82f6"
  telemetry-blue-deep: "#2563eb"
  go-green: "#22c55e"
  abort-red: "#ef4444"
  caution-amber: "#f59e0b"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.35
  icon:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 400
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.05em"
  meta:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
rounded:
  control: "2px"
  card: "2px"
  widget: "6px"
  badge: "11px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "10px"
  lg: "14px"
components:
  button-primary:
    backgroundColor: "{colors.telemetry-blue}"
    textColor: "{colors.signal-white}"
    rounded: "{rounded.control}"
  status-chip-go:
    backgroundColor: "{colors.go-green}"
    textColor: "{colors.void-black}"
    rounded: "{rounded.pill}"
  status-chip-abort:
    backgroundColor: "{colors.abort-red}"
    textColor: "{colors.signal-white}"
    rounded: "{rounded.pill}"
  tab-active:
    backgroundColor: "{colors.void-black}"
    textColor: "{colors.signal-white}"
    rounded: "0px"
  extension-row:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.signal-white}"
    rounded: "0px"
---

# Design System: ATOMIC Studio

## Overview

**Creative North Star: "The Mission Control"**

ATOMIC Studio reads as a cockpit, not a canvas: a dark instrument panel where every signal is real, every status has an honest color, and nothing moves or flashes without a reason. The system is built for two crews at once — a non-coder pilot who needs the console to never lie to them, and a professional engineer who needs it to be fast and dense when they want it to be. Both get the same panel; density and jargon flex, honesty and calm never do.

This isn't decorative sci-fi chrome. "Mission Control" is a discipline: status colors mean exactly one thing each (green is genuinely safe, red is genuinely wrong, amber is genuinely a warning — never used for emphasis or decoration), motion is reserved for things that are actually changing, and the interface holds still between changes instead of rearranging itself for novelty's sake — a deliberate rejection of the "UI churn" competitors are criticized for in `ROADMAP.md`.

**The form is VS Code's workbench, and that is a decision, not an accident.** As of 2026-08-18 the
shell wears VS Code's real geometry — 35px title bar, 48px activity rail with a 2px leading active
edge, 22px section headers, 35px tabs, 22px list rows, 22px status bar, square chrome, 2px controls.
The reason is Mission Control's own reason: an instrument earns trust by being *already known*. A
developer's hands arrive with those measurements memorised, and an IDE that is four pixels off
everywhere reads as a copy of one. What is not borrowed is the palette, the icon set, the language,
or any promise — this is ATOMIC's identity in VS Code's grammar, never VS Code's identity.

**Colour is a theme, not a constant.** The palette above is `ATOMIC Void`, the default, and it is now
one of eight built-in themes (plus any VS Code colour theme the user imports). `src/shared/theme.ts`
derives ~90 workbench tokens from a ~20-value seed; the rules below say *what a token means*, and the
engine guarantees the arithmetic. **The one-accent rule is per theme, not per app.**

**Key Characteristics:**
- Dark, low-chroma base with exactly one accent hue per theme (telemetry blue in the default) — color is a signal, not decoration
- Flat at rest; shadows appear only on things that are genuinely floating above the base layer (modals, dropdowns, the Agent panel's hero)
- Plain system fonts, and one drawn line-icon set — no illustration system, nothing that has to be "on brand" to feel right
- Status semantics borrowed from real instrumentation: go/no-go green and red, caution amber, never repurposed for anything else

## Colors

A near-monochrome dark console with one accent color and three status colors that are never used for anything but their literal meaning.

### Primary
- **Telemetry Blue** (`#3b82f6`): the one accent — active tab underline, focus rings, links, the running-task pulse, primary buttons. Its rarity is the point: on a calm screen it should be the only thing with real color.
- **Telemetry Blue Deep** (`#2563eb`): the pressed/deeper state of Telemetry Blue — gradients and darker variants where the base blue would be too light against `console-panel`.

### Neutral
- **Void Black** (`#0f1115`): the base canvas — the editor surface, the deepest layer.
- **Console Panel** (`#171a21`): the standard surface for chrome — sidebars, headers, footers, the activity bar, cards at rest.
- **Raised Console** (`#1e222b`): one step up from Console Panel — hover states, nested panels, anything that reads as "one layer closer to the user" without a shadow.
- **Hairline Steel** (`#2a2f3a`): every border and divider in the app. Never a heavier line than 1px.
- **Signal White** (`#e6e9ef`): primary text — never pure white, kept slightly warm/gray so it doesn't glare against Void Black.
- **Instrument Gray** (`#8b93a3`): secondary text, timestamps, muted labels, placeholder text — the app's "this is context, not content" color.

### Status (Named Rules)
**The Go/No-Go Rule.** `go-green` (`#22c55e`), `abort-red` (`#ef4444`), and `caution-amber` (`#f59e0b`) mean exactly one thing each — success/safe, failure/dangerous, needs-attention — everywhere in the app, with no exceptions for emphasis or decoration. If something needs visual weight but isn't actually a status, it gets typographic weight or Telemetry Blue, never a status color borrowed for effect.

## Typography

**Body/UI Font:** -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif (13px base)
**Mono Font:** ui-monospace, SFMono-Regular, Menlo, monospace (file paths, code, terminal output, timestamps)

**Character:** Plain native system fonts, deliberately — nothing about the type is "designed," so it never fights the actual code and data the app displays all day. The mono stack carries anything literal (a path, a hex, a shell command); the sans stack carries everything the app itself is saying.

### Hierarchy
- **Display** (650 weight, 22px): the one page-level heading role — the extension detail page's title. Added 2026-08-18 with that page, which is the app's first surface that is a destination rather than a panel; nothing else in the workbench is allowed to reach for it.
- **Title** (650 weight, 15px): section/panel titles — the Mission Hero's objective line, modal titles.
- **Icon** (18-20px box): the activity bar's and other rail-style icons — sized for tap/click comfort, not a text role.
- **Body** (400 weight, 13px): the base UI size — buttons, form fields, primary labels.
- **Body-sm** (400 weight, 12px): secondary body text — list-row detail, section descriptions.
- **Label** (600 weight, 11px, uppercase, 0.05em letter-spacing): section kickers and status-row labels (e.g. "MISSION", "WORKSPACE HEALTH").
- **Meta** (400 weight, 10px): the smallest text — timestamps, chip labels, fine print. Always `instrument-gray` unless it's the active/focused item.
- **Mono** (400 weight, 11px): file paths, code, terminal output, technical metadata.

### Named Rules
**The No-Decoration Type Rule.** Weight and the uppercase-kicker treatment carry hierarchy — never font-family switching, never italics, never a display face. One sans stack, one mono stack, period.

## Layout

A fixed-chrome IDE shell at VS Code's own measurements, all of them living once in the `--wb-*`
geometry block at the top of the workbench layer in `styles.css`: **35px** title bar (with a centred
command centre and the three layout toggles at the right edge) → **48px** far-left icon rail → a
swappable **300px** sidebar whose view title is 35px and whose collapsible section headers are
**22px** → a flexible center workspace with a **35px** tab strip → an optional flexible right dock →
a **22px** status bar whose items are contiguous, gapless hit targets. The bottom panel's head is
**35px**; list and tree rows are **22px**; scrollbars are **14px**, square, with no track. Within panels that scroll (the Agent dock's middle section, the bottom Tools panel), pinned sections (hero, input, health strip) stay fixed while a dedicated `.ap-scroll`-style inner region scrolls — the chrome around the content never moves, only the content itself does.

Density is tight and consistent: **8px** is the base rhythm (gaps, small padding), **10-14px** for section padding, **4px** for the tightest icon/label gaps. Nothing in the chrome uses padding above ~14px — Mission Control doesn't waste space on air.

## Elevation & Depth

Layered, not flat, but deliberately restrained: elevation is reserved for things that are genuinely floating above the base plane (modals, dropdowns, side sheets, the Agent panel's Mission Hero), and everything else — cards, list rows, panels at rest — is flat with only a 1px `hairline-steel` border to separate it from its background. The shadow's size scales with how "high" the element actually sits: a small in-flow card gets a whisper of shadow (1-2px offset, 6-10px blur), a genuine overlay (a modal, the command palette, a context menu) gets a real one (12-24px offset, 40-64px blur).

### Shadow Vocabulary
- **Ambient card** (`0 1px 6px rgba(0,0,0,0.2)` to `0 2px 10px rgba(0,0,0,0.25)`): artifact cards, the Mission Hero — barely-there depth for things that sit slightly above their row but aren't a true overlay.
- **Floating panel** (`0 4px 16px rgba(0,0,0,0.3)`): the Mission Hero's own elevated feel, the diff-preview's floating elements.
- **True overlay** (`0 12px 40px rgba(0,0,0,0.45)` to `0 24px 64px rgba(0,0,0,0.6)`): modals, the command palette, any element that sits above a full-screen backdrop.

### Named Rules
**The Altitude Rule.** Shadow size is a direct, honest signal of how far above the base plane something sits — never applied for decoration, and never on anything that's actually flat/in-flow.

## Shapes

**The workbench is square.** Chrome — the title bar, activity rail, sidebar, section headers, tabs,
list rows, the status bar, the bottom panel — carries **no radius at all**. Softness there is what
made the app read as a chat product wearing an IDE's skeleton; a list row with rounded corners is a
card, and a workbench row is a line in a list.

Radius survives in exactly four places, and each is VS Code's own answer:

- **control (2px):** buttons, inputs, selects, small icon buttons. Just enough to stop a control
  looking like a cut-out rectangle; not enough to read as a pill.
- **card (2px):** the same value, stated separately because it is a different decision — panels and
  cards inside content areas, not chrome.
- **widget (6px):** the quick-input overlays only — the command palette, Quick Open, the colour
  theme picker. The one genuinely floating surface, and the one place VS Code itself rounds.
- **badge (11px) / pill (999px):** anything reporting a discrete state or a count — status chips,
  the activity rail's badge, section counts. Unchanged rule: a state gets a pill, never a rectangle.
- **circle (50%):** icon dots and avatar-scale marks only.

### Named Rules
**The Squareness Rule.** If it is chrome, it is square. A radius in the workbench has to name which
of the four cases above it is; "it looked nicer" is not one of them.

## Components

### Buttons
- **Shape:** 6px radius (`rounded.sm`), never a pill unless it's reporting status.
- **Primary:** `telemetry-blue` background, `signal-white` text.
- **Secondary/Ghost:** transparent or `console-panel` background, `hairline-steel` border, `instrument-gray` text that becomes `signal-white` on hover.
- **Hover/Focus:** background steps to `raised-console`; focus-visible gets a `telemetry-blue` outline (2px, offset inward on dense controls) — never a glow, never a color shift on the text itself.

### Status Chips / Badges
- **Style:** pill radius, small (10-11px) bold text, background is a low-opacity tint of the status color (e.g. `rgba(34,197,94,0.16)` for a go-green chip) with the full-opacity color used for the text — never a solid-fill status color behind body text.
- **State:** exactly three semantic states (ok/warning/error) plus a neutral "idle" gray — no chip color exists that isn't one of the four.

### Cards / Containers
- **Corner Style:** 8px (`rounded.md`).
- **Background:** `console-panel` at rest, `raised-console` on hover.
- **Shadow Strategy:** Ambient card shadow only if the card is meant to feel "lifted" (artifact cards); pure `hairline-steel` border with no shadow for cards that are just organizing content in a list (diff cards, timeline rows).
- **Border:** 1px `hairline-steel`, always — even elevated cards keep the border; the shadow supplements it, never replaces it.
- **Internal Padding:** 8-10px for compact list-style cards, 12-14px for cards that are a destination in themselves (modals, the Mission Hero).

### Inputs / Fields
- **Style:** `console-panel` or `raised-console` background, 1px `hairline-steel` border, 6px radius, mono font for anything the user will paste a literal value into (API keys, paths).
- **Focus:** border shifts to `telemetry-blue`; no glow, no scale change — Mission Control doesn't "bounce."

### Navigation (title bar / activity bar / tab strips / status bar)
- **Title bar (35px):** flat, hairline bottom border, and three regions — brand at the leading edge (inset 74px on macOS, where the system draws its traffic lights over it), a centred **command centre** naming the project and opening Search Everywhere, and the **three layout toggles** at the trailing edge for the sidebar, the bottom panel and the agent dock. Title-bar buttons are 22px and ghost by default; only the one genuinely primary action (Run preview) is filled.
- **Activity bar (48px):** 48×48 items, 24px marks, and the active item is a **2px leading edge plus a full-strength icon** — never a tinted pill. The edge reads at a glance down a 48px rail in a way a background wash does not. The count badge is a 16px pill at the icon's bottom-right, and it is the **only** place the accent is used as a solid badge fill.
- **Tab strip (35px):** the active tab is the editor surface continuing upward — same background, no bottom border — under a **1px accent along its top edge**. That is the whole tab metaphor: one sheet, not a selected chip. The strip scrolls horizontally and shows no scrollbar.
- **Status bar (22px):** items are contiguous, gapless hit targets that light up on hover. Exactly one item may invert (accent background, readable foreground): the remote/connected item, because it is the only one about *where you are* rather than what just happened.
- **Panel tabs:** uppercase 11px labels with a 1px accent underline on the active one. A pill in a header row reads as a filter chip you could switch off; these are views, and exactly one is always on.
- **Legacy toggled state** (segmented controls, palette rows, chips): `toggled-bg` tint, `toggled-fg` text, `toggled-border` — never a solid fill.
- **Icons:** drawn marks from `components/Icon.tsx` at 11-20px, authored in-repo — no icon font, no third-party library, so there is still no build step and no licensing surface.

### Extension rows and the detail page
- **Row:** a 36px square icon tile, then name + version, description, and publisher + state on three tight lines, with the action button appearing on hover or selection so a resting list is text rather than buttons. Rows are full-bleed and square with a 2px leading edge when selected.
- **Icon tiles carry two derived letters, not artwork.** No extension in this product ships an icon, and forty identical puzzle glyphs down a list read as a placeholder because that is what they are. A **theme's** tile is the exception and is painted in that theme's own canvas and accent, generated from its tokens — so an imported theme has a correct tile the moment it lands.
- **Detail page:** lives in the editor area (VS Code's placement) and **below** the tab strip, never over it — it is not a file, so it must not hide the files you have open. 72px tile, 22px display title, Details/Features tabs, and a facts list as a `<dl>` at a 140px label column.

### Source Control (the sidebar view, rebuilt 2026-09-02)
- **Placement:** an activity-bar view in the left sidebar (VS Code's slot, after Search), under the
  35px view title like Explorer and Extensions — never a bottom-panel tab. In the 300px column the
  diff pane stacks under the list; when the view is hosted somewhere wider than 760px it sits beside it.
- **Geometry:** a 22px header, 22px section headers with a neutral count pill, 22px rows, a pinned
  composer between header and list. The list is one scroll region; the composer and header never
  move. Everything is square; the only radius is the 2px on controls and the count pill.
- **Rows read `[icon] leaf  dir … [hover actions] [M]`.** Hover actions are in the layout at all
  times and only change opacity, so a row never reflows under the pointer. Selection is
  `--wb-list-active-*`; keyboard focus is a 1px inset `--wb-focus-border` ring; a row whose
  stage/unstage is still in flight only dims. Status letters use the status colours for their
  literal meaning only: new = ok, changed = warn, deleted / conflicted = danger, renamed = neutral.
- **The diff names its comparison.** "Index ↔ HEAD", "Working tree ↔ Index", "New file",
  "Conflict" — in the pane header, always, because the same file can be open under two rows with
  two different diffs. Binary, oversized and empty results are a sentence, never an empty box.
- **Strips, not banners.** Merge state, a missing remote and a git-ignored folder are 22px-minimum
  strips in `--warn-tint` + `--warn-fg`; a merge conflict is never red, because it is the normal
  path. A connected remote shows nothing at all — the header's Push tooltip says where.
- **Menus are the one floating surface.** Overflow, commit actions and the row context menu share
  one popover: 22px items, hairline border, the true-overlay shadow, disabled entries kept visible
  with their reason at the right. Keyboard: arrows wrap, Escape returns focus to the opener.
- **Disabled explains itself.** The Commit button's tooltip AND a muted hint beside it say why
  ("Nothing staged — stage a file, or use Commit all"). "Commit all" is a menu entry with the hint
  "stages everything first"; it is never the primary.

### The Agent dock (2026-09-03)

- **It opens, rather than being open.** A large surface that is always there is a surface the user
  is always paying for. The dock starts closed and a labelled edge tab opens it; the choice is
  remembered in both directions. Builder Mode is the exception — there the dock IS the product.
- **A collapsed surface must announce itself.** The tab carries the word, not just a glyph, and
  reports a live run with a dot. Hiding a surface must never hide what it was telling you.
- **Every section says what it is for.** A one-line explanation on the header — as its tooltip, a
  quiet circled mark, and a screen-reader description. A panel with a dozen modules should teach
  itself; the alternative is a document the user has to keep open beside it.

### Insight — the workspace view (2026-09-03)

- **Read-surfaces go in the editor area; glance-surfaces go in the panel.** Insight is read to
  decide what to do next, so it takes the workspace like Extensions and Settings. The bottom panel
  keeps what you glance at while working: Activity, Problems, Changes, Workspaces, Terminal.
  **A row of jump buttons is the tell that a container is wrong** — Insight had one, and it is gone
  with the drawer.
- **Four destinations, not twenty sections.** Overview / Review / Code Map / Memory, each named for
  the question it answers. Nothing is a navigation choice unless it is a different question.
- **One verdict.** Competing top-level scores force the user to arbitrate between answers that were
  never asking the same thing. Order them by what is irreversible, show one headline, and demote the
  rest to one supporting line each. A derived score never outranks a measured finding.
- **"Not checked" is a state, and it must not look like "passed".** Six states — not checked ·
  checking · passed · needs attention · failed to run · partial — each carried by an icon, a word
  AND a colour. Silence is not an empty state; an empty state says which kind of empty it is.
- **One primary action per screen.** Five equally-loud primary buttons is none. The primary is
  chosen by the most important unresolved state; individual checks keep a quiet "Run again".
- **Capped measure.** 900px. This is the one screen in the app that is genuinely read rather than
  scanned, and prose set to the full width of a large editor pane is not read at all.
- **Progressive disclosure over deletion.** Advanced analysis is collapsed, not removed — which is
  also what keeps the row count down, because a closed section renders nothing.

### The bottom panel, and where it stops (2026-09-02)

- **The panel spans the EDITOR, not the window.** It is a child of the center column, so the
  sidebar and the agent dock run the full height beside it — VS Code's default panel alignment.
  A panel that reaches wall to wall shortens every column in the app to whatever height is left,
  which is why a terminal used to cut the file tree off mid-list.
- **The terminal's sessions are a list down its right-hand edge**, not a horizontal strip: 22px
  rows, glyph + name, full-bleed selection, and a kill button in a fixed trailing slot that fades
  in on hover so nothing shifts. A strip runs out of width after about four shells and then
  truncates the only thing that tells them apart.
- **Session actions above the list, output actions over the output.** `+` and the overflow sit at
  the top of the session column; Explain and the Docker shortcuts stay on the left, over the
  terminal they act on.
- **Copy the shape, not the controls you cannot back.** The reference had a profile chevron, a
  split control and its own close button. This app has no shell profiles, no split panes, and the
  panel header already closes the panel — so all three were left out rather than drawn dead.

### The empty editor (2026-09-02)
- **One signature element: the ATOMIC atom as a watermark.** The product's own mark from
  `Icon.tsx` at 168px (104px in a short pane), `currentColor` so it follows every theme, one flat
  opacity — 0.10 dark, 0.08 light. No white tile, no glow, no gradient, no shadow, no animation,
  and `aria-hidden`, because it is decoration.
- **Under it, the two or three keystrokes worth knowing**, each a real button running a real
  command, with key caps built by `keys.ts` so they say ⌘⇧P on macOS and Ctrl+Shift+P elsewhere
  and can never disagree with the menu. A row that cannot run right now is disabled with the
  reason in its tooltip — never a control that looks live and does nothing.
- **Restraint is the brief.** 13px muted labels, 8px apart, 22px key caps with a hairline border
  and a 3px radius on `--panel-2`. No card, no marketing, no illustration.
- **Centred in what is LEFT.** The composition centres inside the editor pane, so it stays centred
  as the sidebar, the agent dock and the bottom panel open and close. Short panes shrink the
  watermark first and drop it last, measured with a **container query** — the editor's height, not
  the window's, is what decides.

### Explorer (the file tree, rebuilt 2026-09-02)
- **Geometry, from the workbench tokens:** 48px activity bar, 35px view title, 22px section
  header, **22px rows**, a 16px disclosure slot and a 16px icon slot, 8px per indent level, 1px
  sidebar border, square rows with no radius at all.
- **Rows are full-bleed.** Indentation is padding on the row itself, never a nested container, so
  hover and selection run the whole width of the sidebar. The slots are fixed, so a git letter
  appearing or a folder gaining an arrow never moves the filename.
- **Quiet at rest.** New File, New Folder, Refresh and Collapse All live on the project header and
  appear on hover or keyboard focus. Indent guides are hairlines, dropped on the selected row.
- **Git decorations are a trailing slot of fixed width**, colour-coded by the same status meanings
  as the rest of the app: green added/untracked, amber modified, red deleted/conflicted. The
  selected row keeps the selection's own foreground rather than fighting it.
- **Motion is 90ms on the hover background and nothing else.** No animated row movement, no
  spring, none of it under `prefers-reduced-motion`.

### Quick input (command palette / Quick Open / theme picker)
- **Shape:** 600px, pinned 6px under the title bar, 6px radius, true-overlay shadow, no backdrop scrim. The one rounded, genuinely floating surface in the app.
- **Rows:** 22px, square, full-bleed; groups are separated by an uppercase 11px heading with a hairline above.
- **The theme picker previews on highlight.** Arrow keys repaint the whole app; Enter commits; Escape and click-away actively repaint what was on when it opened. A theme list with swatches is a settings screen — previewing is what turns it into a way of *looking* at eight themes in eight keystrokes.

### Icons — two systems, on purpose

**Product icons and file-type icons are different things, and conflating them is what made the
old file tree look like a placeholder.** As of 2026-09-02 they are separate systems:

- **Product icons** — `components/Icon.tsx`. ATOMIC's own authored marks: Refresh, New File, Git,
  Settings, chevrons, status. Monochrome, `currentColor`, one weight, drawn in-repo. Every control
  in the app uses these, and only these.
- **File-type icons** — `components/FileIcon.tsx` over `shared/file-icons.ts`. A data-driven,
  locally bundled **file-icon theme**: what a `.ts`, a `Dockerfile` or a `package.json` looks
  like. Coloured, per-language, swappable, and identical in the Explorer, the editor tabs, Quick
  Open and the Source Control rows — a file that is TypeScript in the tree is TypeScript in the
  tab strip.

The default theme is **Seti**, vendored from VS Code's `theme-seti` extension at a pinned commit
(Seti UI © 2014 Jesse Weed, MIT; notices kept verbatim beside the assets). It ships as a local
WOFF plus a generated mapping module — **nothing is fetched at runtime**. Resolution follows the
file-icon-theme spec's order: filename-with-parent, exact filename, multi-part extension, simple
extension, language id, default. Seti has no folder glyphs, so folders draw only their disclosure
arrow, exactly as they do in VS Code.

**A file type never renders through `Icon.tsx`, and a control never renders through `FileIcon`.**
If a new file type needs a mark, it comes from the theme's data; if a new control needs one, it is
drawn into `Icon.tsx`.

**Icon sharpness is a rule, not a preference.** File icons are drawn as font glyphs at an integer
`font-size` in a fixed integer slot — no CSS transform, no filter, no scaled raster, no opacity on
the row. `font-display: block` on the bundled face, so the column never paints fallback boxes and
then swaps them for real glyphs.

### The authored product set

One authored set — `components/Icon.tsx`. Every mark is drawn on a 24×24 grid inside a 20×20 live
area, with a single 1.8 stroke, round caps and joins, `currentColor`, and no fill unless the fill
*is* the mark (the status dot). Sizes are passed per use (11-20px); the stroke scales with the box
so a 12px mark and a 20px mark read as the same weight. Adding an icon means adding a path to that
one file — there is no font, no package, and no build step.

**Why it isn't emoji any more.** The app ran on plain unicode for its whole history, and the reasons
it stopped are all things that actually shipped: a colour emoji silently ignores `color:`, so status
marks lost their state colour with no error; advance widths differed per platform, so every icon
slot had to be over-sized to stop glyphs colliding with the text beside them; codepoints outside the
common emoji set rendered as tofu boxes off macOS (twice, in the file tree and on an export button);
and a set assembled from three unicode blocks had three different visual weights in one 18px column.

**The Two Registers Rule** (unchanged — it outlived the glyphs). Every mark belongs to exactly one
register, and they never mix roles:
- **Status marks** — `check` · `close` · `dot` (in progress) · `circle` (idle) · `alert` · `ban` ·
  `chevron-right`/`chevron-down` (disclosure) · `play` · `stop`. Monochrome, always coloured by the
  CSS class on their container, never by the mark itself.
- **Subject marks** — what a thing *is*: `file`, `folder`, `terminal`, `robot`, `monitor`, `lock`.
  They name a thing and never carry state.

**The One Concept, One Mark Rule.** A concept gets exactly one mark across the app, and a mark means
exactly one thing. Both directions were violated in real shipped code: "running" once had three
glyphs (`●`/`⏳`/`▶`) visible at once in a single panel, and `×` meant both "close this" and "delete
this file from disk" one row apart. Close is `close`; deleting a file is `trash`.

**The Same-Row Rule.** Two identical marks must never appear in one row. An in-flight command once
rendered `▶ Ran npm test ▶ 0:12 ▸` — three triangles meaning "active", "run" and "expand".

**Text that stays text.** Key names (`⌘` `⇧` `⌥`), the shell prompt (`❯`), `©`, and arrows used as
punctuation inside a sentence are typography, not icons, and are written as characters.

**Accessibility.** Icons are `aria-hidden` by default, because a visible label is nearly always
beside them. A mark that stands alone takes `label`, which makes it `role="img"` with an accessible
name. An icon-only button labels the *button*, not the mark.

## Do's and Don'ts

### Do:
- **Do** follow the **Two Registers Rule** for icons — it is the single guardrail that keeps the icon set coherent as it grows.
- **Do** reserve `go-green`/`abort-red`/`caution-amber` for literal status only — a button that just needs visual weight uses `telemetry-blue` or type weight, never a status color.
- **Do** keep every card and panel bordered in `hairline-steel`, with or without a shadow — the border is the primary separation mechanism; the shadow is a bonus signal for genuine elevation.
- **Do** respect `prefers-reduced-motion` for every looping/infinite animation (pulsing dots, shimmer effects) — this was a real, fixed gap found in this session's own accessibility review; don't reintroduce it.
- **Do** make every interactive element keyboard-operable with a real `<button>`/`aria-expanded` — a `<div onClick>` masquerading as a toggle was a real Critical bug found and fixed this session.
- **Do** let motion mean something: an animation should always be reporting a real state change (something loading, something newly arrived, something in progress) — never decorative.

### Don't:
- **Don't** round the chrome. Title bar, rail, sidebar, section headers, tabs, list rows, status bar and panel are square; a radius elsewhere has to name which of the four cases in **Shapes** it is.
- **Don't** hardcode a colour in `styles.css`. Every value comes from a token, because the token is what a theme swaps — a literal green is a light theme shipping a dark theme's green. The `:root` blocks at the top stay literal on purpose: they are the pre-JS fallback, and nothing else.
- **Don't** hand a detail view a snapshot of the row that opened it. Look it up from the live list by key — the first thing a user does on an extension's page is enable it, which is exactly when its data changes, and the snapshot version showed an empty Features tab forever.
- **Don't** introduce a second accent color *within a theme*. Telemetry Blue is the only non-status color in the system; a second accent dilutes the "rarity is the point" rule.
- **Don't** use drop shadows on anything that's actually flat/in-flow (list rows, ordinary cards) — shadow implies altitude, and false altitude reads as visual noise.
- **Don't** add an icon font, a third-party icon package, or an illustration system — new marks are authored into `components/Icon.tsx` on the same grid and stroke as the rest (zero build step, zero licensing surface).
- **Don't** reach for a unicode glyph as an icon again. Anything outside the widely-shipped emoji set — Mathematical Alphanumerics, obscure arrow blocks, rare dingbats — is missing from the default Windows/Linux fallback chain and renders as a tofu box (□). Two shipped that way before the set existed: `U+1D5C3 U+1D5CC` as the JavaScript file icon and `U+2B73` on the compliance-export button.
- **Don't** put an icon *inside* an ellipsised string. Give it its own `flex-shrink: 0` slot beside the truncating text, or it eats the budget of the only part worth reading (the filename).
- **Don't** truncate user- or model-authored text with a raw `.slice(n)`. That counts UTF-16 units and splits emoji in half, rendering a lone `�`. Use the grapheme-safe `cutGraphemes()` helper in `agent-panel/derive.ts`.
- **Don't** show a UI element that claims something the app can't back up — no fake "connected" states, no placeholder data presented as real, no non-functional buttons that look clickable. This is the single most consistently enforced rule across this codebase's whole history.
