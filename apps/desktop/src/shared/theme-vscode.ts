import {
  buildTheme,
  mix,
  parseHex,
  type SyntaxColors,
  type Theme,
  type ThemeKind,
  type ThemeSeed,
  type ThemeTokens
} from './theme'

/**
 * Importing a VS Code **colour theme** file.
 *
 * PRODUCT.md rules out `.vsix` extensions, and that rule is not being bent here. A VS Code colour
 * theme is a JSON *data* file — a list of hex values keyed by workbench colour id and TextMate
 * scope. There is no code in it, nothing is executed, and nothing about supporting it implies the
 * extension API works. The honest boundary is exactly this: **we read the colours, we do not run
 * the extension.** A file that turns out to be a manifest rather than a theme is rejected by name
 * rather than half-applied.
 *
 * The conversion is lossy in one direction only, and deliberately so: VS Code defines several
 * hundred workbench colour ids, and this app has surfaces VS Code does not (the agent dock, the
 * device frames, the build receipt). Rather than paint the eighty ids we share and leave everything
 * else at the previous theme's values — which is how an imported theme ends up looking broken in
 * half the app — the importer extracts a *seed* and lets `buildTheme` derive the whole workbench
 * from it, then layers the file's own values back on top wherever it actually specified one.
 */

/** The subset of a `.json` colour theme this reads. Everything else in the file is ignored. */
export interface VsCodeThemeFile {
  name?: string
  type?: string
  colors?: Record<string, string>
  tokenColors?: {
    scope?: string | string[]
    settings?: { foreground?: string; fontStyle?: string }
  }[]
  /** Some themes wrap the real payload; `include` chains are NOT followed (see `importVsCodeTheme`). */
  include?: string
}

export interface ThemeImportResult {
  ok: boolean
  theme?: Theme
  error?: string
}

/** Accept only `#rgb`/`#rrggbb`/`#rrggbbaa`; anything else is treated as absent, never as a value. */
function hex(v: string | undefined): string | null {
  if (typeof v !== 'string') return null
  return parseHex(v) ? `#${v.trim().replace(/^#/, '').slice(0, 6)}` : null
}

function firstHex(colors: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    const h = hex(colors[k])
    if (h) return h
  }
  return null
}

function normalizeKind(type: string | undefined): ThemeKind {
  switch ((type ?? '').toLowerCase()) {
    case 'light':
      return 'light'
    case 'hc':
    case 'hcdark':
    case 'hc-dark':
      return 'hc-dark'
    case 'hclight':
    case 'hc-light':
      return 'hc-light'
    default:
      return 'dark'
  }
}

/** Find the first tokenColor rule whose scope list matches one of `wanted` (longest scope wins). */
function scopeColor(file: VsCodeThemeFile, wanted: string[]): string | null {
  let best: { len: number; color: string } | null = null
  for (const rule of file.tokenColors ?? []) {
    const fg = hex(rule.settings?.foreground)
    if (!fg) continue
    const scopes = typeof rule.scope === 'string' ? rule.scope.split(',').map((s) => s.trim()) : (rule.scope ?? [])
    for (const scope of scopes) {
      for (const w of wanted) {
        // A theme's `entity.name.function.member` should win over a bare `entity.name`, so the
        // most specific matching scope is the one that gets used.
        if (scope === w || scope.startsWith(`${w}.`)) {
          if (!best || scope.length > best.len) best = { len: scope.length, color: fg }
        }
      }
    }
  }
  return best?.color ?? null
}

