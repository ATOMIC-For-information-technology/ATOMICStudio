import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { architectureMap } from './index-service'
import { audit } from './audit'
import type { DependencyFinding, DependencyReport } from '../shared/types'

/**
 * Dependency Health — a fully OFFLINE audit of package.json + lockfile, mirroring the
 * Security Gate's scan→verdict→findings discipline. It catches exactly what an AI-generated
 * app ships silently: unpinned version ranges (installs can drift/break), a missing lockfile
 * (installs not reproducible), a package declared in both deps and devDeps, a dependency that's
 * installed-but-never-imported, and a package imported-but-never-declared (a "phantom" that
 * breaks a clean install). NO network calls — it never invents CVEs, "out of date", or malware;
 * the language is "double-check the spelling" / "consider pinning", never a false scare.
 */

const MAX_FILE = 512 * 1024
// Non-semver specs that are INTENTIONAL (monorepo / local / registry protocol) — never "unpinned".
const NON_SEMVER = /^(workspace|file|link|portal|catalog|npm|git|github|git\+|http|https|bitbucket|gitlab):/i
// Node builtins a phantom check must ignore (bare 'fs', 'path', … and their node: forms).
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os',
  'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib'
])
// Config-loaded-by-name tools/plugins are referenced as strings, not imports — never "unused".
const PLUGIN_NAME = /(^|\/)(eslint-plugin-|eslint-config-|babel-plugin-|babel-preset-|@babel\/plugin|@babel\/preset|postcss-|stylelint-|remark-|rehype-|vite-plugin-|rollup-plugin-|webpack)|(-loader$)|(-plugin$)/
const RANK: Record<DependencyFinding['severity'], number> = { high: 3, medium: 2, low: 1 }

// Curated map of KNOWN typosquats → the real package they impersonate. A curated blocklist (NOT a
// generic edit-distance scan) is used deliberately: a distance-1 scan against popular names accuses
// legitimate packages that merely *look* similar (nuxt≈next, vuex≈vue, vike≈vite, vest≈jest are all
// real, mainstream packages). This list only names the actual supply-chain typos seen in the wild, so
// we honour Dependency Health's contract — "never a false scare".
const KNOWN_TYPOSQUATS: Record<string, string> = {
  crossenv: 'cross-env',
  expres: 'express', expresss: 'express', exprees: 'express', exspress: 'express',
  loadsh: 'lodash', loadash: 'lodash', lodahs: 'lodash', lodas: 'lodash',
  momnet: 'moment', momment: 'moment',
  mongose: 'mongoose', monggose: 'mongoose', mongoos: 'mongoose',
  axioss: 'axios', axois: 'axios', aixos: 'axios',
  reqeust: 'request', reqest: 'request',
  chalck: 'chalk', chak: 'chalk',
  reactt: 'react', raect: 'react', recat: 'react',
  webpak: 'webpack', wbepack: 'webpack',
  typescirpt: 'typescript', typscript: 'typescript', tpyescript: 'typescript',
  dotnev: 'dotenv', dotenb: 'dotenv',
  nodemn: 'nodemon',
  jqeury: 'jquery', jquerry: 'jquery',
  eslnt: 'eslint', eslnit: 'eslint',
  pretttier: 'prettier', pretier: 'prettier',
  tailwindcs: 'tailwindcss', tailwnidcss: 'tailwindcss'
}
// Heavy runtime libs with a lighter, drop-in-ish suggestion (advisory only — size, never "bad").
const HEAVYWEIGHT: Record<string, string> = { moment: 'dayjs or date-fns', lodash: "lodash-es or the specific lodash function you need" }
// Two packages that do the same job — only flagged when BOTH are present.
const OVERLAP_GROUPS: { name: string; members: string[] }[] = [
  { name: 'date library', members: ['moment', 'dayjs', 'date-fns', 'luxon'] },
  { name: 'HTTP client', members: ['axios', 'node-fetch', 'got', 'superagent'] },
  { name: 'unique-id library', members: ['uuid', 'nanoid', 'cuid'] }
]

