import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Terminal } from '@xterm/xterm'
import { Icon } from './Icon'
import { XtermView } from './XtermView'
import { Menu, type MenuEntry } from './git-panel'

interface Props {
  projectPath: string
  providerId: string
  model: string
  onMsg: (type: 'ok' | 'err', text: string) => void
}

interface TermTab {
  id: number
  name: string
  /** PTY session id in the main process; null until it starts (or if it failed to). */
  ptyId: number | null
  error: string | null
}

let nextTabId = 1

/* Session routing lives at MODULE level, keyed by pty id, not in per-instance refs.
   The panel can remount (React re-mounts effects, the panel is closed and reopened, the project
   changes) while a session is still alive in the main process. With the map on the instance, output
   for that session arrives at a listener whose map no longer knows about it, and the terminal sits
   there empty and attached — looking for all the world like a shell that failed to start. */
const SESSION_TERMS = new Map<number, Terminal>()
const SESSION_TEXT = new Map<number, string>()

/** Strip ANSI so "Explain this output" reads what the user reads, not escape codes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g
const MAX_TRANSCRIPT = 200_000

/**
 * The integrated terminal — a real one.
 *
 * Each tab owns a pseudo-terminal running the user's own login shell, so their prompt, aliases and
 * PATH are exactly what they get in Terminal.app, and interactive programs work: Ctrl-C, `vim`,
 * `top`, a password prompt, `git rebase -i`. The previous version ran one command at a time through
 * `child_process` and printed the captured lines, which meant nothing interactive worked, every
 * program could tell it wasn't talking to a terminal (so most turned colour off), and each command
 * paid a fresh process spawn.
 *
 * Every tab stays mounted (inactive ones are hidden) so scrollback and running programs survive a
 * tab switch.
 */
