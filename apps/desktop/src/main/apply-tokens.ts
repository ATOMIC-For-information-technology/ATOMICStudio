import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as fsService from './fs-service'
import { checkpoint } from './undo'
import { diffLines, foldContext } from './diff'
import { CSS_FILE, MAX_FILE, MAX_FILES, MAX_VISITED, COLOR_RE, normColor } from './design'
import { errMessage } from './util'
import type { DiffLine, TokenApplyPlan, TokenApplyResult } from '../shared/types'

/**
 * Apply design tokens — the safe, preview-first counterpart to `extractTokens`. It rewrites
 * HARDCODED 6-digit hex literals in the project's stylesheets to `var(--token)` and prepends
 * the `:root { … }` block to one chosen global sheet. Every write goes through
 * `fsService.writeFile` (auto-snapshotted → Undo / Time-Machine / Replay all work for free),
 * grouped under one checkpoint. Correctness rests on NOT touching anything ambiguous:
 *   • only exact 6-digit hex (`#3b82f6`), never 3-/4-/8-digit — and never a token value that
 *     is a prefix of a longer hex (`#3b82f6ff`), via a trailing-hex-digit negative lookahead;
 *   • never inside a block or line comment, a "…"/'…' string, url(…), an existing var(…)
 *     (idempotent, and preserves fallback colors), or a --name: custom-property declaration
 *     value (the token's own definition);
 *   • CSS files only (`.css/.scss/.sass/.less/.styl`) — never .vue/.svelte/.html/.js where a
 *     scoped/module `var()` may not resolve.
 */

type Token = { name: string; value: string }

/** Char-level mask of spans a hex literal must NOT be rewritten inside. Comments and strings
 * are matched by a state machine (regex can't nest them safely); url()/var()/custom-property
 * declaration values are then OR-ed in (a match already inside a comment/string is harmless). */
function guardMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(false)
  const mark = (a: number, b: number): void => {
    for (let k = a; k < b && k < src.length; k++) mask[k] = true
  }
  const isWord = (ch: string | undefined): boolean => ch != null && /[\w-]/.test(ch)
  let i = 0
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    if (two === '/*') {
      const e = src.indexOf('*/', i + 2)
      const end = e < 0 ? src.length : e + 2
      mark(i, end)
      i = end
      continue
    }
    // url(...) is a span (consumed BEFORE the `//` check) so a `//` inside an unquoted URL —
    // `url(http://x)`, `url(//cdn/x)`, or a base64 data-URI containing `//` — is never mistaken
    // for a line comment (which would silently mask every color after it on the line).
    if (src.slice(i, i + 4).toLowerCase() === 'url(' && !isWord(src[i - 1])) {
      const e = src.indexOf(')', i + 4)
      const end = e < 0 ? src.length : e + 1
      mark(i, end)
      i = end
      continue
    }
    if (two === '//') {
      let e = i
      while (e < src.length && src[e] !== '\n') e++
      mark(i, e)
      i = e
      continue
    }
    const c = src[i]
    if (c === '"' || c === "'") {
      let e = i + 1
      while (e < src.length && src[e] !== c) {
        if (src[e] === '\\') e++ // skip an escaped char
        e++
      }
      const end = Math.min(e + 1, src.length)
      mark(i, end)
      i = end
      continue
    }
    i++
  }
  for (const m of src.matchAll(/var\([^)]*\)/gi)) if (m.index != null) mark(m.index, m.index + m[0].length)
  return mask
}

/** Is the hex at `idx` inside a `--name: …` custom-property (its own token definition)? Scans
 * back to the nearest UNMASKED declaration separator, so a `;` inside a quoted string can't cut
 * the declaration short and expose the hex — which would rewrite a token def into var(--self). */
function inTokenDecl(src: string, mask: boolean[], idx: number): boolean {
  const floor = Math.max(0, idx - 4096)
  let start = floor
  for (let k = idx - 1; k >= floor; k--) {
    if (mask[k]) continue
    const ch = src[k]
    if (ch === ';' || ch === '{' || ch === '}') {
      start = k + 1
      break
    }
  }
  return /^\s*--[\w-]+\s*:/.test(src.slice(start, idx))
}

const byValueMap = (tokens: Token[]): Map<string, string> => {
  const m = new Map<string, string>()
  for (const t of tokens) m.set(t.value.toLowerCase(), t.name)
  return m
}

