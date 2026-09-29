import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import { FileTree, type ExplorerHandle } from './components/FileTree'
import { FileIcon } from './components/FileIcon'
import type { EditorSelection } from './components/CodeEditor'
import { runEditorAction, focusEditor } from './editor-bridge'
import { PreviewPane } from './components/PreviewPane'
import { WelcomeScreen } from './components/WelcomeScreen'
import { EditorEmptyState } from './components/EditorEmptyState'
import { SettingsPanel, type SettingsTab } from './components/SettingsPanel'
import { ActivityBar, type SidebarView } from './components/ActivityBar'
import { ExtensionsView, type ExtItem } from './components/extensions'
import { ExtensionDetail } from './components/extensions'
import { ThemePicker } from './components/ThemePicker'
import { SidebarSection } from './components/SidebarSection'
import { applyTheme } from './theme'
import { AccountPanel } from './components/AccountPanel'
import { AgentPanel } from './components/AgentPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { fixInstruction, kindProblemCount, verifyFix, type FixVerification, type ActionKind } from '../../shared/actionplan'
import { unsavedGuard, type UnsavedGuard, type UnsavedChoice } from '../../shared/worksafety'
import {
  modeSurface,
  commandAllowed,
  describeMode,
  modeSwitchNote,
  unsavedCarryOverNote,
  normalizeMode,
  type StudioMode
} from '../../shared/mode'
import { testsClaim } from '../../shared/actionplan'
import { describeDeletion, type DeletePreview } from '../../shared/deletesafety'
import { key } from './keys'
import { GitPanel } from './components/GitPanel'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { QuickOpen } from './components/QuickOpen'
import type { EditorPrefs } from './components/SettingsPanel'
import { RemotePanel } from './components/RemotePanel'
import { Modal } from './components/Modal'
import { Icon } from './components/Icon'
import { MediaPanel } from './components/MediaPanel'
import { runPreviewControl } from './preview-control'
import { ColumnResizer } from './components/ColumnResizer'
import { PaneResizer } from './components/PaneResizer'
import { AtomicMark } from './components/AtomicMark'
import type {
  CanvasError,
  CanvasSelection,
  DevServerState,
  LogLine,
  ProjectInfo,
  ProviderInfo,
  RemoteState
} from '../../shared/types'

/**
 * Monaco is the single largest thing this renderer can load — the editor plus five language
 * workers. Loading it with the first file the user opens, rather than before the first frame,
 * is what keeps launch fast: a window that opens on the Welcome screen never pays for it at all.
 *
 * `EditorSelection` above is a *type* import, so it is erased at compile time and does not drag the
 * chunk back in; the menu's `runEditorAction`/`focusEditor` come from `editor-bridge`, which
 * deliberately imports nothing.
 */
const CodeEditor = React.lazy(() =>
  import('./components/CodeEditor').then((m) => ({ default: m.CodeEditor }))
)

/* Insight is a whole second screen — four destinations, five analysis engines' worth of view code.
   Lazy for the same reason Monaco is: it must not be in the chunk that has to arrive before the
   first editor paint. Nobody opens Insight in the first second of a session. */
const InsightView = React.lazy(() =>
  import('./components/insight').then((m) => ({ default: m.InsightView }))
)

const SSH_PREFIX = 'ssh://'

/** Tabs of the unified bottom panel (non-coder surfaces first, Terminal last). */
/** lastOpened is real data (stamped when the project is actually opened) — never inferred or faked,
 *  since it drives the "Today"/"Yesterday" captions on the Welcome screen's recent-projects list. */
export interface RecentProject {
  path: string
  name: string
  framework: string
  lastOpened?: number
}

type PanelTab = 'activity' | 'problems' | 'changes' | 'company' | 'terminal'
const PANEL_TABS: { id: PanelTab; label: string; needsProject: boolean }[] = [
  { id: 'activity', label: 'Activity', needsProject: true },
  { id: 'problems', label: 'Problems', needsProject: true },
  { id: 'changes', label: 'Changes', needsProject: true },
  { id: 'company', label: 'Workspaces', needsProject: false },
  { id: 'terminal', label: 'Terminal', needsProject: true }
]

/**
 * Palette entries that are the same command as a menu item, so both filter through the ONE curated
 * mode table in `shared/mode.ts` — the palette must not stay open as a back door into a surface the
 * menu already hides.
 */
const PALETTE_COMMAND: Record<string, string> = {
  'new-file': 'file.newFile',
  'new-folder': 'file.newFolder',
  'p-activity': 'panel.activity',
  'p-github': 'panel.github',
  'p-ws': 'panel.company',
  'p-term': 'panel.terminal',
  'p-insight': 'panel.insight',
  explorer: 'view.explorer',
  'focus-mode': 'view.focusMode'
}

interface Problem {
  id: number
  source: 'preview' | 'ai-check' | 'dev-server'
  message: string
  file?: string
}
let problemSeq = 0

const PREVIEW_TAB = '__preview__'
/**
 * The editor area with no document in it.
 *
 * Closing the last file used to snap to the Preview tab unconditionally, which is right when a
 * preview is actually RUNNING and wrong when it is not — it swapped a document for an empty
 * "Run preview" placeholder rather than for the shortcuts a person wants at that moment. This
 * sentinel is that second case; Preview remains a permanent tab one click away.
 */
const EMPTY_TAB = '__empty__'

interface OpenTab {
  path: string
  content: string
  dirty: boolean
}

