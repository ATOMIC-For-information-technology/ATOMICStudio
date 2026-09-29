import React, { useMemo } from 'react'
import { resolveFileIcon, type IconTheme, type IconVariant } from '../../../shared/file-icons'
import { setiTheme } from '../assets/file-icons/seti-theme.gen'

/**
 * A file-type icon, drawn from the active file-icon THEME.
 *
 * Deliberately separate from `Icon.tsx`, which is the product's own authored monochrome set
 * (Refresh, New File, Git, Settings). A file type is data — what a `.ts` or a `Dockerfile` looks
 * like belongs to a swappable theme, and forcing both through one component is what produced the
 * old nine-glyph approximation where Go, Rust and Java were the same outline. DESIGN.md states
 * the split; this component is the file-type half.
 *
 * Rendering rules, all of them about staying SHARP (and the reason this is not an <img> or a
 * scaled SVG): the glyph comes from a locally bundled WOFF at its intended pixel size, in a fixed
 * 16px slot with integer dimensions, with no transform, no filter and no per-row opacity. The
 * slot is reserved even when the theme has no icon for the row — Seti has no folder glyphs at
 * all, and a missing icon must not shift the filename beside it.
 */

const THEME: IconTheme = setiTheme

interface Props {
  /** Leaf name only. */
  name: string
  isDir?: boolean
  expanded?: boolean
  isRoot?: boolean
  /** Containing folder's leaf name, for a theme's parent-qualified rules. */
  parentName?: string
  variant?: IconVariant
  /** Extra classes for callers that need their own spacing (tabs, quick open). */
  className?: string
}

export function FileIcon({ name, isDir, expanded, isRoot, parentName, variant = 'dark', className }: Props): React.JSX.Element {
  const icon = useMemo(
    () => resolveFileIcon(THEME, { name, isDir, expanded, isRoot, parentName }, variant),
    [name, isDir, expanded, isRoot, parentName, variant]
  )

  // No glyph for this row (a folder under Seti). The slot still occupies its 16px so every
  // filename in the column starts at the same x.
  if (!icon?.char) {
    return <span className={`file-icon file-icon-empty${className ? ` ${className}` : ''}`} aria-hidden="true" />
  }

  return (
    <span
      className={`file-icon${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      data-icon-id={icon.id}
      style={icon.color ? { color: icon.color } : undefined}
    >
      {icon.char}
    </span>
  )
}

/** The upstream the bundled theme came from, for the About/licence surfaces. */
export { SETI_UPSTREAM } from '../assets/file-icons/seti-theme.gen'
