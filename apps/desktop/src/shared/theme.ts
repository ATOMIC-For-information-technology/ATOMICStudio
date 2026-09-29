/**
 * The theme engine.
 *
 * ATOMIC Studio wears VS Code's workbench geometry, so it needs VS Code's *colour vocabulary* too:
 * a title bar, an activity rail, a sidebar, tabs, a status bar, a panel, lists, inputs, widgets and
 * a syntax palette are each separately themable in a real IDE, and a single `--bg` cannot express
 * that. This file is that vocabulary — pure, IO-free, and imported by BOTH processes (the renderer
 * paints from it; the main process persists which one is on and validates imported files), which is
 * exactly why it must stay free of `electron`, DOM and Node.
 *
 * **A theme is authored as a seed, not as ninety hex values.** Hand-maintaining ninety tokens across
 * eight themes is how a palette rots: one theme gets a fixed contrast bug and the other seven keep
 * it. Instead each theme states ~20 real decisions (its surfaces, its one accent, its three status
 * colours, its eleven syntax colours) and `buildTheme` derives the rest by rule. The derivations are
 * the design system expressed as code:
 *
 *  - Hover and active surfaces are the base surface walked toward the foreground, never a second
 *    hand-picked grey that drifts out of step when the base changes.
 *  - Every status *text* colour is walked away from its surface until it actually measures 4.5:1.
 *    DESIGN.md's chip rule (tint background, full-strength text) was previously satisfied by three
 *    hand-tuned pairs; a light theme would have silently shipped 2.4:1 amber-on-white. Now the floor
 *    is arithmetic, so a theme physically cannot be authored below it.
 *  - The one-accent rule is per THEME, not per app. Each theme still has exactly one non-status
 *    accent; what changes between themes is which hue that is.
 *
 * Adding a theme is one entry in `BUILT_IN_SEEDS`. Nothing else in the app has to know about it.
 */

/** Which family a theme belongs to — mirrors VS Code's `type` field, and drives Monaco's base. */
export type ThemeKind = 'dark' | 'light' | 'hc-dark' | 'hc-light'

/** True for the two dark families — the single question every derivation actually asks. */
export function isDarkKind(kind: ThemeKind): boolean {
  return kind === 'dark' || kind === 'hc-dark'
}

/** True for the two high-contrast families, which get visible borders on everything. */
export function isHighContrast(kind: ThemeKind): boolean {
  return kind === 'hc-dark' || kind === 'hc-light'
}

/**
 * The eleven syntax roles. Deliberately small: these are the scopes that actually change how code
 * reads. A theme that tried to colour forty TextMate scopes would be unmaintainable and would still
 * miss whichever grammar the user opened.
 */
export interface SyntaxColors {
  comment: string
  string: string
  keyword: string
  number: string
  func: string
  type: string
  variable: string
  constant: string
  operator: string
  tag: string
  attribute: string
}

/** What a theme author actually decides. Everything else in `ThemeTokens` is derived from this. */
export interface ThemeSeed {
  id: string
  name: string
  publisher: string
  kind: ThemeKind
  /** The editor canvas — the deepest, largest surface. */
  bg: string
  /** Chrome: sidebar, activity bar, title bar, status bar, panel. */
  panel: string
  /** One step closer to the user: nested panels, inputs, cards. */
  panel2: string
  /** Every 1px rule in the app. */
  border: string
  /** Primary text. */
  text: string
  /** Secondary text — context, not content. */
  muted: string
  /** The single non-status accent: focus, active tab, links, primary buttons. */
  accent: string
  ok: string
  danger: string
  warn: string
  /** Optional extra ANSI hues for the terminal; derived from the accent when absent. */
  magenta?: string
  cyan?: string
  syntax: SyntaxColors
  /** Escape hatch for anything a derivation gets wrong for one specific theme. */
  overrides?: Partial<ThemeTokens>
}

/**
 * The full painted surface. Names map 1:1 onto CSS custom properties (`bg` → `--bg`), so a theme is
 * applied by writing this object onto the root element and nothing else in the renderer changes.
 *
 * The first block is the legacy vocabulary the existing stylesheet already consumes; the `wb-`
 * prefixed block is the workbench vocabulary the VS Code-shaped chrome added. Keeping the old names
 * is not laziness — rewriting 2,600 lines of working CSS to satisfy a naming preference would risk
 * the app for no user-visible gain.
 */
export interface ThemeTokens {
  bg: string
  panel: string
  'panel-2': string
  border: string
  text: string
  muted: string
  accent: string
  'accent-2': string
  green: string
  red: string
  amber: string
  hover: string
  'active-bg': string
  'toggled-bg': string
  'toggled-fg': string
  'toggled-border': string
  'danger-tint': string
  'danger-fg': string
  'warn-tint': string
  'warn-fg': string
  'ok-tint': string
  'ok-fg': string
  'info-tint': string
  'info-fg': string
  'neutral-tint': string
  'neutral-fg': string