export function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectInfo | null>(null)
  /* True from mount until the "reopen last project" effect resolves (see below). While it's true,
     `project` being momentarily null is a loading state, not a real no-project state — the panelTab
     effect below reads this so a returning user's actually-saved panel choice never gets silently
     swapped out during that instant. */
  const [restoringProject, setRestoringProject] = useState(() => !!localStorage.getItem('studio.lastProject'))
  const [server, setServer] = useState<DevServerState>({ status: 'idle', url: null, error: null })
  /** Read inside callbacks that must not re-create themselves every time the server state ticks. */
  const serverRef = useRef(server.status)
  serverRef.current = server.status
  const [logs, setLogs] = useState<LogLine[]>([])

  const [pickMode, setPickMode] = useState(false)
  const [selection, setSelection] = useState<CanvasSelection | null>(null)
  const [instruction, setInstruction] = useState('')
  const [editing, setEditing] = useState(false)
  const [editMsg, setEditMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [undoState, setUndoState] = useState<{ canUndo: boolean; label: string | null }>({
    canUndo: false,
    label: null
  })

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providerId, setProviderId] = useState<string>(
    () => localStorage.getItem('studio.provider') || 'atomic'
  )
  const [model, setModel] = useState<string>(() => localStorage.getItem('studio.model') || '')
  const [hasKey, setHasKey] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab | undefined>(undefined)
  const openSettings = useCallback((tab?: SettingsTab) => {
    setSettingsInitialTab(tab)
    setShowSettings(true)
  }, [])
  // Activity bar: which view the left sidebar shows (null = collapsed to just the icon rail).
  // Separate from panelTab (bottom Tools panel) and showSettings (modal) — three independent
  // surfaces. Persisted so a collapsed sidebar stays collapsed across restarts, same as the width.
  const [sidebarView, setSidebarViewState] = useState<SidebarView>(() => {
    const saved = localStorage.getItem('studio.sidebarView')
    if (saved === 'closed') return null
    return (saved as SidebarView) ?? 'explorer'
  })
  /** Bumped to ask the Source Control view to open its clone sheet (Welcome → Clone a repository). */
  const [cloneRequest, setCloneRequest] = useState(0)
  /** Imperative handle onto the Explorer: reveal, collapse all, refresh, start an inline create. */
  const explorerRef = useRef<ExplorerHandle | null>(null)
  /**
   * Git decorations for the file tree: project-relative path → porcelain letter.
   *
   * ONE `gitSnapshot` per change feeds the whole tree — never a git command per row. The Source
   * Control view keeps its own coordinator because it needs the rest of the snapshot (branch,
   * divergence, conflicts); this is the same single-process call, read for the one field the
   * Explorer shows.
   */
  const [gitDecorations, setGitDecorations] = useState<ReadonlyMap<string, string>>(() => new Map())
  const setSidebarView = useCallback((v: SidebarView | ((prev: SidebarView) => SidebarView)) => {
    setSidebarViewState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v
      localStorage.setItem('studio.sidebarView', next ?? 'closed')
      return next
    })
  }, [])
  const [keyInput, setKeyInput] = useState('')

  const [goalRunning, setGoalRunning] = useState(false)
  const [goalSteps, setGoalSteps] = useState<{ id: string; provider: string; ok: boolean }[]>([])
  const [lastEditedFile, setLastEditedFile] = useState<string | null>(null)
  const [autoFixing, setAutoFixing] = useState(false)
  const [lastError, setLastError] = useState<CanvasError | null>(null)
  const autoFixArmRef = useRef(0)
  const handledErrRef = useRef('')

  // --- Phase 7: editor tabs ---
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [activeTab, setActiveTab] = useState<string>(PREVIEW_TAB)
  const [treeRefresh, setTreeRefresh] = useState(0)

  /* --- Builder Mode / Developer Mode (ROADMAP §0 direction A) ---
     One core, two surfaces. The main process OWNS the setting (it builds the menu, and a second
     window must open in the same personality), but it is mirrored into localStorage so the very
     first paint is already the right surface instead of flashing the full IDE at a Builder user.
     `modeChosen` is false only for someone who has never picked — it drives a one-time, dismissible
     invitation, never a dialog that has to be answered before the app can be used. */
  const [mode, setModeState] = useState<StudioMode>(() => normalizeMode(localStorage.getItem('studio.mode')))
  /* Seeded from the SAME mirror, not defaulted and corrected later: flipping this after mount adds a
     bar above the editor a beat after it renders, and resizing Monaco's container mid-mount left it
     showing an empty document (an intermittent, ~50% failure in the GUI suite's editor steps). */
  const [modeChosen, setModeChosen] = useState(() => localStorage.getItem('studio.modeChosen') === 'yes')
  const surface = modeSurface(mode)
  useEffect(() => {
    void window.studio.getMode().then((m) => {
      setModeState(m.mode)
      localStorage.setItem('studio.mode', m.mode)
      setModeChosen(m.chosen)
      localStorage.setItem('studio.modeChosen', m.chosen ? 'yes' : 'no')
    })
    // Another window switching personality changes the SHARED menu bar, so this window follows it
    // rather than being left showing surfaces the menu no longer lists.
    return window.studio.onModeChanged((next) => {
      setModeState(next)
      setModeChosen(true)
      localStorage.setItem('studio.mode', next)
      localStorage.setItem('studio.modeChosen', 'yes')
    })
  }, [])

  // --- Phase 10: agent dock (the single AI surface) — open by default ---
  /* Closed on a fresh profile, opened by the Agent tab on the right edge (requested 2026-09-03:
     "when click on it it opens"). The stored preference wins in BOTH directions, so anyone who
     opens it once keeps it open. Builder Mode is unaffected — `dockAlwaysOn` makes the dock the
     product there, and it is never a toggle that can be lost. Nothing is hidden by this: a run
     that finishes while the dock is closed toasts its result, and the tab itself reports a live
     run. */
  const [showAgent, setShowAgent] = useState(() => localStorage.getItem('studio.agentOpen') === 'on')
  useEffect(() => {
    localStorage.setItem('studio.agentOpen', showAgent ? 'on' : 'off')
  }, [showAgent])

  /* --- Column widths (drag-to-resize, remembered between sessions) ---
     Both columns were fixed: at the 1024px minimum window with the sidebar and the agent dock
     open, the editor was left with ~316px and no way to claim any of it back. */
  const readWidth = (k: string, fallback: number): number => {
    const n = parseInt(localStorage.getItem(k) ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  const [leftWidth, setLeftWidth] = useState(() => readWidth('studio.leftWidth', 300))
  const [rightWidth, setRightWidth] = useState(() => readWidth('studio.rightWidth', 360))
  /* The three resizable dimensions live in CSS custom properties, not just in React state.
     A drag writes the property straight onto <html> (see `useDragResize`'s `liveVar`), so the
     browser re-lays-out one column per frame instead of React re-rendering this entire component
     ~1,470 JSX lines deep on every pointer sample. State catches up once, on release.
     useLayoutEffect, not useEffect: the property has to exist before the first paint or the columns
     would flash at zero width on launch. */
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--left-w', `${leftWidth}px`)
  }, [leftWidth])
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--right-w', `${rightWidth}px`)
  }, [rightWidth])
  /* Keep the two columns inside the window.
     Their maxima (560 + 640) plus the 48px rail and the two 7px resizers come to 1,262px, against a
     1,024px minimum window — so both columns at full width left the editor with nothing, and the
     widths are restored from localStorage, meaning a layout saved on a 2560px display reproduced it
     on every later launch at a smaller size. Nothing watched `resize` at all before this.
     Shrinks whichever column is currently wider, so a deliberately narrow sidebar is not the one
     that pays. */
  useEffect(() => {
    const RAIL = 48
    const RESIZERS = 14
    const MIN_EDITOR = 320
    /* Both setState calls stay OUTSIDE any updater: main.tsx renders under StrictMode, which invokes
       updater functions twice, so a setState nested inside one would fire twice per clamp. */
    const fit = (): void => {
      const room = window.innerWidth - RAIL - RESIZERS - MIN_EDITOR
      const over = leftWidth + rightWidth - room
      if (over <= 0) return
      // Take it from whichever column is currently wider — a deliberately narrow sidebar should not
      // be the one that pays for a shrinking window.
      if (leftWidth >= rightWidth) setLeftWidth(Math.max(200, leftWidth - over))
      else setRightWidth(Math.max(280, rightWidth - over))
    }
    window.addEventListener('resize', fit)
    fit()
    return () => window.removeEventListener('resize', fit)
  }, [leftWidth, rightWidth])

  /* Persisting is debounced because it is synchronous disk I/O. Keyboard resize (←/→ on a focused
     divider) still fires per keystroke, and holding an arrow key repeats fast enough to matter. */
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem('studio.leftWidth', String(leftWidth)), 150)
    return () => clearTimeout(t)
  }, [leftWidth])
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem('studio.rightWidth', String(rightWidth)), 150)
    return () => clearTimeout(t)
  }, [rightWidth])

  // --- Background agents: app-level visibility even with the dock closed ---
  const [agentBusy, setAgentBusy] = useState<{ running: boolean; queued: number }>({ running: false, queued: 0 })
  const showAgentRef = useRef(showAgent)
  useEffect(() => {
    showAgentRef.current = showAgent
  }, [showAgent])
  useEffect(() => {
    void window.studio.agentState().then((st) => setAgentBusy({ running: st.running, queued: st.queued }))
    return window.studio.onAgentEvent((ev) => {
      if (ev.type === 'started') setAgentBusy((b) => ({ running: true, queued: Math.max(0, b.queued - 1) }))
      else if (ev.type === 'queued') setAgentBusy((b) => ({ ...b, queued: ev.position }))
      else if (ev.type === 'done' || ev.type === 'error') {
        setAgentBusy((b) => ({ running: false, queued: b.queued }))
        // Toast the outcome ONLY when the dock is hidden — otherwise the dock shows it.
        if (!showAgentRef.current && ev.type === 'done') {
          setEditMsg({ type: 'ok', text: `Agent finished: ${ev.summary.slice(0, 120)}` })
        }
      }
    })
  }, [])

  // --- Enterprise: company-server state + managed policy ---
  const [remoteState, setRemoteState] = useState<RemoteState>({ connected: false })
  const [managed, setManaged] = useState(false)
  const [airGapped, setAirGapped] = useState(false)
  useEffect(() => {
    void window.studio.enterprisePolicy().then((p) => setManaged(p.managed))
    void window.studio.getAirGapped().then(setAirGapped)
  }, [])
  const toggleAirGap = useCallback(async () => {
    const next = await window.studio.setAirGapped(!airGapped)
    setAirGapped(next)
    void window.studio.listProviders() // provider list collapses/expands to match
  }, [airGapped])

  // --- Unified bottom panel (Activity/Changes/GitHub/Company/Terminal) ---
  /* Once you've picked a tab it stays picked — close it with × and it stays closed across restarts.
     But the very first launch, before there is any real choice to remember, defaults CLOSED: this
     panel is entirely project-scoped (Terminal, Activity, Problems, Changes all need one), and a
     first-time user with no project open has nothing here to land on. Opening onto it anyway is what
     used to redirect straight into an unauthenticated GitHub panel — see the effect below. */
  const [panelTab, setPanelTab] = useState<PanelTab | null>(() => {
    const saved = localStorage.getItem('studio.panelTab')
    // First launch (nothing saved) opens the panel — VS Code does, and GUI_CHECKLIST step 0 asserts
    // it. Only an explicit close ('closed') keeps it shut across sessions; this default drifted to
    // null at some point and the automated pass caught it. With no project open, the needs-project
    // redirect effect below immediately swaps 'activity' for a tab that works without one.
    if (saved === 'closed') return null
    return saved ? (saved as PanelTab) : 'activity'
  })
  const lastTabRef = useRef<PanelTab>('activity')
  const openPanel = useCallback((tab: PanelTab | null) => {
    if (tab) lastTabRef.current = tab
    setPanelTab(tab)
    localStorage.setItem('studio.panelTab', tab ?? 'closed')
  }, [])

  /* If the open tab needs a project and there isn't one, fall back to a tab that actually works
     (GitHub/Workspaces don't need one) rather than showing an empty box. Skipped while the last
     project is still being reopened (see `restoringProject`) — project being momentarily null there
     is a loading state, not a real "no project" state, and redirecting during it would silently swap
     a returning user's real Terminal/Activity choice for GitHub the instant before their project
     actually loads. */
  useEffect(() => {
    if (!panelTab || restoringProject) return
    const tab = PANEL_TABS.find((t) => t.id === panelTab)
    if (tab && tab.needsProject && !project) {
      const usable = PANEL_TABS.find((t) => !t.needsProject)
      if (usable) setPanelTab(usable.id)
    }
  }, [panelTab, project, restoringProject])

  /* Panel height: dragged from the divider above it, remembered, and clamped so the panel can
     never eat the editor whole or collapse to an unusable sliver. */
  const [panelHeight, setPanelHeight] = useState(() => readWidth('studio.panelHeight', 300))
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--panel-h', `${panelHeight}px`)
  }, [panelHeight])
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem('studio.panelHeight', String(panelHeight)), 150)
    return () => clearTimeout(t)
  }, [panelHeight])

  /* --- Focus Mode: hide every side surface, give the center everything ---
     Not a fourth persisted layout — a session-only overlay on top of whatever the user already
     had. Entering remembers exactly what was open so leaving restores it (a hidden sidebar stays
     hidden, a bottom tab that was open reopens on the same tab), rather than snapping back to some
     fixed default layout. */
  const [focusMode, setFocusMode] = useState(false)
  const preFocusLayout = useRef<{ sidebarView: SidebarView; showAgent: boolean; panelTab: PanelTab | null } | null>(null)
  const toggleFocusMode = useCallback(() => {
    setFocusMode((on) => {
      if (!on) {
        preFocusLayout.current = { sidebarView, showAgent, panelTab }
        setSidebarView(null)
        setShowAgent(false)
        openPanel(null)
      } else if (preFocusLayout.current) {
        const prev = preFocusLayout.current
        setSidebarView(prev.sidebarView)
        setShowAgent(prev.showAgent)
        openPanel(prev.panelTab)
      }
      return !on
    })
  }, [sidebarView, showAgent, panelTab, setSidebarView, openPanel])

  // --- Status bar: current git branch (refreshed on project + panel changes) ---
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!project) {
      setBranch(null)
      return
    }
    void window.studio.gitInfo(project.path).then((i) => {
      if (alive) setBranch(i.isRepo ? i.branch : null)
    })
    return () => {
      alive = false
    }
  }, [project, panelTab, undoState])

  // --- ⌘K inline edit ---
  const [inlineSel, setInlineSel] = useState<(EditorSelection & { path: string }) | null>(null)
  const [inlineInstruction, setInlineInstruction] = useState('')
  const [inlineBusy, setInlineBusy] = useState(false)

  // --- Editor preferences (Settings → Editor) ---
  const [editorPrefs, setEditorPrefs] = useState<EditorPrefs>(() => {
    try {
      return { fontSize: 13, wordWrap: true, minimap: false, tabSize: 2, ...JSON.parse(localStorage.getItem('studio.editorPrefs') || '{}') }
    } catch {
      return { fontSize: 13, wordWrap: true, minimap: false, tabSize: 2 }
    }
  })
  useEffect(() => {
    localStorage.setItem('studio.editorPrefs', JSON.stringify(editorPrefs))
  }, [editorPrefs])

  // --- Recent projects + New project ---
  const [recents, setRecents] = useState<RecentProject[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('studio.recent') || '[]')
    } catch {
      return []
    }
  })
  const [showNewProject, setShowNewProject] = useState(false)
  const [npName, setNpName] = useState('')
  const [npTemplate, setNpTemplate] = useState('static-html')
  const [npTemplates, setNpTemplates] = useState<{ id: string; label: string }[]>([])
  const [npBusy, setNpBusy] = useState(false)

  // --- Wave 2: Spend Meter + Security Gate + What-Changed ledger ---
  const [usage, setUsage] = useState<import('../../shared/types').Usage>({ requests: 0, estTokens: 0, byModel: {}, lastModel: null, capTokens: 0 })
  /* This polls every 4s for the life of the app. Handing setUsage a fresh object each time made an
     idle Studio re-render the entire shell 15 times a minute for no change at all. */
  const refreshUsage = useCallback(
    () =>
      void window.studio.getUsage().then((next) =>
        setUsage((prev) =>
          prev.requests === next.requests &&
          prev.estTokens === next.estTokens &&
          prev.lastModel === next.lastModel &&
          prev.capTokens === next.capTokens
            ? prev
            : next
        )
      ),
    []
  )
  useEffect(() => {
    refreshUsage()
    const t = setInterval(refreshUsage, 4000)
    return () => clearInterval(t)
  }, [refreshUsage])
  const [security, setSecurity] = useState<import('../../shared/types').SecurityReport | null>(null)
  const [securityBusy, setSecurityBusy] = useState(false)
  const runSecurityScan = useCallback(async () => {
    if (!project) return
    setSecurityBusy(true)
    setSecurity(await window.studio.securityScan(project.path))
    setSecurityBusy(false)
  }, [project])
  const [depReport, setDepReport] = useState<import('../../shared/types').DependencyReport | null>(null)
  const [depBusy, setDepBusy] = useState(false)
  const runDependencyAudit = useCallback(async () => {
    if (!project) return
    setDepBusy(true)
    setDepReport(await window.studio.dependencyAudit(project.path))
    setDepBusy(false)
  }, [project])
  const [runbookReport, setRunbookReport] = useState<import('../../shared/runbook').Runbook | null>(null)
  const [runbookBusy, setRunbookBusy] = useState(false)
  const runRunDoctor = useCallback(async () => {
    if (!project) return
    setRunbookBusy(true)
    setRunbookReport(await window.studio.runbook(project.path))
    setRunbookBusy(false)
  }, [project])
  const [design, setDesign] = useState<import('../../shared/types').DesignReview | null>(null)
  const [designBusy, setDesignBusy] = useState(false)
  const runDesignReview = useCallback(async () => {
    if (!project) return
    setDesignBusy(true)
    setDesign(await window.studio.designReview(project.path))
    setDesignBusy(false)
  }, [project])
  const exportCompliance = useCallback(async () => {
    if (!project) return
    const res = await window.studio.complianceExport(project.path)
    if (res.ok && res.path) setEditMsg({ type: 'ok', text: `Compliance report saved to ${res.path}.` })
    else if (!res.canceled) setEditMsg({ type: 'err', text: res.error ?? 'Could not export the report.' })
  }, [project])
  const [ledger, setLedger] = useState<import('../../shared/types').LedgerEntry[]>([])
  const loadLedger = useCallback(async () => {
    if (project) setLedger(await window.studio.ledgerList(project.path))
  }, [project])

  // --- Wave 5: Decisions log, Analytics-over-time, Context Packs ---
  const [decisions, setDecisions] = useState<import('../../shared/types').Decision[]>([])
  const loadDecisions = useCallback(async () => {
    if (project) setDecisions(await window.studio.listDecisions(project.path))
  }, [project])
  const [decTitle, setDecTitle] = useState('')
  const [decDetail, setDecDetail] = useState('')
  const addDecision = useCallback(async () => {
    if (!project || !decTitle.trim()) return
    await window.studio.addDecision(project.path, { title: decTitle.trim(), detail: decDetail.trim() })
    setDecTitle('')
    setDecDetail('')
    void loadDecisions()
  }, [project, decTitle, decDetail, loadDecisions])

  const [analytics, setAnalytics] = useState<import('../../shared/types').MetricSnapshot[]>([])
  const loadAnalytics = useCallback(async () => {
    if (project) setAnalytics(await window.studio.analyticsList(project.path))
  }, [project])

  const [ctxSeed, setCtxSeed] = useState('')
  const [ctxPack, setCtxPack] = useState<import('../../shared/types').ContextPack | null>(null)
  const findContext = useCallback(async () => {
    if (!project || !ctxSeed.trim()) return
    setCtxPack(await window.studio.contextPack(project.path, ctxSeed.trim()))
  }, [project, ctxSeed])

  // --- Wave 6: Architecture Drift + Team Knowledge Graph ---
  const [drift, setDrift] = useState<import('../../shared/types').DriftReport | null>(null)
  const loadDrift = useCallback(async () => {
    if (project) setDrift(await window.studio.archDrift(project.path))
  }, [project])
  const setBaseline = useCallback(async () => {
    if (!project) return
    await window.studio.saveArchBaseline(project.path)
    await loadDrift()
    setEditMsg({ type: 'ok', text: 'Architecture baseline set — future drift is measured from here.' })
  }, [project, loadDrift])
  /* --- Insight: what the HOST still owns ------------------------------------------------------
     Everything Insight loads moved into `components/insight/use-insight-data.ts` — nine loaders and
     ten derived memos, gone from this file. What is left here is the handful of actions that need
     something only the shell has: the provider (Explain), the undo stack and open buffers
     (Restore), the agent dock (Fix with AI), and the editor's active file (Generate tests). */
  const [insightOpen, setInsightOpen] = useState(false)
  const [explainText, setExplainText] = useState('')
  const [insightBusy, setInsightBusy] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const backUpNow = useCallback(async () => {
    if (!project) return
    setBackupBusy(true)
    const res = await window.studio.gitCommit(project.path, 'Backup via ATOMIC Studio')
    setBackupBusy(false)
    if (res.ok) {
      setEditMsg({ type: 'ok', text: 'Backed up — your work is saved.' })
      // The view reloads its own Overview off this token; the shell no longer holds the git state.
      setTreeRefresh((n) => n + 1)
    } else setEditMsg({ type: 'err', text: res.error ?? 'Backup failed.' })
  }, [project])
  // Get This File Back: read-only Compare vs last backup, then an inline-confirmed, undoable Restore.
  const [restoreDiff, setRestoreDiff] = useState<{ file: string; inBackup: boolean; lines: import('../../shared/types').DiffLine[] } | null>(null)
  const [restoreArmed, setRestoreArmed] = useState(false)
  const compareToBackup = useCallback(
    async (file: string) => {
      if (!project) return
      setRestoreArmed(false)
      const res = await window.studio.gitCompareHead(project.path, file)
      setRestoreDiff({ file, inBackup: res.inBackup, lines: res.lines })
    },
    [project]
  )
  const explainProject = useCallback(async () => {
    if (!project) return
    setInsightBusy(true)
    const res = await window.studio.explainProject(project.path, providerId, model.trim() || undefined)
    setInsightBusy(false)
    if (res.ok && res.text) setExplainText(res.text)
    else setEditMsg({ type: 'err', text: res.error ?? 'Could not explain the project.' })
  }, [project, providerId, model])

  // "Fix with AI": open the agent dock and seed a targeted instruction — the user still hits Send.
  const [agentSeed, setAgentSeed] = useState<{ text: string; nonce: number } | null>(null)
  // Fix-Verify: snapshot the before-count on Fix-with-AI, then re-check ONLY that kind after Apply.
  const [pendingVerify, setPendingVerify] = useState<{ kind: ActionKind; before: number } | null>(null)
  const [verifyResult, setVerifyResult] = useState<FixVerification | null>(null)
  /* The signals arrive WITH the item. They used to be five pieces of shell state; Insight owns its
     own data now, so it hands over the exact snapshot the instruction and the before-count were
     computed from — which also means the two can never disagree with what the user is looking at. */
  const onFixWithAi = useCallback(
    (item: import('../../shared/actionplan').ActionItem, signals: import('../../shared/actionplan').ActionSignals) => {
      setShowAgent(true)
      setAgentSeed({ text: fixInstruction(item, signals), nonce: Date.now() })
      setPendingVerify({ kind: item.kind, before: kindProblemCount(item.kind, signals) })
      setVerifyResult(null)
    },
    []
  )
  const verifyAfterApply = useCallback(async () => {
    if (!pendingVerify || !project) return
    const { kind, before } = pendingVerify
    let after = before
    let partial = false
    // Re-run ONLY the fixed kind's scan (one kind → one scan) for a fresh after-count.
    /* One kind → one scan, for the after-count ONLY. These used to also write the shell's copy of
       each report; Insight owns those now and marks its own results stale off the change token, so
       writing them from here would be a second source of truth for the same numbers. */
    if (kind === 'security') {
      after = (await window.studio.securityScan(project.path)).findings.length
    } else if (kind === 'design') {
      const r = await window.studio.designReview(project.path)
      after = r.hardcodedColors + r.nearDuplicates.length
    } else if (kind === 'debt' || kind === 'tests') {
      const r = await window.studio.projectInsight(project.path)
      after = kind === 'tests' ? (testsClaim(r) === 'no' ? 1 : 0) : r.debt.filter((d) => d.kind !== 'untested').length
      partial = r.coverage.capped
    } else if (kind === 'drift') {
      const r = await window.studio.archDrift(project.path)
      after = r.hasBaseline ? r.modules.removed.length + r.edges.removed.length + r.externalDeps.removed.length : before
    } else if (kind === 'deps') {
      after = (await window.studio.dependencyAudit(project.path)).findings.length // ALL dep findings — matches kindProblemCount('deps')
    }
    setVerifyResult(verifyFix(kind, before, after, partial))
    setPendingVerify(null) // one verdict per fix — a later unrelated apply must not re-trigger it
  }, [pendingVerify, project])
  useEffect(() => {
    setPendingVerify(null)
    setVerifyResult(null)
  }, [project])
  // "Generate tests": scaffold a deterministic test for the file currently open in the editor.
  const [genTestMsg, setGenTestMsg] = useState<string | null>(null)
  const onGenerateTests = useCallback(async () => {
    if (!project) return
    const src = activeTab !== PREVIEW_TAB && !activeTab.startsWith(SSH_PREFIX) ? activeTab : ''
    if (!/\.(jsx?|tsx?|mjs|cjs)$/i.test(src)) {
      setGenTestMsg('Open a source file (e.g. src/App.tsx) in the editor first, then click Generate tests.')
      return
    }
    const res = await window.studio.generateTests(project.path, src)
    if (res.ok && res.path) {
      setGenTestMsg(`Created ${res.path} — open it and fill in the TODOs (Undo removes it).`)
      setTreeRefresh((n) => n + 1)
      void window.studio.getUndoState().then(setUndoState) // enable the top-bar Undo
    } else {
      setGenTestMsg(res.error ?? 'Could not generate a test.')
    }
  }, [project, activeTab])

  /**
   * The theme, painted before anything else the user can see.
   *
   * The main process owns which theme is on (a second window and the native window background have
   * to agree with it), so the renderer asks once at mount and then follows the push channel. There
   * is no local copy to drift: `applyTheme` writes straight onto <html>.
   */
  useEffect(() => {
    void window.studio.themeGet().then(applyTheme)
    return window.studio.onThemeChanged(applyTheme)
  }, [])

  // --- Problems panel + Search Everywhere + extension toggles ---
  const [problems, setProblems] = useState<Problem[]>([])
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [autoFixOn, setAutoFixOn] = useState(() => localStorage.getItem('studio.ext.autofix') !== 'off')
  useEffect(() => {
    localStorage.setItem('studio.ext.autofix', autoFixOn ? 'on' : 'off')
  }, [autoFixOn])
  const addProblem = useCallback((source: Problem['source'], message: string, file?: string) => {
    setProblems((prev) => [{ id: ++problemSeq, source, message: message.slice(0, 400), file }, ...prev].slice(0, 50))
  }, [])

  // --- Command palette + explorer inline create ---
  const [showPalette, setShowPalette] = useState(false)
  const [showThemePicker, setShowThemePicker] = useState(false)
  /** The Explorer's folder section, collapsible the way every VS Code side view's sections are. */
  const [treeOpen, setTreeOpen] = useState(true)
  /** The extension whose detail page the editor area is showing — VS Code's own placement for it. */
  const [extDetail, setExtDetail] = useState<ExtItem | null>(null)
  const [armedTreeDelete, setArmedTreeDelete] = useState<string | null>(null)
  // Wave 21: what the armed delete would actually destroy, in plain English (null = nothing armed).
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null)
  // The facts behind the armed delete, kept so the post-delete message uses the SAME truth the confirm
  // used. Deriving "was it a file?" by regex-matching the headline silently always said yes.
  const [deleteFacts, setDeleteFacts] = useState<{ relPath: string; restorable: boolean; trashName: string } | null>(null)
  // Arming is async (a disk walk + git). Without a token, a SLOW preview for one file could land after
  // the user armed a different one and describe the wrong thing above a live delete button.
  const armSeqRef = useRef(0)
  // saveTab is declared below closeTab; a ref keeps the seatbelt's Save branch out of the dependency knot.
  const saveTabRef = useRef<((path: string) => Promise<boolean>) | null>(null)
  // Live view of the tabs for guards that resolve LATER (a dialog the user leaves open while typing).
  const tabsRef = useRef<OpenTab[]>([])
  // Live view of refreshOpenFile for the mount-once fs-watcher listener below — refreshOpenFile's own
  // identity changes on every keystroke (it depends on `tabs`), so a stale closure would silently stop
  // reacting to external file changes after the first edit.
  const refreshOpenFileRef = useRef<((relPath?: string | null, actor?: 'ai' | 'disk') => Promise<void>) | null>(null)
  // Wave 21: an action being held back because it would throw away unsaved typing.
  // A QUEUE, not one slot: a multi-file AI apply raises several conflicts, and a single slot let the
  // second prompt overwrite the first — whose buffer was then dropped with nobody ever answering for it.
  const [unsavedQueue, setUnsavedQueue] = useState<{ guard: UnsavedGuard; act: (c: UnsavedChoice) => void }[]>([])
  const pendingUnsaved = unsavedQueue[0] ?? null
  const setPendingUnsaved = useCallback(
    (item: { guard: UnsavedGuard; act: (c: UnsavedChoice) => void } | null) =>
      setUnsavedQueue((prev) => (item ? [...prev, item] : prev.slice(1))),
    []
  )

  // --- Tab autocomplete (ghost text) ---
  const [autocompleteOn, setAutocompleteOn] = useState<boolean>(
    () => localStorage.getItem('studio.autocomplete') !== 'off'
  )
  useEffect(() => {
    localStorage.setItem('studio.autocomplete', autocompleteOn ? 'on' : 'off')
  }, [autocompleteOn])
  useEffect(() => {
    // Config the (once-registered) Monaco inline-completion provider reads per call.
    ;(window as unknown as Record<string, unknown>).__studioAutocomplete = {
      enabled: autocompleteOn,
      provider: providerId,
      model: model.trim() || undefined,
      path: activeTab === PREVIEW_TAB ? undefined : activeTab
    }
  }, [autocompleteOn, providerId, model, activeTab])

  const previewPreloadUrl = window.studioPreviewPreloadUrl
  const provider = providers.find((p) => p.id === providerId)
  const serverBusy = server.status === 'running' || server.status === 'starting'

  /* Keep the menu honest: its labels flip ("Run/Stop Preview", "Show/Hide Panel") and several
     items only make sense with a project open, and a menu is static once built — so push the
     state it renders whenever that state changes. */
  useEffect(() => {
    serverBusyRef.current = serverBusy
    void window.studio.menuState({
      hasProject: !!project,
      previewRunning: serverBusy,
      panelOpen: !!panelTab,
      agentOpen: showAgent
    })
  }, [project, serverBusy, panelTab, showAgent])

  useEffect(() => {
    const offState = window.studio.onDevServerState(setServer)
    const offLog = window.studio.onLog((line) => setLogs((prev) => [...prev.slice(-200), line]))
    // Live filesystem watching (Wave 23): a change made OUTSIDE the app (Finder, a terminal command,
    // `npm install`, another editor) used to be invisible until something the app itself did happened
    // to bump treeRefresh. Now any external change refreshes the tree, and any AFFECTED open tab either
    // silently reloads (clean) or goes through the existing unsaved-work seatbelt (dirty) — the exact
    // same path Undo/Restore already use, just triggered by a new source.
    const offFs = window.studio.onFsChanged((paths) => {
      setTreeRefresh((n) => n + 1)
      const bare = paths.length === 1 && paths[0] === '' // platform omitted the filename — no target info
      if (bare) return
      for (const p of paths) {
        if (tabsRef.current.some((t) => t.path === p)) void refreshOpenFileRef.current?.(p, 'disk')
      }
    })
    window.studio.getDevServerState().then(setServer)
    window.studio.getUndoState().then(setUndoState)
    window.studio.listProviders().then(setProviders)
    return () => {
      offState()
      offLog()
      offFs()
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('studio.provider', providerId)
    const p = providers.find((x) => x.id === providerId)
    if (p && !p.needsKey) {
      setHasKey(true)
      return
    }
    /* Deliberately does NOT open Settings. A missing key used to force the dialog open, and the
       backdrop covers the entire window — including "Open project…" — so the very first thing a new
       user met was a form they could not get past to reach their own code, on a provider that is
       free and needs no key to begin with.
       The state is still surfaced, twice, without blocking anything: the agent dock's attention
       strip says "No API key set for …", and the moment the user actually asks for AI and it fails
       for a missing key, the handler below opens Settings — which is the point at which a key form
       is an answer rather than an obstacle. */
    void window.studio.hasApiKey(providerId).then(setHasKey)
  }, [providerId, providers])

  useEffect(() => {
    localStorage.setItem('studio.model', model)
  }, [model])

  // --- editor tab helpers ---
  const openFile = useCallback(
    async (relPath: string) => {
      if (!project) return
      if (tabs.some((t) => t.path === relPath)) {
        setActiveTab(relPath)
        return
      }
      const res = await window.studio.readFile(project.path, relPath)
      if (!res.ok) {
        const why =
          res.error === 'binary'
            ? 'This is an image or binary file — open it in the preview instead.'
            : res.error === 'too-large'
              ? 'This file is too large to open in the editor.'
              : res.error ?? 'Could not open file.'
        setEditMsg({ type: 'err', text: why })
        return
      }
      setTabs((prev) => [...prev, { path: relPath, content: res.content ?? '', dirty: false }])
      setActiveTab(relPath)
    },
    [project, tabs]
  )

  const dropTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== path)
        if (activeTab === path) {
          // Another document to fall back to → show it. None left → the live preview if there IS
          // one, else the empty editor state.
          setActiveTab(next.length ? next[next.length - 1].path : serverRef.current === 'running' ? PREVIEW_TAB : EMPTY_TAB)
        }
        return next
      })
    },
    [activeTab]
  )

  /**
   * Wave 21 seatbelt: closing a tab with unsaved typing used to throw it away instantly. Nothing can
   * recover it — the undo stack only snapshots inside writeFile, so text that never reached disk has no
   * history. A CLEAN tab still closes in exactly one click (unsavedGuard returns block:false).
   */
  const closeTab = useCallback(
    (path: string) => {
      const guard = unsavedGuard({
        reason: 'close-tab',
        dirtyPaths: tabs.filter((t) => t.dirty).map((t) => t.path),
        targetPath: path,
        isRemote: path.startsWith(SSH_PREFIX)
      })
      if (!guard.block) {
        dropTab(path)
        return
      }
      setPendingUnsaved({
        guard,
        act: (c) => {
          if (c === 'cancel') return
          if (c === 'save') {
            // Only close once the content is genuinely on disk. A failed save leaves the tab open and
            // still dirty — closing it here would destroy exactly what the seatbelt is protecting.
            void saveTabRef.current?.(path).then((ok) => {
              if (ok) dropTab(path)
            })
          } else dropTab(path)
        }
      })
    },
    [tabs, dropTab]
  )

  const changeTab = useCallback((path: string, value: string) => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, content: value, dirty: true } : t)))
  }, [])

  /** Returns TRUE only when the content actually reached disk (or the server). The seatbelt's
   *  "Save first" branch MUST gate on this: dropping the tab after a failed save would destroy the very
   *  typing the seatbelt exists to protect. */
  const saveTab = useCallback(
    async (path: string): Promise<boolean> => {
      const tab = tabs.find((t) => t.path === path)
      if (!tab) return false
      // Company-server tabs save straight back over SSH — never to local disk.
      if (path.startsWith(SSH_PREFIX)) {
        const res = await window.studio.remoteWrite(path.slice(SSH_PREFIX.length), tab.content)
        if (res.ok) {
          setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, dirty: false } : t)))
          setEditMsg({ type: 'ok', text: `Saved to the company server.` })
        } else {
          setEditMsg({ type: 'err', text: res.error ?? 'Server save failed.' })
        }
        return res.ok
      }
      if (!project) return false
      const res = await window.studio.writeFile(project.path, path, tab.content)
      if (res.ok) {
        setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, dirty: false } : t)))
        setUndoState(await window.studio.getUndoState())
        setEditMsg({ type: 'ok', text: `Saved ${path}. The preview updates live.` })
        // Keep the Insight tab (Tech-Debt Radar + Live Architecture Map) honest:
        // a save changes symbols/imports, so re-read the index-derived views.
        setTreeRefresh((n) => n + 1)
      } else {
        setEditMsg({ type: 'err', text: res.error ?? 'Save failed.' })
      }
      return res.ok
    },
    [project, tabs]
  )
  saveTabRef.current = saveTab
  tabsRef.current = tabs
  const activeTabRef = useRef(activeTab)
  activeTabRef.current = activeTab

  /** Re-read a file from disk into its open tab (after an AI edit/undo changed it). */
  const refreshOpenFile = useCallback(
    async (relPath?: string | null, actor: 'ai' | 'disk' = 'ai') => {
      if (!project || !relPath) return
      if (!tabs.some((t) => t.path === relPath)) return
      // Wave 21 seatbelt: reloading from disk REPLACES the editor buffer. If you were typing in this
      // exact file, that typing is destroyed with no trace (it never reached disk, so no snapshot
      // exists). Ask instead of overwriting. A clean tab reloads silently, exactly as before.
      const guard = unsavedGuard({
        reason: actor === 'ai' ? 'ai-changed-file' : 'disk-changed-file',
        dirtyPaths: tabsRef.current.filter((t) => t.dirty).map((t) => t.path),
        targetPath: relPath
      })
      const load = async (): Promise<void> => {
        const res = await window.studio.readFile(project.path, relPath)
        if (res.ok) {
          setTabs((prev) =>
            prev.map((t) => (t.path === relPath ? { ...t, content: res.content ?? '', dirty: false } : t))
          )
        }
      }
      if (!guard.block) {
        await load()
        return
      }
      setPendingUnsaved({
        guard,
        act: (c) => {
          if (c === 'take-theirs') void load()
          // keep-mine: leave the buffer alone AND leave it dirty, so the tab dot still warns that the
          // version on disk is different — a later ⌘S deliberately overwrites the AI's version.
        }
      })
    },
    [project, tabs]
  )
  refreshOpenFileRef.current = refreshOpenFile
  const restoreToBackup = useCallback(
    async (file: string) => {
      if (!project) return
      const res = await window.studio.gitRestoreFile(project.path, file)
      setRestoreArmed(false)
      if (res.ok) {
        setEditMsg({ type: 'ok', text: `Restored ${file} to its last backup — use Undo to reverse it.` })
        setRestoreDiff(null)
        void refreshOpenFile(file, 'disk')
        setTreeRefresh((n) => n + 1)
      } else setEditMsg({ type: 'err', text: res.error ?? 'Restore failed.' })
    },
    [project, refreshOpenFile]
  )

  const resetForProject = useCallback((info: ProjectInfo) => {
    setRecents((prev) => {
      const next = [
        { path: info.path, name: info.name, framework: info.framework, lastOpened: Date.now() },
        ...prev.filter((r) => r.path !== info.path)
      ].slice(0, 8)
      localStorage.setItem('studio.recent', JSON.stringify(next))
      return next
    })
    setProject(info)
    setServer({ status: 'idle', url: null, error: null })
    setLogs([])
    setSelection(null)
    setPickMode(false)
    setTabs([])
    setActiveTab(PREVIEW_TAB)
    // Nothing from the old project may stay armed — "src/index.ts" means a different file here now.
    setArmedTreeDelete(null)
    setDeletePreview(null)
    setDeleteFacts(null)
    setUnsavedQueue([])
    armSeqRef.current++
    setTreeRefresh((n) => n + 1)
  }, [])

  /**
   * Wave 21 seatbelt: switching projects calls setTabs([]) — every unsaved buffer vanishes at once,
   * unrecoverably. Hold the switch until the user chooses. No dirty tabs ⇒ no interruption at all.
   */
  // Wave 21: closing the WINDOW (⌘W / ⌘Q / the red button) bypassed every in-app guard and dropped all
  // unsaved buffers instantly. beforeunload is the only hook that can stop a native window close; main
  // turns the resulting 'will-prevent-unload' into a real Save/Discard/Cancel choice.
  const dirtyCount = tabs.filter((t) => t.dirty).length
  useEffect(() => {
    if (!dirtyCount) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirtyCount])

  const guardProjectSwitch = useCallback(
    (proceed: () => void) => {
      const dirtyPaths = tabsRef.current.filter((t) => t.dirty).map((t) => t.path)
      const guard = unsavedGuard({ reason: 'switch-project', dirtyPaths })
      if (!guard.block) {
        proceed()
        return
      }
      setPendingUnsaved({
        guard,
        act: (c) => {
          if (c === 'cancel') return
          if (c === 'save') {
            // Re-read the dirty list NOW: the user may have kept typing while the dialog was up, and
            // saving the snapshot taken when it opened would silently drop those newer edits.
            const latest = tabsRef.current.filter((t) => t.dirty).map((t) => t.path)
            // EVERY file must be safely saved before we wipe the tab list — one failure and we stay put.
            void Promise.all(latest.map((p) => saveTabRef.current?.(p))).then((results) => {
              if (results.every(Boolean)) proceed()
              else setEditMsg({ type: 'err', text: 'Some files could not be saved, so the project was not switched. Your work is still open.' })
            })
          } else proceed()
        }
      })
    },
    []
  )

  const openProject = useCallback(async () => {
    // openProject only PICKS the folder now; openProjectAt commits it. So "Cancel" in the unsaved-work
    // guard genuinely leaves the current project running instead of half-switching it.
    const picked = await window.studio.openProject()
    if (!picked) return
    guardProjectSwitch(() => {
      void window.studio.openProjectAt(picked.path).then((info) => info && resetForProject(info))
    })
  }, [resetForProject, guardProjectSwitch])

  /** Open a folder directly (used right after cloning a GitHub repo). */
  const openProjectAtPath = useCallback(
    async (path: string) => {
      // Guard FIRST: openProjectAt is the COMMITTING handler (it stops the dev server and repoints
      // main's project), so calling it before the question left the app half-switched on Cancel.
      guardProjectSwitch(() => {
        void window.studio.openProjectAt(path).then((info) => info && resetForProject(info))
      })
    },
    [resetForProject, guardProjectSwitch]
  )

  /* Reopen whatever was open last time.
     Studio remembered your recent projects but always launched into an empty window, so the first
     action of every single session was re-opening the thing you were already working on — and with
     no project, Insight, memory and the terminal are all unreachable. Runs once, and stays quiet if
     the folder has since been moved or deleted: a missing folder drops you on the welcome screen,
     which is the honest outcome, and the stored path is cleared so it cannot nag every launch. */
  const restoredRef = useRef(false)
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const last = localStorage.getItem('studio.lastProject')
    if (!last) {
      setRestoringProject(false)
      return
    }
    void window.studio.openProjectAt(last).then((info) => {
      if (info) resetForProject(info)
      else localStorage.removeItem('studio.lastProject')
      setRestoringProject(false)
    })
  }, [resetForProject])

  useEffect(() => {
    if (project) localStorage.setItem('studio.lastProject', project.path)
  }, [project])

  const start = useCallback(() => {
    if (project) {
      window.studio.startDevServer(project.path)
      setActiveTab(PREVIEW_TAB)
    }
  }, [project])
  const stop = useCallback(() => window.studio.stopDevServer(), [])

  const onSelect = useCallback((sel: CanvasSelection) => {
    setSelection(sel)
    setPickMode(false)
    setEditMsg(null)
    setShowAgent(true) // the right dock is the single AI surface
  }, [])

  // Preview errors surface in the right dock too (with the Fix button).
  useEffect(() => {
    if (lastError && !autoFixing) setShowAgent(true)
  }, [lastError, autoFixing])

  // Toasts: successes fade after 5s; errors persist until dismissed.
  useEffect(() => {
    if (!editMsg || editMsg.type !== 'ok') return
    const t = setTimeout(() => setEditMsg((cur) => (cur === editMsg ? null : cur)), 5000)
    return () => clearTimeout(t)
  }, [editMsg])

  const applyEdit = useCallback(async () => {
    if (!project || !selection || !instruction.trim()) return
    setEditing(true)
    setEditMsg(null)
    const res = await window.studio.applyEdit({
      projectPath: project.path,
      file: selection.file,
      line: selection.line,
      elementName: selection.name,
      instruction: instruction.trim(),
      provider: providerId,
      model: model.trim() || undefined
    })
    setEditing(false)
    if (res.ok) {
      setEditMsg({ type: 'ok', text: `Applied to ${res.file}. The preview updates live.` })
      setInstruction('')
      setLastEditedFile(res.file ?? selection.file)
      setLastError(null)
      handledErrRef.current = ''
      autoFixArmRef.current = Date.now() + 9000
      void refreshOpenFile(res.file ?? selection.file)
    } else {
      setEditMsg({ type: 'err', text: res.error ?? 'Edit failed.' })
      if ((res.error ?? '').includes('API key')) setShowSettings(true)
    }
    setUndoState(await window.studio.getUndoState())
  }, [project, selection, instruction, providerId, model, refreshOpenFile])

  const runGoal = useCallback(async () => {
    if (!project || !selection || !instruction.trim()) return
    setGoalRunning(true)
    setGoalSteps([])
    setEditMsg({ type: 'ok', text: 'Running 2-model goal (draft → finalize)…' })
    const res = await window.studio.runEditGoal({
      projectPath: project.path,
      file: selection.file,
      elementName: selection.name,
      instruction: instruction.trim()
    })
    setGoalRunning(false)
    setGoalSteps(res.steps.map((s) => ({ id: s.id, provider: s.provider, ok: s.ok })))
    if (res.ok) {
      setEditMsg({ type: 'ok', text: `Goal applied to ${res.file} using ${res.steps.length} models.` })
      setInstruction('')
      setLastEditedFile(res.file ?? selection.file)
      handledErrRef.current = ''
      autoFixArmRef.current = Date.now() + 9000
      void refreshOpenFile(res.file ?? selection.file)
    } else {
      setEditMsg({ type: 'err', text: res.error ?? 'Goal failed.' })
      if ((res.error ?? '').includes('API key')) setShowSettings(true)
    }
    setUndoState(await window.studio.getUndoState())
  }, [project, selection, instruction, refreshOpenFile])

  const runAutoFix = useCallback(
    async (errorText: string, file: string) => {
      if (!project) return
      setAutoFixing(true)
      setEditMsg({ type: 'ok', text: 'Error detected — auto-fixing…' })
      const res = await window.studio.autoFix({
        projectPath: project.path,
        file,
        errorText,
        provider: providerId,
        model: model.trim() || undefined
      })
      setAutoFixing(false)
      if (res.ok) {
        setLastError(null)
        setEditMsg({ type: 'ok', text: `Auto-fixed ${res.file}. If it still looks off, press Undo.` })
        void refreshOpenFile(res.file ?? file)
      } else {
        setEditMsg({ type: 'err', text: `Auto-fix failed: ${res.error ?? ''} — you can Undo.` })
      }
      setUndoState(await window.studio.getUndoState())
    },
    [project, providerId, model, refreshOpenFile]
  )

  const onPreviewError = useCallback(
    (err: CanvasError) => {
      setLastError(err)
      addProblem('preview', err.message, lastEditedFile ?? selection?.file)
      const file = lastEditedFile ?? selection?.file
      const sig = err.message.slice(0, 200)
      if (autoFixOn && file && !autoFixing && Date.now() < autoFixArmRef.current && handledErrRef.current !== sig) {
        handledErrRef.current = sig
        void runAutoFix(err.message + (err.stack ? '\n' + err.stack : ''), file)
      }
    },
    [lastEditedFile, selection, autoFixing, runAutoFix, autoFixOn, addProblem]
  )

  useEffect(() => {
    if (server.status === 'error' && server.error) addProblem('dev-server', server.error)
  }, [server.status, server.error, addProblem])

  /** Open a file and (best-effort) jump to a line — Search Everywhere landing. */
  const openFileAtLine = useCallback(
    (rel: string, line?: number) => {
      void openFile(rel).then(() => {
        if (line) {
          setTimeout(() => {
            const ed = (window as unknown as { __studioEditor?: { revealLineInCenter: (l: number) => void; setPosition: (p: { lineNumber: number; column: number }) => void } }).__studioEditor
            ed?.revealLineInCenter(line)
            ed?.setPosition({ lineNumber: line, column: 1 })
          }, 350)
        }
      })
    },
    [openFile]
  )

  const undo = useCallback(async () => {
    const res = await window.studio.undoEdit()
    setUndoState(await window.studio.getUndoState())
    setEditMsg({ type: 'ok', text: 'Reverted the last change.' })
    // undoEdit returns an ABSOLUTE path; the tab list is keyed on project-relative paths.
    const rel = res.file && project && res.file.startsWith(project.path) ? res.file.slice(project.path.length + 1) : res.file
    void refreshOpenFile(rel, 'disk')
  }, [refreshOpenFile])

  /** ⌘K flow: prompt → model rewrites the selection → splice into the tab as an
   * UNSAVED change (review, ⌘S to keep — Monaco undo or close-without-save to drop). */
  const runInlineEdit = useCallback(async () => {
    if (!project || !inlineSel || !inlineInstruction.trim()) return
    const tab = tabs.find((t) => t.path === inlineSel.path)
    if (!tab) return
    setInlineBusy(true)
    const res = await window.studio.inlineEdit({
      projectPath: project.path,
      file: inlineSel.path,
      fileContent: tab.content,
      startLine: inlineSel.startLine,
      endLine: inlineSel.endLine,
      selectedText: inlineSel.text,
      instruction: inlineInstruction.trim(),
      provider: providerId,
      model: model.trim() || undefined
    })
    setInlineBusy(false)
    if (!res.ok || res.replacement === undefined) {
      setEditMsg({ type: 'err', text: res.error ?? 'Inline edit failed.' })
      if ((res.error ?? '').includes('API key')) setShowSettings(true)
      return
    }
    const lines = tab.content.split('\n')
    lines.splice(inlineSel.startLine - 1, inlineSel.endLine - inlineSel.startLine + 1, ...res.replacement.split('\n'))
    changeTab(inlineSel.path, lines.join('\n'))
    setInlineSel(null)
    setInlineInstruction('')
    setEditMsg({ type: 'ok', text: `Rewrote the selection — review it, then ${key('S')} to keep (or close without saving to drop).` })
  }, [project, inlineSel, inlineInstruction, tabs, providerId, model, changeTab])

  /** Open a company-server file as an ssh:// editor tab (content stays remote). */
  const openRemoteFile = useCallback(
    async (absPath: string) => {
      const tabPath = SSH_PREFIX + absPath
      if (tabs.some((t) => t.path === tabPath)) {
        setActiveTab(tabPath)
        return
      }
      const res = await window.studio.remoteRead(absPath)
      if (!res.ok) {
        setEditMsg({ type: 'err', text: res.error ?? 'Could not open the server file.' })
        return
      }
      setTabs((prev) => [...prev, { path: tabPath, content: res.content ?? '', dirty: false }])
      setActiveTab(tabPath)
    },
    [tabs]
  )

  /** Company policy: block copy/cut of protected server code (and log it). */
  useEffect(() => {
    const onCopy = (e: ClipboardEvent): void => {
      if (
        activeTab.startsWith(SSH_PREFIX) &&
        remoteState.connected &&
        remoteState.policy &&
        !remoteState.policy.allowExport
      ) {
        e.preventDefault()
        void window.studio.auditEvent('copy-blocked', activeTab.slice(SSH_PREFIX.length))
        setEditMsg({ type: 'err', text: 'Copying server code out of Studio is disabled by your company policy. This attempt was logged.' })
      }
    }
    document.addEventListener('copy', onCopy, true)
    document.addEventListener('cut', onCopy, true)
    return () => {
      document.removeEventListener('copy', onCopy, true)
      document.removeEventListener('cut', onCopy, true)
    }
  }, [activeTab, remoteState])

  /** Create a fresh project from a starter template, then open it. */
  const createNewProject = useCallback(async () => {
    const parent = await window.studio.pickFolder()
    if (!parent) return
    setNpBusy(true)
    setEditMsg({ type: 'ok', text: 'Creating your project…' })
    const res = await window.studio.createProject(parent, npName.trim() || 'my-app', npTemplate)
    setNpBusy(false)
    if (!res.ok && !res.path) {
      setEditMsg({ type: 'err', text: res.error ?? 'Could not create the project.' })
      return
    }
    if (!res.ok && res.path) setEditMsg({ type: 'err', text: res.error ?? '' })
    setShowNewProject(false)
    setNpName('')
    if (res.path) await openProjectAtPath(res.path)
  }, [npName, npTemplate, openProjectAtPath])

  useEffect(() => {
    if (showNewProject && npTemplates.length === 0) void window.studio.listProjectTemplates().then(setNpTemplates)
  }, [showNewProject, npTemplates.length])

  /** Explorer: create a file/folder at the typed (possibly nested) path. */
  /**
   * Create from the Explorer's inline row. Returns whether it landed, so the row can stay in edit
   * with the typed name intact when it did not — retyping a path because a name collided is the
   * kind of small cruelty an inline editor exists to avoid.
   */
  const createInTree = useCallback(
    async (rel: string, kind: 'file' | 'dir'): Promise<boolean> => {
      if (!project) return false
      const clean = rel.trim().replace(/^\/+/, '')
      if (!clean) return false
      const res = kind === 'file' ? await window.studio.createFile(project.path, clean) : await window.studio.createDir(project.path, clean)
      if (!res.ok) {
        setEditMsg({ type: 'err', text: res.error ?? 'Could not create it.' })
        return false
      }
      setTreeRefresh((n) => n + 1)
      if (kind === 'file') void openFile(clean)
      return true
    },
    [project, openFile]
  )

  /**
   * Rename from the Explorer's inline row. The new name is a LEAF, not a path: an inline rename
   * edits the name in place, and letting a `/` through would silently move the file somewhere the
   * row never showed.
   */
  const renameInTree = useCallback(
    async (rel: string, nextName: string): Promise<boolean> => {
      if (!project) return false
      const leaf = nextName.trim()
      if (!leaf || leaf.includes('/') || leaf.includes('\\') || leaf === '.' || leaf === '..') {
        setEditMsg({ type: 'err', text: 'A name cannot contain a slash.' })
        return false
      }
      const cut = rel.lastIndexOf('/')
      const next = cut < 0 ? leaf : `${rel.slice(0, cut)}/${leaf}`
      const res = await window.studio.renamePath(project.path, rel, next)
      if (!res.ok) {
        setEditMsg({ type: 'err', text: res.error ?? 'Could not rename it.' })
        return false
      }
      setTreeRefresh((n) => n + 1)
      // An open tab for the old path is now pointing at a file that no longer exists.
      if (tabsRef.current.some((t) => t.path === rel)) {
        setTabs((prev) => prev.map((t) => (t.path === rel ? { ...t, path: next } : t)))
        setActiveTab((a) => (a === rel ? next : a))
      }
      return true
    },
    [project]
  )

  /**
   * The destructive half of the explorer delete, split out so the unsaved-work guard can call it after
   * the user answers WITHOUT re-entering deleteEntry (which would re-ask about the same dirty tab
   * forever on "Discard").
   */
  const performTrash = useCallback(
    async (relPath: string) => {
      if (!project) return
      const prefix = relPath.replace(/\/+$/, '') + '/'
      setArmedTreeDelete(null)
      const restorable = deleteFacts?.relPath === relPath ? deleteFacts.restorable : false
      setDeletePreview(null)
      setDeleteFacts(null)
      const res = await window.studio.trashPath(project.path, relPath)
      if (!res.ok) {
        // Trash unavailable (network share / odd volume). NEVER fall through to a permanent delete —
        // say so and let the user decide again.
        setEditMsg({ type: 'err', text: `${res.error ?? 'Delete failed.'} Nothing was deleted.` })
        return
      }
      // Close the deleted file's tab AND any tab inside a deleted folder — leaving them open would point
      // the editor at something that no longer exists.
      setTabs((prev) => prev.filter((t) => t.path !== relPath && !t.path.startsWith(prefix)))
      setActiveTab((cur) => (cur === relPath || cur.startsWith(prefix) ? PREVIEW_TAB : cur))
      setTreeRefresh((n) => n + 1)
      void window.studio.getUndoState().then(setUndoState).catch(() => {})
      if (!res.trashed) {
        // ok but nothing moved — the path was already gone. Claiming a bin copy exists would be false.
        setEditMsg({ type: 'ok', text: `${relPath} was already gone — nothing was deleted.` })
        return
      }
      const bin = deleteFacts?.trashName || 'Trash'
      setEditMsg({
        type: 'ok',
        text: res.restoredFiles
          ? `Moved ${relPath} to the ${bin} — Undo puts all ${res.restoredFiles} files back.`
          : restorable
            ? `Moved ${relPath} to the ${bin} — Undo brings it back.`
            : `Moved ${relPath} to the ${bin} — restore it from there.`
      })
    },
    [project, deleteFacts]
  )

  /**
   * Explorer delete (Wave 21 "Put It Back"): the first × now COUNTS what would go and asks with real
   * numbers; the second × moves it to the Trash instead of erasing it. A single small text file is
   * snapshotted first, so this app's own ↩ Undo brings it back.
   */
  const deleteEntry = useCallback(
    async (relPath: string) => {
      if (!project) return
      if (armedTreeDelete !== relPath || !deletePreview) {
        // Arm ONLY once the preview has actually arrived: a fast double-click used to trash the file
        // before the user ever saw what they were about to lose.
        const token = ++armSeqRef.current
        setArmedTreeDelete(relPath)
        setDeletePreview(null)
        setDeleteFacts(null)
        // Ask the disk (and git) what this would actually destroy, then say it in plain English.
        const [p, changed, info, pathIgnored] = await Promise.all([
          window.studio.previewPath(project.path, relPath),
          // Scoped to the path being deleted so the row cap can't spend itself on unrelated files.
          window.studio.gitWorkingStat(project.path, relPath).catch(() => null),
          window.studio.gitInfo(project.path).catch(() => null),
          window.studio.gitPathIgnored(project.path, relPath).catch(() => null)
        ])
        const under = (f: string): boolean => f === relPath || f.startsWith(relPath.replace(/\/+$/, '') + '/')
        // gitWorkingStat returns [] both for a NON-repo AND for a folder git IGNORES — neither is the
        // same as "a repo with nothing changed". Treating either as known-good would tell the user
        // "all of it is already backed up" about work git has never even seen. rows === null ⇒ "I
        // can't tell", which is the honest answer in both cases.
        // Tracked means: a repo, the project isn't ignored, AND this specific path isn't ignored either
        // (a tracked project still ignores .env and build output — those have NEVER been backed up).
        const trackedByGit = Boolean(info?.isRepo) && info?.isIgnored !== true && pathIgnored !== true
        const rows = trackedByGit && changed ? changed.files : null
        if (armSeqRef.current !== token) return // superseded (or dismissed) while we were asking
        setDeleteFacts({ relPath, restorable: p.restorable, trashName: p.trashName })
        setDeletePreview(
          describeDeletion({
            relPath,
            isDir: p.isDir,
            files: p.files,
            dirs: p.dirs,
            bytes: p.bytes,
            countCapped: p.capped,
            capReason: p.capReason,
            gitKnown: rows !== null,
            noRepo: !info?.isRepo,
            pathIgnored: pathIgnored === true || info?.isIgnored === true,
            // The backup numbers are a FLOOR when git's output was cut off before we finished reading.
            backupCountsCapped: changed ? !changed.exact || changed.capped : false,
            neverBackedUp: rows ? rows.filter((c) => c.kind === 'new' && under(c.file)).length : 0,
            changedNotBackedUp: rows ? rows.filter((c) => c.kind === 'modified' && under(c.file)).length : 0,
            // Ask MAIN whether Undo can really take it back (it also excludes binaries) rather than
            // guessing from size — guessing promised "Undo brings it back" for images it never snapshots.
            canRestoreWithUndo: p.restorable,
            // Learned from reality (a volume where trashItem already failed), never assumed.
            trashAvailable: p.trashAvailable,
            trashName: p.trashName
          })
        )
        return
      }
      // Deleting a file also DROPS its editor tab. If you were typing in it, that typing never reached
      // disk, so neither the Trash nor ↩ Undo can bring it back — ask before destroying it. This applies
      // to the file itself AND to any open tab living inside a deleted folder.
      const prefix = relPath.replace(/\/+$/, '') + '/'
      const doomed = tabs.filter((t) => t.dirty && (t.path === relPath || t.path.startsWith(prefix))).map((t) => t.path)
      if (doomed.length) {
        // The seatbelt is now the only live control: leaving the armed × and its strip on screen let a
        // second click queue a duplicate trash, and made "Keep it" look like it had cancelled.
        setArmedTreeDelete(null)
        setDeletePreview(null)
        const guard = unsavedGuard({ reason: 'delete-path', dirtyPaths: doomed, targetPath: relPath })
        setPendingUnsaved({
          guard,
          act: (c) => {
            if (c === 'cancel') return // already disarmed above — nothing is deleted
            if (c === 'save') {
              void Promise.all(doomed.map((p2) => saveTabRef.current?.(p2))).then((results) => {
                if (results.every(Boolean)) void performTrash(relPath)
                else setEditMsg({ type: 'err', text: 'Some files could not be saved, so nothing was deleted.' })
              })
            } else void performTrash(relPath) // Discard: the typing is knowingly abandoned
          }
        })
        return
      }
      void performTrash(relPath)
    },
    [project, armedTreeDelete, deletePreview, deleteFacts, tabs, performTrash]
  )



  /** Live mirrors for the menu handler, which is mount-stable and must not re-subscribe per render. */
  const panelTabRef = useRef(panelTab)
  panelTabRef.current = panelTab
  const serverBusyRef = useRef(false)

  /** Next/previous editor tab, wrapping — Preview counts as a tab, the way it does in the strip. */
  const cycleTab = useCallback(
    (dir: 1 | -1) => {
      const order = [PREVIEW_TAB, ...tabsRef.current.map((t) => t.path)]
      const i = order.indexOf(activeTabRef.current)
      setActiveTab(order[(i + dir + order.length) % order.length])
    },
    []
  )

  /** Clear the visible terminal the way the shell would: a real form-feed into the PTY. */
  const clearActiveTerminal = useCallback(() => {
    document.querySelector<HTMLTextAreaElement>('.term-view.active .xterm-helper-textarea')?.focus()
    document.dispatchEvent(new CustomEvent('studio:term-clear'))
  }, [])

  /* The agent is about to photograph the preview — put it on screen. A frame nobody is looking at
     may never render a capture, and the user should see what the agent is doing to their app. */
  useEffect(() => {
    const show = (): void => setActiveTab(PREVIEW_TAB)
    document.addEventListener('studio:show-preview', show)
    return () => document.removeEventListener('studio:show-preview', show)
  }, [])

  /* The agent asking to use the running preview. Answers every request, including the failures —
     previewctl in main is waiting on this and times out if nothing replies. */
  useEffect(() => {
    return window.studio.onPreviewControl(async (req) => {
      const result = await runPreviewControl(req.action, req.arg, req.text)
      void window.studio.previewControlResult(req.id, result)
    })
  }, [])

  /**
   * Menu bar → the app's own actions.
   *
   * Every entry here calls the SAME function the corresponding button calls, so the menu can never
   * drift out of step with the UI, and Monaco's own actions are triggered rather than reimplemented.
   * A command with no real implementation is not in the menu at all — a dead menu item is the most
   * convincing lie a desktop app can tell.
   */
  useEffect(() => {
    return window.studio.onMenuCommand((command) => {
      const editor = (id: string) => runEditorAction(id)
      switch (command) {
        // ---- File
        case 'file.newFile': setSidebarView('explorer'); explorerRef.current?.startCreate('file'); break
        case 'file.newFolder': setSidebarView('explorer'); explorerRef.current?.startCreate('dir'); break
        case 'file.newWindow': void window.studio.newWindow(); break
        case 'file.open': void openProject(); break
        case 'file.newProject': setShowNewProject(true); break
        case 'file.save': if (activeTab !== PREVIEW_TAB) void saveTab(activeTab); break
        case 'file.saveAll': for (const t of tabsRef.current) if (t.dirty) void saveTab(t.path); break
        case 'file.closeEditor': if (activeTab !== PREVIEW_TAB) void closeTab(activeTab); break
        case 'file.closeProject': setProject(null); setTabs([]); setActiveTab(PREVIEW_TAB); break
        case 'file.settings': openSettings(); break

        // ---- Edit (Monaco's own actions — same ones the keybindings run)
        case 'edit.find': editor('actions.find'); break
        case 'edit.replace': editor('editor.action.startFindReplaceAction'); break
        case 'edit.comment': editor('editor.action.commentLine'); break
        case 'edit.format': editor('editor.action.formatDocument'); break
        case 'edit.ai': focusEditor(); editor('atomic.inlineEdit'); break
        case 'edit.undoAi': void undo(); break

        // ---- Selection
        case 'sel.expand': editor('editor.action.smartSelect.expand'); break
        case 'sel.shrink': editor('editor.action.smartSelect.shrink'); break
        case 'sel.copyLineUp': editor('editor.action.copyLinesUpAction'); break
        case 'sel.copyLineDown': editor('editor.action.copyLinesDownAction'); break
        case 'sel.moveLineUp': editor('editor.action.moveLinesUpAction'); break
        case 'sel.moveLineDown': editor('editor.action.moveLinesDownAction'); break
        case 'sel.cursorAbove': editor('editor.action.insertCursorAbove'); break
        case 'sel.cursorBelow': editor('editor.action.insertCursorBelow'); break
        case 'sel.allOccurrences': editor('editor.action.selectHighlights'); break

        // ---- View
        case 'view.palette': setShowPalette(true); break
        case 'view.theme': setShowThemePicker(true); break
        case 'view.search': setShowQuickOpen(true); break
        case 'view.explorer': setSidebarView((v) => (v === 'explorer' ? null : 'explorer')); break
        case 'view.extensions': setSidebarView((v) => (v === 'extensions' ? null : 'extensions')); break
        case 'view.scm': setSidebarView((v) => (v === 'scm' ? null : 'scm')); break
        case 'view.media': setSidebarView((v) => (v === 'media' ? null : 'media')); break
        case 'view.account': setSidebarView((v) => (v === 'account' ? null : 'account')); break
        case 'view.togglePanel': openPanel(panelTabRef.current ? null : lastUsableTab()); break
        case 'view.toggleAgent': setShowAgent((v) => !v); break
        /* The menu has carried an Insight item since the bottom-panel days, and this switch never
           had a case for it — so it was a dead menu item, which this repo does not allow. It is the
           alias the workspace view is reached by now. */
        case 'panel.insight': setInsightOpen(true); break
        case 'view.focusMode': toggleFocusMode(); break

        // ---- Go
        case 'go.file': setShowQuickOpen(true); break
        case 'go.symbol': setShowQuickOpen(true); break
        case 'go.line': editor('editor.action.gotoLine'); break
        case 'go.nextTab': cycleTab(1); break
        case 'go.prevTab': cycleTab(-1); break
        case 'go.preview': setActiveTab(PREVIEW_TAB); break

        // ---- Run
        case 'run.togglePreview': if (serverBusyRef.current) stop(); else start(); break
        case 'run.restartPreview': stop(); setTimeout(() => start(), 400); break
        case 'run.doctor': setInsightOpen(true); break
        case 'run.genTests': setInsightOpen(true); break
        case 'run.agent': setShowAgent(true); setTimeout(() => document.querySelector<HTMLTextAreaElement>('.ap-textarea')?.focus(), 60); break
        case 'run.stopAgent': void window.studio.agentCancel(); break

        // ---- Terminal
        case 'term.new': openPanel('terminal'); setTimeout(() => document.querySelector<HTMLButtonElement>('.term-add')?.click(), 120); break
        case 'term.show': openPanel('terminal'); break
        case 'term.close': if (panelTabRef.current === 'terminal') openPanel(null); break
        case 'term.clear': openPanel('terminal'); setTimeout(() => clearActiveTerminal(), 60); break

        // ---- Help
        case 'help.about': openSettings('about'); break
        case 'help.shortcuts': setShowPalette(true); break
        default: break
      }
    })
  }, [openProject, saveTab, closeTab, activeTab, undo, openSettings, openPanel, start, stop, toggleFocusMode])

  /**
   * Tab-strip keys. ←/→ move between tabs (switching as they go, the way editors do), Enter/Space
   * activate the focused tab, and Delete/Backspace closes it — the whole strip was mouse-only.
   */
  const onTabKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const all = [...(el.closest('.tabbar')?.querySelectorAll<HTMLElement>('.tab') ?? [])]
    const i = all.indexOf(el)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next = all[e.key === 'ArrowRight' ? i + 1 : i - 1]
      if (!next) return
      e.preventDefault()
      next.click()
      next.focus()
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      el.click()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      // The Preview tab has no close button and can't be closed — nothing to do there.
      const close = el.querySelector<HTMLElement>('.tab-close')
      if (!close) return
      e.preventDefault()
      close.click()
    }
  }, [])

  /**
   * Switch personality (ROADMAP §0 direction A).
   *
   * Nothing is closed, saved or discarded: Builder Mode HIDES the editor, it does not empty it, so
   * open files — including unsaved typing — are exactly where they were when you switch back. That
   * is why this needs no confirmation dialog: there is nothing to lose. The invariants that follow
   * from the new surface (active tab, panel tab, sidebar view) are enforced by the effect below, in
   * one place, so they also hold when the stored mode arrives from the main process at startup.
   */
  const switchMode = useCallback(
    (next: StudioMode) => {
      setModeChosen(true)
      // Persist even when the mode is unchanged: "keep this one" IS the choice, and writing it is
      // what stops the one-time invitation from coming back on every launch.
      localStorage.setItem('studio.mode', next)
      localStorage.setItem('studio.modeChosen', 'yes')
      void window.studio.setMode(next).then((effective) => {
        // main is the authority: an STUDIO_MODE override (tests, a demo, a support session) means
        // the stored choice is not what the app is actually wearing, and the UI must follow the app.
        if (effective !== next) setModeState(effective)
      })
      if (next === mode) return
      setModeState(next)
      const carry = next === 'builder' ? unsavedCarryOverNote(tabsRef.current.filter((t) => t.dirty).length) : ''
      setEditMsg({ type: 'ok', text: [modeSwitchNote(next), carry].filter(Boolean).join(' ') })
    },
    [mode]
  )

  /** Reopening the panel must land on a tab this mode actually has — the remembered one may be
   *  Terminal, which Builder Mode doesn't show. */
  const lastUsableTab = useCallback(
    (): PanelTab | null =>
      surface.panelTabs.includes(lastTabRef.current) ? lastTabRef.current : surface.panelTabs[0] ?? null,
    [mode]
  )

  /* The surface's invariants, enforced in ONE place: a hidden panel tab, a code tab behind a hidden
     editor, or the Extensions sidebar in a mode that doesn't show it would each leave the window
     rendering something the mode says isn't there. */
  useEffect(() => {
    if (panelTab && !surface.panelTabs.includes(panelTab)) openPanel(surface.panelTabs[0] ?? null)
    if (!surface.code && activeTab !== PREVIEW_TAB) setActiveTab(PREVIEW_TAB)
    if (!surface.extensions && sidebarView === 'extensions') setSidebarView('explorer')
    if (!surface.git && sidebarView === 'scm') setSidebarView('explorer')
  }, [mode, panelTab, activeTab, sidebarView, openPanel])

  /** ⌘⇧P command palette actions — every Studio surface, one list. */
  const paletteActions: PaletteAction[] = [
    { id: 'open', label: 'Open project…', run: () => void openProject() },
    { id: 'new-project', label: 'New project…', run: () => setShowNewProject(true) },
    { id: 'new-window', label: 'New window', hint: key('N'), run: () => void window.studio.newWindow() },
    { id: 'explorer', label: sidebarView ? 'Hide the sidebar' : 'Show the sidebar', hint: key('B'), run: () => setSidebarView((v) => (v ? null : 'explorer')) },
    ...(project
      ? [
          {
            id: 'run',
            label: serverBusy ? 'Stop preview' : 'Run preview',
            run: () => (serverBusy ? stop() : start())
          },
          { id: 'new-file', label: 'New file…', run: () => { setSidebarView('explorer'); explorerRef.current?.startCreate('file') } },
          { id: 'new-folder', label: 'New folder…', run: () => { setSidebarView('explorer'); explorerRef.current?.startCreate('dir') } },
          { id: 'agent', label: showAgent ? 'Hide the Agent' : 'Show the Agent', run: () => setShowAgent((v) => !v) },
          { id: 'p-insight', label: 'Insight: project overview, review, code map and memory', run: () => setInsightOpen(true) },
          { id: 'focus-mode', label: focusMode ? 'Exit Focus Mode' : 'Enter Focus Mode', hint: key('F', { shift: true }), run: toggleFocusMode },
          { id: 'undo', label: 'Undo last change', run: () => void undo() }
        ]
      : []),
    { id: 'p-activity', label: 'Panel: Activity', run: () => openPanel('activity') },
    { id: 'p-changes', label: 'Panel: Changes', run: () => openPanel('changes') },
    { id: 'v-scm', label: 'View: Source Control', hint: key('G', { shift: true }), run: () => setSidebarView((v) => (v === 'scm' ? null : 'scm')) },
    { id: 'p-ws', label: 'Panel: Workspaces', run: () => openPanel('company') },
    { id: 'p-term', label: 'Panel: Terminal', run: () => openPanel('terminal') },
    {
      id: 'mode',
      label: mode === 'builder' ? 'Switch to Developer mode' : 'Switch to Builder mode',
      run: () => switchMode(mode === 'builder' ? 'developer' : 'builder')
    },
    { id: 'media', label: 'Create images & video', run: () => setSidebarView('media') },
    { id: 'theme', label: 'Preferences: Colour Theme', hint: `${key('K')} ${key('T')}`, run: () => setShowThemePicker(true) },
    { id: 'settings', label: 'Settings', run: () => setShowSettings(true) }
  ].filter((a) => commandAllowed(mode, PALETTE_COMMAND[a.id] ?? a.id))

  /**
   * Global shortcuts kept in the renderer: ⌘⇧P and ⌘P.
   *
   * The menu owns these keys for real key presses (Electron consumes an accelerator before the page
   * sees it), so this is the fallback path — and the menu commands SET the overlay open rather than
   * toggling it, so even if a platform delivers the key to both, the result is "open" either way.
   * ⌘N deliberately no longer lives here: the menu maps it to New File the way VS Code does, and
   * two handlers for one key meant a new window AND a new-file prompt.
   */
  /**
   * ⌘K ⌘T — VS Code's chord for the colour theme picker.
   *
   * A chord, not a single accelerator, because Electron's menu accelerators are single combos and
   * ⌘K already belongs to Monaco's "Edit with AI…" inside the editor. That conflict resolves itself
   * by focus: when the editor has focus Monaco consumes the key and marks it handled, so the arming
   * step below deliberately ignores an already-handled ⌘K rather than stealing it back. The chord
   * disarms after two seconds so a stray ⌘K never leaves the next `t` you type doing something
   * surprising.
   */
  const chordArmed = useRef(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (chordArmed.current && k === 't') {
        e.preventDefault()
        chordArmed.current = false
        setShowThemePicker(true)
        return
      }
      if (k === 'k' && !e.defaultPrevented) {
        chordArmed.current = true
        clearTimeout(timer)
        timer = setTimeout(() => (chordArmed.current = false), 2000)
        return
      }
      chordArmed.current = false
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setShowPalette((v) => !v)
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
        // Search Everywhere jumps to a line of code, so it belongs to the code surface: in Builder
        // Mode the menu item is gone and this fallback must go with it, or the shortcut opens an
        // overlay onto files the mode says aren't there.
        if (!surface.search) return
        e.preventDefault()
        setShowQuickOpen((v) => !v)
      } else if (e.key === 'Escape') {
        if (showPalette) {
          setShowPalette(false)
          return
        }
        // Only when nothing else is mid-edit: an Escape typed into a rename/inline-edit box means
        // "cancel that", not "leave Focus Mode" — those inputs handle it themselves.
        const tag = (document.activeElement as HTMLElement | null)?.tagName
        if (focusMode && tag !== 'INPUT' && tag !== 'TEXTAREA') toggleFocusMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [surface.search, showPalette, focusMode, toggleFocusMode])

  /**
   * Keep the Explorer's git decorations current: on project change, on any `.git` write from any
   * process, and whenever something writes to the project. Debounced by the same watcher that
   * feeds the tree, and dropped if the project moved on while the read was in flight.
   */
  useEffect(() => {
    if (!project) {
      setGitDecorations(new Map())
      return
    }
    let alive = true
    const root = project.path
    const read = async (): Promise<void> => {
      const snap = await window.studio.gitSnapshot(root).catch(() => null)
      if (!alive || !snap?.isRepo) return
      const map = new Map<string, string>()
      for (const c of snap.changes) {
        // The working-tree column wins for display: what the file looks like NOW is what a person
        // reading the tree is asking about. An unmerged row is a conflict whatever its columns say.
        const letter = c.unmerged ? 'U' : c.y !== ' ' && c.y !== '.' ? c.y : c.x
        if (letter && letter !== ' ' && letter !== '.') map.set(c.file, letter)
      }
      setGitDecorations(map)
    }
    void read()
    const off = window.studio.onGitChanged(() => void read())
    return () => {
      alive = false
      off()
    }
  }, [project, treeRefresh])

  /** After the agent applies staged edits: sync open tabs, tree, and Undo. */
  const onAgentApplied = useCallback(
    (paths: string[], opts?: { skipVerify?: boolean; actor?: 'ai' | 'disk' }) => {
      if (!project) return
      for (const p of paths) {
        const rel = p.startsWith(project.path) ? p.slice(project.path.length + 1) : p
        void refreshOpenFile(rel, opts?.actor ?? 'ai')
      }
      setTreeRefresh((n) => n + 1)
      void window.studio.getUndoState().then(setUndoState)
      // Fix-Verify follows ONLY a genuine forward apply (a Fix-with-AI result). A revert/rollback must
      // NOT consume the pending verdict — it would misattribute the rollback as "the fix" (e.g. blame a
      // reintroduced secret on a fix that never ran) AND then suppress the real fix's later verdict.
      if (!opts?.skipVerify) void verifyAfterApply()
    },
    [project, refreshOpenFile, verifyAfterApply]
  )

  const saveKey = useCallback(async () => {
    if (!keyInput.trim()) return
    const res = await window.studio.setApiKey(providerId, keyInput.trim())
    if (!res?.ok) {
      setEditMsg({ type: 'err', text: res?.error ?? 'Studio could not save that key.' })
      return
    }
    setHasKey(true)
    setKeyInput('')
  }, [keyInput, providerId])

  /** The dock is a toggle in Developer Mode and permanent in Builder Mode, where it is the product. */
  const dockOpen = !!project && (showAgent || surface.dockAlwaysOn)

  /* One collapse control, reused in every left-header variant (Explorer/Extensions/Create/Account) —
     the activity-bar icon can also collapse it (click the active icon again), but that's a second
     click on something that doesn't look like a toggle. This is the discoverable one. */
  const collapseLeftBtn = (
    <button
      type="button"
      className="left-collapse-btn"
      onClick={() => setSidebarView(null)}
      title={`Hide sidebar (${key('B')})`}
      aria-label="Hide sidebar"
    >
      <Icon name="chevron-left" size={15} />
    </button>
  )

  const activeTabObj = tabs.find((t) => t.path === activeTab)
  const editorIsEmpty = activeTab === EMPTY_TAB
  const fileName = (p: string): string => p.split('/').pop() ?? p

  const panelContext =
    panelTab === 'activity'
      ? server.error ?? ''
      : panelTab === 'company' && remoteState.connected && remoteState.cfg
        ? `${remoteState.cfg.user}@${remoteState.cfg.host} · code never leaves the server`
        : panelTab === 'terminal' && project
          ? `runs in ${project.name}`
          : ''

  /* "click for details" is only true while the details are somewhere else. With the Activity tab
     already open the click sets panelTab to the value it already holds, React bails, and the chip
     reads as a dead control — so the label drops the promise it cannot keep and names the state
     instead. The click still routes there from anywhere else. */
  const previewDetailsElsewhere = panelTab !== 'activity'

  const statusPreviewText =
    server.status === 'running'
      ? `Preview: Running · ${server.url?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? ''}`
      : server.status === 'starting'
        ? 'Preview: Starting…'
        : server.status === 'error'
          ? previewDetailsElsewhere
            ? 'Preview: Error — click for details'
            : 'Preview: Error'
          : 'Preview: Stopped'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <AtomicMark size={20} className="brand-mark" />
          ATOMIC Studio
        </div>

        {/* The command centre — VS Code's centred pill. It names the project and is the way into
            Search Everywhere. Where the mode has no code search it renders as plain text rather
            than a control that would lead nowhere. */}
        <div className="titlebar-center">
          {project ? (
            surface.search ? (
              <button
                type="button"
                className="command-center"
                onClick={() => setShowQuickOpen(true)}
                title={`Search this project (${key('P')})`}
              >
                <Icon name="search" size={12} />
                <span className="command-center-name">{project.name}</span>
                <span className="command-center-hint">{key('P')}</span>
              </button>
            ) : (
              <span className="command-center command-center-static">
                <Icon name="folder" size={12} />
                <span className="command-center-name">{project.name}</span>
              </span>
            )
          ) : (
            <span className="command-center command-center-static">
              <span className="command-center-name muted">No project open</span>
            </span>
          )}
        </div>

        <div className="topbar-actions">
          <div className="btn-group">
            <button className="btn" onClick={openProject}>
              Open project…
            </button>
            {project && (
              <button
                className={`btn ${serverBusy ? 'btn-danger-ghost' : 'btn-primary'}`}
                onClick={serverBusy ? stop : start}
                title={serverBusy ? 'Stop the live preview' : 'Start the live preview'}
              >
                {server.status === 'starting' || serverBusy ? surface.labels.stopPreview : surface.labels.runPreview}
              </button>
            )}
          </div>
          {project && (
            <>
              <span className="topbar-sep" />
              <div className="btn-group">
                <button className="btn" onClick={undo} disabled={!undoState.canUndo} title={undoState.label ?? 'Nothing to undo yet'}>
                  {surface.labels.undo}
                </button>
              </div>
            </>
          )}
          <div className="spacer" />
          <div className="btn-group">
            {/* In Builder Mode the dock IS the product, so it is always on and there is no toggle
                that could lose it. */}
            {/* The three layout toggles VS Code keeps at the right edge of its title bar, driving
                the three real surfaces this app has: sidebar, bottom panel, agent dock. Icon-only
                and 26px, so the chrome stops shouting; every one carries its own aria-label. */}
            <button
              className={`btn layout-toggle ${sidebarView ? 'toggled' : ''}`}
              onClick={() => setSidebarView(sidebarView ? null : 'explorer')}
              title={`${sidebarView ? 'Hide' : 'Show'} the sidebar (${key('B')})`}
              aria-label={`${sidebarView ? 'Hide' : 'Show'} the sidebar`}
              aria-pressed={!!sidebarView}
            >
              <Icon name="layout-sidebar" size={15} />
            </button>
            <button
              className={`btn layout-toggle ${panelTab ? 'toggled' : ''}`}
              onClick={() => openPanel(panelTab ? null : lastUsableTab())}
              title={surface.mode === 'builder' ? 'Health and history for this project' : `${surface.labels.tools} — Activity, Changes, GitHub, Company server, Terminal`}
              aria-label={`${panelTab ? 'Hide' : 'Show'} ${surface.labels.tools}`}
              aria-pressed={!!panelTab}
            >
              <Icon name="layout-panel" size={15} />
            </button>
            {project && !surface.dockAlwaysOn && (
              <button
                className={`btn layout-toggle ${showAgent ? 'toggled' : ''}`}
                onClick={() => setShowAgent((v) => !v)}
                title="AI agent: multi-file changes with diff approval"
                aria-label={`${showAgent ? 'Hide' : 'Show'} the Agent`}
                aria-pressed={showAgent}
              >
                <Icon name="layout-dock" size={15} />
              </button>
            )}
            <button
              className="btn layout-toggle"
              onClick={() => setShowSettings((v) => !v)}
              title="Settings"
              aria-label="Settings"
            >
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>
      </header>

      <div className="body ide">
        <ActivityBar
          sidebarView={sidebarView}
          onSidebarViewChange={setSidebarView}
          terminalOpen={panelTab === 'terminal'}
          onToggleTerminal={() => openPanel(panelTab === 'terminal' ? null : 'terminal')}
          onOpenSearch={() => setShowQuickOpen(true)}
          onOpenSettings={() => openSettings()}
          surface={surface}
          hasProject={!!project}
        />

        {/* LEFT: pure navigation — files, or (per the activity bar) Extensions */}
        {sidebarView && (
          <aside className="left" style={{ width: 'var(--left-w)' }}>
            {sidebarView === 'explorer' && (
              <>
                {/* VS Code's shape exactly: the view's own name in the title bar, and the folder as a
                    collapsible section underneath carrying its own new-file/new-folder actions —
                    not two rows of chrome above a tree. */}
                <div className="left-header">
                  <span className="left-title">{surface.labels.files}</span>
                  {collapseLeftBtn}
                </div>

                <div className="explorer">
                  {project && surface.code ? (
                    <SidebarSection
                      title={project.name}
                      open={treeOpen}
                      onToggle={() => setTreeOpen((v) => !v)}
                      /* VS Code's four Explorer actions, in its order. They are PRODUCT icons from
                         `Icon.tsx` — file-type icons come from the icon theme and never appear on a
                         control. The row is quiet at rest: these fade in on hover or keyboard focus. */
                      actions={
                        <>
                          <button
                            className="sb-action"
                            title="New File…"
                            aria-label="New File"
                            onClick={() => explorerRef.current?.startCreate('file')}
                          >
                            <Icon name="file-plus" size={14} />
                          </button>
                          <button
                            className="sb-action"
                            title="New Folder…"
                            aria-label="New Folder"
                            onClick={() => explorerRef.current?.startCreate('dir')}
                          >
                            <Icon name="folder-plus" size={14} />
                          </button>
                          <button
                            className="sb-action"
                            title="Refresh Explorer"
                            aria-label="Refresh Explorer"
                            onClick={() => explorerRef.current?.refresh()}
                          >
                            <Icon name="refresh" size={14} />
                          </button>
                          <button
                            className="sb-action"
                            title="Collapse Folders in Explorer"
                            aria-label="Collapse Folders in Explorer"
                            onClick={() => explorerRef.current?.collapseAll()}
                          >
                            <Icon name="layers" size={14} />
                          </button>
                          <span className="left-fw" title={`Detected framework: ${project.framework}`}>
                            {project.framework}
                          </span>
                        </>
                      }
                    >
                      <FileTree
                        projectPath={project.path}
                        activeFile={activeTab === PREVIEW_TAB ? null : activeTab}
                        onOpenFile={openFile}
                        onDelete={(rel) => void deleteEntry(rel)}
                        onCreate={createInTree}
                        onRename={renameInTree}
                        decorations={gitDecorations}
                        refreshKey={treeRefresh}
                        handleRef={explorerRef}
                        onStats={(st) => {
                          // Development instrumentation only — the UI suite asserts on it.
                          ;(window as unknown as { __explorerStats?: unknown }).__explorerStats = st
                        }}
                      />
                    </SidebarSection>
                  ) : project ? (
                    /* Builder Mode: no file tree. The sidebar still has to do the one job a
                       non-coder needs from it — open another project — so it keeps the same
                       Projects home the no-project state uses. */
                    <div className="projects-home builder-home">
                      <div className="muted small">
                        Ask the assistant on the right for any change you want. Your files are managed for you.
                      </div>
                      <button className="btn btn-block" onClick={openProject}>
                        Open another project…
                      </button>
                      <button className="btn btn-block" onClick={() => setShowNewProject(true)}>
                        New project…
                      </button>
                    </div>
                  ) : (
                    <div className="projects-home">
                      {/* The full launcher — Open/New/Recent — lives in the center WelcomeScreen now.
                          Duplicating it here read as two apps arguing about where to click, not one
                          intentional state (VS Code's own Explorer sidebar makes the same call: just
                          "no folder open" + one button when nothing's loaded). */}
                      <p className="muted small">No project is open yet.</p>
                      <button className="btn btn-primary btn-block" onClick={openProject}>
                        Open Project
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {sidebarView === 'scm' && (
              <>
                <div className="left-header">
                  <span className="left-title">Source Control</span>
                  {collapseLeftBtn}
                </div>
                <div className="scm-host">
                  <GitPanel
                    refreshKey={treeRefresh}
                    cloneRequest={cloneRequest}
                    projectPath={project?.path ?? null}
                    providerId={providerId}
                    model={model}
                    onCloned={(path) => void openProjectAtPath(path)}
                    onMsg={(type, text) => setEditMsg({ type, text })}
                    onOpenFile={(rel) => void openFile(rel)}
                    onFilesChanged={() => {
                      // Re-read every open tab from disk; the unsaved-work seatbelt fires per tab if the
                      // user was typing in one of them.
                      for (const t of tabsRef.current) void refreshOpenFile(t.path, 'disk')
                      setTreeRefresh((n) => n + 1)
                    }}
                    onOpenSettings={(tab) => openSettings(tab)}
                  />
                </div>
              </>
            )}

            {sidebarView === 'extensions' && (
              <>
                <div className="left-header">
                  <span className="left-title">Extensions</span>
                  {collapseLeftBtn}
                </div>
                <div className="explorer">
                  <ExtensionsView
                    autocompleteOn={autocompleteOn}
                    onAutocompleteChange={setAutocompleteOn}
                    autoFixOn={autoFixOn}
                    onAutoFixChange={setAutoFixOn}
                    airGapped={airGapped}
                    onToggleAirGap={() => void toggleAirGap()}
                    onMsg={(type, text) => setEditMsg({ type, text })}
                    onOpenDetail={setExtDetail}
                    selectedKey={extDetail?.key ?? null}
                  />
                </div>
              </>
            )}

            {sidebarView === 'media' && (
              <>
                <div className="left-header">
                  <span className="left-title">Create</span>
                  {collapseLeftBtn}
                </div>
                <div className="explorer">
                  {project ? (
                    <MediaPanel
                      projectPath={project.path}
                      onMsg={(type, text) => setEditMsg({ type, text })}
                      onOpenSettings={() => openSettings('keys')}
                    />
                  ) : (
                    <p className="muted small" style={{ padding: '12px' }}>
                      Open a project first — generated images and video are saved inside it.
                    </p>
                  )}
                </div>
              </>
            )}

            {sidebarView === 'account' && (
              <>
                <div className="left-header">
                  <span className="left-title">Account</span>
                  {collapseLeftBtn}
                </div>
                <div className="explorer">
                  <AccountPanel
                    providers={providers}
                    showGit={surface.git}
                    onConnectGitHub={() => setSidebarView('scm')}
                    onManageKeys={() => openSettings('keys')}
                  />
                </div>
              </>
            )}
          </aside>
        )}
        {sidebarView && (
          <ColumnResizer
            width={leftWidth}
            onChange={setLeftWidth}
            min={200}
            max={560}
            side="left"
            label="Resize the sidebar"
            liveVar="--left-w"
          />
        )}

        {/* CENTER: the editor, and under it the bottom panel.
            The panel is a child of this column, not of the window: VS Code's default panel
            alignment puts it over the editor area ONLY, so the Explorer and the agent dock run
            the full height beside it instead of being cut short by whatever is open at the
            bottom. Moving it out here was the fix for the panel eating into the sidebar. */}
        <div className="center">
          <main className="workspace">
            {/* Focus Mode hides every side surface — this is the one thing left on screen that says
                how to get them back, since Escape only works if you already know it does. */}
            {focusMode && (
              <button type="button" className="focus-exit-btn" onClick={toggleFocusMode} title={`Exit Focus Mode (Escape or ${key('F', { shift: true })})`}>
                <Icon name="close" size={12} /> Exit Focus Mode
              </button>
            )}
            {/* A real tab strip: one Tab stop, ←/→ between tabs, Enter/Space to switch, and the
                selected tab announced rather than implied by a 2px line. */}
            {/* First run only, and deliberately NOT a dialog: the last modal that opened itself over
                this window blocked new users from reaching their own project. This is one line at the
                top of the workspace, it answers itself with either button, and it never comes back. */}
            {!modeChosen && (
              <div className="mode-invite">
                <span className="mode-invite-text">
                  <b>New here?</b> {describeMode('builder').tagline} You can switch back any time.
                </span>
                <button className="btn btn-sm btn-primary" onClick={() => switchMode('builder')}>
                  Try Builder mode
                </button>
                <button className="btn btn-sm" onClick={() => switchMode('developer')}>
                  Keep Developer mode
                </button>
              </div>
            )}

            {!project ? (
              <WelcomeScreen
                recents={recents}
                onOpenProject={openProject}
                onNewProject={() => setShowNewProject(true)}
                onOpenRecent={(path) => void openProjectAtPath(path)}
                onCloneRepo={() => {
                  switchMode('developer')
                  setSidebarView('scm')
                  setCloneRequest((n) => n + 1)
                }}
                onOpenWorkspaces={() => {
                  switchMode('developer')
                  openPanel('company')
                }}
              />
            ) : (
            <>
            <div className="tabbar" role="tablist" aria-label="Open files">
              <div
                className={`tab tab-preview ${activeTab === PREVIEW_TAB ? 'active' : ''}`}
                onClick={() => setActiveTab(PREVIEW_TAB)}
                onKeyDown={onTabKeyDown}
                role="tab"
                aria-selected={activeTab === PREVIEW_TAB}
                tabIndex={activeTab === PREVIEW_TAB ? 0 : -1}
              >
                <span className={`badge badge-${server.status}`} aria-hidden="true" /> Preview
                {/* The dot's colour is the only thing that says whether the preview is running; this
                    is that same fact, for anyone who can't see the colour. */}
                <span className="sr-only"> — {statusPreviewText}</span>
              </div>
              {/* Builder Mode keeps open files in memory — they are hidden, not closed, so switching
                  back to Developer Mode finds every tab (and every unsaved edit) exactly as it was. */}
              {(surface.code ? tabs : []).map((t) => (
                <div
                  key={t.path}
                  className={`tab ${activeTab === t.path ? 'active' : ''}`}
                  onClick={() => setActiveTab(t.path)}
                  onKeyDown={onTabKeyDown}
                  title={t.path}
                  role="tab"
                  aria-selected={activeTab === t.path}
                  tabIndex={activeTab === t.path ? 0 : -1}
                >
                  {/* The same file-icon theme the Explorer uses: a tab and its tree row must not
                      disagree about what a `.ts` looks like. */}
                  <FileIcon name={fileName(t.path)} className="tab-file-icon" />
                  <span className="tab-name">{fileName(t.path)}</span>
                  {t.dirty && <span className="tab-dot" title="Unsaved"><Icon name="dot" size={8} /></span>}
                  {t.dirty && <span className="sr-only">unsaved changes</span>}
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`Close ${fileName(t.path)}`}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(t.path)
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              ))}
            </div>

            {/* Insight — a workspace view, not a drawer and not a file. Same slot and same rule as
                the extension detail page: below the tab strip so the files you have open stay
                visible, and closing it returns to exactly what was there. Nothing is saved or lost
                on close, because there is nothing here to save. */}
            {insightOpen && project && (
              <React.Suspense fallback={<div className="iv-loading muted small" role="status">Opening Insight…</div>}>
                <InsightView
                  projectPath={project.path}
                  projectName={project.name}
                  advanced={surface.advancedInsight}
                  canOpenFiles={surface.code}
                  changeToken={treeRefresh}
                  explainText={explainText}
                  explainBusy={insightBusy}
                  backupBusy={backupBusy}
                  genTestMsg={genTestMsg}
                  verifyResult={verifyResult}
                  restoreDiff={restoreDiff}
                  restoreArmed={restoreArmed}
                  onClose={() => setInsightOpen(false)}
                  onOpenFile={(p) => void openFile(p)}
                  onOpenFileAtLine={(fp, line) => void openFileAtLine(fp, line)}
                  onFixWithAi={onFixWithAi}
                  onGenerateTests={() => void onGenerateTests()}
                  onExplain={() => void explainProject()}
                  onBackUpNow={() => void backUpNow()}
                  onCompare={(fp) => void compareToBackup(fp)}
                  onArmRestore={setRestoreArmed}
                  onRestore={(fp) => void restoreToBackup(fp)}
                  onCloseDiff={() => { setRestoreDiff(null); setRestoreArmed(false) }}
                  onExportCompliance={() => void exportCompliance()}
                  onTokensApplied={(written) => {
                    // Those files just changed ON DISK. Without re-reading them, the open buffer is
                    // stale and the next ⌘S silently writes the pre-token content back over them.
                    for (const w of written ?? []) void refreshOpenFile(w, 'disk')
                    setTreeRefresh((n) => n + 1)
                    void window.studio.getUndoState().then(setUndoState)
                  }}
                  onReverted={(files) => {
                    setEditMsg({ type: 'ok', text: `Rolled back ${files.length} change${files.length === 1 ? '' : 's'}.` })
                    // A rollback is not a fix (never re-check) and it is the USER's action, not the AI's.
                    onAgentApplied(files, { skipVerify: true, actor: 'disk' })
                  }}
                  onMsg={(type, text) => setEditMsg({ type, text })}
                />
              </React.Suspense>
            )}

            {/* The extension detail page — the editor area, exactly where VS Code puts it, and
                deliberately BELOW the tab strip rather than over it: it is not a file, so it must not
                hide the files you have open. Closing it returns to whatever was there, with nothing to
                save and nothing lost. */}
            {extDetail && (
              <ExtensionDetail
                item={extDetail}
                onClose={() => setExtDetail(null)}
                onEnable={async (item, on) => {
                  await window.studio.connectorSetEnabled(item.id, on)
                  const fresh = (await window.studio.connectorList()).find((c) => c.id === item.id)
                  setExtDetail(fresh ? { ...item, connector: fresh } : null)
                }}
                onUninstall={async (item) => {
                  const res = await window.studio.extensionUninstall(item.id)
                  await window.studio.connectorRemove(item.id)
                  setEditMsg({ type: res.ok ? 'ok' : 'err', text: res.ok ? `Removed ${item.name}.` : (res.error ?? `Removed ${item.name}.`) })
                  setExtDetail(null)
                }}
                onApproveTool={async (id, tool, approved) => {
                  await window.studio.connectorApproveTool(id, tool, approved)
                  const fresh = (await window.studio.connectorList()).find((c) => c.id === id)
                  setExtDetail((prev) => (prev && fresh ? { ...prev, connector: fresh } : prev))
                }}
                onApplyTheme={async (id) => applyTheme(await window.studio.themeSet(id))}
                airGapped={airGapped}
                busy={false}
              />
            )}

            <div className="tab-content">
              {activeTab === PREVIEW_TAB ? (
                <PreviewPane
                  url={server.url}
                  status={server.status}
                  onStart={start}
                  startLabel={surface.labels.runPreview}
                  preloadUrl={previewPreloadUrl}
                  pickMode={pickMode}
                  onTogglePick={() => setPickMode((v) => !v)}
                  onSelect={onSelect}
                  onError={onPreviewError}
                />
              ) : activeTabObj ? (
                <>
                  {inlineSel && inlineSel.path === activeTabObj.path && (
                    <div className="inline-edit-bar">
                      <span className="inline-edit-range">
                        {key('K')} · lines {inlineSel.startLine}–{inlineSel.endLine}
                      </span>
                      <input
                        className="text-input inline-edit-input"
                        autoFocus
                        placeholder='Describe the change, e.g. "add error handling"'
                        value={inlineInstruction}
                        disabled={inlineBusy}
                        onChange={(e) => setInlineInstruction(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void runInlineEdit()
                          else if (e.key === 'Escape') setInlineSel(null)
                        }}
                      />
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={runInlineEdit}
                        disabled={inlineBusy || !inlineInstruction.trim()}
                      >
                        {inlineBusy ? 'Rewriting…' : 'Rewrite'}
                      </button>
                      <button className="btn btn-sm" onClick={() => setInlineSel(null)} disabled={inlineBusy} title="Cancel" aria-label="Cancel">
                        ×
                      </button>
                    </div>
                  )}
                  {/* The fallback is a bare surface, not a spinner: the editor chunk resolves in
                      well under a frame after the first open, and a spinner that flashes for 30ms
                      reads as jank rather than progress. */}
                  <React.Suspense fallback={<div className="editor-loading" aria-hidden="true" />}>
                    <CodeEditor
                      path={activeTabObj.path}
                      value={activeTabObj.content}
                      onChange={(v) => changeTab(activeTabObj.path, v)}
                      onSave={() => saveTab(activeTabObj.path)}
                      onInlineEdit={(sel) => {
                        setInlineSel({ ...sel, path: activeTabObj.path })
                        setInlineInstruction('')
                      }}
                      prefs={editorPrefs}
                    />
                  </React.Suspense>
                </>
              ) : (
                /* No document in the editor area. The WelcomeScreen still owns the no-PROJECT case;
                   this is the other one, and it offers the keystrokes rather than an empty surface. */
                <EditorEmptyState
                  hasProject={!!project}
                  showTerminal={surface.terminal}
                  onOpenAgent={() => setShowAgent(true)}
                  onShowCommands={() => setShowPalette(true)}
                  onToggleTerminal={() => openPanel(panelTab === 'terminal' ? null : 'terminal')}
                />
              )}
            </div>
            </>
            )}

            {/* Wave 21 "Put It Back": the armed delete says what would actually go, before it goes. */}
            {deletePreview && (
              <div className="toast">
                <div className={`delete-preview ${deletePreview.band === 'red' ? 'error-box' : 'warn-box'}`}>
                  <div className="dp-headline">{deletePreview.headline}</div>
                  {deletePreview.lines.map((l, i) => (
                    <div key={i} className="dp-line">{l}</div>
                  ))}
                  <div className="dp-actions">
                    <button className="btn btn-sm btn-danger" onClick={() => armedTreeDelete && void deleteEntry(armedTreeDelete)}>
                      {deletePreview.confirmLabel}
                    </button>
                    <button className="btn btn-sm" onClick={() => { setArmedTreeDelete(null); setDeletePreview(null) }}>
                      Keep it
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Wave 21 seatbelt: an action that would throw away unsaved typing stops here first. */}
            {pendingUnsaved && (
              <div className="toast">
                <div className="unsaved-guard error-box">
                  <div className="dp-headline">{pendingUnsaved.guard.headline}</div>
                  {pendingUnsaved.guard.lines.map((l, i) => (
                    <div key={i} className="dp-line">{l}</div>
                  ))}
                  <div className="dp-actions">
                    {pendingUnsaved.guard.choices.map((c) => (
                      <button
                        key={c}
                        className={`btn btn-sm ${c === 'save' || c === 'keep-mine' ? 'btn-primary' : c === 'discard' || c === 'take-theirs' ? 'btn-danger' : ''}`}
                        onClick={() => {
                          const act = pendingUnsaved.act
                          setUnsavedQueue((prev) => prev.slice(1)) // pop only THIS one; others still wait
                          act(c)
                        }}
                      >
                        {c === 'save' ? 'Save first' : c === 'discard' ? 'Discard my typing' : c === 'cancel' ? 'Cancel' : c === 'keep-mine' ? 'Keep mine' : 'Take theirs'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Toasts float over the workspace — visible wherever the user looks. */}
            {(editMsg || autoFixing) && (
              <div className="toast">
                {editMsg ? (
                  <div className={editMsg.type === 'ok' ? 'ok-box' : 'error-box'}>
                    {editMsg.text}
                    {editMsg.type === 'err' && (
                      <button className="toast-dismiss" onClick={() => setEditMsg(null)} title="Dismiss">
                        ×
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="ok-box">Auto-fixing…</div>
                )}
              </div>
            )}
          </main>

          {/* Unified bottom panel: Activity | Changes | GitHub | Company | Terminal */}
          {panelTab && (
            <PaneResizer
              size={panelHeight}
              onChange={setPanelHeight}
              min={120}
              max={Math.max(240, window.innerHeight - 220)}
              label="Resize the panel"
              liveVar="--panel-h"
            />
          )}
          {panelTab && (
            <section className="panel" style={{ height: 'var(--panel-h)' }}>
              <header className="panel-head">
                {/* A real tablist: `role="tab"` + `aria-selected` + ONE tab stop with roving focus,
                    so ←/→ walk the strip the way every other tab bar in the app does. It had none of
                    this — the tabs were plain buttons, so a screen reader heard six unrelated
                    controls and Tab stopped on each of them. */}
                <div className="seg seg-sm panel-tabs" role="tablist" aria-label="Panel views">
                  {PANEL_TABS.filter((t) => surface.panelTabs.includes(t.id)).map((t, i, list) => {
                    const selected = panelTab === t.id
                    const count = t.id === 'problems' ? problems.length : 0
                    return (
                      <button
                        key={t.id}
                        role="tab"
                        id={`panel-tab-${t.id}`}
                        aria-selected={selected}
                        aria-controls="panel-body"
                        tabIndex={selected ? 0 : -1}
                        className={`seg-btn ${selected ? 'active' : ''}`}
                        disabled={t.needsProject && !project}
                        onClick={() => openPanel(t.id)}
                        onKeyDown={(e) => {
                          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
                          e.preventDefault()
                          const usable = list.filter((x) => !(x.needsProject && !project))
                          const at = usable.findIndex((x) => x.id === t.id)
                          const to =
                            e.key === 'Home' ? 0
                              : e.key === 'End' ? usable.length - 1
                                : (at + (e.key === 'ArrowRight' ? 1 : -1) + usable.length) % usable.length
                          const next = usable[to]
                          if (next) {
                            openPanel(next.id)
                            document.getElementById(`panel-tab-${next.id}`)?.focus()
                          }
                        }}
                      >
                        {surface.labels.panel[t.id] ?? t.label}
                        {/* The number is a badge, not part of the label, so the tab does not change
                            width as problems arrive. Spoken, "Problems 3" is ambiguous — hide the badge
                            and say what the number counts. */}
                        {count > 0 && <span className="panel-count" aria-hidden="true">{count}</span>}
                        {count > 0 && <span className="sr-only">{` — ${count} problem${count === 1 ? '' : 's'}`}</span>}
                      </button>
                    )
                  })}
                </div>
                {panelContext && <span className="panel-context">{panelContext}</span>}
                <span className="spacer" />
                <button className="panel-close" onClick={() => openPanel(null)} title="Close panel" aria-label="Close panel">
                  <Icon name="close" size={13} />
                </button>
              </header>
              <div className="panel-body" id="panel-body" role="tabpanel" aria-labelledby={panelTab ? `panel-tab-${panelTab}` : undefined}>
                {panelTab === 'activity' && (
                  <div className="logs-body activity-body">
                    {/* A failed start says so HERE, in the body, not only in the header's context
                        line. The old code gated the empty state on `logs.length` alone, so a
                        preview that errored before producing any output showed
                        "No output yet — press Run preview." — the panel reporting that nothing had
                        happened while the header beside it reported the failure. Of the two, the
                        louder one was the wrong one. */}
                    {server.error && (
                      <div className="log log-error activity-error" role="alert">
                        {server.error}
                      </div>
                    )}
                    {logs.length === 0 && !server.error && (
                      <div className="muted">No output yet — press Run preview.</div>
                    )}
                    {logs.map((l, i) => (
                      <div key={i} className={`log log-${l.stream}`}>
                        {l.text.trimEnd()}
                      </div>
                    ))}
                  </div>
                )}
                {panelTab === 'problems' && (
                  <div className="problems-body">
                    {problems.length === 0 && <div className="muted small">No problems — errors from the preview, AI checks, and the dev server land here.</div>}
                    {problems.length > 0 && (
                      <div className="git-row problems-toolbar">
                        <span className="muted small">{problems.length} problem{problems.length === 1 ? '' : 's'}</span>
                        <span className="spacer" />
                        <button className="btn btn-sm" onClick={() => setProblems([])}>Clear all</button>
                      </div>
                    )}
                    {problems.map((pr) => (
                      <div key={pr.id} className="problem-row">
                        <span className={`ws-badge problem-badge-${pr.source}`}>{pr.source === 'preview' ? 'Preview' : pr.source === 'ai-check' ? 'AI check' : 'Dev server'}</span>
                        <span className="problem-msg" title={pr.message}>{pr.message}</span>
                        {pr.file && (
                          <button className="btn btn-sm" onClick={() => openFileAtLine(pr.file!)} title={pr.file}>
                            Open file
                          </button>
                        )}
                        {pr.source === 'preview' && pr.file && (
                          <button className="btn btn-sm btn-primary" onClick={() => void runAutoFix(pr.message, pr.file!)}>
                            Fix with AI
                          </button>
                        )}
                        <button className="btn btn-sm" onClick={() => setProblems((prev) => prev.filter((x) => x.id !== pr.id))}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                {panelTab === 'changes' && (
                  <HistoryPanel
                    onReverted={(files) => {
                      setEditMsg({ type: 'ok', text: `Rolled back ${files.length} change${files.length === 1 ? '' : 's'}.` })
                      onAgentApplied(files, { skipVerify: true }) // same refresh path, but a rollback is not a fix
                    }}
                  />
                )}
                {panelTab === 'company' && (
                  <RemotePanel
                    onStateChange={setRemoteState}
                    onOpenRemoteFile={openRemoteFile}
                    onMsg={(type, text) => setEditMsg({ type, text })}
                  />
                )}
                {panelTab === 'terminal' && project && (
                  <TerminalPanel projectPath={project.path} providerId={providerId} model={model} onMsg={(type, text) => setEditMsg({ type, text })} />
                )}
              </div>
            </section>
          )}
        </div>


        {/* RIGHT: the single AI surface — element edit, error fix, agent chat.
            In Builder Mode this IS the product, so it is not a toggle that can be lost. */}
        {dockOpen && (
          <ColumnResizer
            width={rightWidth}
            onChange={setRightWidth}
            min={280}
            max={640}
            side="right"
            label="Resize the agent panel"
            liveVar="--right-w"
          />
        )}
        {dockOpen && (
          <aside className="right" style={{ width: 'var(--right-w)' }}>
            {/* Builder Mode's dock is permanent (dockAlwaysOn) — a collapse control that visibly does
                nothing when clicked is worse than none, so it only exists where collapsing is real. */}
            {!surface.dockAlwaysOn && (
              <div className="right-collapse-row">
                <button
                  type="button"
                  className="right-collapse-btn"
                  onClick={() => setShowAgent(false)}
                  title={`Hide Agent (${key('A', { shift: true })})`}
                  aria-label="Hide Agent"
                >
                  <Icon name="chevron-right" size={15} />
                </button>
              </div>
            )}
            {selection && (
              <div className="edit-panel">
                <div className="edit-title">Selected element</div>
                <div className="sel-chip">
                  &lt;{selection.name}&gt; · {selection.file}:{selection.line}
                </div>
                <textarea
                  className="text-input textarea"
                  placeholder='Describe the change, e.g. "make this button green and larger"'
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={3}
                />
                <button
                  className="btn btn-primary btn-block"
                  onClick={applyEdit}
                  disabled={editing || goalRunning || !instruction.trim()}
                >
                  {editing ? 'Applying…' : 'Apply change'}
                </button>
                <button
                  className="btn btn-block"
                  onClick={runGoal}
                  disabled={editing || goalRunning || !instruction.trim()}
                  title="Two models: one drafts, one finalizes the file"
                >
                  {goalRunning ? 'Running 2 models…' : 'Polish with 2 models'}
                </button>
                {goalSteps.length > 0 && (
                  <div className="steps">
                    {goalSteps.map((s) => (
                      <span key={s.id} className={`step-chip ${s.ok ? 'ok' : 'bad'}`}>
                        {s.id}: {s.provider} <Icon name={s.ok ? 'check' : 'close'} size={11} />
                      </span>
                    ))}
                  </div>
                )}
                <button className="btn btn-block" onClick={() => setSelection(null)}>
                  Cancel
                </button>
              </div>
            )}

            {lastError && !autoFixing && (
              <div className="err-card">
                <div className="edit-title">Error in preview</div>
                <div className="err-text">{lastError.message}</div>
                {(lastEditedFile || selection?.file) && (
                  <button
                    className="btn btn-primary btn-block"
                    onClick={() =>
                      runAutoFix(
                        lastError.message + (lastError.stack ? '\n' + lastError.stack : ''),
                        (lastEditedFile ?? selection?.file)!
                      )
                    }
                  >
                    Fix this error
                  </button>
                )}
                <button className="btn btn-block" onClick={() => setLastError(null)}>
                  Dismiss
                </button>
              </div>
            )}

            <AgentPanel
              projectPath={project.path}
              providerId={providerId}
              model={model}
              providers={providers}
              onApplied={onAgentApplied}
              onProblems={(items) => items.forEach((it) => addProblem('ai-check', it.message, it.file))}
              seed={agentSeed}
              showGit={surface.git}
            />
          </aside>
        )}
        {/* The only way back once the Agent panel is hidden — mirrors the left ActivityBar always
            staying on screen when the sidebar is collapsed. Never shows in Builder Mode: dockOpen is
            already permanently true there (dockAlwaysOn), so this condition never fires. */}
        {!!project && !dockOpen && (
          <button
            type="button"
            className={`right-reopen-tab ${agentBusy.running ? 'busy' : ''}`}
            onClick={() => setShowAgent(true)}
            title={`Show Agent (${key('A', { shift: true })})`}
            aria-label={agentBusy.running ? 'Show Agent — running' : 'Show Agent'}
          >
            <Icon name="robot" size={15} />
            {/* The word, set vertically. An unlabelled 22px glyph is a mystery button; this is the
                one control that says where the agent went, so it says it. */}
            <span className="right-reopen-label" aria-hidden="true">Agent</span>
            {agentBusy.running && <span className="right-reopen-dot" aria-hidden="true" />}
          </button>
        )}
      </div>


      {/* Status bar: the four things a non-coder always needs to know */}
      <footer className="statusbar">
        <button className="status-chip" onClick={() => openPanel('activity')} title="Open the activity log">
          <span className={`status-dot sd-${server.status}`} />
          {statusPreviewText}
        </button>
        <button className="status-chip" onClick={() => setShowSettings(true)} title="Change the AI model">
          AI: {provider?.label ?? providerId}
          {model.trim() ? ` · ${model.trim()}` : ''}
        </button>
        {(agentBusy.running || agentBusy.queued > 0) && (
          <button className="status-chip status-chip-busy" onClick={() => setShowAgent(true)} title="The agent keeps working even with its panel closed">
            <span className="status-dot sd-starting" />
            Agent: working…{agentBusy.queued > 0 ? ` (+${agentBusy.queued} queued)` : ''}
          </button>
        )}
        {usage.requests > 0 && (
          <button className="status-chip" onClick={() => setShowSettings(true)} title={`${usage.requests} AI requests this session${usage.capTokens ? ` · cap ~${usage.capTokens.toLocaleString()} tokens` : ' · no cap set'}${usage.lastModel ? ` · last: ${usage.lastModel}` : ''}`}>
            AI spend: {usage.requests} req · ~{(usage.estTokens / 1000).toFixed(1)}k tok{usage.capTokens ? ` / ${(usage.capTokens / 1000).toFixed(0)}k` : ''}
          </button>
        )}
        <span className="spacer" />
        {/* Which personality is on, and one click to change it — the only always-visible route to
            the switch, so a Builder user who hid the code can always get it back. */}
        <button
          className="status-chip mode-chip"
          onClick={() => switchMode(mode === 'builder' ? 'developer' : 'builder')}
          title={
            mode === 'builder'
              ? 'Builder mode — no code on screen. Click for Developer mode (editor, files, terminal, git).'
              : 'Developer mode — the full IDE. Click for Builder mode (chat and preview only).'
          }
        >
          <Icon name={mode === 'builder' ? 'sparkle' : 'braces'} size={11} /> {describeMode(mode).title} mode
        </button>
        {branch && surface.git && (
          <button className="status-chip" onClick={() => setSidebarView('scm')} title="Open Source Control">
            <Icon name="git-branch" size={11} /> {branch}
          </button>
        )}
        {remoteState.connected && (
          <button className="status-chip status-chip-remote" onClick={() => openPanel('company')} title="Company server connection">
            Company server: Connected
          </button>
        )}
        {managed && (
          <span className="status-chip" title="An enterprise policy file controls AI providers and export rules on this machine">
            <Icon name="shield" size={11} /> Managed by your company
          </span>
        )}
        <button
          className={`status-chip air-gap-chip${airGapped ? ' status-chip-airgap' : ''}`}
          onClick={() => void toggleAirGap()}
          title={airGapped ? 'Air-Gapped: only the local model runs; outbound AI is blocked. Click to turn off.' : 'Click to air-gap: block all outbound AI and use the local model only.'}
        >
          {airGapped ? <><Icon name="lock" size={11} /> Air-gapped</> : <><Icon name="globe" size={11} /> Online AI</>}
        </button>
      </footer>

      {/* Settings modal */}
      {showSettings && (
        <Modal
          label="Settings"
          onClose={() => {
            setShowSettings(false)
            setSettingsInitialTab(undefined)
          }}
        >
          <SettingsPanel
            providers={providers}
            providerId={providerId}
            onProviderChange={setProviderId}
            provider={provider}
            model={model}
            onModelChange={setModel}
            keyInput={keyInput}
            onKeyInputChange={setKeyInput}
            hasKey={hasKey}
            onSaveKey={saveKey}
            autocompleteOn={autocompleteOn}
            onAutocompleteChange={setAutocompleteOn}
            editorPrefs={editorPrefs}
            onEditorPrefsChange={setEditorPrefs}
            autoFixOn={autoFixOn}
            onAutoFixChange={setAutoFixOn}
            airGapped={airGapped}
            onToggleAirGap={() => void toggleAirGap()}
            mode={mode}
            onModeChange={switchMode}
            initialTab={settingsInitialTab}
            onMsg={(type, text) => setEditMsg({ type, text })}
          />
        </Modal>
      )}

      {/* New project modal */}
      {showNewProject && (
        <Modal
          label="New project"
          className="modal np-modal"
          dismissible={!npBusy}
          onClose={() => setShowNewProject(false)}
        >
          <div className="settings-title">New project</div>
          <label className="settings-field">
            Name
            <input
              autoFocus
              className="text-input"
              placeholder="my-app"
              value={npName}
              onChange={(e) => setNpName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void createNewProject()}
            />
          </label>
          <label className="settings-field">
            Template
            <select className="text-input" value={npTemplate} onChange={(e) => setNpTemplate(e.target.value)}>
              {(npTemplates.length ? npTemplates : [{ id: 'static-html', label: 'Simple website (no setup)' }]).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">Next you'll pick where to put it — then it opens, ready to preview.</p>
          <div className="git-row">
            <button className="btn btn-primary" onClick={createNewProject} disabled={npBusy}>
              {npBusy ? 'Creating…' : 'Choose location & create'}
            </button>
            <button className="btn" onClick={() => setShowNewProject(false)} disabled={npBusy}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* ⌘⇧P command palette */}
      {showPalette && <CommandPalette actions={paletteActions} onClose={() => setShowPalette(false)} />}
      {showThemePicker && (
        <ThemePicker onClose={() => setShowThemePicker(false)} onMsg={(type, text) => setEditMsg({ type, text })} />
      )}

      {/* ⌘P Search Everywhere (over the background AI project index) */}
      {showQuickOpen && project && (
        <QuickOpen projectPath={project.path} onOpen={openFileAtLine} onClose={() => setShowQuickOpen(false)} />
      )}
    </div>
  )
}
