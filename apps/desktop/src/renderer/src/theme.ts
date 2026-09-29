import type * as MonacoNS from 'monaco-editor'
import {
  defaultTheme,
  monacoThemeData,
  xtermThemeData,
  type Theme,
  type ThemeTokens,
  type XtermThemeData
} from '../../shared/theme'

/**
 * Painting a theme.
 *
 * Three engines draw this app and only one of them reads CSS: the workbench chrome (custom
 * properties on `<html>`), Monaco (its own theme registry), and xterm.js (a theme object per
 * terminal instance). A theme switch that updated only the first would leave a light workbench
 * wrapped around a black editor — which is exactly the half-themed result that makes an IDE feel
 * unfinished. `applyTheme` drives all three from one call.
 *
 * The current theme also lives here rather than in React state, because two of the three consumers
 * are not React: Monaco is a singleton registry, and an xterm instance is created imperatively
 * inside an effect and has to be able to ask "what is on right now?" at any moment.
 */

let current: Theme = defaultTheme()
const listeners = new Set<(t: Theme) => void>()

/** The theme currently painted. Never null — the default is applied before the first frame. */
export function currentTheme(): Theme {
  return current
}

/** The xterm palette for the theme currently painted, for a terminal being constructed right now. */
export function currentXtermTheme(): XtermThemeData {
  return xtermThemeData(current)
}

/** Subscribe to theme changes; returns the unsubscribe. Used by live xterm instances. */
export function onThemeApplied(cb: (t: Theme) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * Monaco keeps themes in a global registry keyed by name, and `defineTheme` on an existing name
 * silently replaces it — which is what makes live preview in the picker cheap: the same name is
 * redefined per keystroke and `setTheme` re-applies it, with no registry growth.
 */
const MONACO_THEME = 'atomic'
let monacoReady = false
/** Resolved once Monaco has been pulled in; null until an editor is actually opened. */
let monacoMod: typeof MonacoNS | null = null

/**
 * Repaint Monaco — asynchronously, and only once Monaco is actually in the page.
 *
 * The import is dynamic on purpose. `monaco-editor` is by far the largest thing the renderer can
 * pull in, and importing it at module scope here put it in the entry chunk: the whole editor and
 * its five language workers were parsed before the first frame, on every launch, whether or not the
 * user ever opened a file. Loading it with the editor instead is what takes the startup bundle down.
 *
 * Nothing is lost by being late: `monacoThemeName()` already falls back to `vs-dark` until the first
 * define lands, and an editor that has not mounted has nothing to repaint anyway.
 */
function applyMonaco(theme: Theme): void {
  const paint = (m: typeof MonacoNS): void => {
    try {
      // `current`, not the captured `theme`: the user may have switched theme while the editor
      // chunk was still downloading, and the last choice is the one that should land.
      m.editor.defineTheme(MONACO_THEME, monacoThemeData(current) as MonacoNS.editor.IStandaloneThemeData)
      m.editor.setTheme(MONACO_THEME)
      monacoReady = true
    } catch {
      /* An editor that has not mounted yet has nothing to repaint; the next applyTheme catches it. */
    }
  }
  if (monacoMod) {
    paint(monacoMod)
    return
  }
  // Never *causes* the load — only joins one already in flight, so opening the app without ever
  // opening a file never pays for Monaco.
  if (!pendingMonaco) return
  void pendingMonaco.then((m) => {
    monacoMod = m
    // Paint the theme that is current *now*, not the one this call was made with — the user may
    // have changed theme while the editor chunk was still downloading.
    paint(m)
  })
}

/** Set by the editor chunk as it loads, so theming can join the same import. */
let pendingMonaco: Promise<typeof MonacoNS> | null = null
export function registerMonacoLoad(p: Promise<typeof MonacoNS>): void {
  pendingMonaco = p
  void p.then((m) => {
    monacoMod = m
    if (current) applyMonaco(current)
  })
}

/** The theme name `<Editor theme=…>` must be given. Falls back until the first define lands. */
export function monacoThemeName(): string {
  return monacoReady ? MONACO_THEME : 'vs-dark'
}

/**
 * Write the token map onto `<html>` and repaint the other two engines.
 *
 * Tokens are set as inline custom properties on the root element rather than by swapping a
 * stylesheet: it is one synchronous write, it beats every `:root` rule in `styles.css` by
 * specificity without `!important`, and it means a theme with a token the stylesheet has never
 * heard of costs nothing.
 */
export function applyTheme(theme: Theme): void {
  current = theme
  const root = document.documentElement
  const tokens = theme.tokens
  for (const key of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    root.style.setProperty(`--${key}`, tokens[key])
  }
  // Lets CSS ask which family is on — high contrast turns borders on, and `color-scheme` is what
  // makes the browser's own scrollbars, form controls and caret follow the theme instead of
  // staying dark under a light workbench.
  root.setAttribute('data-theme', theme.id)
  root.setAttribute('data-theme-kind', theme.kind)
  root.style.colorScheme = theme.kind === 'light' || theme.kind === 'hc-light' ? 'light' : 'dark'

  applyMonaco(theme)
  for (const cb of listeners) cb(theme)
}
