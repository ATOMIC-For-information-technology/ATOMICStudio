import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import {
  BranchPicker, CloneSheet, Composer, ConflictBanner, DiffView, Menu, PublishSheet, RefreshCoordinator, RemoteBar, ScmHeader, ScmRow, WindowedList,
  applyPendingMoves, buildItems, commitBlocker, deriveGitView, deriveRemote, indexOfKey, moveFocus, reconcileSelection, remoteHost,
  rowKey, selectByClick, actionTargets, EMPTY_SELECTION
} from './git-panel'
import type { HistoryState, ListSelection, MenuEntry, PendingMove, RowHandlers, ScmItem, ScmList, ScmSectionId } from './git-panel'
import { can } from '../../../shared/roles'
import { repoNameError, validRepoName } from '../../../shared/gitnames'
import type {
  ForgeInfo, ForgeRepo, GitBranch, GitCommitInfo, GitDiffMode, GitFileDiff, GitRemote, GitSnapshot, IdentityStatus, PublishPlan, PublishResult
} from '../../../shared/types'

interface Props {
  projectPath: string | null
  providerId: string
  model: string
  /** Called with the cloned repo's path so the shell can open it as a project. */
  onCloned: (path: string) => void
  onMsg: (type: 'ok' | 'err', text: string) => void
  /** Fired after an action that REWRITES files on disk (checkout/pull/merge/discard), so open tabs can be re-read. */
  onFilesChanged?: () => void
  /** Open a file in the editor — used for "Open" and for jumping to a conflicted file. */
  onOpenFile?: (relPath: string) => void
  /** Bumped by the shell whenever anything writes to the project from OUTSIDE the app. */
  refreshKey?: number
  /** Bumped by the shell to open the clone sheet (the Welcome screen's "Clone a repository"). */
  cloneRequest?: number
  /** Opens Settings on a given tab — used to send an unconfigured "Publish this folder" to the Git server tab. */
  onOpenSettings?: (tab: 'git') => void
}

/** Development instrumentation, read by `scripts/test-ui.cjs`. Never shown in the UI. */
interface ScmPerf {
  refreshes: number
  lastRefreshMs: number
  lastProcesses: number
  mountedRows: number
  coalesced: number
  dropped: number
  ipc: Record<string, number>
}
declare global {
  interface Window {
    __scmPerf?: ScmPerf
  }
}
const perf: ScmPerf = { refreshes: 0, lastRefreshMs: 0, lastProcesses: 0, mountedRows: 0, coalesced: 0, dropped: 0, ipc: {} }
const count = (name: string): void => {
  perf.ipc[name] = (perf.ipc[name] ?? 0) + 1
  if (typeof window !== 'undefined') window.__scmPerf = perf
}

const ROW_H = 22
/** Below this width the diff stacks under the list instead of beside it. */
const WIDE_PX = 760

/**
 * Source Control.
 *
 * This file is the ORCHESTRATOR only: every piece of view lives in `git-panel/`, and every
 * fold that can be checked without a window lives in `git-panel/derive.ts`.
 *
 * Shape (2026-09-02, replacing a vertical stack of forms): a sticky 22px header (branch,
 * divergence, the remote verbs, overflow) → attention strips only when they apply (merge,
 * no remote, ignored folder) → a PINNED commit composer → ONE windowed list holding Staged /
 * Changes / Conflicts / History as 22px rows → a diff pane beside the list when the panel is
 * wide enough, under it when not. Cloning and server setup live in the empty state and the
 * overflow menu, not at the top of every repository view.
 *
 * Refresh discipline: one `gitSnapshot` (one git process) per refresh, through a coordinator
 * that debounces watcher bursts, keeps a single request in flight, coalesces the rest and
 * drops results from a repository that is no longer open. Branches, history and remotes are
 * COLD — read when their UI is opened and served from a stamp-validated cache in the main
 * process after that.
 */
