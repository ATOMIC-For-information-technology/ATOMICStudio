import React from 'react'

/**
 * ATOMIC Studio's icon system.
 *
 * Drawn, not typed. Every mark below is authored on the same 24×24 grid with a 20×20 live area,
 * one 1.8 stroke, round caps and joins, and no fill unless the fill *is* the mark (the status dot).
 * Nothing here is a font codepoint, which is the point: the emoji set this replaced rendered at a
 * different weight, colour and advance width on every OS, ignored `color:` when it resolved to a
 * colour glyph, and could tofu outright off macOS.
 *
 * Two registers, same as before — the rule outlived the glyphs:
 *  - **Status marks** (check, close, dot, circle, alert, play, stop) are monochrome and take their
 *    colour from CSS, so one mark serves ok/error/idle by class alone.
 *  - **Subject marks** (file, folder, terminal, robot…) name a thing. They never carry state.
 *
 * Icons are decorative by default (`aria-hidden`) because in this app a label is nearly always
 * beside them. Pass `label` for the handful that stand alone, and it becomes an `<svg role="img">`
 * with a title instead.
 */

export type IconName =
  // status + structure
  | 'check' | 'close' | 'dot' | 'circle' | 'circle-dashed' | 'alert' | 'ban' | 'target'
  | 'chevron-right' | 'chevron-left' | 'chevron-down' | 'play' | 'stop' | 'plus' | 'minus'
  | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right' | 'arrow-enter' | 'undo'
  // subjects
  | 'file' | 'file-code' | 'file-text' | 'folder' | 'folder-open' | 'braces' | 'palette'
  | 'image' | 'component' | 'atom' | 'globe' | 'search' | 'settings' | 'trash' | 'user'
  | 'puzzle' | 'terminal' | 'robot' | 'chat' | 'chart' | 'compass' | 'archive' | 'flag'
  | 'lock' | 'shield' | 'clock' | 'sparkle' | 'pencil' | 'monitor' | 'phone' | 'tablet'
  | 'devices' | 'download' | 'upload' | 'git-branch' | 'list' | 'layers' | 'key'
  | 'refresh' | 'external-link' | 'ellipsis'
  // layout toggles — which surface a title-bar control shows or hides
  | 'layout-sidebar' | 'layout-panel' | 'layout-dock'
  | 'file-plus' | 'folder-plus'

interface Props {
  name: IconName
  /** Rendered box in px. The grid is 24, so the stroke scales with it and stays optically even. */
  size?: number
  className?: string
  /** Give the icon an accessible name. Omit when a visible label sits next to it. */
  label?: string
}

/* Marks are grouped by register. Keep new ones on the same grid: 2px padding, 1.8 stroke,
   geometry snapped to whole or half units so nothing renders on a half-pixel at 16px. */
