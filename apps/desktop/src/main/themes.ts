import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  resolveTheme,
  type Theme,
  type ThemeInstallResult,
  type ThemeKind
} from '../shared/theme'
import { importVsCodeTheme, themeIdFromName } from '../shared/theme-vscode'
import { audit } from './audit'

/**
 * Which theme is on, and which themes exist.
 *
 * This lives in the MAIN process for the same reason `mode.ts` does: a second window must open
 * wearing the theme the user is actually using, and the native window chrome (`backgroundColor`,
 * the vibrancy behind a frameless title bar) is set from main, so main has to know the answer. The
 * renderer paints; it does not own the fact.
 *
 * Installed themes come from two places, and both are data:
 *   - `<userData>/themes/*.json` — one file the user imported by hand.
 *   - `<userData>/extensions/<id>/` whose manifest is `kind: "theme"` — a theme pack installed
 *     through the normal extension flow.
 *
 * **Neither can execute anything.** That is the whole reason theme import is allowed at all while
 * `.vsix` extensions are not (PRODUCT.md): a colour theme is a list of hex values, so importing one
 * carries none of the "this runs someone else's code with your file permissions" risk that gates
 * the MCP connector path. A theme pack is checked for that: a manifest claiming `kind: "theme"`
 * while also carrying a `command` is rejected rather than quietly installed.
 */

const THEME_FILE = 'theme.json'

function themesDir(): string {
  const dir = join(app.getPath('userData'), 'themes')
  mkdirSync(dir, { recursive: true })
  return dir
}

function selectionPath(): string {
  return join(app.getPath('userData'), THEME_FILE)
}

/**
 * VS Code ships its own themes as JSON *with comments and trailing commas* — the format its editor
 * calls JSONC. `JSON.parse` rejects both, so the very first real theme a user tries to import would
 * fail with "Unexpected token /" and look like our bug. This strips the two things JSONC adds and
 * nothing else; it is not a general JSON5 parser and does not pretend to be.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let escape = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // Trailing commas, now that no comma inside a string can be confused for one.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** Is this object one of OUR themes (already derived), rather than a VS Code file? */
function isAtomicTheme(v: unknown): v is Theme {
  if (!v || typeof v !== 'object') return false
  const t = v as Partial<Theme>
  return typeof t.id === 'string' && !!t.tokens && typeof t.tokens === 'object' && !!t.syntax
}

/** Read one theme file (either format) into a Theme, or null if it is neither. */
function readThemeFile(path: string, fallbackName: string): Theme | null {
  try {
    const raw = parseJsonc(readFileSync(path, 'utf8'))
    if (isAtomicTheme(raw)) return { ...raw, source: 'installed' }
    const res = importVsCodeTheme(raw, fallbackName)
    return res.ok && res.theme ? res.theme : null
  } catch {
    return null
  }
}

/** Every theme installed as a standalone file. */
function fileThemes(): Theme[] {
  const out: Theme[] = []
  let names: string[] = []
  try {
    names = readdirSync(themesDir())
  } catch {
    return out
  }
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.json') continue
    const t = readThemeFile(join(themesDir(), name), basename(name, '.json'))
    if (t) out.push(t)
  }
  return out
}

/**
 * Every theme that arrived inside a `kind: "theme"` extension.
 *
 * Read straight off disk rather than through `extensions.ts` to keep the dependency one-way: the
 * Extensions view needs to know which themes a pack contributed, so extensions may depend on
 * themes, and the reverse would be a cycle.
 */
function extensionThemes(): Theme[] {
  const out: Theme[] = []
  const root = join(app.getPath('userData'), 'extensions')
  if (!existsSync(root)) return out
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return out
  }
  for (const dir of dirs) {
    const manifestPath = join(root, dir, 'atomic-extension.json')
    if (!existsSync(manifestPath)) continue
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        kind?: string
        name?: string
        command?: string
        themes?: unknown
      }
      if (m.kind !== 'theme') continue
      // A theme pack that also wants to spawn a process is not a theme pack.
      if (typeof m.command === 'string' && m.command) continue
      const files = Array.isArray(m.themes) ? m.themes.map(String) : []
      for (const rel of files) {
        // The manifest names the files; a `../` in one of them must not reach outside the pack.
        const full = resolve(join(root, dir), rel)
        if (!full.startsWith(resolve(join(root, dir)))) continue
        if (!existsSync(full)) continue
        const t = readThemeFile(full, m.name ?? dir)
        if (t) out.push({ ...t, publisher: m.name ?? dir })
      }
    } catch {
      /* a malformed pack is skipped, never fatal to the picker */
    }
  }
  return out
}

