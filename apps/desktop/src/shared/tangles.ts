/**
 * Tangle Finder — the circular-import fold. A PURE DFS over the architecture graph's edges that finds
 * knots where files depend on each other in a circle (A → B → A) — a hidden cause of hard-to-trace
 * startup/crash bugs. Uses the WHITE/GRAY/BLACK coloring proven in the workflow engine's validateDag.
 * Each loop is canonicalized (rotated to a stable start) and deduped, and enumeration is hard-capped so
 * a big graph stays fast and readable. No I/O, no model.
 */
export interface Cycle {
  /** The loop, canonicalized to its lexicographically-smallest rotation (so A→B→A and B→A→B are one). */
  files: string[]
}
export interface TangleReport {
  cycles: Cycle[]
  /** True when the cap was hit — there may be more tangles than shown. */
  partial: boolean
}

const MAX_CYCLES = 20
const MAX_LEN = 8
const WHITE = 0
const GRAY = 1
const BLACK = 2

function canonical(loop: string[]): string[] {
  let min = 0
  for (let i = 1; i < loop.length; i++) if (loop[i] < loop[min]) min = i
  return [...loop.slice(min), ...loop.slice(0, min)]
}

export function findCycles(edges: { from: string; to: string }[]): TangleReport {
  const adj = new Map<string, string[]>()
  const nodes = new Set<string>()
  const dedupe = new Set<string>()
  for (const e of edges) {
    // A DUPLICATE edge is not a second path: keeping it would re-walk the same target as a cross-edge and
    // falsely mark the report partial (and it multiplies the reachability work for nothing).
    const key = e.from + '\u0000' + e.to
    if (dedupe.has(key)) continue
    dedupe.add(key)
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e.to)
    nodes.add(e.from)
    nodes.add(e.to)
  }
  // Bounded reachability: can `src` still get back to `dst`? Used ONLY to decide whether a cross-edge
  // into a finished subtree closes a real loop we can't enumerate. Visit-capped so it stays cheap on a
  // big graph; hitting the cap returns false (we under-claim rather than invent a tangle).
  // 'yes' = a loop provably exists · 'no' = provably none · 'unknown' = we ran out of budget. 'unknown'
  // must NEVER collapse to 'no': that would drop a real loop AND claim the list is complete.
  const MAX_VISITS = 400
  const reaches = (src: string, dst: string): 'yes' | 'no' | 'unknown' => {
    const q = [src]
    const been = new Set<string>([src])
    let visits = 0
    while (q.length) {
      if (++visits > MAX_VISITS) return 'unknown'
      const cur = q.shift()!
      for (const nxt of adj.get(cur) ?? []) {
        if (nxt === dst) return 'yes'
        if (!been.has(nxt)) {
          been.add(nxt)
          q.push(nxt)
        }
      }
    }
    return 'no'
  }
  const color = new Map<string, number>()
  for (const n of nodes) color.set(n, WHITE)
  const cycles: Cycle[] = []
  const seen = new Set<string>()
  const stack: string[] = []
  let capped = false

  const dfs = (u: string): void => {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of adj.get(u) ?? []) {
      if (cycles.length >= MAX_CYCLES) {
        capped = true
        break
      }
      if (color.get(v) === GRAY) {
        const loop = stack.slice(stack.lastIndexOf(v)) // v … u forms a back edge
        if (loop.length <= MAX_LEN) {
          const c = canonical(loop)
          const key = c.join('\u0000')
          if (!seen.has(key)) {
            seen.add(key)
            cycles.push({ files: c })
          }
        } else {
          // A REAL tangle, just too long to render readably. Never drop it silently — mark the report
          // partial so the card degrades to "there may be more tangles than shown" instead of "clean".
          capped = true
        }
      } else if (color.get(v) === WHITE) {
        dfs(v)
      } else if (reaches(v, u) !== 'no') {
        // v is BLACK — a cross-edge into an already-finished subtree. One-pass DFS can't enumerate the
        // loop it closes (edges A→B, A→C, B→D, C→D, D→A hide [A,C,D]), but if v can still reach u then a
        // loop provably exists. Flag the report partial rather than imply the shown list is exhaustive.
        capped = true
      }
    }
    stack.pop()
    color.set(u, BLACK)
  }

  for (const n of nodes) {
    if (cycles.length >= MAX_CYCLES) {
      capped = true
      break
    }
    if (color.get(n) === WHITE) dfs(n)
  }
  return { cycles, partial: capped }
}
