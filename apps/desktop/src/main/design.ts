import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as fsService from './fs-service'
import { audit } from './audit'
import type { DesignReview } from '../shared/types'

/**
 * Design System / AI Design Review — a non-coder-readable "is the styling
 * consistent?" check. Scans the project's style files for the design system:
 * the color palette, how many colors are hardcoded vs pulled from tokens
 * (CSS custom properties), near-duplicate colors (a #3b82f6 next to a #3b82fa),
 * and the spread of spacing/font-size values (too many distinct values = no
 * scale). Heuristic, not a linter. Runs the color/px regexes over the FULL file
 * content (not per line) so a minified one-line CSS is still analyzed.
 */

const STYLE_EXT = /\.(css|scss|sass|less|styl|vue|svelte|html?)$/i
// Exported so apply-tokens.ts reuses the exact same walk caps + CSS-file gate (no drift).
export const MAX_FILE = 512 * 1024
export const MAX_FILES = 400
export const MAX_VISITED = 20_000
const MAX_PALETTE = 60

// Common CSS named colors → hex, so `color: red` counts in the palette.
const NAMED_COLORS: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080',
  pink: '#ffc0cb', brown: '#a52a2a', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00',
  navy: '#000080', teal: '#008080', silver: '#c0c0c0', gold: '#ffd700', rebeccapurple: '#663399'
}
// hex/rgb/hsl are unambiguous → scan any style file. Named color WORDS (red, blue…)
// are common English, so scan them ONLY in real stylesheets (not HTML/Vue/Svelte
// prose) and ONLY in a value context (after : space , or ( via lookbehind), so a
// class `.red`, a `--red` prop, or a comment/sentence never invents a color.
const HEX_RGB_HSL = '#[0-9a-f]{8}\\b|#[0-9a-f]{6}\\b|#[0-9a-f]{4}\\b|#[0-9a-f]{3}\\b|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)'
const NAMED_ARM = '(?<=[:\\s,(])(?:' + [...Object.keys(NAMED_COLORS), 'transparent', 'currentcolor'].join('|') + ')\\b'
// Exported so apply-tokens.ts reuses the exact hex/rgb/hsl matcher (NOT the named arm — a bare
// word like `red` is too risky to rewrite) and the one canonicalizer.
export const COLOR_RE = new RegExp(HEX_RGB_HSL, 'gi')
const CSS_COLOR_RE = new RegExp(HEX_RGB_HSL + '|' + NAMED_ARM, 'gi')
export const CSS_FILE = /\.(css|scss|sass|less|styl)$/i
// A color is a TOKEN definition if the declaration it sits in starts with `--name:`
// — anywhere in the value, so multi-value props (--shadow: 0 1px 2px #111) count.
const DECL_IS_TOKEN = /^\s*--[\w-]+\s*:/
// Spacing scale = px only inside actual spacing properties (not width/height/etc.).
const SPACING_RE = /\b(?:margin|padding|gap|row-gap|column-gap|inset)(?:-[a-z]+)?\s*:\s*([^;{}]+)/gi
const FONT_SIZE_RE = /font-size\s*:\s*(\d{1,4})px/gi

const hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')