// A color literal carrying an ALPHA channel must NOT be rewritten: normColor silently drops
// alpha, so folding it onto an opaque token would make a translucent color solid. Tested on the
// raw literal before normColor. Covers: 4-/8-digit hex, rgba()/hsla(), modern slash-alpha, AND a
// 4th component in a comma/space rgb()/hsl() (legal alpha, e.g. `rgb(0,0,0,.5)`).
const HAS_ALPHA = (lit: string): boolean => {
  if (/^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/i.test(lit)) return true
  if (lit.includes('/') || /^(?:rgba|hsla)\(/i.test(lit)) return true
  if (/^(?:rgb|hsl)\(/i.test(lit)) {
    const inner = lit.slice(lit.indexOf('(') + 1, lit.lastIndexOf(')'))
    if (inner.split(/[\s,]+/).filter(Boolean).length >= 4) return true // a 4th arg = alpha
  }
  return false
}

/** Rewrite unguarded color literals (6-/3-digit hex, rgb(), hsl()) whose canonical #rrggbb
 * equals a token value → var(--name). Pure. Alpha-bearing and named colors are left alone. */
function planFile(src: string, byValue: Map<string, string>): { newContent: string; replacements: number } {
  const mask = guardMask(src)
  let out = ''
  let last = 0
  let replacements = 0
  for (const m of src.matchAll(COLOR_RE)) {
    const idx = m.index
    // Skip a color inside a comment / string / url() / var(), or one that IS a token's own
    // definition value (a --name: decl) — rewriting the latter would create var(--self).
    if (idx == null || mask[idx] || inTokenDecl(src, mask, idx)) continue
    if (HAS_ALPHA(m[0])) continue // never make a translucent color opaque
    const norm = normColor(m[0]) // the single canonicalizer: #abc / rgb() / hsl() → #rrggbb
    if (!norm) continue
    const name = byValue.get(norm)
    if (!name) continue // not one of the extracted tokens
    out += src.slice(last, idx) + `var(--${name})`
    last = idx + m[0].length
    replacements++
  }
  out += src.slice(last)
  return { newContent: out, replacements }
}

/** Walk CSS files reusing design.ts's caps + gate (no drift). Returns project-relative paths. */
function cssFiles(root: string): string[] {
  const out: string[] = []
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
      if (!CSS_FILE.test(entry.name)) continue
      files++
      out.push(entry.path)
    }
  }
  walk('')
  return out
}

/** Preview: per-CSS-file replacement count + folded diff, for the files that WOULD change.
 * Writes nothing. */
export function planApplyTokens(root: string, tokens: Token[]): TokenApplyPlan[] {
  const byValue = byValueMap(tokens)
  if (!byValue.size) return []
  const plans: TokenApplyPlan[] = []
  for (const rel of cssFiles(root)) {
    try {
      const abs = join(root, rel)
      if (statSync(abs).size > MAX_FILE) continue
      const src = readFileSync(abs, 'utf8')
      const { newContent, replacements } = planFile(src, byValue)
      if (replacements > 0) plans.push({ file: rel, replacements, diff: foldContext(diffLines(src, newContent)) })
    } catch {
      /* unreadable — skip */
    }
  }
  return plans
}

/** Write the opted-in files (hex → var) and prepend the :root block to one chosen sheet, all
 * under a single checkpoint so Time-Machine reverts the whole apply in one click. */
export function applyTokens(
  root: string,
  checkedFiles: string[],
  tokens: Token[],
  blockCss: string,
  blockTargetFile: string
): TokenApplyResult {
  const byValue = byValueMap(tokens)
  // Re-derive every write here (don't trust the renderer's list): dedupe, CSS-files-only, and
  // read through fsService.readFile so safeResolve blocks any traversal path — a caller can't
  // make apply read or rewrite a file outside the project or a non-stylesheet.
  const wantsBlock = !!blockCss && !!blockTargetFile && CSS_FILE.test(blockTargetFile)
  const pending: { rel: string; content: string }[] = []
  const planned = new Set<string>()
  try {
    for (const rel of checkedFiles) {
      if (planned.has(rel) || !CSS_FILE.test(rel)) continue
      const read = fsService.readFile(root, rel)
      if (!read.ok || read.content == null) continue
      const { newContent, replacements } = planFile(read.content, byValue)
      const isTarget = wantsBlock && rel === blockTargetFile
      if (replacements === 0 && !isTarget) continue
      planned.add(rel)
      // Fold the :root block into the SAME write when this file is the block target, so the
      // target is one snapshot (one Undo), never a double prepend.
      pending.push({ rel, content: isTarget ? blockCss + '\n\n' + newContent : newContent })
    }
    if (wantsBlock && !planned.has(blockTargetFile)) {
      const read = fsService.readFile(root, blockTargetFile) // ok:false for a new file → cur ''
      pending.push({ rel: blockTargetFile, content: blockCss + '\n\n' + (read.ok ? read.content ?? '' : '') })
    }
    // Nothing to do → no checkpoint (never leave a stale empty "Apply design tokens" mark).
    if (!pending.length) return { ok: true, filesWritten: 0 }
    const checkpointId = checkpoint('Apply design tokens')
    let filesWritten = 0
    for (const { rel, content } of pending) if (fsService.writeFile(root, rel, content).ok) filesWritten++
    return { ok: true, filesWritten, checkpointId }
  } catch (e) {
    return { ok: false, filesWritten: 0, error: errMessage(e) }
  }
}
