import type { ArchitectureMap } from './types'

/**
 * Unused-File Finder — the "probably safe to remove" fold. A PURE reduction of the architecture map the
 * IDE already computes: a file nobody imports, that isn't an entry point or a test, is likely dead. It
 * NEVER deletes and NEVER auto-acts — it's a "review before deleting" list. Mirrors buildPassport's
 * pure-fold shape. No I/O, no model.
 */
export interface UnusedFile {
  path: string
  symbols: number
}
export interface UnusedReport {
  files: UnusedFile[]
  /** True when the import graph hit its cap — the list may miss things, so it's never authoritative. */
  partial: boolean
}

// Test/spec/mock files are meant to have no importer — never flag them as "unused".
const IS_TEST = /(\.|-)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|tests?|specs?|e2e|cypress)\//i

/**
 * Files the FRAMEWORK loads by convention — nothing imports a Next.js route, a Cloudflare Pages
 * function, a migration or a config, yet deleting one breaks production. They are invisible to an
 * import graph by design, so they can never be called "safe to remove".
 */
const IS_CONVENTION =
  /(^|\/)(pages|app|routes|functions|api|migrations|seeds|scripts|public|workers)\/|(^|\/)[^/]*\.config\.[cm]?[jt]s$|\.d\.ts$|\.stories\.[cm]?[jt]sx?$|(^|\/)(index|main|server|worker|middleware|layout|page|route|loading|error|not-found)\.[cm]?[jt]sx?$/i

/** Languages whose imports the indexer does NOT parse — we know nothing about them, so we claim nothing. */
const NO_IMPORT_PARSER = /\.(py|vue|svelte)$/i

export function findUnusedFiles(arch: ArchitectureMap | null): UnusedReport {
  if (!arch || !arch.nodes.length) return { files: [], partial: false }
  const imported = new Set(arch.edges.map((e) => e.to)) // every file that SOMEONE imports
  const files = arch.nodes
    .filter(
      (n) =>
        n.symbols > 0 &&
        !n.isEntry &&
        !IS_TEST.test(n.path) &&
        !IS_CONVENTION.test(n.path) &&
        !NO_IMPORT_PARSER.test(n.path) &&
        !imported.has(n.path)
    )
    .map((n) => ({ path: n.path, symbols: n.symbols }))
    .sort((a, b) => b.symbols - a.symbols || a.path.localeCompare(b.path))
  // A multi-file project with ZERO resolved edges means we failed to read its imports at all (a Python
  // project, an exotic module system) — every file would look unused. Claim nothing, and say so.
  if (!arch.edges.length && arch.nodes.length > 1) return { files: [], partial: true }
  const partial = arch.partial === true || arch.edges.length >= 2000 // graph-level OR the edge cap
  return { files, partial }
}