/** Every workbench id this app can paint, mapped onto its token. Ids absent from a file are derived. */
const WORKBENCH_MAP: [keyof ThemeTokens, string[]][] = [
  ['wb-titlebar-bg', ['titleBar.activeBackground']],
  ['wb-titlebar-fg', ['titleBar.activeForeground']],
  ['wb-titlebar-inactive-fg', ['titleBar.inactiveForeground']],
  ['wb-activitybar-bg', ['activityBar.background']],
  ['wb-activitybar-fg', ['activityBar.foreground']],
  ['wb-activitybar-inactive-fg', ['activityBar.inactiveForeground']],
  ['wb-activitybar-active-border', ['activityBar.activeBorder']],
  ['wb-badge-bg', ['activityBarBadge.background', 'badge.background']],
  ['wb-badge-fg', ['activityBarBadge.foreground', 'badge.foreground']],
  ['wb-sidebar-bg', ['sideBar.background']],
  ['wb-sidebar-fg', ['sideBar.foreground']],
  ['wb-sidebar-section-bg', ['sideBarSectionHeader.background']],
  ['wb-sidebar-section-border', ['sideBarSectionHeader.border']],
  ['wb-editor-bg', ['editor.background']],
  ['wb-editor-fg', ['editor.foreground']],
  ['wb-editor-line-highlight', ['editor.lineHighlightBackground']],
  ['wb-editor-selection', ['editor.selectionBackground']],
  ['wb-editor-cursor', ['editorCursor.foreground']],
  ['wb-editor-linenumber', ['editorLineNumber.foreground']],
  ['wb-editor-linenumber-active', ['editorLineNumber.activeForeground']],
  ['wb-tab-active-bg', ['tab.activeBackground']],
  ['wb-tab-active-fg', ['tab.activeForeground']],
  ['wb-tab-inactive-bg', ['tab.inactiveBackground']],
  ['wb-tab-inactive-fg', ['tab.inactiveForeground']],
  ['wb-tab-border', ['tab.border']],
  ['wb-tab-active-border-top', ['tab.activeBorderTop']],
  ['wb-tab-hover-bg', ['tab.hoverBackground']],
  ['wb-statusbar-bg', ['statusBar.background']],
  ['wb-statusbar-fg', ['statusBar.foreground']],
  ['wb-statusbar-border', ['statusBar.border']],
  ['wb-statusbar-remote-bg', ['statusBarItem.remoteBackground']],
  ['wb-statusbar-remote-fg', ['statusBarItem.remoteForeground']],
  ['wb-panel-bg', ['panel.background']],
  ['wb-panel-border', ['panel.border']],
  ['wb-list-hover-bg', ['list.hoverBackground']],
  ['wb-list-active-bg', ['list.activeSelectionBackground']],
  ['wb-list-active-fg', ['list.activeSelectionForeground']],
  ['wb-list-inactive-bg', ['list.inactiveSelectionBackground']],
  ['wb-input-bg', ['input.background']],
  ['wb-input-fg', ['input.foreground']],
  ['wb-input-border', ['input.border']],
  ['wb-input-placeholder', ['input.placeholderForeground']],
  ['wb-dropdown-bg', ['dropdown.background']],
  ['wb-dropdown-border', ['dropdown.border']],
  ['wb-button-bg', ['button.background']],
  ['wb-button-fg', ['button.foreground']],
  ['wb-button-hover-bg', ['button.hoverBackground']],
  ['wb-button-secondary-bg', ['button.secondaryBackground']],
  ['wb-button-secondary-fg', ['button.secondaryForeground']],
  ['wb-widget-bg', ['editorWidget.background', 'quickInput.background']],
  ['wb-widget-border', ['editorWidget.border', 'contrastBorder']],
  ['wb-focus-border', ['focusBorder']],
  ['wb-scrollbar-slider', ['scrollbarSlider.background']],
  ['wb-scrollbar-slider-hover', ['scrollbarSlider.hoverBackground']],
  ['wb-scrollbar-slider-active', ['scrollbarSlider.activeBackground']],
  ['wb-selection-bg', ['selection.background', 'editor.selectionBackground']],
  ['term-bg', ['terminal.background', 'editor.background']],
  ['term-fg', ['terminal.foreground']],
  ['term-cursor', ['terminalCursor.foreground']],
  ['term-black', ['terminal.ansiBlack']],
  ['term-red', ['terminal.ansiRed']],
  ['term-green', ['terminal.ansiGreen']],
  ['term-yellow', ['terminal.ansiYellow']],
  ['term-blue', ['terminal.ansiBlue']],
  ['term-magenta', ['terminal.ansiMagenta']],
  ['term-cyan', ['terminal.ansiCyan']],
  ['term-white', ['terminal.ansiWhite']],
  ['term-bright-black', ['terminal.ansiBrightBlack']],
  ['term-bright-red', ['terminal.ansiBrightRed']],
  ['term-bright-green', ['terminal.ansiBrightGreen']],
  ['term-bright-yellow', ['terminal.ansiBrightYellow']],
  ['term-bright-blue', ['terminal.ansiBrightBlue']],
  ['term-bright-magenta', ['terminal.ansiBrightMagenta']],
  ['term-bright-cyan', ['terminal.ansiBrightCyan']],
  ['term-bright-white', ['terminal.ansiBrightWhite']]
]

/** Slug an imported theme's name into a stable, filesystem-safe id. */
export function themeIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug ? `vsc-${slug}` : 'vsc-imported'
}

