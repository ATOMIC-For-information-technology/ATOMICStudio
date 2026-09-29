import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { currentXtermTheme, onThemeApplied } from '../theme'

interface Props {
  /** PTY session id this view is attached to, or null while it's still starting. */
  ptyId: number | null
  /** True when this tab is the visible one — a hidden xterm must not try to measure itself. */
  visible: boolean
  onReady: (term: Terminal) => void
}

/**
 * One xterm.js surface bound to one PTY session.
 *
 * xterm is what makes this feel like the system terminal rather than a log view: it implements the
 * actual terminal emulation — cursor addressing, scroll regions, 256/true colour, wide characters,
 * selection — so `vim`, `top`, `git log` and a progress bar all behave the way they do in Terminal.app.
 *
 * The DOM renderer is used on purpose. The WebGL/canvas renderers are faster on paper, but this app
 * already hosts Monaco and a live-preview <webview>; a third GPU context is where Electron starts
 * dropping frames. The DOM renderer also keeps the output as real text in the DOM, which is what
 * makes "Explain this output" and the UI tests able to read it at all.
 */
export function XtermView({ ptyId, visible, onReady }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const themeOff = useRef<(() => void) | null>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    if (!hostRef.current || term.current) return
    const t = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      // The terminal wears the active theme's sixteen ANSI slots, so it reads as part of the
      // workbench rather than a black rectangle dropped into it — and it repaints when the theme
      // changes rather than keeping the palette it was born with (see the subscription below).
      theme: currentXtermTheme(),
      scrollback: 10_000,
      allowProposedApi: true
    })
    // xterm has no "re-read the theme" call, but assigning `options.theme` repaints in place, so a
    // live terminal follows a theme switch without being torn down and losing its scrollback.
    const off = onThemeApplied(() => {
      t.options.theme = currentXtermTheme()
    })
    themeOff.current = off

    const f = new FitAddon()
    t.loadAddon(f)
    t.open(hostRef.current)
    term.current = t
    fit.current = f
    // Test hook, matching the one CodeEditor exposes for Monaco: `input()` is xterm's public API
    // for "the user typed this", so the automated pass drives the real input path, not a shortcut.
    ;(window as unknown as Record<string, unknown>).__studioTerm = t
    onReadyRef.current(t)
    return () => {
      const w = window as unknown as Record<string, unknown>
      if (w.__studioTerm === t) delete w.__studioTerm
      themeOff.current?.()
      themeOff.current = null
      t.dispose()
      term.current = null
    }
  }, [])

  /* Refit on container resize — the panel divider, the side docks and the window all change this
     terminal's width. ResizeObserver rather than a window listener, because the panel can resize
     without the window doing anything. */
  useEffect(() => {
    if (!hostRef.current) return
    const ro = new ResizeObserver(() => {
      if (!visible) return
      try {
        fit.current?.fit()
        const t = term.current
        if (t && ptyId != null) void window.studio.ptyResize(ptyId, t.cols, t.rows)
      } catch {
        /* fit throws while the element is display:none or zero-sized */
      }
    })
    ro.observe(hostRef.current)
    return () => ro.disconnect()
  }, [visible, ptyId])

  /* Becoming visible again needs an explicit refit: everything that happened while this tab was
     hidden was measured against a zero-width box. */
  /* Runs on every render of the visible view (not just when `visible` flips): with several tabs
     open, the last one to MOUNT would otherwise keep the hook, so input aimed at "the terminal"
     landed in a tab nobody was looking at. */
  useEffect(() => {
    if (visible && term.current) (window as unknown as Record<string, unknown>).__studioTerm = term.current
  })

  useEffect(() => {
    if (!visible) return
    /* Keep trying until the box actually HAS a size.
       A single fit-on-next-tick is not enough: the panel can still be laying out (or be a few
       pixels tall) at that moment, and xterm that fitted to a zero-size box renders nothing at all
       — the shell's prompt arrives and is simply never drawn, which looks exactly like a terminal
       that failed to start. Retries stop as soon as one succeeds. */
    let tries = 0
    const attempt = (): void => {
      const host = hostRef.current
      const t = term.current
      if (!host || !t) return
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.current?.fit()
          if (ptyId != null) void window.studio.ptyResize(ptyId, t.cols, t.rows)
          if (t.cols > 2 && t.rows > 1) return // a real size — done retrying
        } catch {
          /* fall through to another attempt */
        }
      }
      if (++tries < 40) id = setTimeout(attempt, 100)
    }
    let id = setTimeout(attempt, 0)
    return () => clearTimeout(id)
  }, [visible, ptyId])

  return <div className="xterm-host" ref={hostRef} />
}
