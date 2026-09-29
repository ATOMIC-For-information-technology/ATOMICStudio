/**
 * Keyboard-hint labels that match the machine the app is actually running on.
 *
 * Every shortcut in the UI used to be written as a literal "⌘S". On Windows and Linux that symbol means
 * nothing — the key is Ctrl — so a non-coder reading the hint would press the wrong thing (or hunt for a
 * key their keyboard doesn't have). The shortcut HANDLERS already accept both modifiers; only the
 * printed labels were macOS-only.
 *
 * Detection uses the UA platform string rather than an IPC call so a label never renders wrong for a
 * frame while an async answer is in flight.
 */
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')

/** The command/control key: ⌘ on macOS, Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl+'
/** The shift key: ⇧ on macOS, Shift+ elsewhere. */
export const SHIFT = isMac ? '⇧' : 'Shift+'
/** The alt/option key: ⌥ on macOS, Alt+ elsewhere. */
export const ALT = isMac ? '⌥' : 'Alt+'

/**
 * Build a shortcut label: `key('S')` → "⌘S" or "Ctrl+S"; `key('P', { shift: true })` → "⌘⇧P" or
 * "Ctrl+Shift+P". Pass the letter as the user would see it on the key cap.
 */
export function key(letter: string, opts?: { shift?: boolean; alt?: boolean }): string {
  return `${MOD}${opts?.alt ? ALT : ''}${opts?.shift ? SHIFT : ''}${letter}`
}