/** Built-ins plus everything installed, de-duplicated by id (a built-in id always wins). */
export function listThemes(): Theme[] {
  const seen = new Set(BUILT_IN_THEMES.map((t) => t.id))
  const installed: Theme[] = []
  for (const t of [...fileThemes(), ...extensionThemes()]) {
    if (seen.has(t.id)) continue
    seen.add(t.id)
    installed.push(t)
  }
  return [...BUILT_IN_THEMES, ...installed]
}

let cachedId: string | null = null

/** The chosen theme id — read once, then cached. Falls back to the default, never to nothing. */
export function getThemeId(): string {
  if (process.env.STUDIO_THEME) return process.env.STUDIO_THEME
  if (cachedId) return cachedId
  try {
    const p = selectionPath()
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && parsed.id) {
        cachedId = parsed.id
        return cachedId
      }
    }
  } catch {
    /* unreadable/malformed → the default theme, never an unpainted window */
  }
  return DEFAULT_THEME_ID
}

/** The chosen theme, fully resolved. */
export function getTheme(): Theme {
  return resolveTheme(getThemeId(), listThemes())
}

/** Persist a choice. Returns the theme actually in effect (an unknown id resolves to the default). */
export function setTheme(id: unknown): Theme {
  const next = resolveTheme(typeof id === 'string' ? id : null, listThemes())
  cachedId = next.id
  try {
    writeFileSync(selectionPath(), JSON.stringify({ id: next.id }), 'utf8')
  } catch {
    /* best-effort persistence — the session still switches */
  }
  return next
}

/**
 * Install a theme from a `.json` file the user picks.
 *
 * The file is copied into `<userData>/themes/` **after** it converts cleanly, so a rejected file
 * never lands on disk and a broken theme can never be the one that loads at startup.
 */
export async function installThemeFromFile(win: BrowserWindow | null): Promise<ThemeInstallResult> {
  const picked = await dialog.showOpenDialog(win ?? undefined!, {
    title: 'Install a colour theme',
    message: 'Pick a VS Code colour theme (.json). Colour themes are data — nothing in one runs.',
    properties: ['openFile'],
    filters: [{ name: 'Colour theme', extensions: ['json'] }]
  })
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'cancelled' }
  const src = picked.filePaths[0]

  let raw: unknown
  try {
    raw = parseJsonc(readFileSync(src, 'utf8'))
  } catch (e) {
    return { ok: false, error: `That file is not valid JSON: ${(e as Error).message}` }
  }

  const fallbackName = basename(src, extname(src))
  const theme = isAtomicTheme(raw) ? ({ ...raw, source: 'installed' } as Theme) : undefined
  const res = theme ? { ok: true, theme } : importVsCodeTheme(raw, fallbackName)
  if (!res.ok || !res.theme) return { ok: false, error: res.error ?? 'That file is not a colour theme.' }

  if (BUILT_IN_THEMES.some((t) => t.id === res.theme!.id)) {
    return { ok: false, error: `"${res.theme.name}" has the same id as a built-in theme. Rename it and try again.` }
  }

  try {
    writeFileSync(join(themesDir(), `${res.theme.id}.json`), JSON.stringify(res.theme, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, error: `Could not save the theme: ${(e as Error).message}` }
  }
  audit('theme.install', `${res.theme.id} (${res.theme.name}) from ${src}`)
  return { ok: true, theme: res.theme }
}

/** Remove an installed theme. Built-ins are refused rather than silently ignored. */
export function removeTheme(id: string): ThemeInstallResult {
  if (BUILT_IN_THEMES.some((t) => t.id === id)) {
    return { ok: false, error: 'Built-in themes cannot be removed.' }
  }
  const path = join(themesDir(), `${id}.json`)
  if (!existsSync(path)) {
    return { ok: false, error: 'That theme came from an extension — uninstall the extension to remove it.' }
  }
  try {
    rmSync(path)
  } catch (e) {
    return { ok: false, error: `Could not remove the theme: ${(e as Error).message}` }
  }
  audit('theme.remove', id)
  // Removing the theme that is currently on would leave the window painted by a file that no longer
  // exists, so the selection falls back explicitly rather than by accident on next launch.
  if (getThemeId() === id) setTheme(DEFAULT_THEME_ID)
  return { ok: true }
}

/** For tests: drop the cache so a fresh file/env is re-read. */
export function resetThemeCache(): void {
  cachedId = null
}

/** The window background to paint before the renderer's first frame — stops a white flash. */
export function windowBackgroundColor(): string {
  return getTheme().tokens.bg
}

export type { Theme, ThemeInstallResult, ThemeKind }
export { themeIdFromName }