export function TerminalPanel({ projectPath, providerId, model, onMsg }: Props): React.JSX.Element {
  const [tabs, setTabs] = useState<TermTab[]>([{ id: nextTabId++, name: 'Terminal 1', ptyId: null, error: null }])
  const [active, setActive] = useState(tabs[0].id)
  const [dockerInfo, setDockerInfo] = useState<{ composeFile: string | null; available: boolean }>({ composeFile: null, available: false })
  const [dockerBusy, setDockerBusy] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [explainText, setExplainText] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)

  /** tab id → the pty session it owns, so the visible tab can be resolved to a session. */
  const sessionOf = useRef<Map<number, number>>(new Map())
  const activeRef = useRef(active)
  activeRef.current = active

  /** Write into a session's terminal and keep its plain-text transcript (what Explain reads). */
  const append = useCallback((ptyId: number, data: string): void => {
    SESSION_TERMS.get(ptyId)?.write(data)
    const clean = data.replace(ANSI, '')
    SESSION_TEXT.set(ptyId, ((SESSION_TEXT.get(ptyId) ?? '') + clean).slice(-MAX_TRANSCRIPT))
  }, [])

  /** The pty session behind the visible tab, if it has one yet. */
  const activeSession = useCallback((): number | null => sessionOf.current.get(activeRef.current) ?? null, [])

  useEffect(() => {
    void window.studio.dockerInfo(projectPath).then(setDockerInfo)
  }, [projectPath])

  /* One mount-stable listener for every session: routing by pty id means switching tabs mid-command
     can never deliver output to the wrong terminal. */
  useEffect(
    () =>
      window.studio.onPtyData((ev) => append(ev.id, ev.data)),
    [append]
  )

  /* The Docker buttons still go through the dockerCompose IPC — it resolves the compose file it
     actually found rather than trusting PATH — and its output is written into the active terminal
     so everything the user triggers shows up in one place. */
  useEffect(
    () =>
      window.studio.onTermLine((ev) => {
        const ptyId = activeSession()
        if (ptyId == null) return
        append(ptyId, ev.line.text.replace(/\r?\n$/, '') + '\r\n')
      }),
    [append, activeSession]
  )

  /** Attach a freshly-created xterm to a new PTY session, wiring keystrokes both ways. */
  const bind = useCallback(
    async (tabId: number, term: Terminal): Promise<void> => {

      /* Wire keystrokes BEFORE awaiting the pty, buffering anything typed in the meantime.
         Registering onData after the await meant every character typed between the terminal
         appearing and the shell attaching was silently dropped — invisible to anyone who types
         fast, and the thing that made the terminal test flaky. */
      let ptyId: number | null = null
      const early: string[] = []
      term.onData((d) => {
        if (ptyId == null) early.push(d)
        else void window.studio.ptyWrite(ptyId, d)
      })

      const res = await window.studio.ptyStart(projectPath, term.cols || 80, term.rows || 24)
      if (!res.ok || res.id == null) {
        // Say what's wrong inside the terminal rather than leaving a dead black box.
        term.write(`\r\n\x1b[31m${res.error ?? 'Could not start a terminal session.'}\x1b[0m\r\n`)
        setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, error: res.error ?? 'unavailable' } : t)))
        return
      }
      ptyId = res.id
      SESSION_TERMS.set(ptyId, term)
      sessionOf.current.set(tabId, ptyId)
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ptyId } : t)))
      const back = await window.studio.ptyScrollback(ptyId)
      if (back) term.write(back)
      // Anything typed while the shell was starting, delivered in order.
      for (const d of early) void window.studio.ptyWrite(ptyId, d)
      early.length = 0
    },
    [projectPath]
  )

  const addTab = useCallback(() => {
    setTabs((prev) => {
      /* Named by position, not by the module-level id counter: that counter only ever grows, so a
         long session produced "Terminal 139" as somebody's second tab. The id stays unique and
         internal; the NAME is what the user reads. */
      const used = new Set(prev.map((t) => t.name))
      let n = 1
      while (used.has(`Terminal ${n}`)) n++
      const t: TermTab = { id: nextTabId++, name: `Terminal ${n}`, ptyId: null, error: null }
      setActive(t.id)
      return [...prev, t]
    })
  }, [])

  const closeTab = useCallback(
    (id: number) => {
      setTabs((prev) => {
        if (prev.length === 1) return prev
        const closing = prev.find((t) => t.id === id)
        if (closing?.ptyId != null) {
          void window.studio.ptyKill(closing.ptyId)
          SESSION_TERMS.delete(closing.ptyId)
          SESSION_TEXT.delete(closing.ptyId)
        }
        sessionOf.current.delete(id)
        const next = prev.filter((t) => t.id !== id)
        if (active === id) setActive(next[next.length - 1].id)
        return next
      })
    },
    [active]
  )

  /** Clear the visible terminal — the same thing the View menu's "Clear Terminal" does. */
  const clearActive = useCallback(() => {
    document.dispatchEvent(new CustomEvent('studio:term-clear'))
  }, [])

  /* Kill every shell and open ONE fresh terminal. The panel always shows a terminal — there is no
     "no terminals" state to fall into — so this is what "kill all" can honestly mean here, and the
     menu entry says so in its hint rather than leaving the user to discover it. */
  const killAll = useCallback(() => {
    for (const ptyId of sessionOf.current.values()) {
      void window.studio.ptyKill(ptyId)
      SESSION_TERMS.delete(ptyId)
      SESSION_TEXT.delete(ptyId)
    }
    sessionOf.current.clear()
    const fresh: TermTab = { id: nextTabId++, name: 'Terminal 1', ptyId: null, error: null }
    setTabs([fresh])
    setActive(fresh.id)
  }, [])

  const compose = useCallback(
    async (action: 'up' | 'down' | 'ps') => {
      const ptyId = activeSession()
      setDockerBusy(true)
      if (ptyId != null) append(ptyId, `$ docker compose ${action}\r\n`)
      const res = await window.studio.dockerCompose(projectPath, action)
      setDockerBusy(false)
      if (!res.ok && ptyId != null) append(ptyId, `${res.output}\r\n`)
    },
    [projectPath, append, activeSession]
  )

  const explain = useCallback(async () => {
    const ptyId = activeSession()
    const text = ptyId != null ? SESSION_TEXT.get(ptyId) ?? '' : ''
    if (!text.trim()) {
      onMsg('err', 'Run a command first, then I can explain the output.')
      return
    }
    setExplaining(true)
    const res = await window.studio.explainOutput(text, providerId, model.trim() || undefined)
    setExplaining(false)
    if (res.ok && res.text) setExplainText(res.text)
    else onMsg('err', res.error ?? 'Could not explain the output.')
  }, [providerId, model, onMsg, activeSession])

  /* "Clear Terminal" from the menu. Clears xterm's buffer AND sends the shell a Ctrl-L, so the
     prompt is redrawn at the top exactly as it would be in Terminal.app — clearing only our side
     would leave the shell thinking the cursor is halfway down the screen. */
  useEffect(() => {
    const onClear = (): void => {
      const ptyId = activeSession()
      if (ptyId == null) return
      SESSION_TERMS.get(ptyId)?.clear()
      SESSION_TEXT.set(ptyId, '')
      void window.studio.ptyWrite(ptyId, '\x0c')
    }
    document.addEventListener('studio:term-clear', onClear)
    return () => document.removeEventListener('studio:term-clear', onClear)
  }, [activeSession])

  /* Kill every session when the panel goes away (panel closed, project switched). A shell with no
     window attached is invisible and would keep running forever. */
  useEffect(() => {
    const live = sessionOf.current
    return () => {
      for (const ptyId of live.values()) {
        void window.studio.ptyKill(ptyId)
        SESSION_TERMS.delete(ptyId)
        SESSION_TEXT.delete(ptyId)
      }
      live.clear()
    }
  }, [])

  /* VS Code's terminal chrome: the SESSIONS live in a list down the right-hand edge, not in a
     horizontal strip that runs out of room after four. Everything that acts on the whole terminal
     ( +, the overflow ) sits above that list; everything that acts on the OUTPUT (Explain, the
     Docker shortcuts) stays over the output itself, on the left.

     Deliberately NOT copied from the reference: the profile chevron (this app has no shell
     profiles), the split control (no split panes), and a second close button (the panel header
     already carries one). A control that cannot do anything is worse than a missing one. */
  const moreEntries: MenuEntry[] = [
    { id: 'new', label: 'New Terminal', icon: 'plus' },
    { id: 'clear', label: 'Clear Terminal', icon: 'ban' },
    { id: 'kill', label: `Close ${tabs.find((t) => t.id === active)?.name ?? 'Terminal'}`, icon: 'trash', section: true, disabled: tabs.length === 1, hint: tabs.length === 1 ? 'the last one stays open' : undefined },
    { id: 'killall', label: 'Kill All Terminals', icon: 'trash', danger: true, hint: 'opens a fresh one' }
  ]

  return (
    <div className="term-drawer panel-pane">
      <div className="term-body">
        <div className="term-main">
          <div className="term-toolbar">
            <button className="btn btn-sm" onClick={explain} disabled={explaining} title="Explain the output / errors in plain English">
              {explaining ? 'Reading…' : <><Icon name="sparkle" size={11} /> Explain</>}
            </button>
            <span className="spacer" />
            {dockerInfo.composeFile && (
              <div className="docker-actions" title={`Found ${dockerInfo.composeFile}`}>
                <span className="muted small">Docker:</span>
                <button className="btn btn-sm" onClick={() => void compose('up')} disabled={dockerBusy}><Icon name="arrow-up" size={11} /> Up</button>
                <button className="btn btn-sm" onClick={() => void compose('down')} disabled={dockerBusy}><Icon name="stop" size={11} /> Down</button>
                <button className="btn btn-sm" onClick={() => void compose('ps')} disabled={dockerBusy}>ps</button>
              </div>
            )}
          </div>

          {explainText && (
            <div className="term-explain">
              <button className="btn btn-sm term-explain-close" onClick={() => setExplainText('')} aria-label="Close explanation">
                <Icon name="close" size={12} />
              </button>
              {explainText}
            </div>
          )}

          <div className="term-views">
            {tabs.map((t) => (
              <div key={t.id} className={`term-view ${t.id === active ? 'active' : ''}`}>
                <XtermView ptyId={t.ptyId} visible={t.id === active} onReady={(term) => void bind(t.id, term)} />
              </div>
            ))}
          </div>
        </div>

        <div className="term-side">
          <div className="term-side-actions">
            <button className="term-side-btn term-add" onClick={addTab} title="New Terminal" aria-label="New Terminal">
              <Icon name="plus" size={13} />
            </button>
            <div className="term-more-wrap">
              <button
                className="term-side-btn"
                onClick={() => setMoreOpen((v) => !v)}
                title="More terminal actions"
                aria-label="More terminal actions"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                <Icon name="ellipsis" size={13} />
              </button>
              {moreOpen && (
                <Menu
                  entries={moreEntries}
                  ariaLabel="Terminal actions"
                  onClose={() => setMoreOpen(false)}
                  onPick={(id) => {
                    setMoreOpen(false)
                    if (id === 'new') addTab()
                    else if (id === 'clear') clearActive()
                    else if (id === 'kill') closeTab(active)
                    else if (id === 'killall') killAll()
                  }}
                />
              )}
            </div>
          </div>

          <div className="term-list term-tabbar" role="tablist" aria-orientation="vertical" aria-label="Terminals">
            {tabs.map((t, i) => (
              <div
                key={t.id}
                className={`term-tab ${t.id === active ? 'active' : ''}`}
                onClick={() => setActive(t.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActive(t.id)
                    return
                  }
                  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
                  e.preventDefault()
                  const to =
                    e.key === 'Home' ? 0
                      : e.key === 'End' ? tabs.length - 1
                        : (i + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length
                  setActive(tabs[to].id)
                  // Focus follows selection here: the list IS the selection, and a terminal you
                  // arrow to but cannot type into would be a trap.
                  requestAnimationFrame(() => {
                    document.querySelector<HTMLTextAreaElement>('.term-view.active .xterm-helper-textarea')?.focus()
                  })
                }}
                role="tab"
                aria-selected={t.id === active}
                tabIndex={t.id === active ? 0 : -1}
                title={t.error ? `${t.name} — ${t.error}` : t.name}
                /* Which session this tab is attached to — 'starting' until the shell is up, 'error' if
                   it never came up. Visible state, so a stuck terminal can be diagnosed instead of guessed at. */
                data-pty={t.ptyId != null ? String(t.ptyId) : t.error ? 'error' : 'starting'}
              >
                <Icon name="terminal" size={13} className="term-tab-icon" />
                <span className="term-tab-name">{t.name}</span>
                {t.error && <span className="sr-only"> — {t.error}</span>}
                {tabs.length > 1 && (
                  <button
                    type="button"
                    className="term-tab-kill"
                    aria-label={`Close ${t.name}`}
                    title={`Close ${t.name}`}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(t.id)
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
