import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { applyTheme, currentTheme } from '../theme'
import { KIND_ORDER, kindLabel, type Theme, type ThemeKind } from '../../../shared/theme'

interface Props {
  onClose: () => void
  onMsg: (type: 'ok' | 'err', text: string) => void
}

type Row =
  | { kind: 'group'; label: string; count: number }
  | { kind: 'theme'; theme: Theme }
  | { kind: 'action'; id: 'install'; label: string; detail: string }

/**
 * The colour theme picker — VS Code's `Preferences: Color Theme` quick pick, and specifically its
 * one behaviour that matters: **the arrow keys paint the app.**
 *
 * A theme list with a swatch beside each name is a settings screen; you still have to commit to
 * find out what you chose. Previewing on highlight turns the same list into a way of *looking* at
 * eight themes in eight keystrokes, and it costs nothing here because `applyTheme` is a synchronous
 * write of custom properties plus one Monaco `setTheme`.
 *
 * Escape and clicking away therefore have to restore what was on when the picker opened — not
 * "close the dialog", but actively repaint. Anything less and browsing themes silently changes the
 * app.
 */
export function ThemePicker({ onClose, onMsg }: Props): React.JSX.Element {
  const [themes, setThemes] = useState<Theme[]>([])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const restoreTo = useRef<HTMLElement | null>(null)
  /** What was painted when this opened. Escape repaints it; Enter forgets it. */
  const opened = useRef<Theme>(currentTheme())
  const committed = useRef(false)

  const refresh = useCallback(async () => {
    setThemes(await window.studio.themeList())
  }, [])

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    void refresh()
    return () => {
      // The unmount path is the only one both Escape and click-away share, so the restore lives
      // here rather than in each handler — a picker that closed some other way still repaints.
      if (!committed.current) applyTheme(opened.current)
      restoreTo.current?.focus?.()
    }
  }, [refresh])

  /** Grouped exactly the way VS Code groups them: dark, light, then the two high-contrast families. */
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const matches = q ? themes.filter((t) => t.name.toLowerCase().includes(q) || t.publisher.toLowerCase().includes(q)) : themes
    const out: Row[] = []
    for (const kind of KIND_ORDER as ThemeKind[]) {
      const inKind = matches.filter((t) => t.kind === kind)
      if (inKind.length === 0) continue
      out.push({ kind: 'group', label: kindLabel(kind), count: inKind.length })
      for (const theme of inKind) out.push({ kind: 'theme', theme })
    }
    out.push({
      kind: 'action',
      id: 'install',
      label: 'Install a colour theme from a file…',
      detail: 'VS Code .json colour themes — colours only, nothing in one runs'
    })
    return out
  }, [themes, query])

  /** Only themes and actions are selectable; the group headings are passed over by the arrow keys. */
  const selectable = useMemo(() => rows.map((r, i) => (r.kind === 'group' ? -1 : i)).filter((i) => i >= 0), [rows])

  // Open on whatever is already applied, the way VS Code does — the list starts where you are.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || themes.length === 0) return
    const at = rows.findIndex((r) => r.kind === 'theme' && r.theme.id === opened.current.id)
    if (at >= 0) setIndex(at)
    seeded.current = true
  }, [rows, themes.length])

  useEffect(() => {
    if (!seeded.current) return
    setIndex(selectable[0] ?? 0)
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps

  // The live preview. Highlighting a theme paints it; highlighting the install row leaves whatever
  // the last highlighted theme painted, rather than snapping back and flickering.
  useEffect(() => {
    const row = rows[index]
    if (row?.kind === 'theme') applyTheme(row.theme)
  }, [index, rows])

  useEffect(() => {
    listRef.current?.querySelector('.qp-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const move = useCallback(
    (delta: number) => {
      if (selectable.length === 0) return
      const at = selectable.indexOf(index)
      const next = at < 0 ? 0 : (at + delta + selectable.length) % selectable.length
      setIndex(selectable[next])
    },
    [index, selectable]
  )

  const install = useCallback(async () => {
    setBusy(true)
    let res: Awaited<ReturnType<typeof window.studio.themeInstallFile>>
    try {
      res = await window.studio.themeInstallFile()
    } finally {
      setBusy(false) // never leave the button stuck disabled if the IPC ever rejects
    }
    if (res.ok && res.theme) {
      await refresh()
      // Apply it immediately: the user picked a theme file to *use* it, and making them find it in
      // the list afterwards is a second decision they never asked for.
      committed.current = true
      applyTheme(await window.studio.themeSet(res.theme.id))
      onMsg('ok', `Installed and applied "${res.theme.name}".`)
      onClose()
    } else if (res.error && res.error !== 'cancelled') {
      onMsg('err', res.error)
    }
  }, [refresh, onMsg, onClose])

  const commit = useCallback(
    async (row: Row | undefined) => {
      if (!row) return
      if (row.kind === 'action') return void install()
      if (row.kind !== 'theme') return
      committed.current = true
      applyTheme(await window.studio.themeSet(row.theme.id))
      onClose()
    },
    [install, onClose]
  )

  const remove = useCallback(
    async (theme: Theme) => {
      const res = await window.studio.themeRemove(theme.id)
      if (!res.ok) return onMsg('err', res.error ?? 'Could not remove that theme.')
      onMsg('ok', `Removed "${theme.name}".`)
      // The removed theme may have been the one previewing, so repaint from the source of truth.
      opened.current = await window.studio.themeGet()
      applyTheme(opened.current)
      await refresh()
    },
    [onMsg, refresh]
  )

  const activeId = rows[index]?.kind === 'group' ? undefined : `qp-row-${index}`

  return (
    <div className="quickinput-backdrop" onMouseDown={onClose}>
      <div
        className="quickinput"
        role="dialog"
        aria-modal="true"
        aria-label="Colour theme"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="qp-title">Colour Theme</div>
        <input
          ref={inputRef}
          className="qp-input"
          placeholder="Select colour theme (Up/Down to preview)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded="true"
          aria-controls="qp-list"
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              move(1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              move(-1)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              void commit(rows[index])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
        />
        <div className="qp-list" id="qp-list" role="listbox" aria-label="Colour themes" ref={listRef}>
          {rows.map((row, i) =>
            row.kind === 'group' ? (
              <div key={`g-${row.label}`} className="qp-group" role="presentation">
                {row.label}
                <span className="qp-group-count">{row.count}</span>
              </div>
            ) : row.kind === 'action' ? (
              <div
                key="install"
                id={`qp-row-${i}`}
                className={`qp-row qp-row-action ${index === i ? 'active' : ''}`}
                role="option"
                aria-selected={index === i}
                onMouseMove={() => setIndex(i)}
                onClick={() => void install()}
              >
                <span className="qp-swatch qp-swatch-action">
                  <Icon name={busy ? 'clock' : 'download'} size={13} />
                </span>
                <span className="qp-label">{busy ? 'Choosing a file…' : row.label}</span>
                <span className="qp-detail">{row.detail}</span>
              </div>
            ) : (
              <div
                key={row.theme.id}
                id={`qp-row-${i}`}
                className={`qp-row ${index === i ? 'active' : ''}`}
                role="option"
                aria-selected={index === i}
                onMouseMove={() => setIndex(i)}
                onClick={() => void commit(row)}
              >
                <ThemeSwatch theme={row.theme} />
                <span className="qp-label">{row.theme.name}</span>
                {row.theme.id === opened.current.id && (
                  <span className="qp-current">
                    <Icon name="check" size={12} /> current
                  </span>
                )}
                <span className="qp-detail">{row.theme.publisher}</span>
                {row.theme.source === 'installed' && (
                  <button
                    type="button"
                    className="qp-remove"
                    title={`Remove ${row.theme.name}`}
                    aria-label={`Remove ${row.theme.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(row.theme)
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                )}
              </div>
            )
          )}
          {rows.length === 1 && <div className="qp-empty muted">No theme matches “{query}”.</div>}
        </div>
        <div className="qp-foot">
          <kbd>↑</kbd> <kbd>↓</kbd> preview · <kbd>↵</kbd> apply · <kbd>esc</kbd> keep {opened.current.name}
        </div>
      </div>
    </div>
  )
}

/**
 * Four bands from the theme's own tokens — canvas, chrome, accent, and the syntax keyword. Enough
 * to tell two dark themes apart in a list without previewing, and it is generated from the theme
 * rather than authored per theme, so a newly imported theme has one the moment it lands.
 */
function ThemeSwatch({ theme }: { theme: Theme }): React.JSX.Element {
  const t = theme.tokens
  return (
    <span className="qp-swatch" aria-hidden="true">
      <span style={{ background: t.bg }} />
      <span style={{ background: t.panel }} />
      <span style={{ background: t.accent }} />
      <span style={{ background: theme.syntax.keyword }} />
    </span>
  )
}