const MARKS: Record<IconName, React.ReactNode> = {
  // ---- status + structure -------------------------------------------------
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  circle: <circle cx="12" cy="12" r="6.5" />,
  'circle-dashed': <circle cx="12" cy="12" r="6.5" strokeDasharray="2.6 2.8" />,
  // Overflow ("more actions"). Three filled dots, the one mark whose fill IS the mark.
  ellipsis: (
    <>
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.5l8.5 15h-17l8.5-15z" />
      <path d="M12 10v4" />
      <path d="M12 16.6h.01" strokeWidth="2.2" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 6.5l11 11" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.2" />
    </>
  ),
  'chevron-right': <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />,
  'chevron-left': <path d="M14.5 5.5l-6.5 6.5 6.5 6.5" />,
  'chevron-down': <path d="M5.5 9.5l6.5 6.5 6.5-6.5" />,
  play: <path d="M8 5.6l10.5 6.4L8 18.4z" strokeLinejoin="round" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  'arrow-up': <path d="M12 19V5.5M6 11.5L12 5.5l6 6" />,
  'arrow-down': <path d="M12 5v13.5M6 12.5l6 6 6-6" />,
  'arrow-left': <path d="M19 12H5.5M11.5 6L5.5 12l6 6" />,
  'arrow-right': <path d="M5 12h13.5M12.5 6l6 6-6 6" />,
  'arrow-enter': <path d="M5 5.5v6a4 4 0 004 4h9M14.5 11.5l4 4-4 4" />,
  undo: <path d="M4.5 10.5h10a4.75 4.75 0 010 9.5H9M8.5 6L4.5 10.5 8.5 15" />,

  // ---- subjects -----------------------------------------------------------
  file: (
    <>
      <path d="M6 3.5h7l5 5v12a1 1 0 01-1 1H6a1 1 0 01-1-1v-16a1 1 0 011-1z" />
      <path d="M13 3.5V9h5" />
    </>
  ),
  'file-text': (
    <>
      <path d="M6 3.5h7l5 5v12a1 1 0 01-1 1H6a1 1 0 01-1-1v-16a1 1 0 011-1z" />
      <path d="M13 3.5V9h5M8.5 13h7M8.5 16.5h7" />
    </>
  ),
  'file-code': (
    <>
      <path d="M6 3.5h7l5 5v12a1 1 0 01-1 1H6a1 1 0 01-1-1v-16a1 1 0 011-1z" />
      <path d="M13 3.5V9h5" />
      <path d="M10 12.5l-2 2 2 2M14 12.5l2 2-2 2" />
    </>
  ),
  folder: <path d="M3.5 6.5A1.5 1.5 0 015 5h4.1l2 2.4H19A1.5 1.5 0 0120.5 9v8.5A1.5 1.5 0 0119 19H5a1.5 1.5 0 01-1.5-1.5v-11z" />,
  'folder-open': (
    <>
      <path d="M3.5 17.5v-11A1.5 1.5 0 015 5h4.1l2 2.4H19A1.5 1.5 0 0120.5 9v1.5" />
      <path d="M3.5 18.5l2.6-7.4h15.4l-2.6 7.4z" />
    </>
  ),
  braces: (
    <>
      <path d="M9.5 4.5c-2 0-2.6 1-2.6 2.8v2c0 1.5-.8 2.4-2.4 2.7 1.6.3 2.4 1.2 2.4 2.7v2c0 1.8.6 2.8 2.6 2.8" />
      <path d="M14.5 4.5c2 0 2.6 1 2.6 2.8v2c0 1.5.8 2.4 2.4 2.7-1.6.3-2.4 1.2-2.4 2.7v2c0 1.8-.6 2.8-2.6 2.8" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5c4.7 0 8.5 3.6 8.5 8 0 2.2-1.8 3.6-3.8 3.6h-1.5c-1.2 0-2.1.9-2.1 2 0 .5.2.9.5 1.3.3.4.5.8.5 1.2 0 1.1-.9 1.9-2.1 1.9-4.7 0-8.5-4-8.5-9s3.8-9 8.5-9z" />
      <circle cx="8.5" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="7.8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="16.3" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 17l4.8-4.3 3.7 3.3 3-2.5 4 3.5" />
    </>
  ),
  component: <path d="M12 3.5l8 4.7v7.6l-8 4.7-8-4.7V8.2l8-4.7z" />,
  atom: (
    <>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="9" ry="4" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(120 12 12)" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.5 3.7 5.4 3.7 8.5s-1.3 6-3.7 8.5c-2.4-2.5-3.7-5.4-3.7-8.5S9.6 6 12 3.5z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <path d="M19.3 13.4a7.6 7.6 0 000-2.8l1.9-1.4-1.9-3.3-2.2 1a7.6 7.6 0 00-2.4-1.4L14.3 3h-3.8l-.4 2.5a7.6 7.6 0 00-2.4 1.4l-2.2-1-1.9 3.3 1.9 1.4a7.6 7.6 0 000 2.8l-1.9 1.4 1.9 3.3 2.2-1a7.6 7.6 0 002.4 1.4l.4 2.5h3.8l.4-2.5a7.6 7.6 0 002.4-1.4l2.2 1 1.9-3.3-1.9-1.4z" />
      <circle cx="12.4" cy="12" r="2.8" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.3A1.3 1.3 0 0110.8 4h2.4a1.3 1.3 0 011.3 1.3V7" />
      <path d="M6.8 7l.9 12.2A1.5 1.5 0 009.2 20.5h5.6a1.5 1.5 0 001.5-1.3L17.2 7" />
      <path d="M10.5 11v6M13.5 11v6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.7" />
      <path d="M4.8 20a7.2 7.2 0 0114.4 0" />
    </>
  ),
  puzzle: <path d="M10 4.6a2 2 0 014 0V6h3.4a1 1 0 011 1v3.4h1.4a2 2 0 010 4h-1.4V18a1 1 0 01-1 1H14v-1.4a2 2 0 00-4 0V19H6.6a1 1 0 01-1-1v-3.4H7a2 2 0 000-4H5.6V7a1 1 0 011-1H10V4.6z" />,
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M7.5 9.5l3 3-3 3M13 15.5h4" />
    </>
  ),
  robot: (
    <>
      <rect x="4" y="8" width="16" height="11.5" rx="3" />
      <path d="M12 4.5V8" />
      <circle cx="12" cy="3.6" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.2" cy="13.4" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="13.4" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  chat: <path d="M20.5 12.2c0 3.8-3.8 6.9-8.5 6.9-1 0-2-.1-2.9-.4L4 20.5l1.6-3.6c-1.3-1.2-2.1-2.9-2.1-4.7 0-3.8 3.8-6.9 8.5-6.9s8.5 3.1 8.5 6.9z" />,
  chart: (
    <>
      <path d="M4 17l5.2-5.2 3.4 3.4L20 8" />
      <path d="M15.2 8H20v4.8" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5z" strokeLinejoin="round" />
    </>
  ),
  archive: (
    <>
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
      <path d="M5.5 9v9.5a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5V9" />
      <path d="M10 12.5h4" />
    </>
  ),
  flag: <path d="M6 20.5V4.5M6 5h11.5l-2.3 3.7 2.3 3.8H6" />,
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V7.6a4 4 0 018 0v2.9" />
    </>
  ),
  shield: <path d="M12 3.4l7.5 2.8v5.3c0 4.4-3 7.9-7.5 9.1-4.5-1.2-7.5-4.7-7.5-9.1V6.2L12 3.4z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 6.8V12l3.4 2" />
    </>
  ),
  sparkle: <path d="M12 3.5l2.1 6.4 6.4 2.1-6.4 2.1L12 20.5l-2.1-6.4-6.4-2.1 6.4-2.1L12 3.5z" strokeLinejoin="round" />,
  pencil: (
    <>
      <path d="M4 20l.9-4.1L16.4 4.4a2.1 2.1 0 013 3L7.9 18.9 4 20z" strokeLinejoin="round" />
      <path d="M14.5 6.5l3 3" />
    </>
  ),
  /* "New file" / "New folder": the existing subject mark with a plus in the free corner, so the
     action reads as "one more of this thing" rather than as a different object. */
  'file-plus': (
    <>
      <path d="M13.5 3.5H7a1.5 1.5 0 00-1.5 1.5v14A1.5 1.5 0 007 20.5h5" />
      <path d="M13.5 3.5l5 5V12" />
      <path d="M13.5 3.5V8a.5.5 0 00.5.5h4.5" />
      <path d="M17 15v6M14 18h6" />
    </>
  ),
  'folder-plus': (
    <>
      <path d="M3.5 6.5a1.5 1.5 0 011.5-1.5h3.6l2 2.5H15a1.5 1.5 0 011.5 1.5V13" />
      <path d="M3.5 6.5v11A1.5 1.5 0 005 19h7" />
      <path d="M17 15v6M14 18h6" />
    </>
  ),
  /* The three layout marks share one frame — a 15×13 workbench outline — and differ only in which
     region is filled. Drawn as a family on purpose: side by side in the title bar they read as one
     control group, and the filled region says which surface the button governs. */
  'layout-sidebar': (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M9 5.5v13" />
      <path d="M3.5 5.5h5.5v13H3.5z" fill="currentColor" stroke="none" opacity="0.9" />
    </>
  ),
  'layout-panel': (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M3.5 14h17" />
      <path d="M3.5 14h17v4.5H3.5z" fill="currentColor" stroke="none" opacity="0.9" />
    </>
  ),
  'layout-dock': (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M15 5.5v13" />
      <path d="M15 5.5h5.5v13H15z" fill="currentColor" stroke="none" opacity="0.9" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 17v3" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 18h2" />
    </>
  ),
  tablet: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M10.5 18h3" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="5.5" width="12" height="9" rx="1.6" />
      <path d="M7 18h5" />
      <rect x="16.5" y="9.5" width="4.5" height="9" rx="1.4" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14" />,
  upload: <path d="M12 20V9M7.5 13.5L12 9l4.5 4.5M5 4.5h14" />,
  'git-branch': (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="8.5" r="2.2" />
      <path d="M7 8.2v7.6" />
      <path d="M17 10.7c0 3.2-2.8 4.6-6.4 5" />
    </>
  ),
  list: <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11M4.6 6.5h.01M4.6 12h.01M4.6 17.5h.01" strokeWidth="2" />,
  layers: (
    <>
      <path d="M12 3.5l8.5 4.6L12 12.7 3.5 8.1 12 3.5z" strokeLinejoin="round" />
      <path d="M3.5 12.9l8.5 4.6 8.5-4.6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.8" />
      <path d="M11.8 12H20M17.5 12v3M14.5 12v2.2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8.1 8.1 0 00-15.5-2m-.5-4v4h4" />
      <path d="M4 13a8.1 8.1 0 0015.5 2m.5 4v-4h-4" />
    </>
  ),
  'external-link': (
    <>
      <path d="M12 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-6" />
      <path d="M11 13l9-9" />
      <path d="M15 4h5v5" />
    </>
  )
}

/** Marks whose whole point is the fill; they must not also take the stroke. */
const FILLED = new Set<IconName>(['dot'])

export function Icon({ name, size = 16, className, label }: Props): React.JSX.Element {
  const mark = MARKS[name]
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={FILLED.has(name) ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {mark}
    </svg>
  )
}