  /* ---- Workbench: the surfaces VS Code themes separately ---- */
  'wb-titlebar-bg': string
  'wb-titlebar-fg': string
  'wb-titlebar-inactive-fg': string
  'wb-activitybar-bg': string
  'wb-activitybar-fg': string
  'wb-activitybar-inactive-fg': string
  'wb-activitybar-active-border': string
  'wb-activitybar-active-bg': string
  'wb-badge-bg': string
  'wb-badge-fg': string
  'wb-sidebar-bg': string
  'wb-sidebar-fg': string
  'wb-sidebar-section-bg': string
  'wb-sidebar-section-border': string
  'wb-editor-bg': string
  'wb-editor-fg': string
  'wb-editor-line-highlight': string
  'wb-editor-selection': string
  'wb-editor-cursor': string
  'wb-editor-linenumber': string
  'wb-editor-linenumber-active': string
  'wb-editor-indent-guide': string
  'wb-tab-active-bg': string
  'wb-tab-active-fg': string
  'wb-tab-inactive-bg': string
  'wb-tab-inactive-fg': string
  'wb-tab-border': string
  'wb-tab-active-border-top': string
  'wb-tab-hover-bg': string
  'wb-statusbar-bg': string
  'wb-statusbar-fg': string
  'wb-statusbar-hover-bg': string
  'wb-statusbar-border': string
  'wb-statusbar-remote-bg': string
  'wb-statusbar-remote-fg': string
  'wb-panel-bg': string
  'wb-panel-border': string
  'wb-list-hover-bg': string
  'wb-list-active-bg': string
  'wb-list-active-fg': string
  'wb-list-inactive-bg': string
  'wb-list-inactive-fg': string
  'wb-input-bg': string
  'wb-input-fg': string
  'wb-input-border': string
  'wb-input-placeholder': string
  'wb-dropdown-bg': string
  'wb-dropdown-border': string
  'wb-button-bg': string
  'wb-button-fg': string
  'wb-button-hover-bg': string
  'wb-button-secondary-bg': string
  'wb-button-secondary-fg': string
  'wb-button-secondary-hover-bg': string
  'wb-widget-bg': string
  'wb-widget-border': string
  'wb-widget-shadow': string
  'wb-focus-border': string
  'wb-scrollbar-slider': string
  'wb-scrollbar-slider-hover': string
  'wb-scrollbar-slider-active': string
  'wb-scrollbar-shadow': string
  'wb-selection-bg': string

  /* ---- Terminal: the 16 ANSI slots, so the shell belongs to the theme too ---- */
  'term-bg': string
  'term-fg': string
  'term-cursor': string
  'term-selection': string
  'term-black': string
  'term-red': string
  'term-green': string
  'term-yellow': string
  'term-blue': string
  'term-magenta': string
  'term-cyan': string
  'term-white': string
  'term-bright-black': string
  'term-bright-red': string
  'term-bright-green': string
  'term-bright-yellow': string
  'term-bright-blue': string
  'term-bright-magenta': string
  'term-bright-cyan': string
  'term-bright-white': string
}

/** A finished, paintable theme. */
export interface Theme {
  id: string
  name: string
  publisher: string
  kind: ThemeKind
  /** Where it came from — the picker groups by this, and only `installed` can be removed. */
  source: 'built-in' | 'installed'
  tokens: ThemeTokens
  syntax: SyntaxColors
}

/** Result of installing or removing a theme — a stated error, never a silent no-op. */
export interface ThemeInstallResult {
  ok: boolean
  theme?: Theme
  error?: string
}

/* ================================================================================
   Colour maths. Small, exact, and dependency-free — a colour library would be the
   only runtime dependency in `src/shared`, for eleven lines of arithmetic.
   ================================================================================ */

interface Rgb {
  r: number
  g: number
  b: number
}

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored). Returns null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const s = hex.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return { r: parseInt(s[0] + s[0], 16), g: parseInt(s[1] + s[1], 16), b: parseInt(s[2] + s[2], 16) }
  }
  if (/^[0-9a-f]{6}$/i.test(s) || /^[0-9a-f]{8}$/i.test(s)) {
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) }
  }
  return null
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n)
}

function toHex({ r, g, b }: Rgb): string {
  const h = (n: number): string => clamp255(n).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** Linear blend: `amount` 0 returns `a`, 1 returns `b`. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a)
  const y = parseHex(b)
  if (!x || !y) return a
  const t = amount < 0 ? 0 : amount > 1 ? 1 : amount
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t })
}