/**
 * Convert a parsed VS Code colour theme into an ATOMIC theme.
 *
 * Returns a stated error rather than a half-built theme when the file is not one: a `package.json`
 * dropped on this by mistake would otherwise import as a black-on-black theme with no explanation.
 */
export function importVsCodeTheme(file: unknown, fallbackName: string): ThemeImportResult {
  if (!file || typeof file !== 'object') return { ok: false, error: 'That file is not a JSON object.' }
  const f = file as VsCodeThemeFile
  const colors = (f.colors && typeof f.colors === 'object' ? f.colors : {}) as Record<string, string>
  const hasTokens = Array.isArray(f.tokenColors) && f.tokenColors.length > 0

  if (Object.keys(colors).length === 0 && !hasTokens) {
    return {
      ok: false,
      error: f.include
        ? 'That theme file only points at another theme (an "include" chain), which this cannot follow. Import the file it points to instead.'
        : 'That JSON has no "colors" or "tokenColors" — it does not look like a VS Code colour theme.'
    }
  }

  const kind = normalizeKind(f.type)
  const dark = kind === 'dark' || kind === 'hc-dark'
  const fgEnd = dark ? '#ffffff' : '#000000'

  const bg = firstHex(colors, ['editor.background']) ?? (dark ? '#1e1e1e' : '#ffffff')
  const text = firstHex(colors, ['editor.foreground', 'foreground']) ?? (dark ? '#d4d4d4' : '#1f1f1f')
  const panel = firstHex(colors, ['sideBar.background', 'activityBar.background', 'panel.background']) ?? mix(bg, fgEnd, 0.04)
  const panel2 = firstHex(colors, ['input.background', 'dropdown.background', 'list.hoverBackground']) ?? mix(panel, fgEnd, 0.05)
  const border = firstHex(colors, ['panel.border', 'sideBar.border', 'contrastBorder', 'editorGroup.border']) ?? mix(panel, fgEnd, 0.14)
  const muted = firstHex(colors, ['descriptionForeground', 'editorLineNumber.foreground', 'tab.inactiveForeground']) ?? mix(text, bg, 0.42)
  const accent =
    firstHex(colors, ['focusBorder', 'button.background', 'textLink.foreground', 'activityBarBadge.background', 'progressBar.background']) ??
    (dark ? '#3b82f6' : '#1a6fd4')

  const syntax: SyntaxColors = {
    comment: scopeColor(f, ['comment']) ?? mix(text, bg, 0.5),
    string: scopeColor(f, ['string']) ?? text,
    keyword: scopeColor(f, ['keyword', 'storage']) ?? accent,
    number: scopeColor(f, ['constant.numeric', 'constant']) ?? text,
    func: scopeColor(f, ['entity.name.function', 'support.function', 'meta.function']) ?? text,
    type: scopeColor(f, ['entity.name.type', 'support.type', 'support.class', 'entity.name.class']) ?? text,
    variable: scopeColor(f, ['variable']) ?? text,
    constant: scopeColor(f, ['constant.language', 'support.constant']) ?? text,
    operator: scopeColor(f, ['keyword.operator']) ?? text,
    tag: scopeColor(f, ['entity.name.tag']) ?? text,
    attribute: scopeColor(f, ['entity.other.attribute-name']) ?? text
  }

  // Anything the file states explicitly wins over the derivation. Everything it left out is derived,
  // so the app is never half-painted.
  const overrides: Partial<ThemeTokens> = {}
  for (const [token, ids] of WORKBENCH_MAP) {
    const v = firstHex(colors, ids)
    if (v) overrides[token] = v
  }

  const name = (typeof f.name === 'string' && f.name.trim()) || fallbackName
  const seed: ThemeSeed = {
    id: themeIdFromName(name),
    name,
    publisher: 'Imported',
    kind,
    bg,
    panel,
    panel2,
    border,
    text,
    muted,
    accent,
    ok: firstHex(colors, ['terminal.ansiGreen', 'editorGutter.addedBackground', 'gitDecoration.addedResourceForeground']) ?? '#22c55e',
    danger: firstHex(colors, ['editorError.foreground', 'terminal.ansiRed', 'errorForeground']) ?? '#ef4444',
    warn: firstHex(colors, ['editorWarning.foreground', 'terminal.ansiYellow']) ?? '#f59e0b',
    magenta: firstHex(colors, ['terminal.ansiMagenta']) ?? undefined,
    cyan: firstHex(colors, ['terminal.ansiCyan']) ?? undefined,
    syntax,
    overrides
  }

  return { ok: true, theme: buildTheme(seed, 'installed') }
}
