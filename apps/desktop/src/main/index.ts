import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename, resolve, sep } from 'node:path'
import { ProcessManager } from './process-manager'
import { createProject, PROJECT_TEMPLATES } from './projects'
import { editFile, editSelection, autocomplete } from './ai-edit'
import { snapshot, undo as undoEdit, canUndo, lastLabel, history as undoHistory, undoTo, undoDiff, checkpoints, restoreToCheckpoint } from './undo'
import { diffLines, foldContext } from './diff'
import { setApiKey, hasApiKey, vaultStatus } from './keyvault'
import { PROVIDERS, getUsage, resetUsage, setSpendCap, opencodeModels } from './providers'
import * as media from './media'
import { MEDIA_PROVIDERS } from '../shared/media'
import { runGoalEdit } from './goal-edit'
import * as fsService from './fs-service'
import * as simulator from './simulator'
import * as indexService from './index-service'
import * as docker from './docker'
import * as models from './models'
import * as insight from './insight'
import { ledgerList, ledgerSearch } from './ledger'
import { scanProject } from './security'
import { dependencyAudit } from './dependency'
import { scaffoldTest } from './testgen'
import { runbook } from './runbook'
import { buildComplianceReport } from './compliance'
import { addDecision, listDecisions } from './decisions'
import { analyticsRecord, analyticsList } from './analytics'
import { saveArchBaseline, archDrift } from './drift'
import { designReview } from './design'
import { planApplyTokens, applyTokens } from './apply-tokens'
import * as impact from './impact'
import * as agent from './agent'
import * as gh from './git'
import { preflight, ensureKey, publishPlan, publishRun, studioKeyPath } from './git-provision'
import * as remote from './remote'
import * as ws from './workspaces'
import { audit, auditTail, reportFraud } from './audit'
import { enterprisePolicy, getAirGap, identityRequired, setAirGap } from './policy'
import * as identity from './identity'
import { getMode, modeChosen, setMode } from './mode'
import { getTheme, installThemeFromFile, listThemes, removeTheme, setTheme, windowBackgroundColor } from './themes'
import { execStream, type RunHandle } from './terminal'
import { watchProject, watchGitDir } from './watcher'
import * as pty from './pty'
import { buildMenu, setMenuState } from './menu'
import * as mcp from './mcp'
import * as extensions from './extensions'
import * as previewctl from './previewctl'
import * as memory from './memory'
import { IPC } from '../shared/ipc'
import type {
  AgentEvent,
  AgentRunRequest,
  ApplyEditResult,
  AutocompleteRequest,
  AutoFixRequest,
  EditRequest,
  EditResult,
  GitDiffMode,
  GitServer,
  GoalEditRequest,
  GoalEditResult,
  InlineEditRequest,
  ProjectInfo,
  RemoteConfig,
  RemotePolicy,
  RemoteState,
  WsCloudCreateRequest,
  WsProvisionRequest,
  GitLogQuery
} from '../shared/types'

/* NOTE: do NOT call app.setName() here to fix the "Electron" label on the dev menu bar.
   The app's name is what derives `app.getPath('userData')`, so renaming it moves every setting the
   app has ever stored — air-gap state, panel prefs — to a new folder and the old one is silently
   orphaned. Tried, measured (a second Application Support directory appeared), reverted.
   macOS takes that first menu title from the bundle, so it is only ever wrong in development;
   packaged builds already read "ATOMIC Studio" from electron-builder's productName. */

let mainWindow: BrowserWindow | null = null

/**
 * Multi-window: every window gets its OWN dev server + current project, so two
 * windows can run two different apps side by side. Cross-cutting singletons
 * (AI agent, remote/workspace session, undo stack) stay app-wide.
 */
interface WinState {
  pm: ProcessManager
  project: ProjectInfo | null
  /** Stops the current project's filesystem watcher (Wave 23) — called before switching projects. */
  stopWatch: (() => void) | null
  /** Stops the `.git` metadata watcher when the repo's `.git` lives outside the project folder. */
  stopGitWatch: (() => void) | null
}
const winStates = new Map<number, WinState>()

function stateFor(sender: Electron.WebContents): WinState {
  let s = winStates.get(sender.id)
  if (!s) {
    s = { pm: new ProcessManager(), project: null, stopWatch: null, stopGitWatch: null }
    winStates.set(sender.id, s)
  }
  return s
}

/** The themed colours for the native window-control overlay (Windows/Linux only). */
function titleBarOverlayColors(): { color: string; symbolColor: string } {
  const t = getTheme().tokens
  return { color: t['wb-titlebar-bg'], symbolColor: t['wb-titlebar-fg'] }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'ATOMIC Studio',
    // Painted before the renderer's first frame, so launching on a light theme does not flash the
    // dark one (and vice versa). Kept in step by the themeSet handler.
    backgroundColor: windowBackgroundColor(),
    // The app draws its own 35px title bar (VS Code's `window.titleBarStyle: custom`). On macOS the
    // system traffic lights stay, inset into our bar — the renderer reserves 74px for them via the
    // [data-platform='mac'] rule. Everywhere else Electron overlays real window controls on the
    // right, tinted to the theme so they are not a grey rectangle on a dark bar.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 10 } : undefined,
    ...(process.platform === 'darwin'
      ? {}
      : { titleBarOverlay: { color: titleBarOverlayColors().color, symbolColor: titleBarOverlayColors().symbolColor, height: 35 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Needed so the device frames can host the live preview via <webview>.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  guardUnsavedOnClose(win) // Wave 21: never close a window over unsaved typing without asking

  const pm = new ProcessManager()
  // Capture now — win.webContents THROWS ("Object has been destroyed") if read
  // inside the 'closed' handler.
  const wcId = win.webContents.id
  winStates.set(wcId, { pm, project: null, stopWatch: null, stopGitWatch: null })

  // Forward THIS window's dev-server state + logs to THIS window only.
  pm.on('state', (state) => !win.isDestroyed() && win.webContents.send(IPC.devServerState, state))
  pm.on('log', (line) => !win.isDestroyed() && win.webContents.send(IPC.log, line))

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    pm.stop()
    winStates.get(wcId)?.stopWatch?.()
    winStates.get(wcId)?.stopGitWatch?.()
    winStates.delete(wcId)
    if (mainWindow === win) mainWindow = BrowserWindow.getAllWindows()[0] ?? null
  })

  mainWindow = win
  return win
}

/**
 * Start watching a newly-opened project for changes made outside the app (Finder, a terminal command,
 * `npm install`, another editor). Stops any previous watcher first — a project switch must never leave
 * the OLD project's watcher running and pushing stale events into a window that moved on.
 */
function startWatching(win: BrowserWindow, st: WinState, root: string): void {
  st.stopWatch?.()
  st.stopGitWatch?.()
  st.stopGitWatch = null
  const gitChanged = (): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.gitChanged)
  }
  st.stopWatch = watchProject(
    root,
    (paths) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.fsChanged, paths)
    },
    gitChanged
  )
  // A project that is a SUBFOLDER of its repository (or a linked worktree) keeps its `.git`
  // above the watched root, where the project watcher cannot see a terminal's `git add` or
  // `git commit`. Watch that directory too, so the Source Control view follows every process.
  const loc = gh.findRepo(root)
  if (loc && !loc.gitDir.startsWith(resolve(root) + sep)) st.stopGitWatch = watchGitDir(loc.gitDir, gitChanged)
}