/** Convert HSL (h deg, s%, l%) to r,g,b in 0..255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  s /= 100
  l /= 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [(r + mm) * 255, (g + mm) * 255, (b + mm) * 255]
}

/** Normalize a hex/rgb/hsl/named color literal to #rrggbb (alpha dropped), or null. */
export function normColor(raw: string): string | null {
  const s = raw.trim().toLowerCase()
  if (s === 'transparent' || s === 'currentcolor') return null
  if (NAMED_COLORS[s]) return NAMED_COLORS[s]
  let m: RegExpExecArray | null
  if ((m = /^#([0-9a-f]{3})$/.exec(s))) return '#' + m[1].split('').map((c) => c + c).join('')
  if ((m = /^#([0-9a-f]{4})$/.exec(s))) return '#' + m[1].slice(0, 3).split('').map((c) => c + c).join('')
  if ((m = /^#([0-9a-f]{6})$/.exec(s))) return '#' + m[1]
  if ((m = /^#([0-9a-f]{8})$/.exec(s))) return '#' + m[1].slice(0, 6)
  if ((m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s)))
    return hex(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10))
  if ((m = /^hsla?\(\s*([\d.]+)(deg|turn|rad|grad)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(s))) {
    // Convert the hue to degrees by its unit (hslToRgb normalizes mod 360). Alpha (a
    // trailing `/ A` or 4th arg) is deliberately IGNORED — colors fold on hue, not opacity.
    const scale = m[2] === 'turn' ? 360 : m[2] === 'rad' ? 180 / Math.PI : m[2] === 'grad' ? 0.9 : 1
    const h = parseFloat(m[1]) * scale
    const sv = parseFloat(m[3])
    const lv = parseFloat(m[4])
    // A bare "." satisfies [\d.]+ but parseFloat("." )===NaN — reject so no "#..NaN" color
    // (the only path a non-#rrggbb value could otherwise enter the palette) escapes.
    if (!Number.isFinite(h) || !Number.isFinite(sv) || !Number.isFinite(lv)) return null
    const [r, g, b] = hslToRgb(h, sv, lv)
    return hex(r, g, b)
  }
  return null // percentage-channel rgb, unitless hsl args, uncommon named colors — out of scope
}

const toRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]

export function designReview(root: string): DesignReview {
  const palette = new Map<string, { count: number; isToken: boolean }>()
  let hardcodedColors = 0
  let tokensUsed = 0
  const spacing = new Set<number>()
  const fontSizes = new Set<number>()
  let files = 0
  let visited = 0

  const walk = (rel: string): void => {
    if (files >= MAX_FILES || visited >= MAX_VISITED) return
    for (const entry of fsService.listDir(root, rel)) {
      if (files >= MAX_FILES || visited >= MAX_VISITED) return
      visited++
      if (entry.isDir) {
        walk(entry.path)
        continue
      }
      if (!STYLE_EXT.test(entry.name)) continue
      files++
      try {
        const abs = join(root, entry.path)
        if (statSync(abs).size > MAX_FILE) continue
        // Strip block comments so a `/* red button */` note can't invent a color.
        const src = readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')
        tokensUsed += (src.match(/var\(\s*--[\w-]+/g) ?? []).length
        // Named color words only in real stylesheets; hex/rgb/hsl everywhere.
        const colorRe = CSS_FILE.test(entry.name) ? CSS_COLOR_RE : COLOR_RE
        for (const m of src.matchAll(colorRe)) {
          const norm = normColor(m[0])
          if (!norm) continue
          // Is this color inside a `--name: …` custom-property value (a token
          // definition, at any position) vs a raw value in a normal property?
          const win = src.slice(Math.max(0, m.index - 256), m.index)
          const term = Math.max(win.lastIndexOf(';'), win.lastIndexOf('{'), win.lastIndexOf('}'))
          const isDef = DECL_IS_TOKEN.test(win.slice(term + 1))
          const p = palette.get(norm) ?? { count: 0, isToken: false }
          p.count += 1
          if (isDef) p.isToken = true
          else hardcodedColors += 1
          palette.set(norm, p)
        }
        for (const m of src.matchAll(SPACING_RE)) {
          for (const px of m[1].matchAll(/(\d{1,4})px/g)) {
            const n = parseInt(px[1], 10)
            if (n > 0 && spacing.size < 200) spacing.add(n)
          }
        }
        for (const m of src.matchAll(FONT_SIZE_RE)) fontSizes.add(parseInt(m[1], 10))
      } catch {
        /* unreadable — skip */
      }
    }
  }
  walk('')

  const paletteArr = [...palette.entries()]
    .map(([value, p]) => ({ value, count: p.count, isToken: p.isToken }))
    .sort((a, b) => b.count - a.count)
  const top = paletteArr.slice(0, MAX_PALETTE)

  // Near-duplicate colors: pairwise RGB Euclidean distance ≤ 10 (tight, to avoid
  // flagging genuinely distinct brand colors). Bounded to the top palette + 20 pairs.
  const nearDuplicates: { a: string; b: string; distance: number }[] = []
  for (let i = 0; i < top.length && nearDuplicates.length < 20; i++) {
    const [r1, g1, b1] = toRgb(top[i].value)
    for (let j = i + 1; j < top.length && nearDuplicates.length < 20; j++) {
      const [r2, g2, b2] = toRgb(top[j].value)
      const d = Math.round(Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2))
      if (d > 0 && d <= 10) nearDuplicates.push({ a: top[i].value, b: top[j].value, distance: d })
    }
  }

  const spacingScale = [...spacing].sort((a, b) => a - b).slice(0, 40)
  const fontSizeScale = [...fontSizes].sort((a, b) => a - b)
  const distinctColors = paletteArr.length

  const problems: string[] = []
  if (hardcodedColors > Math.max(3, tokensUsed)) problems.push(`${hardcodedColors} hardcoded colors`)
  if (nearDuplicates.length) problems.push(`${nearDuplicates.length} near-duplicate color pair${nearDuplicates.length === 1 ? '' : 's'}`)
  if (spacingScale.length > 12) problems.push(`${spacingScale.length} distinct spacing values`)
  const ok = problems.length === 0
  const verdict = files === 0
    ? 'No style files found to review.'
    : ok
      ? `Consistent — ${distinctColors} colors, ${tokensUsed} token uses, tidy scale.`
      : `Design could be tighter: ${problems.join(', ')}.`

  audit('design-review', `${files} style files · ${distinctColors} colors · ${hardcodedColors} hardcoded`)
  return { ok, verdict, palette: top, hardcodedColors, tokensUsed, nearDuplicates, spacingScale, fontSizeScale, filesScanned: files }
}
