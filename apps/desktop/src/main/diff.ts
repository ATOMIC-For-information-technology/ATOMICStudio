import type { DiffLine } from '../shared/types'

/**
 * Minimal line diff (LCS) for the agent's staged-edit review cards — enough to
 * show a non-coder exactly what will change, with zero dependencies. Files
 * beyond MAX_DIFF_LINES fall back to a whole-file replace marker so we never
 * burn O(n·m) memory on huge inputs.
 */
const MAX_DIFF_LINES = 3000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [
      { kind: 'del', text: `(entire file replaced — ${a.length} lines before)` },
      { kind: 'add', text: `(entire file replaced — ${b.length} lines after)` }
    ]
  }

  // LCS table
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

/**
 * Collapse long unchanged stretches for display: keep `context` lines around
 * each change, replace the rest with a fold marker.
 */
export function foldContext(lines: DiffLine[], context = 2): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.kind !== 'ctx') {
      for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true
    }
  })
  const out: DiffLine[] = []
  let folded = 0
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep[idx]) {
      if (folded > 0) {
        out.push({ kind: 'fold', text: `… ${folded} unchanged line${folded === 1 ? '' : 's'} …` })
        folded = 0
      }
      out.push(lines[idx])
    } else {
      folded++
    }
  }
  if (folded > 0) out.push({ kind: 'fold', text: `… ${folded} unchanged line${folded === 1 ? '' : 's'} …` })
  return out
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
