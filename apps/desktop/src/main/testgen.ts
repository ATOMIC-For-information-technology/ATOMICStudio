import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectHouseStyle } from './index-service'
import * as fsService from './fs-service'

/**
 * Generate tests — a DETERMINISTIC, offline test scaffolder (no model, $0, guaranteed output).
 * The Fix-First Action Plan's "Add tests" row is a dead-end today; this turns it into a real,
 * correctly-imported `*.test.<ext>` skeleton in the project's own runner + quote/import style,
 * with clearly-marked TODO placeholders. It NEVER overwrites an existing test and NEVER emits a
 * fake always-passing assertion — only a genuine "this export exists" smoke check + a TODO.
 */

export type TestRunner = 'vitest' | 'jest' | 'node'
export interface TestStyle {
  runner: TestRunner
  quote: string
  semi: string
}

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/i
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/i
const camel = (s: string): string => (s.replace(/[^\w$]+([a-z0-9])/gi, (_, c: string) => c.toUpperCase()).replace(/[^\w$]/g, '').replace(/^[^A-Za-z_$]+/, '').replace(/^[A-Z]/, (c) => c.toLowerCase()) || 'subject')

/** The NAMES a file actually EXPORTS (not every top-level symbol — importing a non-exported name
 * would produce a broken test). Covers ES named/default and CJS `exports.x` / `module.exports = {…}`. */
export function exportedNames(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/^\s*export\s+(?:async\s+)?(?:function|class)\s*\*?\s+([\w$]+)/gm)) out.add(m[1])
  for (const m of source.matchAll(/^\s*export\s+(?:const|let|var)\s+([\w$]+)/gm)) out.add(m[1])
  for (const m of source.matchAll(/^\s*export\s*\{([^}]*)\}/gm))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop()?.trim()
      if (name && /^[\w$]+$/.test(name) && name !== 'default') out.add(name)
    }
  for (const m of source.matchAll(/(?:module\.)?exports\.([\w$]+)\s*=/g)) out.add(m[1])
  for (const m of source.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':')[0].trim()
      if (name && /^[\w$]+$/.test(name)) out.add(name)
    }
  return [...out]
}

/** PURE skeleton builder — unit-testable with plain strings. `names` = the source's EXPORTED symbols;
 * when empty (default-only or side-effect file), it falls back to a module-loads smoke import. */
export function buildTestSkeleton(srcRel: string, names: string[], style: TestStyle): { path: string; content: string } {
  const q = style.quote
  const s = style.semi
  const base = srcRel.replace(/^.*\//, '') // file name
  const ext = base.slice(base.lastIndexOf('.'))
  const stem = base.slice(0, base.lastIndexOf('.'))
  const testRel = srcRel.slice(0, srcRel.lastIndexOf('.')) + '.test' + ext
  const spec = './' + stem // sibling import

  // Import only what the file actually exports. No named exports → a `import * as` smoke import
  // (the module object is always defined) rather than an import of a non-exported name.
  let importLine: string
  let subjects: string[]
  if (names.length === 0) {
    const name = camel(stem)
    importLine = `import * as ${name} from ${q}${spec}${q}${s}`
    subjects = [name]
  } else {
    const picked = names.slice(0, 6)
    importLine = `import { ${picked.join(', ')} } from ${q}${spec}${q}${s}`
    subjects = picked
  }

  // Runner harness: vitest imports its API; jest uses globals; node uses node:test + assert.
  const header: string[] = []
  // Assert the export EXISTS (is not undefined) — NOT truthiness, so a valid `export const n = 0`
  // (or '' / false) doesn't spuriously fail the smoke check.
  const assertOf = (name: string): string =>
    style.runner === 'node' ? `    assert.notStrictEqual(${name}, undefined)${s}` : `    expect(${name}).toBeDefined()${s}`
  if (style.runner === 'vitest') header.push(`import { describe, it, expect } from ${q}vitest${q}${s}`)
  else if (style.runner === 'node') header.push(`import { describe, it } from ${q}node:test${q}${s}`, `import assert from ${q}node:assert${q}${s}`)
  // jest: describe/it/expect are globals — no import.

  const cases = subjects
    .map(
      (name) =>
        `  it(${q}${name} works${q}, () => {\n    // TODO: call ${name}(...) with real inputs and assert the result.\n${assertOf(name)}\n  })${s}`
    )
    .join('\n')

  const content =
    [...header, importLine].join('\n') +
    `\n\ndescribe(${q}${stem}${q}, () => {\n${cases}\n})${s}\n`

  return { path: testRel, content }
}

/** Read package.json deps to pick the runner the project already uses (else node:test). */
function pickRunner(root: string): TestRunner {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    if (all.vitest) return 'vitest'
    if (all.jest || all['@jest/globals'] || all['ts-jest']) return 'jest'
  } catch {
    /* no/broken package.json → fall through to node:test */
  }
  return 'node'
}

/** Gather everything and produce a test skeleton for one source file. Writes nothing. */
export function scaffoldTest(root: string, srcRel: string): { path: string; content: string } | { error: string } {
  if (!CODE_EXT.test(srcRel) || TEST_FILE.test(srcRel)) return { error: 'Pick a source file (not a test) to generate a test for.' }
  // Read through fsService so safeResolve blocks a traversal path (../../outside) + size/binary caps.
  const read = fsService.readFile(root, srcRel)
  if (!read.ok || read.content == null) return { error: read.error === 'too-large' ? 'That file is too large to scaffold a test for.' : 'Could not read that source file.' }
  const source = read.content
  const testRel = srcRel.slice(0, srcRel.lastIndexOf('.')) + '.test' + srcRel.slice(srcRel.lastIndexOf('.'))
  if (existsSync(join(root, testRel))) return { error: 'A test for this file already exists — open it instead of overwriting.' }

  const names = exportedNames(source) // only what's actually exported → never a broken import
  const hs = detectHouseStyle(root)
  return buildTestSkeleton(srcRel, names, {
    runner: pickRunner(root),
    quote: hs.quotes === 'double' ? '"' : "'",
    semi: hs.semicolons ? ';' : ''
  })
}
