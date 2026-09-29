/**
 * ANSI escape-code parser for the interactive Terminal panel — text in, styled segments out, no I/O.
 * This app is deliberately not a PTY (no cursor-movement/redraw emulation, no interactive TUIs — see
 * terminal.ts's own doc comment), so this handles exactly one thing: SGR ("Select Graphic Rendition")
 * color/style codes, which is what makes `git status`, colorized test output, linters, etc. look like a
 * real terminal instead of raw text. Every OTHER escape sequence (cursor movement, clear-line, hide/show
 * cursor, alternate screen) is recognized and silently dropped rather than left as garbled `\x1b[2K` text
 * in the scrollback.
 */
export interface AnsiSegment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  /** Swap fg/bg — SGR 7. */
  inverse?: boolean
}

// The standard 16-color ANSI palette (8 normal + 8 bright). Fixed, not theme-reactive — this is exactly
// what every real terminal does; a colorized `git status` looks the same in any app.
const PALETTE: Record<number, string> = {
  30: '#2b2b2b', 31: '#e06c75', 32: '#98c379', 33: '#e5c07b', 34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#d7dae0',
  90: '#6b7280', 91: '#f2777a', 92: '#b5e890', 93: '#f0d080', 94: '#8ab6f9', 95: '#e0a0f0', 96: '#8fd6e0', 97: '#ffffff'
}
const BG_PALETTE: Record<number, string> = {
  40: '#2b2b2b', 41: '#e06c75', 42: '#98c379', 43: '#e5c07b', 44: '#61afef', 45: '#c678dd', 46: '#56b6c2', 47: '#d7dae0',
  100: '#6b7280', 101: '#f2777a', 102: '#b5e890', 103: '#f0d080', 104: '#8ab6f9', 105: '#e0a0f0', 106: '#8fd6e0', 107: '#ffffff'
}

// Any CSI sequence: ESC [ <params> <final-byte>. SGR ends in 'm'; everything else (cursor moves, clear
// screen/line, show/hide cursor, alt-screen toggles…) ends in a different letter and is just discarded.
const CSI_RE = /\x1b\[([0-9;?]*)([a-zA-Z])/g
// OSC sequences (window title, hyperlinks) — ESC ] ... BEL or ESC \.
const OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g

interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

function applySgr(style: Style, params: string): Style {
  const next = { ...style }
  const codes = params.length ? params.split(';').map((n) => parseInt(n, 10) || 0) : [0]
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) {
      next.fg = undefined
      next.bg = undefined
      next.bold = next.dim = next.italic = next.underline = next.inverse = false
    } else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 7) next.inverse = true
    else if (c === 22) next.bold = next.dim = false
    else if (c === 23) next.italic = false
    else if (c === 24) next.underline = false
    else if (c === 27) next.inverse = false
    else if (c === 39) next.fg = undefined
    else if (c === 49) next.bg = undefined
    else if (c === 38 && codes[i + 1] === 5) {
      // 256-color fg — fold the extended palette down to the nearest of our 16, rather than ignore it.
      next.fg = fold256(codes[i + 2])
      i += 2
    } else if (c === 48 && codes[i + 1] === 5) {
      next.bg = fold256(codes[i + 2])
      i += 2
    } else if (PALETTE[c]) next.fg = PALETTE[c]
    else if (BG_PALETTE[c]) next.bg = BG_PALETTE[c]
  }
  return next
}

/** Map a 256-color index onto the nearest of the 16 colors we actually render. */
function fold256(idx: number): string | undefined {
  if (!Number.isFinite(idx)) return undefined
  if (idx < 16) return PALETTE[idx < 8 ? 30 + idx : 82 + idx] ?? PALETTE[37]
  // 232-255 is the grayscale ramp; treat the rest of the 216-color cube as "white-ish" — good enough for
  // a scrollback view, and far better than either crashing or ignoring the color entirely.
  return idx >= 232 ? (idx < 244 ? PALETTE[90] : PALETTE[97]) : PALETTE[37]
}

/** Parse one line of process output into styled segments, dropping every non-color escape sequence. */
export function parseAnsi(text: string): AnsiSegment[] {
  const clean = text.replace(OSC_RE, '')
  const segments: AnsiSegment[] = []
  let style: Style = {}
  let last = 0
  CSI_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CSI_RE.exec(clean))) {
    const chunk = clean.slice(last, m.index)
    if (chunk) segments.push({ text: chunk, ...style })
    if (m[2] === 'm') style = applySgr(style, m[1])
    last = CSI_RE.lastIndex
  }
  const tail = clean.slice(last)
  if (tail) segments.push({ text: tail, ...style })
  return segments
}