/** App-wide pushes (agent events) go to every open window. */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

/**
 * Shared tail of the applyEdit + autoFix handlers: guard the model result, then
 * snapshot for one-click undo and write the file (hot-reload shows the change).
 */
function commitEdit(result: EditResult, file: string, label: string, fallbackErr: string): ApplyEditResult {
  if (!result.ok || !result.newContent || !result.absolutePath) {
    return { ok: false, error: result.error ?? fallbackErr, canUndo: canUndo() }
  }
  snapshot(result.absolutePath, label)
  mkdirSync(join(result.absolutePath, '..'), { recursive: true })
  writeFileSync(result.absolutePath, result.newContent, 'utf8')
  return { ok: true, file, canUndo: canUndo() }
}

function registerIpc(): void {
  /**
   * Wave 21: this only ASKS which folder — it no longer stops the dev server or swaps the active
   * project. The renderer may still have unsaved typing to ask about, and "Cancel" has to mean cancel;
   * committing here left the app half-switched whatever the user answered. The renderer calls
   * openProjectAt once the unsaved-work guard has resolved.
   */
  ipcMain.handle(IPC.openProject, async (e): Promise<ProjectInfo | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open a project folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const st = stateFor(e.sender)
    return st.pm.inspectProject(result.filePaths[0]) // inspect only — no side effects
  })

  // Open a folder as the project directly (no dialog) — used after git clone.
  ipcMain.handle(IPC.openProjectAt, async (e, path: string): Promise<ProjectInfo | null> => {
    const st = stateFor(e.sender)
    st.pm.stop()
    st.project = st.pm.inspectProject(path)
    setTimeout(() => indexService.buildProjectIndex(path), 50) // background AI index
    const win = BrowserWindow.fromWebContents(e.sender)
    if (st.project && win) startWatching(win, st, path)
    return st.project
  })

  // "New project…" — scaffold from a starter template, then the renderer opens it.
  ipcMain.handle(IPC.createProject, async (e, parentDir: string, name: string, template: string) =>
    createProject(parentDir, name, template, (line) => !e.sender.isDestroyed() && e.sender.send(IPC.log, line))
  )

  ipcMain.handle(IPC.listProjectTemplates, async () =>
    Object.entries(PROJECT_TEMPLATES).map(([id, t]) => ({ id, label: t.label }))
  )

  // Multi-window: a fresh, fully independent Studio window.
  ipcMain.handle(IPC.newWindow, async () => {
    createWindow()
  })

  // Search Everywhere: query the background AI project index.
  ipcMain.handle(IPC.indexSearch, async (_e, root: string, query: string) => indexService.indexSearch(root, query))

  // Docker integration: compose detection + lifecycle streamed to the terminal.
  ipcMain.handle(IPC.dockerInfo, async (_e, projectPath: string) => ({
    composeFile: docker.composeFile(projectPath),
    available: await docker.dockerAvailable()
  }))
  ipcMain.handle(IPC.dockerCompose, async (e, projectPath: string, action: 'up' | 'down' | 'ps') => {
    const sender = e.sender
    const id = ++termCounter
    return docker.composeRun(projectPath, action, (line) => !sender.isDestroyed() && sender.send(IPC.termLine, { id, line }))
  })

  // ---- Wave 1: Project Explainer / Insight, Git Supercharge, Smart Terminal ----
  ipcMain.handle(IPC.projectInsight, async (_e, root: string) => indexService.projectInsight(root))
  ipcMain.handle(IPC.projectBrain, async (_e, root: string) => indexService.projectBrain(root))
  ipcMain.handle(IPC.architectureMap, async (_e, root: string) => indexService.architectureMap(root))
  ipcMain.handle(IPC.configGuard, async (_e, paths: string[]) =>
    impact.configAdvisory(Array.isArray(paths) ? paths : [])
  )
  ipcMain.handle(IPC.blastRadius, async (_e, root: string, paths: string[]) =>
    impact.blastRadius(root, Array.isArray(paths) ? paths : [])
  )
  ipcMain.handle(IPC.explainProject, async (_e, root: string, provider: string, model?: string) => insight.explainProject(root, provider, model))
  ipcMain.handle(IPC.draftGitText, async (_e, kind: insight.GitDraftKind, projectPath: string, provider: string, model?: string) => {
    const diff = await gh.gitDiff(projectPath)
    return insight.draftGitText(kind, diff, provider, model)
  })
  ipcMain.handle(IPC.explainOutput, async (_e, output: string, provider: string, model?: string) => insight.explainOutput(output, provider, model))

  // ---- Wave 2: named guarantees ----
  ipcMain.handle(IPC.getUsage, async () => getUsage())
  ipcMain.handle(IPC.resetUsage, async () => resetUsage())
  ipcMain.handle(IPC.setSpendCap, async (_e, tokens: number) => setSpendCap(tokens))

  // ---- Media generation: images + video, billed to the client's OWN provider account ----
  // `hasKey` is resolved here rather than in the renderer for the usual reason: the renderer learns
  // WHETHER a key exists, never what it is.
  ipcMain.handle(IPC.mediaProviders, async () =>
    MEDIA_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      sharesChatKey: p.sharesChatKey,
      keyUrl: p.keyUrl,
      planNote: p.planNote,
      hasKey: p.id === 'mock-media' ? true : hasApiKey(p.id),
      models: p.models
    }))
  )
  ipcMain.handle(IPC.mediaGenerate, async (e, req: Parameters<typeof media.generate>[0]) =>
    media.generate({
      ...req,
      // Progress goes back to the window that asked, so a second window isn't narrated at.
      onProgress: (note) => {
        if (!e.sender.isDestroyed()) e.sender.send(IPC.mediaProgress, { note })
      }
    })
  )
  ipcMain.handle(IPC.mediaList, async (_e, project: string) => media.listMedia(project))
  ipcMain.handle(IPC.mediaDelete, async (_e, project: string, file: string) => media.deleteMedia(project, file))
  ipcMain.handle(IPC.mediaDataUrl, async (_e, project: string, file: string) => media.readMediaDataUrl(project, file))
  ipcMain.handle(IPC.mediaUsage, async () => media.getMediaUsage())
  ipcMain.handle(IPC.mediaSetCap, async (_e, usd: number) => media.setMediaCap(usd))
  ipcMain.handle(IPC.undoCheckpoints, async () => checkpoints())
  ipcMain.handle(IPC.restoreCheckpoint, async (_e, id: string) => {
    const restored = restoreToCheckpoint(id)
    return { ok: restored.length > 0, restored, canUndo: canUndo() }
  })
  ipcMain.handle(IPC.ledgerList, async (_e, project: string) => ledgerList(project))
  ipcMain.handle(IPC.ledgerSearch, async (_e, project: string, query: string) => ledgerSearch(project, query))
  // Wave 5 — Decisions log, Analytics-over-time, Context Packs
  ipcMain.handle(IPC.addDecision, async (_e, project: string, entry: { title: string; detail: string; tags?: string[] }) => addDecision(project, entry))
  ipcMain.handle(IPC.listDecisions, async (_e, project: string) => listDecisions(project))
  ipcMain.handle(IPC.analyticsRecord, async (_e, project: string, snap: Omit<import('../shared/types').MetricSnapshot, 'ts'>) => analyticsRecord(project, snap))
  ipcMain.handle(IPC.analyticsList, async (_e, project: string) => analyticsList(project))
  ipcMain.handle(IPC.contextPack, async (_e, root: string, seed: string) => indexService.contextPack(root, seed))
  ipcMain.handle(IPC.saveArchBaseline, async (_e, project: string) => saveArchBaseline(project))
  ipcMain.handle(IPC.archDrift, async (_e, project: string) => archDrift(project))
  ipcMain.handle(IPC.designReview, async (_e, project: string) => designReview(project))
  ipcMain.handle(IPC.planApplyTokens, async (_e, root: string, tokens: { name: string; value: string }[]) =>
    planApplyTokens(root, tokens)
  )
  ipcMain.handle(
    IPC.applyTokens,
    async (
      _e,
      root: string,
      checkedFiles: string[],
      tokens: { name: string; value: string }[],
      blockCss: string,
      blockTargetFile: string
    ) => applyTokens(root, checkedFiles, tokens, blockCss, blockTargetFile)
  )
  ipcMain.handle(IPC.securityScan, async (_e, project: string) => scanProject(project))
  ipcMain.handle(IPC.dependencyAudit, async (_e, project: string) => dependencyAudit(project))
  ipcMain.handle(IPC.generateTests, async (_e, root: string, srcRel: string) => {
    const res = scaffoldTest(root, srcRel)
    if ('error' in res) return { ok: false, error: res.error }
    // Write the new test file (fsService.writeFile snapshots → one-click Undo removes it).
    const w = fsService.writeFile(root, res.path, res.content)
    return w.ok ? { ok: true, path: res.path } : { ok: false, error: w.error }
  })
  ipcMain.handle(IPC.runbook, async (_e, root: string) => runbook(root))
  ipcMain.handle(IPC.complianceExport, async (e, project: string) => {
    // Bundle the three trust surfaces (fresh scan + ledger + audit tail) into a
    // Markdown report the user saves wherever they choose. Records the export.
    const report = buildComplianceReport(basename(project), Date.now(), scanProject(project), ledgerList(project, 1000), auditTail(200))
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save compliance report',
      defaultPath: `compliance-${basename(project) || 'project'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    try {
      writeFileSync(res.filePath, report, 'utf8')
      audit('compliance-export', res.filePath)
      return { ok: true, path: res.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save the report.' }
    }
  })

  ipcMain.handle(IPC.startDevServer, async (e, projectPath: string) => {
    const st = stateFor(e.sender)
    if (!st.project || st.project.path !== projectPath) st.project = st.pm.inspectProject(projectPath)
    st.pm.start(st.project)
  })

  ipcMain.handle(IPC.stopDevServer, async (e) => {
    stateFor(e.sender).pm.stop()
  })

  ipcMain.handle(IPC.getDevServerState, async (e) => stateFor(e.sender).pm.getState())

  // --- Phase 1: click-to-edit ---
  ipcMain.handle(IPC.applyEdit, async (_e, req: EditRequest): Promise<ApplyEditResult> =>
    commitEdit(await editFile(req), req.file, `${req.instruction} (${req.file})`, 'Edit failed.')
  )

  // ⌘K inline edit — returns the replacement snippet; nothing touches disk here.
  ipcMain.handle(IPC.inlineEdit, async (_e, req: InlineEditRequest) => editSelection(req))

  // Tab autocomplete — ghost-text suggestion for the cursor position.
  ipcMain.handle(IPC.autocomplete, async (_e, req: AutocompleteRequest) => autocomplete(req))

  ipcMain.handle(IPC.autoFix, async (_e, req: AutoFixRequest): Promise<ApplyEditResult> => {
    const result = await editFile({
      projectPath: req.projectPath,
      file: req.file,
      line: 0,
      instruction:
        'The app is showing this error, likely caused by the most recent change. ' +
        'Fix the file so the error is resolved while keeping all working behavior.\n\nERROR:\n' +
        req.errorText,
      provider: req.provider,
      model: req.model
    })
    return commitEdit(result, req.file, `auto-fix (${req.file})`, 'Auto-fix failed.')
  })

  ipcMain.handle(IPC.runEditGoal, async (_e, req: GoalEditRequest): Promise<GoalEditResult> =>
    runGoalEdit(req)
  )

  ipcMain.handle(IPC.undoEdit, async () => {
    const file = undoEdit()
    return { ok: Boolean(file), file: file ?? undefined, canUndo: canUndo() }
  })

  ipcMain.handle(IPC.getUndoState, async () => ({ canUndo: canUndo(), label: lastLabel() }))

  ipcMain.handle(IPC.getUndoHistory, async () => undoHistory())

  ipcMain.handle(IPC.undoTo, async (_e, keep: number) => {
    const restored = undoTo(keep)
    return { ok: restored.length > 0, restored, canUndo: canUndo() }
  })
  ipcMain.handle(IPC.undoDiff, async (_e, stackIndex: number) => undoDiff(stackIndex))

  // Returns the outcome: a refusal (an unreadable vault we must not overwrite) has to reach the user,
  // not be swallowed into an optimistic green tick.
  ipcMain.handle(IPC.setApiKey, async (_e, provider: string, key: string) => setApiKey(provider, key))
  ipcMain.handle(IPC.vaultStatus, async () => vaultStatus())

  ipcMain.handle(IPC.hasApiKey, async (_e, provider: string) => hasApiKey(provider))

  ipcMain.handle(IPC.listProviders, async () => {
    const ep = enterprisePolicy()
    const air = getAirGap()
    return PROVIDERS.filter((p) => {
      // Air-Gapped Mode hides everything but the local model (belt: the real
      // enforcement is the guard inside complete()).
      const isLocal = p.id === 'ollama' || p.kind === 'mock'
      if (air && !isLocal) return false
      return !ep.managed || !ep.allowedProviders || ep.allowedProviders.includes(p.id)
    }).map((p) => ({ id: p.id, label: p.label, needsKey: p.needsKey, defaultModel: p.defaultModel }))
  })
  ipcMain.handle(IPC.modelCatalog, async () => models.modelCatalog())
  ipcMain.handle(IPC.ollamaStart, async () => models.startOllama())
  ipcMain.handle(IPC.opencodeModels, async () => opencodeModels())

  // ---- Phase 7 — IDE shell: file tree + code editor ----
  ipcMain.handle(IPC.listDir, async (_e, projectPath: string, relPath: string, scope?: fsService.ListScope) =>
    // The scope is validated here rather than trusted: an unknown value falls back to the STRICTER
    // scan list, so a malformed call can never widen what the renderer is allowed to enumerate.
    fsService.listDir(projectPath, relPath, scope === 'explorer' ? 'explorer' : 'scan')
  )
  ipcMain.handle(IPC.readFile, async (_e, projectPath: string, relPath: string) =>
    fsService.readFile(projectPath, relPath)
  )
  ipcMain.handle(IPC.writeFile, async (_e, projectPath: string, relPath: string, content: string) => {
    const res = fsService.writeFile(projectPath, relPath, content)
    if (res.ok) setTimeout(() => indexService.refreshIndexedFile(projectPath, relPath), 20)
    return res
  })
  ipcMain.handle(IPC.createFile, async (_e, projectPath: string, relPath: string) =>
    fsService.createFile(projectPath, relPath)
  )
  ipcMain.handle(IPC.createDir, async (_e, projectPath: string, relPath: string) =>
    fsService.createDir(projectPath, relPath)
  )
  ipcMain.handle(IPC.renamePath, async (_e, projectPath: string, relPath: string, newRelPath: string) =>
    fsService.renamePath(projectPath, relPath, newRelPath)
  )
  // Wave 21 — what a delete would actually destroy, so the confirm step can say it out loud.
  ipcMain.handle(IPC.gitPathIgnored, async (_e, projectPath: string, relPath: string) =>
    gh.gitPathIgnored(projectPath, relPath)
  )
  ipcMain.handle(IPC.previewPath, async (_e, projectPath: string, relPath: string) =>
    fsService.previewPath(projectPath, relPath)
  )
  // Wave 21 — the file tree's × now moves to the Trash instead of erasing. Same index cleanup as the
  // permanent delete below, or the trashed file lingers as a phantom node in the architecture map.
  ipcMain.handle(IPC.trashPath, async (_e, projectPath: string, relPath: string) => {
    const res = await fsService.trashPath(projectPath, relPath)
    if (res.ok) setTimeout(() => indexService.refreshIndexedFile(projectPath, relPath), 20)
    return res
  })
  ipcMain.handle(IPC.deletePath, async (_e, projectPath: string, relPath: string) => {
    const res = fsService.deletePath(projectPath, relPath)
    // Drop it from the index too (mirrors writeFile). A deleted file left in the index stays a phantom
    // node in the architecture map — so the X-ray cards would keep offering a file that no longer
    // exists as "probably safe to remove", and Search Everywhere would keep finding its symbols.
    if (res.ok) setTimeout(() => indexService.refreshIndexedFile(projectPath, relPath), 20)
    return res
  })

  // ---- Phase 8 — real iOS Simulator (macOS) ----
  ipcMain.handle(IPC.listSimulators, async () => simulator.listSimulators())
  ipcMain.handle(IPC.openInSimulator, async (_e, udid: string, url: string) => simulator.openUrl(udid, url))
  ipcMain.handle(IPC.simulatorScreenshot, async (_e, udid: string) => simulator.screenshot(udid))

  // ---- Phase 10 — built-in AI agent ----
  const emitAgent = (ev: AgentEvent): void => broadcast(IPC.agentEvent, ev)
  // Fire-and-forget: the run streams progress over agentEvent; the invoke only
  // reports whether it could start.
  ipcMain.handle(IPC.agentStart, async (e, req: AgentRunRequest) => {
    // A second instruction while the agent is busy QUEUES behind it (owner-approved,
    // 2026-07-26) and auto-runs when the current run finishes — the backend's
    // queue + finally-drain already support this; startAgent returns { queued }.
    // (No await in the not-running case, so the IPC returns without blocking on the run.)
    // Pass THIS window's ProcessManager so ACTION run_preview/stop_preview control the same
    // dev server the "Run preview" button does, not some other open window's.
    const pm = stateFor(e.sender).pm
    if (agent.getAgentState().running) return agent.startAgent(req, emitAgent, pm)
    void agent.startAgent(req, emitAgent, pm)
    return { ok: true }
  })
  ipcMain.handle(IPC.agentCancel, async () => agent.cancelAgent())
  ipcMain.handle(IPC.agentState, async () => agent.getAgentState())
  ipcMain.handle(IPC.agentApply, async (_e, ids: string[] | 'all') => agent.applyStaged(ids))
  ipcMain.handle(IPC.agentReject, async (_e, ids: string[] | 'all') => agent.rejectStaged(ids))
  ipcMain.handle(IPC.scanStagedSecrets, async () => agent.scanStagedSecrets())
  ipcMain.handle(IPC.agentNewChat, async () => agent.resetSession())

  // ---- Phase 10 — integrated terminal ----
  const termRuns = new Map<number, RunHandle>()
  // Active ollama pulls, keyed by the LAUNCHING window then model name → term id. Per-window
  // because termLine is sender-bound: another window must not rehydrate (and get stuck on) a
  // pull whose progress it will never receive. A Settings reopen in the SAME window rehydrates.
  const activePulls = new Map<number, Map<string, number>>()
  let termCounter = 0
  ipcMain.handle(IPC.termRun, async (e, projectPath: string, command: string) => {
    const st = stateFor(e.sender)
    if (!st.project || st.project.path !== projectPath)
      return { ok: false, error: 'Open a project first.' }
    const id = ++termCounter
    const sender = e.sender
    // Only the interactive Terminal panel opts into color — every other execStream caller (the agent's
    // run tool, git/docker/dependency internals) keeps FORCE_COLOR=0 so ANSI codes never leak into text
    // that gets parsed programmatically. The renderer turns these codes into real colored spans.
    const handle = execStream(
      command,
      projectPath,
      (line) => !sender.isDestroyed() && sender.send(IPC.termLine, { id, line }),
      undefined,
      undefined,
      { FORCE_COLOR: '1' }
    )
    termRuns.set(id, handle)
    void handle.done.then(() => termRuns.delete(id))
    return { ok: true, id }
  })
  ipcMain.handle(IPC.termKill, async (_e, id: number) => termRuns.get(id)?.kill())

  /* Real terminal sessions. These are deliberately NOT the same path as termRun above: the agent
     needs "run this, capture the output, tell me the exit code", while a person needs a live TTY.
     Trying to serve both from one mechanism is what kept the Terminal panel from being a terminal. */
  ipcMain.handle(IPC.ptyStart, async (e, cwd: string, cols: number, rows: number) =>
    pty.startSession(cwd, cols, rows, pty.senderFor(e.sender, IPC.ptyData))
  )
  ipcMain.handle(IPC.ptyWrite, async (_e, id: number, data: string) => pty.write(id, data))
  ipcMain.handle(IPC.ptyResize, async (_e, id: number, cols: number, rows: number) => pty.resize(id, cols, rows))
  ipcMain.handle(IPC.ptyKill, async (_e, id: number) => pty.kill(id))
  ipcMain.handle(IPC.ptyScrollback, async (_e, id: number) => pty.scrollback(id))
  ipcMain.handle(IPC.menuState, async (_e, state: Parameters<typeof setMenuState>[0]) => setMenuState(state))

  /* Connectors (MCP) + installable extensions. Every one of these is inert until the user enables
     it, and each tool stays behind its own approval — see mcp.ts for why that is the whole story. */
  /* Project Memory. The renderer never touches the store; every path goes through here, so the
     same retrieval the agent runs is the one the panel previews. */
  ipcMain.handle(IPC.memoryList, async (_e, project: string) => memory.active(project))
  ipcMain.handle(IPC.memoryAdd, async (_e, project: string, entry: Parameters<typeof memory.remember>[1]) =>
    memory.remember(project, { ...entry, source: 'user' })
  )
  ipcMain.handle(IPC.memoryForget, async (_e, project: string, id: string) => memory.forget(project, id))
  ipcMain.handle(IPC.memoryPin, async (_e, project: string, id: string, pinned: boolean) =>
    memory.setPinned(project, id, pinned)
  )
  ipcMain.handle(IPC.memoryStats, async (_e, project: string) => memory.stats(project))
  ipcMain.handle(IPC.memoryPreview, async (_e, project: string, task: string) => memory.retrieve(project, task))
  ipcMain.handle(IPC.memorySetSync, async (_e, project: string, on: boolean) => memory.setSync(project, on))

  ipcMain.handle(IPC.connectorList, async () => mcp.list())
  ipcMain.handle(IPC.connectorSetEnabled, async (_e, id: string, enabled: boolean) => mcp.setEnabled(id, enabled))
  ipcMain.handle(IPC.connectorApproveTool, async (_e, id: string, tool: string, approved: boolean) =>
    mcp.setToolApproved(id, tool, approved)
  )
  ipcMain.handle(IPC.connectorRemove, async (_e, id: string) => mcp.remove(id))
  ipcMain.handle(IPC.extensionsList, async () => extensions.listInstalled())
  ipcMain.handle(IPC.extensionInstallFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Choose an extension folder',
      message: 'Pick a folder containing atomic-extension.json',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: 'cancelled' }
    return extensions.installFromFolder(picked.filePaths[0])
  })
  ipcMain.handle(IPC.extensionInstallGit, async (_e, url: string) => extensions.installFromGit(url))
  ipcMain.handle(IPC.extensionUninstall, async (_e, id: string) => extensions.uninstall(id))
  ipcMain.handle(IPC.extensionRegistry, async () => extensions.registry())
  ipcMain.handle(IPC.previewControlResult, async (_e, id: number, result: Parameters<typeof previewctl.settle>[1]) =>
    previewctl.settle(id, result)
  )
  // Air-gapped model catalog: `ollama pull <name>` streamed over the term-line
  // channel (shows in the Terminal panel); termKill(id) cancels it for free.
  ipcMain.handle(IPC.modelPull, async (e, name: string) => {
    const sender = e.sender
    const sid = sender.id
    const id = ++termCounter
    const handle = models.pullModel(name, (line) => !sender.isDestroyed() && sender.send(IPC.termLine, { id, line }))
    termRuns.set(id, handle)
    let forSender = activePulls.get(sid)
    if (!forSender) activePulls.set(sid, (forSender = new Map()))
    forSender.set(name, id)
    void handle.done.then(() => {
      termRuns.delete(id)
      const m = activePulls.get(sid)
      if (m && m.get(name) === id) {
        // Only if THIS pull is still the active one — a concurrent re-pull of the same model
        // overwrote the entry, so its later drain owns the deletion.
        m.delete(name)
        if (!m.size) activePulls.delete(sid)
      }
    })
    return { ok: true, id }
  })
  // Rehydrate on Settings reopen: model pulls still running IN THIS WINDOW (name → term id).
  ipcMain.handle(IPC.listActivePulls, async (e) => Object.fromEntries(activePulls.get(e.sender.id) ?? new Map<string, number>()))

  // ---- Enterprise: GitHub / git ----
  ipcMain.handle(IPC.ghUser, async () => gh.ghUser())
  ipcMain.handle(IPC.pickFolder, async (e) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { title: 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
  })
  ipcMain.handle(IPC.gitInfo, async (_e, projectPath: string) => gh.gitInfo(projectPath))
  // Source Control (2026-09-02): the one-process hot status, and exact per-row diffs whose MODE is
  // decided by the row's list in the renderer and executed here — never inferred from a path.
  ipcMain.handle(IPC.gitSnapshot, async (_e, projectPath: string) => gh.gitSnapshot(projectPath))
  ipcMain.handle(IPC.gitDiffFile, async (_e, projectPath: string, relPath: string, mode: GitDiffMode, orig?: string) =>
    gh.gitDiffFile(projectPath, relPath, mode, orig)
  )
  ipcMain.handle(IPC.gitCommit, async (_e, projectPath: string, message: string, stageAll?: boolean) =>
    gh.gitCommit(projectPath, message, stageAll === true)
  )
  ipcMain.handle(IPC.gitPush, async (_e, projectPath: string, setUpstream?: boolean) => gh.gitPush(projectPath, setUpstream === true))
  ipcMain.handle(IPC.gitPull, async (_e, projectPath: string) => gh.gitPull(projectPath))
  ipcMain.handle(IPC.gitCheckout, async (_e, projectPath: string, branch: string, create: boolean) =>
    gh.gitCheckout(projectPath, branch, create)
  )
  ipcMain.handle(IPC.gitTimeline, async (_e, projectPath: string) => gh.gitTimelineCached(projectPath))
  ipcMain.handle(IPC.gitLog, async (_e, projectPath: string, query?: GitLogQuery) => gh.gitLog(projectPath, query))
  ipcMain.handle(IPC.gitWorkingStat, async (_e, projectPath: string, subPath?: string) => gh.gitWorkingStat(projectPath, subPath))
  ipcMain.handle(IPC.gitCompareHead, async (_e, projectPath: string, relPath: string) => {
    // Read-only Compare: the last-backup version vs the current working copy, as a folded diff.
    const committed = await gh.gitShowHead(projectPath, relPath)
    if (committed == null) return { inBackup: false, lines: [] }
    const cur = fsService.readFile(projectPath, relPath)
    const current = cur.ok ? cur.content ?? '' : ''
    return { inBackup: true, lines: foldContext(diffLines(committed, current)) }
  })
  ipcMain.handle(IPC.gitRestoreFile, async (_e, projectPath: string, relPath: string) => {
    // Read the last-committed version, snapshot the CURRENT file for one-click Undo, then write it back.
    const committed = await gh.gitShowHead(projectPath, relPath)
    if (committed == null) return { ok: false, error: "Couldn't read the backed-up version." }
    const abs = join(projectPath, relPath)
    snapshot(abs, `Restore ${relPath} to last backup`)
    return fsService.writeFile(projectPath, relPath, committed)
  })
  ipcMain.handle(IPC.gitCommitFiles, async (_e, projectPath: string, hash: string) => gh.gitCommitFiles(projectPath, hash))
  // Client git engine (2026-08-31): staging, branches, remotes, merge + forges.
  ipcMain.handle(IPC.gitStage, async (_e, projectPath: string, relPaths: string[]) => gh.gitStage(projectPath, relPaths))
  ipcMain.handle(IPC.gitUnstage, async (_e, projectPath: string, relPaths: string[]) => gh.gitUnstage(projectPath, relPaths))
  ipcMain.handle(IPC.gitStagedStat, async (_e, projectPath: string) => gh.gitStagedStat(projectPath))
  ipcMain.handle(IPC.gitBranches, async (_e, projectPath: string) => gh.gitBranchesCached(projectPath))
  ipcMain.handle(IPC.gitBranchDelete, async (_e, projectPath: string, branch: string, force?: boolean) =>
    gh.gitBranchDelete(projectPath, branch, force === true)
  )
  ipcMain.handle(IPC.gitFetch, async (_e, projectPath: string, remote?: string) => gh.gitFetch(projectPath, remote))
  ipcMain.handle(IPC.gitRemotes, async (_e, projectPath: string) => gh.gitRemotesCached(projectPath))
  ipcMain.handle(IPC.gitRemoteAdd, async (_e, projectPath: string, name: string, url: string) => gh.gitRemoteAdd(projectPath, name, url))
  ipcMain.handle(IPC.gitClone, async (_e, url: string, destDir: string, name?: string) => gh.gitClone(url, destDir, name))
  // Self-hosted git provisioning (2026-09-03)
  ipcMain.handle(IPC.gitServerConfig, async () => {
    const key = studioKeyPath()
    return { server: gh.serverConfig(), managed: identityRequired(), keyPath: key, hasKey: existsSync(key) }
  })
  ipcMain.handle(IPC.gitServerSave, async (_e, server: GitServer) => {
    // A managed seat's catalogue is server-filtered and must not be overridable from the client.
    // The AUTHORITATIVE check now lives inside `saveServerConfig` itself (forge-atomic.ts), so it
    // still holds for any future main-process caller that skips IPC entirely. This is the OUTER
    // layer — reached first, free to phrase the message for the renderer — and is kept
    // deliberately redundant with the inner one rather than trusted alone: do not "simplify" one
    // of the two away.
    if (identityRequired()) return { ok: false, error: 'Your organisation manages this setting.' }
    return gh.saveServerConfig(server)
  })
  ipcMain.handle(IPC.gitServerTest, async (_e, server: GitServer) => preflight(server))
  ipcMain.handle(IPC.gitServerKey, async () => ensureKey())
  ipcMain.handle(IPC.gitPublishPlan, async (_e, projectPath: string, name: string) => {
    const s = gh.serverConfig()
    if (!s) return { error: 'No git server is configured yet.' }
    try {
      return await publishPlan(s, projectPath, name)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle(IPC.gitPublishRun, async (_e, projectPath: string, name: string) => {
    const s = gh.serverConfig()
    if (!s) return { ok: false, pushed: false, error: 'No git server is configured yet.' }
    return publishRun(s, projectPath, name)
  })
  ipcMain.handle(IPC.gitMerge, async (_e, projectPath: string, branch: string) => gh.gitMerge(projectPath, branch))
  ipcMain.handle(IPC.gitMergeAbort, async (_e, projectPath: string) => gh.gitMergeAbort(projectPath))
  ipcMain.handle(IPC.gitMergeContinue, async (_e, projectPath: string) => gh.gitMergeContinue(projectPath))
  ipcMain.handle(IPC.gitConflicts, async (_e, projectPath: string) => gh.gitConflicts(projectPath))
  ipcMain.handle(IPC.gitResolveFile, async (_e, projectPath: string, relPath: string) => gh.gitResolveFile(projectPath, relPath))
  ipcMain.handle(IPC.gitMergeInProgress, async (_e, projectPath: string) => gh.gitMergeInProgress(projectPath))
  ipcMain.handle(IPC.forgeList, async () =>
    Promise.all(gh.FORGES.map(async (f) => ({ id: f.id, name: f.name, kind: f.kind, signedIn: await f.signedIn() })))
  )
  ipcMain.handle(IPC.forgeRepos, async (_e, forgeId: string) => (await gh.forgeById(forgeId)?.repos()) ?? [])
  ipcMain.handle(IPC.gitAuthorship, async (_e, projectPath: string) => gh.gitAuthorship(projectPath))
  ipcMain.handle(IPC.kgCrossRepo, async (_e, paths: string[]) => gh.crossRepoGraph(Array.isArray(paths) ? paths : []))

  // ---- Enterprise: company-server workspace + protection policy ----
  ipcMain.handle(IPC.remoteConnect, async (_e, cfg: RemoteConfig, policy: RemotePolicy) => remote.remoteConnect(cfg, policy))
  ipcMain.handle(IPC.remoteDisconnect, async () => remote.remoteDisconnect())
  ipcMain.handle(IPC.remoteState, async (): Promise<RemoteState> => {
    const s = remote.activeRemote()
    return s ? { connected: true, cfg: s.cfg, policy: s.policy } : { connected: false }
  })
  ipcMain.handle(IPC.remoteList, async (_e, path: string) => remote.remoteList(path))
  ipcMain.handle(IPC.remoteRead, async (_e, path: string) => remote.remoteRead(path))
  ipcMain.handle(IPC.remoteWrite, async (_e, path: string, content: string) => remote.remoteWrite(path, content))
  ipcMain.handle(IPC.remoteExec, async (_e, command: string) => remote.remoteExec(command))
  ipcMain.handle(IPC.tunnelOpen, async (_e, remotePort: number, localPort?: number) => remote.tunnelOpen(remotePort, localPort))
  ipcMain.handle(IPC.tunnelList, async () => remote.tunnelList())
  ipcMain.handle(IPC.tunnelClose, async (_e, id: number) => remote.tunnelClose(id))
  // ---- ATOMIC Workspaces: two-tier codespaces ----
  ipcMain.handle(IPC.wsList, async () => ws.wsList())
  ipcMain.handle(IPC.wsCreateCompany, async (_e, req: WsProvisionRequest) => ws.wsCreateCompany(req))
  ipcMain.handle(IPC.wsCreateCloud, async (_e, req: WsCloudCreateRequest) => ws.wsCreateCloud(req))
  ipcMain.handle(IPC.wsOpen, async (_e, id: string) => ws.wsOpen(id))
  ipcMain.handle(IPC.wsDelete, async (_e, id: string, alsoRemote: boolean) => ws.wsDelete(id, alsoRemote))
  ipcMain.handle(IPC.wsHealth, async (_e, id: string) => ws.wsHealth(id))
  ipcMain.handle(IPC.wsCloudSetup, async (_e, baseUrl: string) => ws.wsCloudSetup(baseUrl))
  ipcMain.handle(IPC.wsCloudConfig, async () => ws.wsCloudConfig())
  ipcMain.handle(IPC.wsSecretsSet, async (_e, id: string, secrets: Record<string, string>) => ws.wsSecretsSet(id, secrets))
  ipcMain.handle(IPC.wsSecretNames, async (_e, id: string) => ws.wsSecretNames(id))
  ipcMain.handle(IPC.wsExec, async (_e, id: string, command: string) => ws.wsExec(id, command))
  ipcMain.handle(IPC.wsSnapshot, async (_e, id: string, name: string, description?: string) => ws.wsSnapshot(id, name, description))
  ipcMain.handle(IPC.wsSnapshots, async (_e, id: string) => ws.wsSnapshots(id))
  ipcMain.handle(IPC.wsRestore, async (_e, id: string, snapshotId: string) => ws.wsRestore(id, snapshotId))

  // ---- Phase 3: team, billing touchpoint, enterprise policy ----
  ipcMain.handle(IPC.wsTeamList, async () => ws.wsTeamList())
  ipcMain.handle(IPC.wsTeamInvite, async (_e, name: string, role: 'editor' | 'viewer') => ws.wsTeamInvite(name, role))
  ipcMain.handle(IPC.wsTeamRevoke, async (_e, name: string) => ws.wsTeamRevoke(name))
  ipcMain.handle(IPC.wsCloudRole, async () => ws.wsCloudRole())
  ipcMain.handle(IPC.wsSubscribeInfo, async () => ws.wsSubscribeInfo())
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(IPC.enterprisePolicy, async () => enterprisePolicy())
  ipcMain.handle(IPC.identityStatus, async () => identity.identityStatus())
  ipcMain.handle(IPC.identityBeginLogin, async () => identity.beginLogin())
  ipcMain.handle(IPC.identityCompleteLogin, async () => identity.completeLogin())
  ipcMain.handle(IPC.identityLogout, async () => identity.logout())
  ipcMain.handle(IPC.getAirGapped, async () => getAirGap())
  ipcMain.handle(IPC.setAirGapped, async (_e, on: boolean) => setAirGap(on))
  ipcMain.handle(IPC.getMode, async () => ({ mode: getMode(), chosen: modeChosen() }))
  ipcMain.handle(IPC.setMode, async (_e, mode: unknown) => {
    const next = setMode(mode)
    // The menu is built once and is static: rebuild it here or Builder Mode keeps a Terminal menu
    // whose panel the window no longer renders.
    setMenuState({ mode: next })
    // The menu is application-wide, so EVERY window must follow it: a second window left in the
    // other personality would be showing surfaces the shared menu bar no longer lists.
    broadcast(IPC.modeChanged, next)
    return next
  })

  // Themes. `themeSet` broadcasts for the same reason `setMode` does: the theme is application-wide,
  // and a second window left on the old palette would be the same window wearing two identities.
  ipcMain.handle(IPC.themeList, async () => listThemes())
  ipcMain.handle(IPC.themeGet, async () => getTheme())
  ipcMain.handle(IPC.themeSet, async (_e, id: unknown) => {
    const next = setTheme(id)
    broadcast(IPC.themeChanged, next)
    // The native window background sits behind the renderer: leaving it on the old theme's colour
    // shows a one-frame flash of the previous palette on every resize and on reload.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.setBackgroundColor(next.tokens.bg)
      // Windows/Linux draw their own minimise/maximise/close over our bar; left alone they keep the
      // launch theme's colours and read as a foreign strip in the corner.
      if (process.platform !== 'darwin') {
        try {
          win.setTitleBarOverlay({ ...titleBarOverlayColors(), height: 35 })
        } catch {
          /* not every platform/build supports the overlay; the bar itself is still themed */
        }
      }
    }
    return next
  })
  ipcMain.handle(IPC.themeInstallFile, async (e) => {
    const res = await installThemeFromFile(BrowserWindow.fromWebContents(e.sender))
    return res
  })
  ipcMain.handle(IPC.themeRemove, async (_e, id: string) => {
    const res = removeTheme(id)
    if (res.ok) broadcast(IPC.themeChanged, getTheme())
    return res
  })

  ipcMain.handle(IPC.auditEvent, async (_e, event: string, detail: string) => audit(event, detail))
  ipcMain.handle(IPC.auditTail, async () => auditTail())
  ipcMain.handle(IPC.reportFraud, async (_e, reason: string) =>
    reportFraud(remote.activeRemote()?.policy.fraudWebhook, reason)
  )
}

app.whenReady().then(() => {
  registerIpc()
  // Seed the menu with the stored personality FIRST: building the developer menu and correcting it
  // once the renderer reports in would flash a Terminal menu at a Builder-Mode user.
  setMenuState({ mode: getMode(), identityRequired: identityRequired(), role: identity.currentRole() })
  // One subscription for the whole app: the menu is application-wide, and every window must agree
  // about who is signed in for the same reason they must agree about the mode.
  identity.onIdentityChange((status) => {
    setMenuState({ identityRequired: status.required, role: status.identity?.role ?? null })
    broadcast(IPC.identityChanged, status)
  })
  buildMenu() // replaces Electron's generic default menu with Studio's own
  createWindow()
  // Silent re-sign-in from the stored refresh token. Deliberately NOT awaited: a managed seat must
  // still open its window when the identity provider is slow or unreachable.
  void identity.restoreSession()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const s of winStates.values()) s.pm.stop()
  // A live shell — or a connector's server process — holds the app open with no window to close
  // it from.
  pty.killAll()
  void mcp.stopAll()
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Wave 21 "No Silent Losses" — the renderer calls preventDefault() on beforeunload while any editor tab
 * has unsaved typing. Electron reports that as 'will-prevent-unload'; without a handler it closes anyway
 * and the typing is gone with no disk copy and no undo snapshot. Ask, and honour the answer.
 */
function guardUnsavedOnClose(win: BrowserWindow): void {
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep editing', 'Close and lose my typing'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved work',
      message: 'You have typing that was never saved.',
      detail: 'It only exists in the editor — closing now throws it away and nothing can bring it back.'
    })
    if (choice === 1) event.preventDefault() // preventDefault here = allow the close to proceed
  })
}

// 'will-quit' fires only once every window has actually agreed to close. Stopping the dev servers in
// 'before-quit' killed them BEFORE the unsaved-work dialog could cancel the quit, so choosing "Keep
// editing" left the user with a dead preview. Each window's own 'closed' handler already stops its
// process manager, so this is just the belt-and-braces sweep.
app.on('will-quit', () => {
  for (const s of winStates.values()) s.pm.stop()
  pty.killAll()
  void mcp.stopAll()
})
