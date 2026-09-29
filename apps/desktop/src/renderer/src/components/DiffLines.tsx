import React from 'react'
import type { DiffLine, DiffLineKind } from '../../../shared/types'

/**
 * The one place a `DiffLine[]` becomes markup.
 *
 * Two surfaces render diffs — the agent's staged-edit cards and the Git drawer's click-to-see-it —
 * and they were about to grow two renderers with two ideas of what a folded line looks like. The
 * `dl-*` classes already existed in `styles.css` for the agent panel, so this extracts the renderer
 * rather than inventing a parallel one: whichever surface you are looking at, an added line is the
 * same green.
 */
export function diffLineClass(kind: DiffLineKind): string {
  return kind === 'add' ? 'dl dl-add' : kind === 'del' ? 'dl dl-del' : kind === 'fold' ? 'dl dl-fold' : 'dl'
}

export function DiffLines({ lines, className }: { lines: DiffLine[]; className?: string }): React.JSX.Element {
  return (
    <pre className={className ?? 'diff-body'}>
      {lines.map((l, i) => (
        <div key={i} className={diffLineClass(l.kind)}>
          {l.text}
        </div>
      ))}
    </pre>
  )
}
