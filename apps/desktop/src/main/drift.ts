import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { architectureMap, MAX_FILES } from './index-service'
import type { ArchBaseline, ArchitectureMap, DriftReport } from '../shared/types'

/**
 * Architecture Drift Detection — freeze the project's dependency graph as a
 * baseline, then report how the current graph has drifted from it: modules,
 * in-project edges, and external dependencies that were added or removed. The
 * baseline is one replaceable JSON snapshot per project in userData. Diffs are
 * SET-based (order changes every rebuild — nodes in index order, deps by count).
 */

function baselinePath(project: string): string {
  const dir = join(app.getPath('userData'), 'arch-baseline')
  mkdirSync(dir, { recursive: true })
  return join(dir, createHash('sha1').update(project).digest('hex') + '.json')
}

/** Freeze the current architecture as the baseline. Returns it even if the write fails. */
export function saveArchBaseline(project: string): ArchBaseline {
  // full graph → drift is exact (all edges/deps, not the top-20 display caps).
  const baseline: ArchBaseline = { capturedAt: Date.now(), full: true, map: architectureMap(project, { full: true }) }
  try {
    writeFileSync(baselinePath(project), JSON.stringify(baseline), 'utf8')
  } catch {
    /* never throw — the baseline is still returned to the caller */
  }
  return baseline
}

function loadArchBaseline(project: string): ArchBaseline | null {
  try {
    const p = baselinePath(project)
    if (!existsSync(p)) return null
    const b = JSON.parse(readFileSync(p, 'utf8')) as ArchBaseline
    // Validate the shape — a truncated/old-schema baseline must not crash diffArch.
    if (!b || !b.map || !Array.isArray(b.map.nodes) || !Array.isArray(b.map.edges) || !Array.isArray(b.map.externalDeps)) return null
    return b
  } catch {
    return null
  }
}

// In FULL mode only the node ceiling (MAX_FILES) can still cap the graph — the
// dep/edge display caps are lifted — so only a >=MAX_FILES project is "partial".
// In legacy (capped) mode any of the three display caps means possible phantom drift.
const isCapped = (m: ArchitectureMap, full: boolean): boolean =>
  full ? m.nodes.length >= MAX_FILES : m.externalDeps.length >= 20 || m.edges.length >= 2000 || m.nodes.length >= MAX_FILES

const edgeKey = (e: { from: string; to: string }): string => `${e.from}\x00${e.to}`

/** Pure set-diff of two architecture maps (testable without electron). */
export function diffArch(base: ArchitectureMap, cur: ArchitectureMap): Pick<DriftReport, 'modules' | 'edges' | 'externalDeps'> {
  const baseNodes = new Set(base.nodes.map((n) => n.path))
  const curNodes = new Set(cur.nodes.map((n) => n.path))
  const baseEdges = new Map(base.edges.map((e) => [edgeKey(e), e]))
  const curEdges = new Map(cur.edges.map((e) => [edgeKey(e), e]))
  const baseDeps = new Set(base.externalDeps.map((d) => d.name))
  const curDeps = new Set(cur.externalDeps.map((d) => d.name))
  return {
    modules: {
      added: [...curNodes].filter((x) => !baseNodes.has(x)).sort(),
      removed: [...baseNodes].filter((x) => !curNodes.has(x)).sort()
    },
    edges: {
      added: [...curEdges].filter(([k]) => !baseEdges.has(k)).map(([, e]) => e),
      removed: [...baseEdges].filter(([k]) => !curEdges.has(k)).map(([, e]) => e)
    },
    externalDeps: {
      added: [...curDeps].filter((x) => !baseDeps.has(x)).sort(),
      removed: [...baseDeps].filter((x) => !curDeps.has(x)).sort()
    }
  }
}

/** Compare the current architecture to the saved baseline. No baseline → hasBaseline:false. */
export function archDrift(project: string): DriftReport {
  const baseline = loadArchBaseline(project)
  if (!baseline) {
    return {
      hasBaseline: false,
      capturedAt: null,
      partial: false,
      modules: { added: [], removed: [] },
      edges: { added: [], removed: [] },
      externalDeps: { added: [], removed: [] }
    }
  }
  // Diff full-vs-full. An OLD capped baseline (full !== true) can't be compared
  // exactly against a full current map (every dep #21+/edge #2001+ would read as
  // "added"), so force partial:true — an honest "re-baseline needed" beats phantom drift.
  const full = baseline.full === true
  const cur = architectureMap(project, { full })
  return {
    hasBaseline: true,
    capturedAt: baseline.capturedAt,
    partial: !full || isCapped(baseline.map, full) || isCapped(cur, full),
    ...diffArch(baseline.map, cur)
  }
}