// Packages that are legitimately in `dependencies` but used IMPLICITLY (a runtime shim/polyfill
// or a framework loaded by config), so a "you never import this" nudge would be a false alarm.
const IMPLICIT_RUNTIME = new Set([
  'tslib', 'core-js', 'core-js-pure', 'regenerator-runtime', '@babel/runtime', 'reflect-metadata',
  'zone.js', 'dotenv', 'source-map-support', 'whatwg-fetch'
])

/** Pure string-in → findings-out (unit-testable). importedPkgs = external package names actually imported. */
export function analyzeManifest(pkgJsonText: string, lockText: string | null, importedPkgs: Set<string>): DependencyFinding[] {
  let pkg: unknown
  try {
    pkg = JSON.parse(pkgJsonText)
  } catch {
    return [] // malformed package.json → calm empty result, never a throw
  }
  if (!pkg || typeof pkg !== 'object') return []
  const obj = (v: unknown): Record<string, string> => (v && typeof v === 'object' ? (v as Record<string, string>) : {})
  const deps = obj((pkg as { dependencies?: unknown }).dependencies)
  const devDeps = obj((pkg as { devDependencies?: unknown }).devDependencies)
  // A package listed as a peer/optional dependency IS declared — never a phantom when imported.
  const peerOpt = { ...obj((pkg as { peerDependencies?: unknown }).peerDependencies), ...obj((pkg as { optionalDependencies?: unknown }).optionalDependencies) }
  const hasLockfile = lockText != null
  const findings: DependencyFinding[] = []

  // Missing lockfile → installs aren't reproducible (only meaningful if there ARE deps).
  if (!hasLockfile && (Object.keys(deps).length || Object.keys(devDeps).length))
    findings.push({
      severity: 'medium',
      kind: 'no-lockfile',
      package: '',
      message: 'No lockfile (package-lock.json / yarn.lock / pnpm-lock.yaml) — installs may not be reproducible. Commit a lockfile.'
    })

  // Unpinned ranges across ALL declared deps (a wildcard is always risky; a ^/~ range is only a
  // drift risk WITHOUT a lockfile — with one, the version is locked, so we don't nag).
  for (const [name, rangeRaw] of Object.entries({ ...devDeps, ...deps })) {
    const range = String(rangeRaw ?? '').trim()
    if (NON_SEMVER.test(range)) continue
    const wildcard = range === '' || range === '*' || range === 'x' || range === 'X' || range.toLowerCase() === 'latest'
    if (wildcard)
      findings.push({
        severity: 'high',
        kind: 'unpinned',
        package: name,
        message: `"${name}" can install ANY version (${range || 'no version'}) — pin it to a version so an install can't silently change it.`
      })
    else if (!hasLockfile && /^[\^~]|^>=?|^</.test(range))
      findings.push({
        severity: 'low',
        kind: 'unpinned',
        package: name,
        message: `"${name}" uses a range (${range}) and there's no lockfile — the installed version can drift. Add a lockfile or pin it.`
      })
  }

  // Same package in both deps and devDeps.
  const devSet = new Set(Object.keys(devDeps))
  for (const name of Object.keys(deps))
    if (devSet.has(name))
      findings.push({ severity: 'medium', kind: 'duplicate', package: name, message: `"${name}" is listed in both dependencies and devDependencies — keep it in one place.` })

  // Unused: declared in DEPENDENCIES (never devDeps — those are build/config tools, not imported)
  // but never imported. @types/* are type-only and never imported at runtime → excluded.
  for (const [name, rangeRaw] of Object.entries(deps)) {
    if (name.startsWith('@types/') || IMPLICIT_RUNTIME.has(name) || PLUGIN_NAME.test(name)) continue // type-only / implicit-runtime / config-loaded-by-name
    if (NON_SEMVER.test(String(rangeRaw ?? ''))) continue
    if (!importedPkgs.has(name))
      findings.push({ severity: 'low', kind: 'unused', package: name, message: `"${name}" is installed but never imported in your code — you may not need it.` })
  }

  // Phantom: imported in code but declared nowhere (breaks a clean install). Skip node builtins.
  const declared = new Set([...Object.keys(deps), ...Object.keys(devDeps), ...Object.keys(peerOpt)])
  for (const name of importedPkgs) {
    if (!name || NODE_BUILTINS.has(name) || name.startsWith('node:') || declared.has(name)) continue
    findings.push({ severity: 'medium', kind: 'phantom', package: name, message: `"${name}" is imported in your code but not listed in package.json — add it so installs include it.` })
  }

  const allNames = [...Object.keys(deps), ...Object.keys(devDeps)]
  // Typosquat: a declared name that MATCHES a curated list of real supply-chain typos → a likely
  // spelling slip. A gentle QUESTION, never a malware accusation — and never fired for a legitimate
  // package that merely resembles a popular one (nuxt/vuex/vike/… are not in the list, so never flagged).
  for (const name of allNames) {
    const real = KNOWN_TYPOSQUATS[name.toLowerCase()]
    if (real && real !== name) findings.push({ severity: 'medium', kind: 'typosquat', package: name, message: `"${name}" looks like a typo of "${real}" — did you mean "${real}"? Double-check the spelling.` })
  }
  // Heavyweight: a large runtime dep with a lighter alternative (dependencies only — size, not "bad").
  for (const name of Object.keys(deps)) {
    if (HEAVYWEIGHT[name]) findings.push({ severity: 'low', kind: 'heavyweight', package: name, message: `"${name}" is a large library — if you only need a little of it, ${HEAVYWEIGHT[name]} is lighter.` })
  }
  // Overlap: two packages doing the same job — flag the group ONCE when 2+ are present.
  const declaredSet = new Set(allNames)
  for (const g of OVERLAP_GROUPS) {
    const present = g.members.filter((m) => declaredSet.has(m))
    if (present.length >= 2) findings.push({ severity: 'low', kind: 'overlap', package: present.join(' + '), message: `${present.join(' and ')} both do the same job (a ${g.name}) — you probably only need one.` })
  }

  return findings.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.package.localeCompare(b.package))
}

