import type { GitHotspot, DebtItem } from './types'

/**
 * Fragile Files watchlist — the "handle with care" fold. A PURE join of the files changed most often
 * (git hotspots the Project Brain already computes) with the messy/untested ones (tech-debt), so the
 * CEO sees exactly where cleanup effort protects them. Purely informational (never a ship-blocker);
 * each row is actionable via the existing Fix-with-AI. Degrades to a debt-only view without git history.
 */
export interface FragileFile {
  path: string
  commits: number
  churn: number
  /** Which debt signals this file carries (oversized / todo / dead …). */
  debt: string[]
  /** commits × churn — how much this file churns. */
  score: number
  /** A hotspot that ALSO carries real debt — the risky combination. */
  fragile: boolean
}
export interface FragileReport {
  files: FragileFile[]
  /** True when there's no git history to rank by (non-git / no commits / project isn't the repo root). */
  needsGit: boolean
  /**
   * True when we HAVE both hotspots and debt but none of the busiest files carry any — so `files` is the
   * debt-only fallback, not a hotspot∩debt watchlist. Honest in both readings (genuinely-clean hotspots,
   * or a path-namespace mismatch): the card never silently renders empty and never claims "all clean".
   */
  noOverlap: boolean
}

export function rankFragile(hotspots: GitHotspot[], debt: DebtItem[]): FragileReport {
  // debt keys on `.path`, hotspots on `.file` — join across the deliberate field-name mismatch.
  const debtByPath = new Map<string, string[]>()
  for (const d of debt) {
    if (d.kind === 'untested' && d.path === '(project)') continue // skip the synthetic project-level row
    const arr = debtByPath.get(d.path) ?? []
    if (!arr.includes(d.kind)) arr.push(d.kind)
    debtByPath.set(d.path, arr)
  }
  const debtOnly = (): FragileFile[] =>
    [...debtByPath.entries()]
      .map(([path, kinds]) => ({ path, commits: 0, churn: 0, debt: kinds, score: 0, fragile: kinds.length > 0 }))
      .sort((a, b) => b.debt.length - a.debt.length || a.path.localeCompare(b.path))
  if (!hotspots.length) {
    // No git history → rank by debt alone, and tell the user the picture is incomplete.
    return { files: debtOnly(), needsGit: true, noOverlap: false }
  }
  const files = hotspots
    .map((h) => {
      const kinds = debtByPath.get(h.file) ?? []
      return { path: h.file, commits: h.commits, churn: h.churn, debt: kinds, score: h.commits * h.churn, fragile: kinds.length > 0 }
    })
    .filter((f) => f.fragile) // only the churny-AND-messy files land on the watchlist
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  // Hotspots AND debt exist but they intersect in nothing: rather than render an empty card (which reads
  // as "your busiest files are clean" — and would be a LIE if the two path namespaces ever drift apart
  // again), fall back to the messiest-files list under its own honest label.
  if (!files.length && debtByPath.size) return { files: debtOnly(), needsGit: false, noOverlap: true }
  return { files, needsGit: false, noOverlap: false }
}
