import type { DesignReview } from './types'

/** #rrggbb → HSL (h 0-360, s/l 0-100). Local + pure — this module is renderer-side and
 * must not import the Electron-main color code; DesignColor.value is always #rrggbb. */
function rgbToHsl(hexColor: string): { h: number; s: number; l: number } {
  const r = parseInt(hexColor.slice(1, 3), 16) / 255
  const g = parseInt(hexColor.slice(3, 5), 16) / 255
  const b = parseInt(hexColor.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = h * 60
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

// Hue buckets: the FIRST threshold a hue is below names it (red wraps at both ends).
const HUE_FAMILIES: [number, string][] = [
  [15, 'red'], [45, 'orange'], [70, 'yellow'], [165, 'green'],
  [195, 'teal'], [255, 'blue'], [285, 'purple'], [330, 'magenta'], [345, 'pink'], [360, 'red']
]

/** A self-describing token name from a color: hue family + a Tailwind-ish lightness step
 * (50 = lightest … 900 = darkest). Near-greys (low saturation) are the `gray` family. */
function tokenName(hexColor: string): string {
  const { h, s, l } = rgbToHsl(hexColor)
  const family = s < 10 ? 'gray' : (HUE_FAMILIES.find(([max]) => h < max)?.[1] ?? 'gray')
  const step = l >= 95 ? 50 : Math.min(9, Math.max(1, Math.round((100 - l) / 10))) * 100
  return `${family}-${step}`
}

/**
 * Design tokens auto-extract — from a Design Review, propose a `:root { … }`
 * block of CSS custom properties for the project's HARDCODED colors, so a
 * non-coder can adopt tokens in one paste. Near-duplicate colors are folded to a
 * single token (union-find over the review's near-dup pairs). Pure — no I/O, no
 * electron — computed in the renderer from the already-fetched DesignReview.
 */
export function extractTokens(review: DesignReview): { css: string; tokens: { name: string; value: string }[] } {
  const hardcoded = review.palette.filter((c) => !c.isToken)
  if (!hardcoded.length) return { css: '', tokens: [] }

  const idxOf = new Map<string, number>()
  review.palette.forEach((c, i) => idxOf.set(c.value, i))
  const isHard = new Set(hardcoded.map((c) => c.value))
  const countOf = new Map(hardcoded.map((c) => [c.value, c.count]))

  // Union-find: fold near-duplicate hardcoded colors into one group (one token).
  const parent = new Map<string, string>()
  hardcoded.forEach((c) => parent.set(c.value, c.value))
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r) as string
    let cur = x
    while (cur !== r) {
      const next = parent.get(cur) as string
      parent.set(cur, r)
      cur = next
    }
    return r
  }
  for (const p of review.nearDuplicates) {
    if (isHard.has(p.a) && isHard.has(p.b)) {
      const ra = find(p.a)
      const rb = find(p.b)
      if (ra !== rb) parent.set(ra, rb)
    }
  }

  // Group members by root; representative = most-used member (earliest palette index on tie).
  const groups = new Map<string, { members: string[]; total: number }>()
  for (const c of hardcoded) {
    const root = find(c.value)
    const g = groups.get(root) ?? { members: [], total: 0 }
    g.members.push(c.value)
    g.total += c.count
    groups.set(root, g)
  }
  const rep = (members: string[]): string =>
    members
      .slice()
      .sort((a, b) => (countOf.get(b) ?? 0) - (countOf.get(a) ?? 0) || (idxOf.get(a) ?? 0) - (idxOf.get(b) ?? 0))[0]

  const groupList = [...groups.values()]
    .map((g) => ({ value: rep(g.members), total: g.total }))
    .sort((a, b) => b.total - a.total || (idxOf.get(a.value) ?? 0) - (idxOf.get(b.value) ?? 0))

  // Name each token by its own color family + lightness (usage-ranked order preserved).
  // Dedup identical idents (two similar blues) with a numeric suffix — the css join has no
  // dedup of its own, so a repeated `--blue-400:` would otherwise be invalid/last-wins CSS.
  const used = new Set<string>()
  const tokens = groupList.map((g) => {
    const base = tokenName(g.value)
    let name = base
    for (let k = 2; used.has(name); k++) name = `${base}-${k}`
    used.add(name)
    return { name, value: g.value }
  })
  const css = ':root {\n' + tokens.map((t) => `  --${t.name}: ${t.value};`).join('\n') + '\n}'
  return { css, tokens }
}