export function GitPanel({ projectPath, providerId, model, onCloned, onMsg, onFilesChanged, onOpenFile, refreshKey = 0, cloneRequest = 0, onOpenSettings }: Props): React.JSX.Element {
  /* ── forges / clone ─────────────────────────────────────────────────────────────────── */
  const [forges, setForges] = useState<ForgeInfo[]>([])
  const [activeForge, setActiveForge] = useState('')
  const [repos, setRepos] = useState<ForgeRepo[]>([])
  const [showRepos, setShowRepos] = useState(false)
  const [reposLoaded, setReposLoaded] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [cloneOpen, setCloneOpen] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  useEffect(() => {
    if (cloneRequest > 0) setCloneOpen(true)
  }, [cloneRequest])
  /** A managed seat that has not signed in looks exactly like an unconfigured one. It isn't. */
  const [needsSignIn, setNeedsSignIn] = useState(false)
  useEffect(() => {
    void window.studio.identityStatus().then((st) => setNeedsSignIn(st.required && !st.signedIn))
    return window.studio.onIdentityChanged((st) => setNeedsSignIn(st.required && !st.signedIn))
  }, [])
  /**
   * Gates "Publish this folder" on the `createRepo` capability — ABSENT, not disabled, when the
   * role lacks it (no dead controls). Defaults true so an unmanaged seat (the common case) never
   * waits on this round trip to see the button; an unmanaged seat has no roles at all and must
   * behave exactly as it always has (`roles.ts`'s `surfaceAllowed`).
   */
  const [canCreateRepo, setCanCreateRepo] = useState(true)
  useEffect(() => {
    const apply = (st: IdentityStatus): void =>
      setCanCreateRepo(!st.required || (st.identity ? can(st.identity.role, 'createRepo') : false))
    void window.studio.identityStatus().then(apply)
    return window.studio.onIdentityChanged(apply)
  }, [])
  const refreshForges = useCallback(async () => {
    const list = await window.studio.forgeList()
    setForges(list)
    // FORGES is ordered self-hosted-first in the main process, so this lands on the team's own
    // server whenever one is configured.
    setActiveForge((cur) => cur || list.find((f) => f.signedIn)?.id || list[0]?.id || '')
  }, [])
  useEffect(() => { void refreshForges() }, [refreshForges])

  /* ── hot state: the snapshot, through the coordinator ───────────────────────────────── */
  const [snap, setSnap] = useState<GitSnapshot | null>(null)
  const [pending, setPending] = useState<Map<string, PendingMove>>(new Map())
  const coord = useRef<RefreshCoordinator<GitSnapshot> | null>(null)

  useEffect(() => {
    setSnap(null)
    setPending(new Map())
    if (!projectPath) return
    const c = new RefreshCoordinator<GitSnapshot>(
      () => {
        count('gitSnapshot')
        return window.studio.gitSnapshot(projectPath)
      },
      (s) => {
        perf.refreshes++
        perf.lastRefreshMs = s.perf.ms
        perf.lastProcesses = s.perf.processes
        perf.coalesced = c.stats.coalesced
        perf.dropped = c.stats.dropped
        window.__scmPerf = perf
        setSnap(s)
        // Drop optimistic moves git has caught up with. A failed request drops its entry at once;
        // a successful one waits for a status that agrees, so the row never snaps back and forth.
        setPending((prev) => {
          if (prev.size === 0) return prev
          const inStaged = new Set<string>()
          const inUnstaged = new Set<string>()
          for (const ch of s.changes) {
            if (ch.x !== ' ' && ch.x !== '?' && ch.x !== '!') inStaged.add(ch.file)
            if (ch.y !== ' ' && ch.y !== '!') inUnstaged.add(ch.file)
          }
          const next = new Map(prev)
          for (const [file, to] of prev) {
            const agrees = to === 'staged' ? inStaged.has(file) || !inUnstaged.has(file) : inUnstaged.has(file) || !inStaged.has(file)
            if (agrees) next.delete(file)
          }
          return next.size === prev.size ? prev : next
        })
      },
      100
    )
    coord.current = c
    c.request(true)
    const offGit = window.studio.onGitChanged(() => c.request())
    return () => {
      offGit()
      c.dispose()
      if (coord.current === c) coord.current = null
    }
  }, [projectPath])

  useEffect(() => {
    if (refreshKey > 0) coord.current?.request()
  }, [refreshKey])

  const refresh = useCallback((immediate = true) => coord.current?.request(immediate), [])

  /* ── cold state: remotes, branches, history ─────────────────────────────────────────── */
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const loadRemotes = useCallback(async () => {
    if (!projectPath) return
    count('gitRemotes')
    setRemotes(await window.studio.gitRemotes(projectPath))
  }, [projectPath])
  const isRepo = snap?.isRepo === true
  useEffect(() => {
    setRemotes([])
    if (isRepo) void loadRemotes()
  }, [isRepo, loadRemotes])

  const [branches, setBranches] = useState<GitBranch[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const loadBranches = useCallback(async () => {
    if (!projectPath) return
    setBranchesLoading(true)
    count('gitBranches')
    setBranches(await window.studio.gitBranches(projectPath))
    setBranchesLoading(false)
  }, [projectPath])
  useEffect(() => {
    if (pickerOpen) void loadBranches()
  }, [pickerOpen, loadBranches])

  const [collapsed, setCollapsed] = useState<Record<ScmSectionId, boolean>>({ staged: false, unstaged: false, conflicts: false, history: true })
  const EMPTY_HISTORY: HistoryState = { loaded: false, loading: false, commits: [], openCommit: null, commitFiles: {}, nextSkip: null, loadingMore: false }
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY)
  /**
   * Bumped whenever history is re-read from the start, so a page still in flight for the PREVIOUS
   * repository — or for a history that has since been reloaded after a commit — is dropped rather
   * than appended to the new one. Same guard as `diffToken`, for the same reason: `gitLog` is a
   * real process and its timing is not guaranteed.
   */
  const historyToken = useRef(0)
  const HISTORY_PAGE = 50

  const loadHistory = useCallback(async () => {
    if (!projectPath) return
    const token = ++historyToken.current
    setHistory((h) => ({ ...h, loading: true }))
    count('gitLog')
    const page = await window.studio.gitLog(projectPath, { limit: HISTORY_PAGE })
    if (token !== historyToken.current) return
    setHistory((h) => ({ ...h, loaded: true, loading: false, loadingMore: false, commits: page.commits, nextSkip: page.nextSkip }))
  }, [projectPath])

  /** Append the next page. Never runs twice concurrently, and never on a stale token. */
  const loadMoreHistory = useCallback(async () => {
    if (!projectPath) return
    const token = historyToken.current
    let skip: number | null = null
    setHistory((h) => {
      if (h.loadingMore || h.nextSkip === null) return h
      skip = h.nextSkip
      return { ...h, loadingMore: true }
    })
    if (skip === null) return
    count('gitLog')
    const page = await window.studio.gitLog(projectPath, { skip, limit: HISTORY_PAGE })
    if (token !== historyToken.current) return
    setHistory((h) => {
      // Concatenating pages can duplicate a commit when someone commits between two requests and
      // everything shifts down by one. Dedupe by hash so the list never shows the same commit twice
      // — the keys are the hash, and React would otherwise warn about it too.
      const seen = new Set(h.commits.map((c) => c.hash))
      const added = page.commits.filter((c) => !seen.has(c.hash))
      return { ...h, loadingMore: false, commits: [...h.commits, ...added], nextSkip: page.nextSkip }
    })
  }, [projectPath])

  useEffect(() => {
    historyToken.current++
    setHistory(EMPTY_HISTORY)
    // EMPTY_HISTORY is a fresh object each render but is only ever used as a reset value, so it is
    // deliberately not a dependency — including it would reset history on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath])
  const historyOpen = !collapsed.history
  useEffect(() => {
    if (historyOpen && isRepo) void loadHistory()
  }, [historyOpen, isRepo, loadHistory])
  const toggleCommit = useCallback(
    async (hash: string) => {
      setHistory((h) => ({ ...h, openCommit: h.openCommit === hash ? null : hash }))
      if (!history.commitFiles[hash] && projectPath) {
        count('gitCommitFiles')
        const files = await window.studio.gitCommitFiles(projectPath, hash)
        setHistory((h) => ({ ...h, commitFiles: { ...h.commitFiles, [hash]: files } }))
      }
    },
    [history.commitFiles, projectPath]
  )

  /* ── the view ───────────────────────────────────────────────────────────────────────── */
  const view = useMemo(() => applyPendingMoves(deriveGitView(snap), pending), [snap, pending])
  const remote = useMemo(() => deriveRemote(remotes, view.upstream), [remotes, view.upstream])
  const items = useMemo(() => buildItems(view, collapsed, history), [view, collapsed, history])
  const itemsRef = useRef(items)
  itemsRef.current = items

  const [selection, setSelection] = useState<ListSelection>(EMPTY_SELECTION)
  useEffect(() => {
    setSelection((s) => reconcileSelection(items, s))
  }, [items])
  useEffect(() => { setSelection(EMPTY_SELECTION) }, [projectPath])

  const [busy, setBusy] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [draftText, setDraftText] = useState('')
  const [overflowOpen, setOverflowOpen] = useState(false)
  /**
   * Keyed by row IDENTITY, never by position.
   *
   * This held an `index` into `items`, read back at click time from the CURRENT array. A watcher
   * refresh lands on its own schedule — another window stages a file, a build writes to the tree —
   * and rows are inserted, removed or reordered underneath an open menu. "Discard changes" then ran
   * against whatever row had slid into that slot rather than the one that was right-clicked, which
   * is how a destructive action ends up on the wrong file. derive.ts documents choosing keys over
   * indexes for exactly this reason when `selection` was fixed; the context menu was missed. A key
   * that has left the list now resolves to nothing and the menu closes, matching the diff pane.
   */
  const [ctxMenu, setCtxMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string[] | null>(null)

  /* ── the diff pane ──────────────────────────────────────────────────────────────────── */
  const [openDiff, setOpenDiff] = useState<{ list: ScmList; file: string; mode: GitDiffMode; orig?: string } | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  /** Bumped per request so a slow answer for a row you already clicked away from is dropped. */
  const diffToken = useRef(0)
  const showDiff = useCallback(
    async (list: ScmList, file: string, orig?: string, code?: string) => {
      if (!projectPath) return
      const mode: GitDiffMode = list === 'staged' ? 'staged' : list === 'conflicts' ? 'conflict' : code === '?' ? 'untracked' : 'unstaged'
      const token = ++diffToken.current
      setOpenDiff({ list, file, mode, orig })
      setDiff(null)
      setDiffLoading(true)
      count('gitDiffFile')
      const res = await window.studio.gitDiffFile(projectPath, file, mode, orig)
      if (token !== diffToken.current) return
      setDiffLoading(false)
      setDiff(res)
    },
    [projectPath]
  )
  const closeDiff = useCallback(() => {
    diffToken.current++
    setOpenDiff(null)
    setDiff(null)
    setDiffLoading(false)
  }, [])
  useEffect(() => { closeDiff() }, [projectPath, closeDiff])
  // A row that left its list takes its diff with it: showing "staged" content under a row that
  // has since been unstaged is exactly the kind of lie the mode label exists to prevent.
  useEffect(() => {
    if (openDiff && indexOfKey(items, rowKey(openDiff.list, openDiff.file)) < 0) closeDiff()
  }, [items, openDiff, closeDiff])
  // Same rule for the context menu: a menu whose row is gone would offer Stage and Discard with
  // nothing to apply them to, so it closes rather than lingering over a list it no longer matches.
  useEffect(() => {
    if (ctxMenu && indexOfKey(items, ctxMenu.key) < 0) setCtxMenu(null)
  }, [items, ctxMenu])

  /* ── mutations ──────────────────────────────────────────────────────────────────────── */

  /** Stage or unstage, optimistically. Only the affected rows show as busy. */
  const moveFiles = useCallback(
    async (files: string[], to: PendingMove) => {
      if (!projectPath || files.length === 0) return
      setPending((prev) => {
        const next = new Map(prev)
        for (const f of files) next.set(f, to)
        return next
      })
      count(to === 'staged' ? 'gitStage' : 'gitUnstage')
      const res = to === 'staged' ? await window.studio.gitStage(projectPath, files) : await window.studio.gitUnstage(projectPath, files)
      if (!res.ok) {
        onMsg('err', res.error ?? (to === 'staged' ? 'Could not stage.' : 'Could not unstage.'))
        setPending((prev) => {
          const next = new Map(prev)
          for (const f of files) next.delete(f)
          return next
        })
      }
      refresh(true)
    },
    [projectPath, onMsg, refresh]
  )

  /**
   * Every mutating action funnels through here so that exactly one place decides when open
   * editor tabs must be re-read and which cold data to reload. Checkout/pull/merge REWRITE
   * files under the editor; without the signal the tab keeps the old content and the next ⌘S
   * writes it straight back over the new one.
   */
  const run = useCallback(
    async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
      setBusy(label)
      const res = await fn()
      setBusy(null)
      if (res.ok) {
        onMsg('ok', okText)
        if (/checkout|pull|switch|merge|resolve|abort|branch/i.test(label)) onFilesChanged?.()
      } else onMsg('err', res.error ?? `${label} failed.`)
      refresh(true)
      if (/fetch|pull|push|publish|connect|checkout|branch|merge/i.test(label)) {
        void loadRemotes()
        if (branches.length) void loadBranches()
      }
      if (history.loaded && /commit|pull|merge|checkout|branch/i.test(label)) void loadHistory()
    },
    [onMsg, onFilesChanged, refresh, loadRemotes, loadBranches, branches.length, history.loaded, loadHistory]
  )

  const commit = useCallback(
    (all = false) => {
      if (!projectPath) return
      const m = commitMsg
      if (!m.trim()) return onMsg('err', 'Write a commit message first.')
      setCommitMsg('')
      const n = all ? view.staged.length + view.unstaged.length : view.staged.length
      void run('commit', () => window.studio.gitCommit(projectPath, m, all), all ? 'Committed everything.' : `Committed ${n} file${n === 1 ? '' : 's'}.`)
    },
    [projectPath, commitMsg, onMsg, view.staged.length, view.unstaged.length, run]
  )

  const draft = useCallback(
    async (kind: 'commit' | 'pr' | 'release') => {
      if (!projectPath) return
      setBusy(`draft-${kind}`)
      const res = await window.studio.draftGitText(kind, projectPath, providerId, model.trim() || undefined)
      setBusy(null)
      if (res.ok && res.text) {
        if (kind === 'commit') setCommitMsg(res.text.trim())
        else setDraftText(res.text)
      } else onMsg('err', res.error ?? 'Could not draft it.')
    },
    [projectPath, providerId, model, onMsg]
  )

  /**
   * Throw away the working-tree changes to tracked files. Destructive, so it is confirmed in a
   * strip first — but NOT unrecoverable: `gitRestoreFile` snapshots the current contents before
   * writing HEAD back, so each file lands on the one-click Undo stack. Untracked files are never
   * offered here: there is no committed version, so "discard" would mean deleting a file git has
   * never seen, which is a different and more dangerous act.
   */
  const performDiscard = useCallback(
    async (files: string[]) => {
      if (!projectPath) return
      setConfirmDiscard(null)
      setBusy('discard')
      let failed = 0
      for (const f of files) {
        count('gitRestoreFile')
        const res = await window.studio.gitRestoreFile(projectPath, f)
        if (!res.ok) failed++
      }
      setBusy(null)
      if (failed === 0) onMsg('ok', files.length === 1 ? `Discarded your changes to ${files[0]}. Undo brings them back.` : `Discarded ${files.length} files' changes. Undo brings them back.`)
      else onMsg('err', `Could not discard ${failed} of ${files.length} files.`)
      onFilesChanged?.()
      if (openDiff && files.includes(openDiff.file)) closeDiff()
      refresh(true)
    },
    [projectPath, onMsg, onFilesChanged, openDiff, closeDiff, refresh]
  )

  const resolveFiles = useCallback(
    async (files: string[]) => {
      if (!projectPath) return
      for (const f of files) {
        const res = await window.studio.gitResolveFile(projectPath, f)
        if (!res.ok) onMsg('err', res.error ?? `Could not mark ${f} resolved.`)
      }
      refresh(true)
    },
    [projectPath, onMsg, refresh]
  )

  const connectRemote = useCallback(
    async (url: string) => {
      if (!projectPath) return
      setBusy('connect')
      const add = await window.studio.gitRemoteAdd(projectPath, 'origin', url)
      if (!add.ok) {
        setBusy(null)
        onMsg('err', add.error ?? 'Could not set the remote.')
        return
      }
      const push = await window.studio.gitPush(projectPath, true)
      setBusy(null)
      if (push.ok) onMsg('ok', `Connected to ${remoteHost(url)} and pushed ${view.branch}.`)
      // The remote IS set at this point. Saying "connect failed" would send the user to add it
      // again; saying what actually happened sends them to the real problem, which is the push.
      else onMsg('err', `Remote saved, but the push failed: ${push.error ?? 'unknown error'}`)
      setConnectOpen(false)
      void loadRemotes()
      refresh(true)
    },
    [projectPath, onMsg, view.branch, loadRemotes, refresh]
  )

  const publishBranch = useCallback(() => {
    if (!projectPath) return
    void run('publish', () => window.studio.gitPush(projectPath, true), `Published ${view.branch} to ${remote.host}.`)
  }, [projectPath, run, view.branch, remote.host])

  const merge = useCallback(
    async (b: string) => {
      if (!projectPath) return
      setPickerOpen(false)
      setBusy('merge')
      const res = await window.studio.gitMerge(projectPath, b)
      setBusy(null)
      // Conflicts are DATA, not a failure: say what happened plainly and let the strip and the
      // Conflicts section take over. A red "merge failed" here would be a lie.
      if (res.ok) onMsg('ok', `Merged ${b}.`)
      else if (res.conflicts.length) onMsg('ok', `Merged ${b} — ${res.conflicts.length} file${res.conflicts.length === 1 ? '' : 's'} need your attention.`)
      else onMsg('err', res.error ?? 'Merge failed.')
      onFilesChanged?.()
      refresh(true)
      if (history.loaded) void loadHistory()
    },
    [projectPath, onMsg, onFilesChanged, refresh, history.loaded, loadHistory]
  )

  /* ── clone / forge ──────────────────────────────────────────────────────────────────── */
  const signIn = useCallback(async () => {
    if (!tokenInput.trim() || !activeForge) return
    await window.studio.setApiKey(activeForge, tokenInput.trim())
    setTokenInput('')
    await refreshForges()
  }, [tokenInput, activeForge, refreshForges])
  const loadRepos = useCallback(async () => {
    setBusy('repos')
    count('forgeRepos')
    setRepos(await window.studio.forgeRepos(activeForge))
    setReposLoaded(true)
    setShowRepos(true)
    setBusy(null)
  }, [activeForge])
  const cloneRepo = useCallback(
    async (repo: ForgeRepo) => {
      const dest = await window.studio.pickFolder()
      if (!dest) return
      setBusy(repo.fullName)
      const res = await window.studio.gitClone(repo.cloneUrl, dest)
      setBusy(null)
      if (res.ok && res.path) {
        onMsg('ok', `Cloned ${repo.fullName}.`)
        setCloneOpen(false)
        onCloned(res.path)
      } else onMsg('err', res.error ?? 'Clone failed.')
    },
    [onCloned, onMsg]
  )
  /** Clone any URL — the escape hatch that keeps Studio honest about not needing a forge. */
  const cloneFromUrl = useCallback(async () => {
    // NOT window.prompt(): Electron throws "prompt() is and will not be supported", and because
    // the click handler is `void cloneFromUrl()` that rejection was swallowed — the button did
    // nothing whatsoever. The URL comes from a real field in the sheet.
    const url = urlInput
    if (!url.trim()) return
    const dest = await window.studio.pickFolder()
    if (!dest) return
    setBusy('clone-url')
    const res = await window.studio.gitClone(url.trim(), dest)
    setBusy(null)
    if (res.ok && res.path) {
      onMsg('ok', 'Cloned.')
      setUrlInput('')
      setCloneOpen(false)
      onCloned(res.path)
    } else onMsg('err', res.error ?? 'Clone failed.')
  }, [onCloned, onMsg, urlInput])
  const forgeName = forges.find((f) => f.id === activeForge)?.name ?? 'the server'

  /* ── "Publish this folder" ──────────────────────────────────────────────────────────── */
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishName, setPublishName] = useState('')
  const [publishPlan, setPublishPlan] = useState<PublishPlan | null>(null)
  const [publishPlanning, setPublishPlanning] = useState(false)
  /** Set only when a re-plan for the CURRENT name comes back with an error, so the sheet can say
   *  why there is no command rather than the generic "enter a name" hint. */
  const [publishPlanError, setPublishPlanError] = useState<string | null>(null)
  const [publishBusy, setPublishBusy] = useState(false)
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null)
  const [publishOpening, setPublishOpening] = useState(false)
  /** The name `publishPlan` was actually planned for — lets the re-plan effect skip a redundant
   *  round trip right after opening (when the suggested name already matches what was planned). */
  const plannedNameRef = useRef<string | null>(null)
  /**
   * A live mirror of `publishName`, read only inside the re-plan effect's `.then` — see below.
   * `gitPublishPlan` does a REAL SSH round trip, so its timing is not guaranteed: editing the name
   * twice in quick succession can let the FIRST request's response arrive after the SECOND's. A
   * plain closure over `publishName` would still see whatever value was current when the effect
   * was set up, which is exactly the stale value a naive re-plan can (and, per review, DID) install
   * over a newer, correct one. Reading a ref that's updated synchronously wherever the name changes
   * — never through this effect itself — lets each response compare itself against whatever is
   * ACTUALLY in the field right now, not what it was when the request was sent.
   */
  const publishNameRef = useRef('')

  const openPublish = useCallback(async () => {
    if (!projectPath || publishOpening) return
    setPublishOpening(true)
    const base = projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
    const suggested = validRepoName(base) ? base : ''
    // `gitPublishPlan` changes NOTHING — planning against a placeholder when the folder's own
    // name would be rejected still gets a real preflight ladder onto the screen; only the FIELD
    // stays empty, never pre-filled with a name that would just be rejected.
    const probeName = suggested || 'repo'
    const res = await window.studio.gitPublishPlan(projectPath, probeName)
    setPublishOpening(false)
    if ('error' in res) {
      // The one branch a brand-new user hits first: send them to fix it rather than dead-ending.
      if (res.error === 'No git server is configured yet.') {
        onOpenSettings?.('git')
        return
      }
      onMsg('err', res.error)
      return
    }
    plannedNameRef.current = probeName
    publishNameRef.current = suggested
    setPublishName(suggested)
    setPublishPlan(res)
    setPublishPlanError(null)
    setPublishResult(null)
    setPublishOpen(true)
  }, [projectPath, publishOpening, onOpenSettings, onMsg])

  /**
   * The invariant this whole sheet exists to hold is "the visible plan always matches the visible
   * name" — and per review, that is worth making STRUCTURAL rather than something re-plan guards
   * have to keep re-establishing. So a name edit clears the plan the INSTANT it happens, in the
   * same event as `setPublishName` (React batches these — there is no render in between where a
   * stale plan is shown beside a new name), not only once its own re-plan resolves. The `<pre>`
   * then has exactly one way to show a command: a response that (a) is for the name still in the
   * field when it arrives and (b) was not itself superseded by a later request — both enforced in
   * the effect below.
   */
  const handleNameChange = useCallback((v: string) => {
    publishNameRef.current = v
    setPublishName(v)
    setPublishPlan(null)
    setPublishPlanError(null)
    setPublishResult(null)
    plannedNameRef.current = null
  }, [])

  // Re-plan — still side-effect-free — whenever the name changes to something that passes client
  // validation, so `plan.command` in the sheet always matches the name actually in the field.
  // Debounced: `gitPublishPlan` re-runs the SSH preflight, and must not fire on every keystroke.
  useEffect(() => {
    if (!publishOpen || !projectPath) return
    if (repoNameError(publishName) || plannedNameRef.current === publishName) return
    setPublishPlanning(true)
    const requestedName = publishName
    const t = setTimeout(() => {
      void window.studio.gitPublishPlan(projectPath, requestedName).then((res) => {
        // Discard a superseded response. `gitPublishPlan` does a real SSH round trip, so an
        // EARLIER debounce fire's request can resolve AFTER a LATER one — this is not a
        // theoretical race, review caught it landing a wrong-name plan in practice. Only a
        // response for the name CURRENTLY in the field (read from the ref, not this closure) may
        // ever become the visible plan; anything else would let Create run a command that no
        // longer matches what's on screen.
        if (requestedName !== publishNameRef.current) return
        setPublishPlanning(false)
        if ('error' in res) {
          // `plan` is already null (cleared the moment the name changed, above) — surface WHY
          // rather than leave the generic "enter a name" hint standing in for a real failure.
          setPublishPlanError(res.error)
          return
        }
        plannedNameRef.current = requestedName
        setPublishPlan(res)
      })
    }, 400)
    return () => { clearTimeout(t); setPublishPlanning(false) }
  }, [publishName, publishOpen, projectPath])

  // `gitPublishRun` — the ONLY call in this file with side effects — fires from here alone,
  // never on open, on a name keystroke, or on blur.
  const confirmPublish = useCallback(async () => {
    if (!projectPath) return
    setPublishBusy(true)
    const res = await window.studio.gitPublishRun(projectPath, publishName)
    setPublishBusy(false)
    setPublishResult(res)
  }, [projectPath, publishName])

  const closePublish = useCallback(() => {
    setPublishOpen(false)
    setPublishPlan(null)
    setPublishPlanError(null)
    setPublishResult(null)
    setPublishName('')
    publishNameRef.current = ''
    plannedNameRef.current = null
  }, [])
  /**
   * A plan belongs to the folder it was planned for, and to no other.
   *
   * Every other piece of state here is reset on `projectPath` — the snapshot, the selection, the
   * open diff, the history. The publish sheet was not, and it is the one that ends in a real SSH
   * round trip. Open the sheet on a non-repository folder A, switch the project to another
   * non-repository folder B, and the empty state renders again with `publishOpen` still true: the
   * sheet reappears showing A's name and A's command. The re-plan effect cannot correct it, because
   * its `plannedNameRef.current === publishName` guard is still satisfied and it returns without
   * re-planning. Confirming from there calls `gitPublishRun` with B's path and a plan that was
   * never validated against B — provisioning a repository the user never confirmed for that folder.
   */
  useEffect(() => { closePublish() }, [projectPath, closePublish])

  /* ── list interaction ───────────────────────────────────────────────────────────────── */
  const stageOrUnstage = useCallback(
    (list: ScmList, files: string[]) => {
      if (list === 'staged') void moveFiles(files, 'unstaged')
      else if (list === 'unstaged') void moveFiles(files, 'staged')
      else void resolveFiles(files)
    },
    [moveFiles, resolveFiles]
  )
  const requestDiscard = useCallback(
    (files: string[]) => {
      const tracked = files.filter((f) => view.unstaged.some((r) => r.file === f && r.code !== '?'))
      if (tracked.length) setConfirmDiscard(tracked)
    },
    [view.unstaged]
  )

  const handlers: RowHandlers = useMemo(
    () => ({
      onClick: (index, e) => {
        setCtxMenu(null)
        const it = itemsRef.current[index]
        const next = selectByClick(itemsRef.current, selection, index, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey })
        setSelection(next)
        if (it?.kind === 'row' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          if (openDiff && openDiff.list === it.list && openDiff.file === it.row.file) closeDiff()
          else void showDiff(it.list, it.row.file, it.row.orig, it.row.code)
        }
      },
      onContextMenu: (index, e) => {
        e.preventDefault()
        const it = itemsRef.current[index]
        if (it?.kind !== 'row') return
        setSelection((s) => (s.selected.has(it.key) ? { ...s, focusKey: it.key } : selectByClick(itemsRef.current, s, index, {})))
        setCtxMenu({ key: it.key, x: e.clientX, y: e.clientY })
      },
      onToggleSection: (id) => setCollapsed((c) => ({ ...c, [id]: !c[id as ScmSectionId] })),
      onSectionAction: (id) => {
        if (id === 'unstaged') void moveFiles(view.unstaged.map((r) => r.file), 'staged')
        else if (id === 'staged') void moveFiles(view.staged.map((r) => r.file), 'unstaged')
      },
      onOpen: (file) => onOpenFile?.(file),
      onDiscard: (file) => requestDiscard([file]),
      onAct: (list, file) => stageOrUnstage(list, [file]),
      onToggleCommit: (hash) => void toggleCommit(hash),
      onLoadMore: () => void loadMoreHistory()
    }),
    [selection, openDiff, closeDiff, showDiff, moveFiles, view.unstaged, view.staged, onOpenFile, requestDiscard, stageOrUnstage, toggleCommit, loadMoreHistory]
  )

  const onListKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const list = itemsRef.current
      const focusIdx = indexOfKey(list, selection.focusKey)
      const focus = list[focusIdx]
      const move = (to: number): void => {
        e.preventDefault()
        setSelection((s) => moveFocus(list, s, to, e.shiftKey))
      }
      switch (e.key) {
        case 'ArrowDown': return move(focusIdx + 1)
        case 'ArrowUp': return move(focusIdx - 1)
        case 'PageDown': return move(focusIdx + 10)
        case 'PageUp': return move(focusIdx - 10)
        case 'Home': return move(0)
        case 'End': return move(list.length - 1)
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (focus?.kind === 'section') {
            e.preventDefault()
            setCollapsed((c) => ({ ...c, [focus.id]: e.key === 'ArrowLeft' }))
          } else if (focus?.kind === 'commit') {
            e.preventDefault()
            if ((e.key === 'ArrowRight') !== focus.open) void toggleCommit(focus.commit.hash)
          }
          return
        }
        case 'Enter': {
          e.preventDefault()
          if (!focus) return
          if (focus.kind === 'section') setCollapsed((c) => ({ ...c, [focus.id]: !c[focus.id] }))
          else if (focus.kind === 'commit') void toggleCommit(focus.commit.hash)
          else if (focus.kind === 'row') {
            if (e.metaKey || e.ctrlKey || focus.list === 'conflicts') onOpenFile?.(focus.row.file)
            else void showDiff(focus.list, focus.row.file, focus.row.orig, focus.row.code)
          }
          return
        }
        case ' ': {
          if (focus?.kind !== 'row') return
          e.preventDefault()
          const targets = actionTargets(list, selection, focus.list)
          if (targets.length) stageOrUnstage(focus.list, targets.map((r) => r.file))
          return
        }
        case 'Backspace':
        case 'Delete': {
          if (focus?.kind !== 'row' || focus.list !== 'unstaged') return
          e.preventDefault()
          requestDiscard(actionTargets(list, selection, 'unstaged').map((r) => r.file))
          return
        }
        case 'a': {
          if (!(e.metaKey || e.ctrlKey) || focus?.kind !== 'row') return
          e.preventDefault()
          const keys = list.filter((it): it is Extract<ScmItem, { kind: 'row' }> => it.kind === 'row' && it.list === focus.list).map((it) => it.key)
          setSelection((s) => ({ ...s, selected: new Set(keys) }))
          return
        }
        case 'Escape': {
          e.preventDefault()
          if (openDiff) closeDiff()
          else setSelection((s) => ({ ...s, selected: new Set() }))
          return
        }
        default:
      }
    },
    [selection, toggleCommit, onOpenFile, showDiff, stageOrUnstage, requestDiscard, openDiff, closeDiff]
  )

  /* ── menus ──────────────────────────────────────────────────────────────────────────── */

  /**
   * What "Commit all" will actually stage, said in the menu itself.
   *
   * It runs `git add -A`, and since git 2.0 that is repository-wide even when git's cwd is a
   * subdirectory — so in a project that is a SUBFOLDER of a bigger repo it reaches files this
   * view does not list. The row list is scoped to the opened folder, so the difference is
   * invisible unless the hint says it: "never claim a capability the app can't back up" cuts
   * both ways, and a commit that quietly swept up a sibling folder is exactly the surprise the
   * 2026-08-31 removal of the implicit `add -A` existed to prevent.
   */
  const commitAllHint = view.clean
    ? 'nothing to commit'
    : view.isRepoRoot
      ? 'stages everything first'
      : 'stages everything in the WHOLE repository, including files outside this folder'
  const overflow: MenuEntry[] = useMemo(() => {
    const noRemote = remote.state === 'no-remote'
    const out: MenuEntry[] = [
      { id: 'refresh', label: 'Refresh', icon: 'refresh' },
      { id: 'fetch', label: 'Fetch', icon: 'download', disabled: noRemote || !!busy, hint: noRemote ? 'no remote' : undefined },
      { id: 'pull', label: 'Pull', icon: 'arrow-down', disabled: noRemote || !view.upstream || !!busy, hint: noRemote ? 'no remote' : !view.upstream ? 'no upstream' : undefined },
      view.upstream || noRemote
        ? { id: 'push', label: 'Push', icon: 'arrow-up', disabled: noRemote || !!busy, hint: noRemote ? 'no remote' : undefined }
        : { id: 'publish', label: `Publish ${view.branch}`, icon: 'upload', disabled: !!busy },
      { id: 'commit-all', label: 'Commit all changes…', icon: 'check', section: true, disabled: view.clean || !!busy, hint: commitAllHint },
      { id: 'clone', label: 'Clone repository…', icon: 'download', section: true }
    ]
    if (noRemote) out.push({ id: 'connect', label: 'Connect to a server…', icon: 'globe' })
    if (view.merging) {
      out.push({ id: 'merge-abort', label: 'Abort merge', icon: 'undo', section: true, danger: true })
      out.push({ id: 'merge-continue', label: 'Finish merge', icon: 'check', disabled: view.conflicts.length > 0, hint: view.conflicts.length ? 'resolve conflicts first' : undefined })
    }
    return out
  }, [remote.state, busy, view.upstream, view.branch, view.clean, view.merging, view.conflicts.length, commitAllHint])

  const onOverflow = useCallback(
    (id: string) => {
      if (!projectPath) return
      switch (id) {
        case 'refresh': return refresh(true)
        case 'fetch': return void run('fetch', () => window.studio.gitFetch(projectPath), `Fetched from ${remote.host || forgeName}.`)
        case 'pull': return void run('pull', () => window.studio.gitPull(projectPath), 'Pulled the latest changes.')
        case 'push': return void run('push', () => window.studio.gitPush(projectPath, false), `Pushed to ${remote.host || forgeName}.`)
        case 'publish': return publishBranch()
        case 'commit-all': return commit(true)
        case 'clone': return setCloneOpen(true)
        case 'connect': return setConnectOpen(true)
        case 'merge-abort': return void run('merge-abort', () => window.studio.gitMergeAbort(projectPath), 'Merge abandoned.')
        case 'merge-continue': return void run('merge-continue', () => window.studio.gitMergeContinue(projectPath), 'Merge finished.')
        default:
      }
    },
    [projectPath, refresh, run, remote.host, forgeName, publishBranch, commit]
  )

  const composerMenu: MenuEntry[] = useMemo(
    () => [
      { id: 'commit-all', label: 'Commit all changes', icon: 'check', disabled: view.clean || !!busy, hint: commitAllHint },
      { id: 'ai-commit', label: 'Write the message with AI', icon: 'sparkle', section: true, disabled: !!busy || view.clean },
      { id: 'ai-pr', label: 'Draft a PR description', icon: 'file-text', disabled: !!busy || view.clean },
      { id: 'ai-release', label: 'Draft release notes', icon: 'file-text', disabled: !!busy || view.clean }
    ],
    [view.clean, busy, commitAllHint]
  )
  const onComposerMenu = useCallback(
    (id: string) => {
      if (id === 'commit-all') commit(true)
      else if (id === 'ai-commit') void draft('commit')
      else if (id === 'ai-pr') void draft('pr')
      else if (id === 'ai-release') void draft('release')
    },
    [commit, draft]
  )

  const ctxEntries: MenuEntry[] = useMemo(() => {
    const it = ctxMenu ? (itemsRef.current[indexOfKey(itemsRef.current, ctxMenu.key)] ?? null) : null
    if (it?.kind !== 'row') return []
    const n = actionTargets(itemsRef.current, selection, it.list).length || 1
    const many = n > 1 ? ` (${n})` : ''
    const out: MenuEntry[] = [{ id: 'open', label: 'Open in editor', icon: 'external-link', hint: '⌘↵' }]
    if (it.list === 'unstaged') out.push({ id: 'act', label: `Stage${many}`, icon: 'plus', hint: 'Space' })
    else if (it.list === 'staged') out.push({ id: 'act', label: `Unstage${many}`, icon: 'minus', hint: 'Space' })
    else out.push({ id: 'act', label: `Mark resolved${many}`, icon: 'check' })
    if (it.list === 'unstaged' && it.row.code !== '?') out.push({ id: 'discard', label: `Discard changes${many}`, icon: 'undo', danger: true, hint: '⌫' })
    out.push({ id: 'copy', label: 'Copy path', icon: 'file', section: true })
    return out
  }, [ctxMenu, selection])
  const onCtx = useCallback(
    (id: string) => {
      const it = ctxMenu ? (itemsRef.current[indexOfKey(itemsRef.current, ctxMenu.key)] ?? null) : null
      if (it?.kind !== 'row') return
      const targets = actionTargets(itemsRef.current, selection, it.list)
      const files = targets.length ? targets.map((r) => r.file) : [it.row.file]
      if (id === 'open') onOpenFile?.(it.row.file)
      else if (id === 'act') stageOrUnstage(it.list, files)
      else if (id === 'discard') requestDiscard(files)
      else if (id === 'copy') void navigator.clipboard?.writeText(files.join('\n'))
    },
    [ctxMenu, selection, onOpenFile, stageOrUnstage, requestDiscard]
  )

  /* ── layout ─────────────────────────────────────────────────────────────────────────── */
  const rootRef = useRef<HTMLDivElement>(null)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= WIDE_PX))
    ro.observe(el)
    setWide(el.clientWidth >= WIDE_PX)
    return () => ro.disconnect()
  }, [])
  const onMounted = useCallback((n: number) => {
    perf.mountedRows = n
    window.__scmPerf = perf
  }, [])

  const blocker = commitBlocker(view, commitMsg, busy === 'commit')

  const cloneSheet = (
    <CloneSheet
      forges={forges}
      activeId={activeForge}
      repos={repos}
      showRepos={showRepos}
      busy={busy}
      tokenInput={tokenInput}
      urlInput={urlInput}
      needsSignIn={needsSignIn}
      onPick={(id) => { setActiveForge(id); setShowRepos(false); setRepos([]); setReposLoaded(false) }}
      onTokenChange={setTokenInput}
      onSignIn={() => void signIn()}
      onLoadRepos={() => void loadRepos()}
      onClone={(r) => void cloneRepo(r)}
      onUrlChange={setUrlInput}
      onCloneUrl={() => void cloneFromUrl()}
      onClose={() => setCloneOpen(false)}
    />
  )

  if (!projectPath || (snap && !snap.isRepo)) {
    return (
      <div className="scm panel-pane" ref={rootRef}>
        <div className="scm-empty">
          <Icon name="git-branch" size={16} />
          <div className="scm-empty-text">
            {!projectPath ? 'Open a project to see its changes, or clone one.' : 'This folder is not a git repository.'}
          </div>
          {!cloneOpen && !publishOpen && (
            <button type="button" className="btn btn-sm" onClick={() => { closePublish(); setCloneOpen(true) }}>
              <Icon name="download" size={11} /> Clone repository…
            </button>
          )}
          {/* Absent, never disabled, when the role lacks `createRepo` — the "no dead controls"
              rule. Needs a real folder open, so it never shows in the "no project" empty state. */}
          {projectPath && canCreateRepo && !cloneOpen && !publishOpen && (
            <button type="button" className="btn btn-primary" disabled={publishOpening} onClick={() => void openPublish()}>
              <Icon name="upload" size={11} /> Publish this folder…
            </button>
          )}
        </div>
        {cloneOpen && cloneSheet}
        {publishOpen && (
          <PublishSheet
            name={publishName}
            onNameChange={handleNameChange}
            plan={publishPlan}
            planning={publishPlanning}
            planError={publishPlanError}
            busy={publishBusy}
            result={publishResult}
            onConfirm={() => void confirmPublish()}
            onClose={closePublish}
          />
        )}
      </div>
    )
  }

  if (!snap) {
    return (
      <div className="scm panel-pane" ref={rootRef}>
        <div className="scm-empty muted small">Reading git status…</div>
      </div>
    )
  }

  return (
    <div className="scm panel-pane" ref={rootRef} data-wide={wide ? 'true' : 'false'}>
      <ScmHeader
        view={view}
        remote={remote}
        busy={busy}
        pickerOpen={pickerOpen}
        overflowOpen={overflowOpen}
        onBranch={() => setPickerOpen((v) => !v)}
        onRefresh={() => refresh(true)}
        onFetch={() => onOverflow('fetch')}
        onPull={() => onOverflow('pull')}
        onPush={() => onOverflow('push')}
        onPublish={publishBranch}
        onOverflow={() => setOverflowOpen((v) => !v)}
      >
        {overflowOpen && <Menu entries={overflow} onPick={onOverflow} onClose={() => setOverflowOpen(false)} ariaLabel="Source Control actions" />}
      </ScmHeader>

      {pickerOpen && (
        <BranchPicker
          current={view.branch}
          branches={branches}
          loading={branchesLoading}
          busy={!!busy}
          onClose={() => setPickerOpen(false)}
          onSwitch={(b) => { setPickerOpen(false); void run('checkout', () => window.studio.gitCheckout(projectPath, b, false), `Switched to ${b}.`) }}
          onCreate={(b) => { setPickerOpen(false); void run('branch', () => window.studio.gitCheckout(projectPath, b, true), `Created branch ${b}.`) }}
          onMerge={(b) => void merge(b)}
          onDelete={(b) => void run('branch-delete', () => window.studio.gitBranchDelete(projectPath, b), `Deleted branch ${b}.`)}
        />
      )}

      {cloneOpen && cloneSheet}

      {view.isIgnored && (
        <div className="scm-strip scm-strip-warn" role="status">
          <Icon name="alert" size={12} />
          <span>This folder is listed in <code>.gitignore</code> — git tracks nothing in it, so an empty list does not mean your work is saved.</span>
        </div>
      )}

      <ConflictBanner
        conflicts={view.conflicts.length}
        merging={view.merging}
        rebasing={view.rebasing}
        busy={!!busy}
        onAbort={() => onOverflow('merge-abort')}
        onContinue={() => onOverflow('merge-continue')}
      />

      <RemoteBar
        remote={remote}
        branch={view.branch}
        serverName={forgeName}
        repos={repos}
        reposLoaded={reposLoaded}
        busy={busy}
        open={connectOpen}
        onOpen={() => setConnectOpen(true)}
        onCloseForm={() => setConnectOpen(false)}
        onLoadRepos={() => void loadRepos()}
        onConnect={(u) => void connectRemote(u)}
        onPublish={publishBranch}
      />

      <div className="scm-body">
        <div className="scm-main">
          <Composer
            value={commitMsg}
            onChange={setCommitMsg}
            branch={view.branch}
            stagedCount={view.staged.length}
            outsideStaged={view.outsideStaged}
            blocker={blocker}
            busy={busy}
            onCommit={() => commit(false)}
            menu={composerMenu}
            onMenu={onComposerMenu}
          />

          {confirmDiscard && (
            <div className="scm-strip scm-strip-warn" role="alertdialog" aria-label="Confirm discard">
              <Icon name="alert" size={12} />
              <span>
                Throw away your edits to {confirmDiscard.length === 1 ? <strong>{confirmDiscard[0]}</strong> : <strong>{confirmDiscard.length} files</strong>}? Undo can bring them back.
              </span>
              <span className="spacer" />
              <button type="button" className="btn btn-sm btn-danger-ghost" autoFocus onClick={() => void performDiscard(confirmDiscard)}>Discard</button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmDiscard(null)}>Keep</button>
            </div>
          )}

          <WindowedList
            items={items}
            rowHeight={ROW_H}
            focusKey={selection.focusKey}
            overscan={6}
            ariaLabel="Changes"
            onKeyDown={onListKey}
            onEnter={() => { if (!selection.focusKey && items.length) setSelection((s) => ({ ...s, focusKey: items[0].key })) }}
            onMounted={onMounted}
            renderItem={(it, index) => (
              <ScmRow
                key={it.key}
                item={it}
                index={index}
                focused={selection.focusKey === it.key}
                selected={selection.selected.has(it.key)}
                pending={it.kind === 'row' && pending.has(it.row.file)}
                busy={!!busy}
                h={handlers}
              />
            )}
          />

          {draftText && (
            <div className="scm-draft-wrap">
              <div className="scm-draft-head">
                <span className="scm-kicker">AI draft</span>
                <span className="spacer" />
                <button type="button" className="scm-icon-btn" aria-label="Close the draft" title="Close" onClick={() => setDraftText('')}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <pre className="scm-draft">{draftText}</pre>
            </div>
          )}
        </div>

        {openDiff && (
          <DiffView
            file={openDiff.file}
            mode={openDiff.mode}
            loading={diffLoading}
            diff={diff}
            onOpen={() => onOpenFile?.(openDiff.file)}
            onClose={closeDiff}
          />
        )}
      </div>

      {ctxMenu && <Menu entries={ctxEntries} onPick={onCtx} onClose={() => setCtxMenu(null)} ariaLabel="File actions" at={{ x: ctxMenu.x, y: ctxMenu.y }} />}
    </div>
  )
}
