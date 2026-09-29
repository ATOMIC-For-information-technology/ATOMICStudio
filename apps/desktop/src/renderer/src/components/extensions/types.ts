import type { ConnectorInfo, ExtensionManifest, RegistryEntry } from '../../../../shared/types'
import type { Theme } from '../../../../shared/theme'

/**
 * One row in the Extensions view, whatever it actually is underneath.
 *
 * The view lists four genuinely different things — an installed MCP connector, a colour theme, a
 * built-in Studio feature, and a registry entry that is not installed yet — and VS Code renders all
 * four with the same row anatomy. Rather than four near-identical row components, they are folded
 * into one shape here, and `kind` carries the one thing the row still has to decide: what its
 * action button does.
 */
export interface ExtItem {
  /** Unique across every section — sections can legitimately contain the same id (a theme pack). */
  key: string
  id: string
  name: string
  publisher: string
  version: string
  description: string
  kind: 'connector' | 'theme' | 'builtin' | 'registry'
  /** Two letters on the icon tile, derived from the name — no per-extension artwork exists. */
  initials: string
  /** The short status line under the description: "4 tools approved", "disabled", "core". */
  state: string
  /** Which status tone the state line carries, if any. */
  tone?: 'ok' | 'warn' | 'danger' | 'neutral'
  /** True while the row's action is mid-flight. */
  busy?: boolean
  connector?: ConnectorInfo
  manifest?: ExtensionManifest
  theme?: Theme
  registry?: RegistryEntry
  /** Built-in rows only: the live value and its setter. */
  toggle?: { on: boolean; core?: boolean; set: (on: boolean) => void }
}

/** Two-letter mark for the icon tile: initials of the first two words, or the first two letters. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (name.trim().slice(0, 2) || '??').toUpperCase()
}