const readIfSmall = (p: string): string | null => {
  try {
    return existsSync(p) && statSync(p).size <= MAX_FILE ? readFileSync(p, 'utf8') : existsSync(p) ? '' : null
  } catch {
    return null
  }
}

export function dependencyAudit(root: string): DependencyReport {
  const pkgPath = join(root, 'package.json')
  const pkgText = readIfSmall(pkgPath)
  if (pkgText == null) return { ok: true, verdict: 'No package.json here — nothing to audit.', findings: [], depCount: 0, hasLockfile: false }

  // Cover every package manager's lockfile (bun.lockb is BINARY — presence is all we need).
  let lockText: string | null = null
  for (const ln of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock']) {
    const t = readIfSmall(join(root, ln))
    if (t != null) {
      lockText = t
      break
    }
  }
  if (lockText == null && existsSync(join(root, 'bun.lockb'))) lockText = '' // binary bun lockfile → present
  // full:true so the imported-package set is COMPLETE — a package ranked past the top-20 must not
  // look "unused".
  const imported = new Set(architectureMap(root, { full: true }).externalDeps.map((d) => d.name))
  const findings = analyzeManifest(pkgText, lockText, imported)

  let depCount = 0
  try {
    const p = JSON.parse(pkgText)
    depCount = Object.keys(p.dependencies ?? {}).length + Object.keys(p.devDependencies ?? {}).length
  } catch {
    /* already handled in analyzeManifest */
  }
  const high = findings.filter((f) => f.severity === 'high').length
  const ok = findings.length === 0
  const verdict = ok
    ? 'Dependencies look healthy.'
    : `${findings.length} thing${findings.length === 1 ? '' : 's'} to check${high ? ` — ${high} that could break an install` : ''}.`
  audit('dependency-audit', `${root}: ${findings.length} findings`)
  return { ok, verdict, findings, depCount, hasLockfile: lockText != null }
}