/** `rgba(...)` string from a hex and an alpha — used wherever a tint sits over an unknown surface. */
/**
 * A colour at partial opacity, as **8-digit hex** — not `rgba()`.
 *
 * This used to return `rgba(59, 130, 246, 0.32)`, which is perfectly good CSS, and every custom
 * property built from it looked right. The same tokens are also handed to Monaco's `colors` map,
 * and Monaco parses those with its own hex parser — which understands `#RRGGBB` and `#RRGGBBAA`
 * and **falls back to solid red for anything else**. So every alpha-derived editor colour rendered
 * as red: selection most visibly (reported 2026-09-03 as "i dont want the red color"), but also the
 * current-line highlight, the indent guides and the whitespace marks, in all eight themes.
 *
 * Eight-digit hex is understood by CSS, Monaco and xterm alike, so one format serves all three and
 * this class of failure cannot come back. Do not "simplify" this to `rgba()`.
 */
export function alpha(hex: string, a: number): string {
  const c = parseHex(hex)
  if (!c) return hex
  const aa = Math.round(Math.max(0, Math.min(1, a)) * 255)
  const h = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${h(aa)}`
}

function channelLum(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const c = parseHex(hex)
  if (!c) return 0
  return 0.2126 * channelLum(c.r) + 0.7152 * channelLum(c.g) + 0.0722 * channelLum(c.b)
}

/** WCAG contrast ratio between two opaque colours, 1–21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Walk `fg` away from `bg` until it clears `min:1`, then stop.
 *
 * This is the single rule that lets a theme be authored by seed without shipping unreadable status
 * text. It moves toward white on a dark surface and toward black on a light one, in 5% steps, and
 * returns the first step that measures — so a colour that already passes is returned untouched and
 * keeps its hue.
 */
export function readableOn(fg: string, bg: string, min = 4.5): string {
  if (contrast(fg, bg) >= min) return fg
  const target = luminance(bg) > 0.35 ? '#000000' : '#ffffff'
  for (let step = 0.05; step <= 1; step += 0.05) {
    const candidate = mix(fg, target, step)
    if (contrast(candidate, bg) >= min) return candidate
  }
  // The chosen pole itself cannot reach the floor — which happens when `fg` started at or near
  // that pole (white text on a mid-blue accent was the shipped case: the loop mixed white into
  // white forever and returned a 3.7:1 "fix"). Walk toward the opposite pole instead, and if
  // neither direction reaches the floor, return whichever pole measures better.
  const opposite = target === '#ffffff' ? '#000000' : '#ffffff'
  for (let step = 0.05; step <= 1; step += 0.05) {
    const candidate = mix(fg, opposite, step)
    if (contrast(candidate, bg) >= min) return candidate
  }
  return contrast(target, bg) >= contrast(opposite, bg) ? target : opposite
}

/**
 * Text-on-a-filled-control: pick white or black, whichever actually measures better on `bg` — and
 * when even the winning pole cannot reach `min`, return an adjusted background alongside it, walked
 * toward the losing pole until the pair passes. Buttons, badges and the status bar's remote item
 * are the only solid accent fills in the app, and they are exactly where "white text, always" broke:
 * on an amber or sky accent, white measures ~3:1 and black passes easily.
 */
export function fillPair(bg: string, min = 4.5): { bg: string; fg: string } {
  const pick = (b: string): string => (contrast('#ffffff', b) >= contrast('#000000', b) ? '#ffffff' : '#000000')
  let fg = pick(bg)
  if (contrast(fg, bg) >= min) return { bg, fg }
  // Neither pole passes on this fill — the fill itself is mid-luminance. Nudge it away from the
  // winning pole (darken under white text, lighten under black) until the pair measures.
  const away = fg === '#ffffff' ? '#000000' : '#ffffff'
  let adjusted = bg
  for (let step = 0.05; step <= 1; step += 0.05) {
    adjusted = mix(bg, away, step)
    fg = pick(adjusted)
    if (contrast(fg, adjusted) >= min) return { bg: adjusted, fg }
  }
  return { bg: away, fg: pick(away) }
}

/* ================================================================================
   Derivation
   ================================================================================ */

/**
 * Turn a seed into the full token map.
 *
 * Every rule here is stated once and applies to every theme, authored or imported. That is the
 * point: an imported VS Code theme that only sets `editor.background` still gets a complete,
 * contrast-checked workbench rather than half a painted app.
 */
export function buildTheme(seed: ThemeSeed, source: Theme['source'] = 'built-in'): Theme {
  const dark = isDarkKind(seed.kind)
  const hc = isHighContrast(seed.kind)
  const fgEnd = dark ? '#ffffff' : '#000000'
  const bgEnd = dark ? '#000000' : '#ffffff'

  // Interaction surfaces are the base walked toward the foreground. High contrast steps harder,
  // because at hc contrast a 6% shift is invisible.
  const hover = mix(seed.panel2, fgEnd, hc ? 0.16 : 0.07)
  const activeBg = mix(seed.panel2, fgEnd, hc ? 0.24 : 0.13)

  const accentText = readableOn(seed.accent, seed.panel, 4.5)
  const accentDeep = mix(seed.accent, bgEnd, 0.2)
  // The three solid accent fills (button, badge, remote status item) each get the black-or-white
  // text that actually measures on THEIR fill, with the fill nudged when neither pole passes.
  const button = fillPair(accentDeep)
  const badge = fillPair(seed.accent)
  const magenta = seed.magenta ?? mix(seed.accent, '#d946ef', 0.6)
  const cyan = seed.cyan ?? mix(seed.accent, '#22d3ee', 0.6)

  const tint = (c: string): string => alpha(c, dark ? 0.16 : 0.13)

  const tokens: ThemeTokens = {
    bg: seed.bg,
    panel: seed.panel,
    'panel-2': seed.panel2,
    border: seed.border,
    text: seed.text,
    muted: readableOn(seed.muted, seed.panel, hc ? 7 : 4.5),
    accent: seed.accent,
    'accent-2': accentDeep,
    green: seed.ok,
    red: seed.danger,
    amber: seed.warn,
    hover,
    'active-bg': activeBg,
    // DESIGN.md's toggled treatment: a tint of the accent, never a solid accent fill.
    'toggled-bg': alpha(seed.accent, hc ? 0.28 : 0.15),
    'toggled-fg': accentText,
    'toggled-border': alpha(seed.accent, hc ? 0.9 : 0.4),
    'danger-tint': tint(seed.danger),
    'danger-fg': readableOn(seed.danger, seed.panel, 4.5),
    'warn-tint': tint(seed.warn),
    'warn-fg': readableOn(seed.warn, seed.panel, 4.5),
    'ok-tint': tint(seed.ok),
    'ok-fg': readableOn(seed.ok, seed.panel, 4.5),
    'info-tint': tint(seed.accent),
    'info-fg': accentText,
    // Taxonomy never borrows a status colour, so it is built from the neutral axis alone.
    'neutral-tint': alpha(seed.muted, dark ? 0.18 : 0.16),
    'neutral-fg': readableOn(mix(seed.muted, fgEnd, 0.35), seed.panel, 4.5),

    'wb-titlebar-bg': seed.panel,
    'wb-titlebar-fg': readableOn(seed.muted, seed.panel, 4.5),
    'wb-titlebar-inactive-fg': alpha(seed.muted, 0.6),
    'wb-activitybar-bg': seed.panel,
    'wb-activitybar-fg': seed.text,
    'wb-activitybar-inactive-fg': readableOn(seed.muted, seed.panel, 4.5),
    'wb-activitybar-active-border': seed.accent,
    'wb-activitybar-active-bg': hc ? alpha(seed.accent, 0.2) : 'transparent',
    'wb-badge-bg': badge.bg,
    'wb-badge-fg': badge.fg,
    'wb-sidebar-bg': seed.panel,
    'wb-sidebar-fg': seed.text,
    'wb-sidebar-section-bg': mix(seed.panel, fgEnd, hc ? 0.1 : 0.03),
    'wb-sidebar-section-border': seed.border,
    'wb-editor-bg': seed.bg,
    'wb-editor-fg': seed.text,
    'wb-editor-line-highlight': mix(seed.bg, fgEnd, 0.05),
    'wb-editor-selection': alpha(seed.accent, dark ? 0.32 : 0.24),
    'wb-editor-cursor': seed.accent,
    'wb-editor-linenumber': readableOn(seed.muted, seed.bg, 3),
    'wb-editor-linenumber-active': seed.text,
    'wb-editor-indent-guide': mix(seed.bg, fgEnd, 0.12),
    // VS Code's tab rule exactly: the active tab is the editor surface continuing upward, so it
    // reads as the same sheet of paper; the inactive strip is chrome.
    'wb-tab-active-bg': seed.bg,
    'wb-tab-active-fg': seed.text,
    'wb-tab-inactive-bg': mix(seed.panel, bgEnd, dark ? 0.18 : 0.06),
    'wb-tab-inactive-fg': readableOn(seed.muted, seed.panel, 4.5),
    'wb-tab-border': seed.border,
    'wb-tab-active-border-top': seed.accent,
    'wb-tab-hover-bg': mix(seed.panel, fgEnd, 0.05),
    'wb-statusbar-bg': seed.panel,
    'wb-statusbar-fg': readableOn(seed.muted, seed.panel, 4.5),
    'wb-statusbar-hover-bg': alpha(fgEnd, dark ? 0.12 : 0.08),
    'wb-statusbar-border': seed.border,
    'wb-statusbar-remote-bg': button.bg,
    'wb-statusbar-remote-fg': button.fg,
    'wb-panel-bg': seed.panel,
    'wb-panel-border': seed.border,
    'wb-list-hover-bg': hover,
    'wb-list-active-bg': alpha(seed.accent, hc ? 0.34 : 0.2),
    'wb-list-active-fg': seed.text,
    'wb-list-inactive-bg': alpha(seed.muted, dark ? 0.16 : 0.14),
    'wb-list-inactive-fg': seed.text,
    'wb-input-bg': hc ? seed.bg : mix(seed.panel2, bgEnd, dark ? 0.25 : 0),
    'wb-input-fg': seed.text,
    'wb-input-border': hc ? seed.text : seed.border,
    'wb-input-placeholder': readableOn(seed.muted, seed.panel2, 4.5),
    'wb-dropdown-bg': mix(seed.panel2, fgEnd, dark ? 0.04 : 0),
    'wb-dropdown-border': seed.border,
    'wb-button-bg': button.bg,
    'wb-button-fg': button.fg,
    'wb-button-hover-bg': mix(button.bg, fgEnd, 0.12),
    'wb-button-secondary-bg': mix(seed.panel2, fgEnd, dark ? 0.06 : 0.04),
    'wb-button-secondary-fg': seed.text,
    'wb-button-secondary-hover-bg': mix(seed.panel2, fgEnd, dark ? 0.14 : 0.1),
    'wb-widget-bg': mix(seed.panel, fgEnd, dark ? 0.05 : 0),
    'wb-widget-border': hc ? seed.text : seed.border,
    // A real overlay shadow: offset plus soft blur, never a zero-offset halo.
    'wb-widget-shadow': dark ? '0 12px 40px rgba(0, 0, 0, 0.56)' : '0 12px 40px rgba(0, 0, 0, 0.18)',
    'wb-focus-border': seed.accent,
    'wb-scrollbar-slider': alpha(seed.muted, dark ? 0.34 : 0.4),
    'wb-scrollbar-slider-hover': alpha(seed.muted, dark ? 0.52 : 0.6),
    'wb-scrollbar-slider-active': alpha(seed.muted, dark ? 0.72 : 0.8),
    'wb-scrollbar-shadow': alpha(bgEnd, 0.4),
    'wb-selection-bg': alpha(seed.accent, dark ? 0.38 : 0.28),

    'term-bg': seed.bg,
    'term-fg': seed.text,
    'term-cursor': seed.accent,
    'term-selection': alpha(seed.accent, 0.35),
    'term-black': dark ? seed.panel : mix(seed.text, bgEnd, 0.15),
    'term-red': seed.danger,
    'term-green': seed.ok,
    'term-yellow': seed.warn,
    'term-blue': seed.accent,
    'term-magenta': magenta,
    'term-cyan': cyan,
    'term-white': dark ? seed.text : mix(seed.text, bgEnd, 0.45),
    'term-bright-black': seed.muted,
    'term-bright-red': mix(seed.danger, fgEnd, 0.32),
    'term-bright-green': mix(seed.ok, fgEnd, 0.32),
    'term-bright-yellow': mix(seed.warn, fgEnd, 0.32),
    'term-bright-blue': mix(seed.accent, fgEnd, 0.32),
    'term-bright-magenta': mix(magenta, fgEnd, 0.32),
    'term-bright-cyan': mix(cyan, fgEnd, 0.32),
    'term-bright-white': dark ? '#ffffff' : seed.text,

    ...(seed.overrides ?? {})
  }

  return {
    id: seed.id,
    name: seed.name,
    publisher: seed.publisher,
    kind: seed.kind,
    source,
    tokens,
    syntax: seed.syntax
  }
}

/* ================================================================================
   The authored themes
   ================================================================================ */

/**
 * Eight themes across four families. Each states one accent hue and its own syntax palette; the
 * rest is derived. `atomic-void` is the default and is the palette the app shipped with, promoted
 * from a hardcoded `:root` block into a theme so it can be left as well as returned to.
 */
export const BUILT_IN_SEEDS: ThemeSeed[] = [
  {
    id: 'atomic-void',
    name: 'ATOMIC Void',
    publisher: 'ATOMIC',
    kind: 'dark',
    bg: '#0f1115',
    panel: '#171a21',
    panel2: '#1e222b',
    border: '#2a2f3a',
    text: '#e6e9ef',
    muted: '#8b93a3',
    accent: '#3b82f6',
    ok: '#22c55e',
    danger: '#ef4444',
    warn: '#f59e0b',
    magenta: '#a78bfa',
    cyan: '#38bdf8',
    syntax: {
      comment: '#5f6878',
      string: '#9ecbff',
      keyword: '#7aa2f7',
      number: '#e0af68',
      func: '#82aaff',
      type: '#5ccfe6',
      variable: '#dfe4ee',
      constant: '#c792ea',
      operator: '#89ddff',
      tag: '#f07178',
      attribute: '#ffcb6b'
    }
  },
  {
    id: 'atomic-reactor',
    name: 'ATOMIC Reactor',
    publisher: 'ATOMIC',
    kind: 'dark',
    // Warm, dense, slightly brown-black — the console of something that runs hot.
    bg: '#16130f',
    panel: '#1d1a15',
    panel2: '#262119',
    border: '#3a3227',
    text: '#efe6d7',
    muted: '#9c8f7c',
    accent: '#ff9d3f',
    ok: '#8ec07c',
    danger: '#fb4934',
    warn: '#fabd2f',
    magenta: '#d3869b',
    cyan: '#83a598',
    syntax: {
      comment: '#7c6f5b',
      string: '#b8bb26',
      keyword: '#ff9d3f',
      number: '#d3869b',
      func: '#fabd2f',
      type: '#8ec07c',
      variable: '#efe6d7',
      constant: '#d3869b',
      operator: '#fe8019',
      tag: '#fb4934',
      attribute: '#83a598'
    }
  },
  {
    id: 'atomic-graphite',
    name: 'ATOMIC Graphite',
    publisher: 'ATOMIC',
    kind: 'dark',
    // Near-achromatic. For long sessions where any hue in the chrome is one signal too many.
    bg: '#131313',
    panel: '#1a1a1a',
    panel2: '#232323',
    border: '#333333',
    text: '#e4e4e4',
    muted: '#8f8f8f',
    accent: '#9aa7b8',
    ok: '#7fb069',
    danger: '#d16b6b',
    warn: '#d4a25e',
    magenta: '#b39ec4',
    cyan: '#7fa8b0',
    syntax: {
      comment: '#6a6a6a',
      string: '#a8b5a0',
      keyword: '#c5cdd8',
      number: '#c9b18a',
      func: '#dcdcdc',
      type: '#a3b3c2',
      variable: '#e4e4e4',
      constant: '#b39ec4',
      operator: '#9aa7b8',
      tag: '#c0a0a0',
      attribute: '#c9b18a'
    }
  },
  {
    id: 'atomic-fission',
    name: 'ATOMIC Fission',
    publisher: 'ATOMIC',
    kind: 'dark',
    // Deep indigo with a cold accent — the highest-chroma dark theme in the set.
    bg: '#12121f',
    panel: '#191930',
    panel2: '#20203c',
    border: '#2f2f52',
    text: '#e4e4f4',
    muted: '#8b8bb4',
    accent: '#22d3ee',
    ok: '#4ade80',
    danger: '#fb7185',
    warn: '#fcd34d',
    magenta: '#c084fc',
    cyan: '#67e8f9',
    syntax: {
      comment: '#5c5c8a',
      string: '#a5f3d0',
      keyword: '#c084fc',
      number: '#fcd34d',
      func: '#67e8f9',
      type: '#7dd3fc',
      variable: '#e4e4f4',
      constant: '#f0abfc',
      operator: '#22d3ee',
      tag: '#fb7185',
      attribute: '#facc15'
    }
  },
  {
    id: 'atomic-daylight',
    name: 'ATOMIC Daylight',
    publisher: 'ATOMIC',
    kind: 'light',
    bg: '#ffffff',
    panel: '#f3f4f6',
    panel2: '#e9ebef',
    border: '#d3d7de',
    text: '#1f2430',
    muted: '#5c6472',
    accent: '#1a6fd4',
    ok: '#15803d',
    danger: '#c2261c',
    warn: '#a35c00',
    magenta: '#8b2fc9',
    cyan: '#0e7490',
    syntax: {
      comment: '#6b7280',
      string: '#0a7a52',
      keyword: '#0b56b8',
      number: '#985700',
      func: '#5a2ca0',
      type: '#0e7490',
      variable: '#1f2430',
      constant: '#8b2fc9',
      operator: '#0b56b8',
      tag: '#a4262c',
      attribute: '#985700'
    }
  },
  {
    id: 'atomic-paper',
    name: 'ATOMIC Paper',
    publisher: 'ATOMIC',
    kind: 'light',
    // Warm light, lower glare than pure white — for a bright room rather than a dark one.
    bg: '#faf6ef',
    panel: '#f1ece2',
    panel2: '#e7e0d3',
    border: '#d5cbb8',
    text: '#2c2620',
    muted: '#6b6154',
    accent: '#b0430f',
    ok: '#4a7c2f',
    danger: '#a52a1a',
    warn: '#8a5a00',
    magenta: '#8a3a70',
    cyan: '#276678',
    syntax: {
      comment: '#8a7f6f',
      string: '#4a7c2f',
      keyword: '#b0430f',
      number: '#8a5a00',
      func: '#8a3a70',
      type: '#276678',
      variable: '#2c2620',
      constant: '#8a3a70',
      operator: '#a05010',
      tag: '#a52a1a',
      attribute: '#8a5a00'
    }
  },
  {
    id: 'atomic-contrast',
    name: 'ATOMIC Contrast',
    publisher: 'ATOMIC',
    kind: 'hc-dark',
    // Pure black ground, saturated primaries, and a border on everything — the HC families get
    // visible edges on inputs and widgets rather than relying on a surface step.
    bg: '#000000',
    panel: '#0b0b0b',
    panel2: '#161616',
    border: '#6fc3ff',
    text: '#ffffff',
    muted: '#c2c2c2',
    accent: '#4cc2ff',
    ok: '#3ff23f',
    danger: '#ff5f5f',
    warn: '#ffdd00',
    magenta: '#e58cff',
    cyan: '#5ff5ff',
    syntax: {
      comment: '#9ad4ff',
      string: '#ffd580',
      keyword: '#5ff5ff',
      number: '#ffdd00',
      func: '#ffffff',
      type: '#3ff23f',
      variable: '#ffffff',
      constant: '#e58cff',
      operator: '#5ff5ff',
      tag: '#ff5f5f',
      attribute: '#ffd580'
    }
  },
  {
    id: 'atomic-contrast-light',
    name: 'ATOMIC Contrast Light',
    publisher: 'ATOMIC',
    kind: 'hc-light',
    bg: '#ffffff',
    panel: '#ffffff',
    panel2: '#f2f2f2',
    border: '#0f4a85',
    text: '#000000',
    muted: '#3b3b3b',
    accent: '#0f4a85',
    ok: '#0a5c0a',
    danger: '#a80000',
    warn: '#6b4300',
    magenta: '#7a007a',
    cyan: '#005a6e',
    syntax: {
      comment: '#3b5a80',
      string: '#0a5c0a',
      keyword: '#0f4a85',
      number: '#6b4300',
      func: '#7a007a',
      type: '#005a6e',
      variable: '#000000',
      constant: '#7a007a',
      operator: '#0f4a85',
      tag: '#a80000',
      attribute: '#6b4300'
    }
  }
]

export const BUILT_IN_THEMES: Theme[] = BUILT_IN_SEEDS.map((s) => buildTheme(s, 'built-in'))

export const DEFAULT_THEME_ID = 'atomic-void'

/** The default theme, guaranteed to exist — every lookup falls back here rather than to nothing. */
export function defaultTheme(): Theme {
  return BUILT_IN_THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? BUILT_IN_THEMES[0]
}

/** Look a theme up across built-ins and a list of installed ones; never returns undefined. */
export function resolveTheme(id: string | null | undefined, installed: Theme[] = []): Theme {
  if (id) {
    const hit = [...BUILT_IN_THEMES, ...installed].find((t) => t.id === id)
    if (hit) return hit
  }
  return defaultTheme()
}

/** Human-readable family label, used as the group heading in the theme picker. */
export function kindLabel(kind: ThemeKind): string {
  switch (kind) {
    case 'dark':
      return 'Dark'
    case 'light':
      return 'Light'
    case 'hc-dark':
      return 'High Contrast Dark'
    case 'hc-light':
      return 'High Contrast Light'
  }
}

/** The order families appear in the picker — dark first, because that is what most sessions use. */
export const KIND_ORDER: ThemeKind[] = ['dark', 'light', 'hc-dark', 'hc-light']

/* ================================================================================
   Adapters — the two engines inside the app that paint themselves, not from CSS
   ================================================================================ */

/** Monaco's `IStandaloneThemeData`, expressed as a plain object so `src/shared` stays import-free. */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: { token: string; foreground?: string; fontStyle?: string }[]
  colors: Record<string, string>
}

/** Monaco wants bare hex without the `#`, and silently ignores a rule that includes one. */
function bare(hex: string): string {
  return hex.replace(/^#/, '')
}

/**
 * The editor half of a theme.
 *
 * The eleven syntax roles are expanded here into the TextMate scopes Monaco actually emits, so a
 * theme author never has to know that `entity.name.function` and `support.function` are two scopes
 * for one idea.
 */
export function monacoThemeData(theme: Theme): MonacoThemeData {
  const s = theme.syntax
  const t = theme.tokens
  const base: MonacoThemeData['base'] =
    theme.kind === 'hc-dark' ? 'hc-black' : theme.kind === 'hc-light' ? 'hc-light' : theme.kind === 'light' ? 'vs' : 'vs-dark'

  return {
    base,
    inherit: true,
    rules: [
      { token: '', foreground: bare(t['wb-editor-fg']) },
      { token: 'comment', foreground: bare(s.comment), fontStyle: 'italic' },
      { token: 'string', foreground: bare(s.string) },
      { token: 'string.escape', foreground: bare(s.operator) },
      { token: 'keyword', foreground: bare(s.keyword) },
      { token: 'keyword.operator', foreground: bare(s.operator) },
      { token: 'operator', foreground: bare(s.operator) },
      { token: 'delimiter', foreground: bare(t.muted) },
      { token: 'number', foreground: bare(s.number) },
      { token: 'constant', foreground: bare(s.constant) },
      { token: 'constant.language', foreground: bare(s.constant) },
      { token: 'entity.name.function', foreground: bare(s.func) },
      { token: 'support.function', foreground: bare(s.func) },
      { token: 'type', foreground: bare(s.type) },
      { token: 'type.identifier', foreground: bare(s.type) },
      { token: 'support.type', foreground: bare(s.type) },
      { token: 'variable', foreground: bare(s.variable) },
      { token: 'variable.parameter', foreground: bare(s.variable) },
      { token: 'identifier', foreground: bare(s.variable) },
      { token: 'tag', foreground: bare(s.tag) },
      { token: 'metatag', foreground: bare(s.tag) },
      { token: 'attribute.name', foreground: bare(s.attribute) },
      { token: 'attribute.value', foreground: bare(s.string) },
      { token: 'key', foreground: bare(s.attribute) },
      { token: 'annotation', foreground: bare(s.constant) },
      { token: 'invalid', foreground: bare(t.red) }
    ],
    colors: {
      'editor.background': t['wb-editor-bg'],
      'editor.foreground': t['wb-editor-fg'],
      'editor.lineHighlightBackground': t['wb-editor-line-highlight'],
      'editor.selectionBackground': t['wb-editor-selection'],
      'editorCursor.foreground': t['wb-editor-cursor'],
      'editorLineNumber.foreground': t['wb-editor-linenumber'],
      'editorLineNumber.activeForeground': t['wb-editor-linenumber-active'],
      'editorIndentGuide.background': t['wb-editor-indent-guide'],
      'editorIndentGuide.activeBackground': t.muted,
      'editorWhitespace.foreground': t['wb-editor-indent-guide'],
      'editorGutter.background': t['wb-editor-bg'],
      'editorWidget.background': t['wb-widget-bg'],
      'editorWidget.border': t['wb-widget-border'],
      'editorSuggestWidget.background': t['wb-widget-bg'],
      'editorSuggestWidget.border': t['wb-widget-border'],
      'editorSuggestWidget.selectedBackground': t['wb-list-active-bg'],
      'editorHoverWidget.background': t['wb-widget-bg'],
      'editorHoverWidget.border': t['wb-widget-border'],
      'editorError.foreground': t.red,
      'editorWarning.foreground': t.amber,
      'editorInfo.foreground': t.accent,
      'scrollbarSlider.background': t['wb-scrollbar-slider'],
      'scrollbarSlider.hoverBackground': t['wb-scrollbar-slider-hover'],
      'scrollbarSlider.activeBackground': t['wb-scrollbar-slider-active'],
      'minimap.background': t['wb-editor-bg'],
      'focusBorder': t['wb-focus-border']
    }
  }
}

/** xterm.js's `ITheme`, as a plain object for the same reason. */
export interface XtermThemeData {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** The terminal half of a theme — all sixteen ANSI slots, so the shell belongs to the workbench. */
export function xtermThemeData(theme: Theme): XtermThemeData {
  const t = theme.tokens
  return {
    background: t['term-bg'],
    foreground: t['term-fg'],
    cursor: t['term-cursor'],
    selectionBackground: t['term-selection'],
    black: t['term-black'],
    red: t['term-red'],
    green: t['term-green'],
    yellow: t['term-yellow'],
    blue: t['term-blue'],
    magenta: t['term-magenta'],
    cyan: t['term-cyan'],
    white: t['term-white'],
    brightBlack: t['term-bright-black'],
    brightRed: t['term-bright-red'],
    brightGreen: t['term-bright-green'],
    brightYellow: t['term-bright-yellow'],
    brightBlue: t['term-bright-blue'],
    brightMagenta: t['term-bright-magenta'],
    brightCyan: t['term-bright-cyan'],
    brightWhite: t['term-bright-white']
  }
}

/** The `:root` declaration list for a theme — one `--name: value;` per token. */
export function themeCssVars(theme: Theme): string {
  return (Object.keys(theme.tokens) as (keyof ThemeTokens)[])
    .map((k) => `--${k}: ${theme.tokens[k]};`)
    .join('\n')
}
