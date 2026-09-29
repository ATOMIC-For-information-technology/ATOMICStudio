import { contextBridge, ipcRenderer } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc'
import type { AgentEvent, DevServerState, IdentityStatus, LogLine, PreviewControlAction, StudioApi, TermLineEvent } from '../shared/types'
import type { StudioMode } from '../shared/mode'
import type { Theme } from '../shared/theme'

/** Typed passthrough to ipcRenderer.invoke for a channel; arg/return types are
 * inferred from the StudioApi member each entry is assigned to. */
const invoke =
  <A extends unknown[], R>(channel: string) =>
  (...args: A): Promise<R> =>
    ipcRenderer.invoke(channel, ...args)

const api: StudioApi = {
  openProject: invoke(IPC.openProject),
  openProjectAt: invoke(IPC.openProjectAt),
  createProject: invoke(IPC.createProject),
  listProjectTemplates: invoke(IPC.listProjectTemplates),
  newWindow: invoke(IPC.newWindow),
  indexSearch: invoke(IPC.indexSearch),
  dockerInfo: invoke(IPC.dockerInfo),
  dockerCompose: invoke(IPC.dockerCompose),
  projectInsight: invoke(IPC.projectInsight),
  projectBrain: invoke(IPC.projectBrain),
  architectureMap: invoke(IPC.architectureMap),
  blastRadius: invoke(IPC.blastRadius),
  configGuard: invoke(IPC.configGuard),
  scanStagedSecrets: invoke(IPC.scanStagedSecrets),
  explainProject: invoke(IPC.explainProject),
  draftGitText: invoke(IPC.draftGitText),
  explainOutput: invoke(IPC.explainOutput),
  getUsage: invoke(IPC.getUsage),
  resetUsage: invoke(IPC.resetUsage),
  setSpendCap: invoke(IPC.setSpendCap),
  undoCheckpoints: invoke(IPC.undoCheckpoints),
  restoreCheckpoint: invoke(IPC.restoreCheckpoint),
  ledgerList: invoke(IPC.ledgerList),
  ledgerSearch: invoke(IPC.ledgerSearch),
  addDecision: invoke(IPC.addDecision),
  listDecisions: invoke(IPC.listDecisions),
  analyticsRecord: invoke(IPC.analyticsRecord),
  analyticsList: invoke(IPC.analyticsList),
  contextPack: invoke(IPC.contextPack),
  gitAuthorship: invoke(IPC.gitAuthorship),
  kgCrossRepo: invoke(IPC.kgCrossRepo),
  saveArchBaseline: invoke(IPC.saveArchBaseline),
  archDrift: invoke(IPC.archDrift),
  designReview: invoke(IPC.designReview),
  planApplyTokens: invoke(IPC.planApplyTokens),
  applyTokens: invoke(IPC.applyTokens),
  securityScan: invoke(IPC.securityScan),
  dependencyAudit: invoke(IPC.dependencyAudit),
  generateTests: invoke(IPC.generateTests),
  runbook: invoke(IPC.runbook),
  complianceExport: invoke(IPC.complianceExport),
  startDevServer: invoke(IPC.startDevServer),
  stopDevServer: invoke(IPC.stopDevServer),
  getDevServerState: invoke(IPC.getDevServerState),

  onDevServerState: (cb: (state: DevServerState) => void) => {
    const listener = (_e: unknown, state: DevServerState) => cb(state)
    ipcRenderer.on(IPC.devServerState, listener)
    return () => ipcRenderer.removeListener(IPC.devServerState, listener)
  },

  onLog: (cb: (line: LogLine) => void) => {
    const listener = (_e: unknown, line: LogLine) => cb(line)
    ipcRenderer.on(IPC.log, listener)
    return () => ipcRenderer.removeListener(IPC.log, listener)
  },

  // Wave 23 — live filesystem watching: fires with the project-relative paths that changed OUTSIDE the
  // app (Finder, a terminal command, npm install, another editor), so the tree and open tabs stay real.
  onFsChanged: (cb: (paths: string[]) => void) => {
    const listener = (_e: unknown, paths: string[]) => cb(paths)
    ipcRenderer.on(IPC.fsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.fsChanged, listener)
  },

  // Phase 1 — click-to-edit
  applyEdit: invoke(IPC.applyEdit),
  inlineEdit: invoke(IPC.inlineEdit),
  autocomplete: invoke(IPC.autocomplete),
  autoFix: invoke(IPC.autoFix),
  runEditGoal: invoke(IPC.runEditGoal),
  undoEdit: invoke(IPC.undoEdit),
  getUndoState: invoke(IPC.getUndoState),
  getUndoHistory: invoke(IPC.getUndoHistory),
  undoTo: invoke(IPC.undoTo),
  undoDiff: invoke(IPC.undoDiff),
  setApiKey: invoke(IPC.setApiKey),
  hasApiKey: invoke(IPC.hasApiKey),
  vaultStatus: invoke(IPC.vaultStatus),
  listProviders: invoke(IPC.listProviders),
  modelCatalog: invoke(IPC.modelCatalog),
  opencodeModels: invoke(IPC.opencodeModels),
  modelPull: invoke(IPC.modelPull),
  ollamaStart: invoke(IPC.ollamaStart),
  listActivePulls: invoke(IPC.listActivePulls),

  // Phase 7 — IDE shell: file tree + editor
  listDir: invoke(IPC.listDir),
  readFile: invoke(IPC.readFile),
  writeFile: invoke(IPC.writeFile),
  createFile: invoke(IPC.createFile),
  createDir: invoke(IPC.createDir),
  renamePath: invoke(IPC.renamePath),
  deletePath: invoke(IPC.deletePath),
  previewPath: invoke(IPC.previewPath),
  trashPath: invoke(IPC.trashPath),
  gitPathIgnored: invoke(IPC.gitPathIgnored),

  // Phase 8 — real iOS Simulator (macOS)
  listSimulators: invoke(IPC.listSimulators),
  openInSimulator: invoke(IPC.openInSimulator),
  simulatorScreenshot: invoke(IPC.simulatorScreenshot),

  // Phase 10 — built-in AI agent
  agentStart: invoke(IPC.agentStart),
  agentCancel: invoke(IPC.agentCancel),
  agentState: invoke(IPC.agentState),
  agentApply: invoke(IPC.agentApply),
  agentReject: invoke(IPC.agentReject),
  agentNewChat: invoke(IPC.agentNewChat),
  onAgentEvent: (cb: (ev: AgentEvent) => void) => {
    const listener = (_e: unknown, ev: AgentEvent) => cb(ev)
    ipcRenderer.on(IPC.agentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.agentEvent, listener)
  },

  // Media generation — images + video on the client's own account
  mediaProviders: invoke(IPC.mediaProviders),
  mediaGenerate: invoke(IPC.mediaGenerate),
  mediaList: invoke(IPC.mediaList),
  mediaDelete: invoke(IPC.mediaDelete),
  mediaDataUrl: invoke(IPC.mediaDataUrl),
  mediaUsage: invoke(IPC.mediaUsage),
  mediaSetCap: invoke(IPC.mediaSetCap),
  onMediaProgress: (cb: (ev: { note: string }) => void) => {
    const listener = (_e: unknown, ev: { note: string }) => cb(ev)
    ipcRenderer.on(IPC.mediaProgress, listener)
    return () => ipcRenderer.removeListener(IPC.mediaProgress, listener)
  },

  // Phase 10 — integrated terminal
  termRun: invoke(IPC.termRun),
  termKill: invoke(IPC.termKill),
  ptyStart: invoke(IPC.ptyStart),
  ptyWrite: invoke(IPC.ptyWrite),
  ptyResize: invoke(IPC.ptyResize),
  ptyKill: invoke(IPC.ptyKill),
  ptyScrollback: invoke(IPC.ptyScrollback),
  menuState: invoke(IPC.menuState),
  memoryList: invoke(IPC.memoryList),
  memoryAdd: invoke(IPC.memoryAdd),
  memoryForget: invoke(IPC.memoryForget),
  memoryPin: invoke(IPC.memoryPin),
  memoryStats: invoke(IPC.memoryStats),
  memoryPreview: invoke(IPC.memoryPreview),
  memorySetSync: invoke(IPC.memorySetSync),
  connectorList: invoke(IPC.connectorList),
  connectorSetEnabled: invoke(IPC.connectorSetEnabled),
  connectorApproveTool: invoke(IPC.connectorApproveTool),
  connectorRemove: invoke(IPC.connectorRemove),
  extensionsList: invoke(IPC.extensionsList),
  extensionInstallFolder: invoke(IPC.extensionInstallFolder),
  extensionInstallGit: invoke(IPC.extensionInstallGit),
  extensionUninstall: invoke(IPC.extensionUninstall),
  extensionRegistry: invoke(IPC.extensionRegistry),
  previewControlResult: invoke(IPC.previewControlResult),

  // Enterprise — GitHub / git
  ghUser: invoke(IPC.ghUser),
  pickFolder: invoke(IPC.pickFolder),
  gitInfo: invoke(IPC.gitInfo),
  gitSnapshot: invoke(IPC.gitSnapshot),
  gitDiffFile: invoke(IPC.gitDiffFile),
  onGitChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.gitChanged, listener)
    return () => ipcRenderer.removeListener(IPC.gitChanged, listener)
  },
  gitCommit: invoke(IPC.gitCommit),
  gitPush: invoke(IPC.gitPush),
  gitPull: invoke(IPC.gitPull),
  gitCheckout: invoke(IPC.gitCheckout),
  gitTimeline: invoke(IPC.gitTimeline),
  gitLog: invoke(IPC.gitLog),
  gitWorkingStat: invoke(IPC.gitWorkingStat),
  gitCompareHead: invoke(IPC.gitCompareHead),
  gitRestoreFile: invoke(IPC.gitRestoreFile),
  gitCommitFiles: invoke(IPC.gitCommitFiles),
  gitStage: invoke(IPC.gitStage),
  gitUnstage: invoke(IPC.gitUnstage),
  gitStagedStat: invoke(IPC.gitStagedStat),
  gitBranches: invoke(IPC.gitBranches),
  gitBranchDelete: invoke(IPC.gitBranchDelete),
  gitFetch: invoke(IPC.gitFetch),
  gitRemotes: invoke(IPC.gitRemotes),
  gitRemoteAdd: invoke(IPC.gitRemoteAdd),
  gitClone: invoke(IPC.gitClone),
  gitServerConfig: invoke(IPC.gitServerConfig),
  gitServerSave: invoke(IPC.gitServerSave),
  gitServerTest: invoke(IPC.gitServerTest),
  gitServerKey: invoke(IPC.gitServerKey),
  gitPublishPlan: invoke(IPC.gitPublishPlan),
  gitPublishRun: invoke(IPC.gitPublishRun),
  gitMerge: invoke(IPC.gitMerge),
  gitMergeAbort: invoke(IPC.gitMergeAbort),
  gitMergeContinue: invoke(IPC.gitMergeContinue),
  gitConflicts: invoke(IPC.gitConflicts),
  gitResolveFile: invoke(IPC.gitResolveFile),
  gitMergeInProgress: invoke(IPC.gitMergeInProgress),
  forgeList: invoke(IPC.forgeList),
  forgeRepos: invoke(IPC.forgeRepos),

  // Identity — on-prem OIDC sign-in (air-gapped enterprise)
  identityStatus: invoke(IPC.identityStatus),
  identityBeginLogin: invoke(IPC.identityBeginLogin),
  identityCompleteLogin: invoke(IPC.identityCompleteLogin),
  identityLogout: invoke(IPC.identityLogout),
  onIdentityChanged: (cb: (status: IdentityStatus) => void) => {
    const listener = (_e: unknown, status: IdentityStatus) => cb(status)
    ipcRenderer.on(IPC.identityChanged, listener)
    return () => ipcRenderer.removeListener(IPC.identityChanged, listener)
  },

  // Enterprise — company-server workspace + protection policy
  remoteConnect: invoke(IPC.remoteConnect),
  remoteDisconnect: invoke(IPC.remoteDisconnect),
  remoteState: invoke(IPC.remoteState),
  remoteList: invoke(IPC.remoteList),
  remoteRead: invoke(IPC.remoteRead),
  remoteWrite: invoke(IPC.remoteWrite),
  remoteExec: invoke(IPC.remoteExec),
  tunnelOpen: invoke(IPC.tunnelOpen),
  tunnelList: invoke(IPC.tunnelList),
  tunnelClose: invoke(IPC.tunnelClose),
  // ATOMIC Workspaces
  wsList: invoke(IPC.wsList),
  wsCreateCompany: invoke(IPC.wsCreateCompany),
  wsCreateCloud: invoke(IPC.wsCreateCloud),
  wsOpen: invoke(IPC.wsOpen),
  wsDelete: invoke(IPC.wsDelete),
  wsHealth: invoke(IPC.wsHealth),
  wsCloudSetup: invoke(IPC.wsCloudSetup),
  wsCloudConfig: invoke(IPC.wsCloudConfig),
  wsSecretsSet: invoke(IPC.wsSecretsSet),
  wsSecretNames: invoke(IPC.wsSecretNames),
  wsExec: invoke(IPC.wsExec),
  wsSnapshot: invoke(IPC.wsSnapshot),
  wsSnapshots: invoke(IPC.wsSnapshots),
  wsRestore: invoke(IPC.wsRestore),
  wsTeamList: invoke(IPC.wsTeamList),
  wsTeamInvite: invoke(IPC.wsTeamInvite),
  wsTeamRevoke: invoke(IPC.wsTeamRevoke),
  wsCloudRole: invoke(IPC.wsCloudRole),
  wsSubscribeInfo: invoke(IPC.wsSubscribeInfo),
  openExternal: invoke(IPC.openExternal),
  enterprisePolicy: invoke(IPC.enterprisePolicy),
  getAirGapped: invoke(IPC.getAirGapped),
  setAirGapped: invoke(IPC.setAirGapped),
  getMode: invoke(IPC.getMode),
  setMode: invoke(IPC.setMode),
  themeList: invoke(IPC.themeList),
  themeGet: invoke(IPC.themeGet),
  themeSet: invoke(IPC.themeSet),
  themeInstallFile: invoke(IPC.themeInstallFile),
  themeRemove: invoke(IPC.themeRemove),
  onThemeChanged: (cb: (theme: Theme) => void) => {
    const listener = (_e: unknown, theme: Theme): void => cb(theme)
    ipcRenderer.on(IPC.themeChanged, listener)
    return () => ipcRenderer.removeListener(IPC.themeChanged, listener)
  },
  onModeChanged: (cb: (mode: StudioMode) => void) => {
    const listener = (_e: unknown, mode: StudioMode): void => cb(mode)
    ipcRenderer.on(IPC.modeChanged, listener)
    return () => ipcRenderer.removeListener(IPC.modeChanged, listener)
  },
  auditEvent: invoke(IPC.auditEvent),
  auditTail: invoke(IPC.auditTail),
  reportFraud: invoke(IPC.reportFraud),
  onPreviewControl: (cb: (req: { id: number; action: PreviewControlAction; arg: string; text?: string }) => void) => {
    const listener = (_e: unknown, req: { id: number; action: PreviewControlAction; arg: string; text?: string }) =>
      cb(req)
    ipcRenderer.on(IPC.previewControl, listener)
    return () => {
      ipcRenderer.removeListener(IPC.previewControl, listener)
    }
  },
  onMenuCommand: (cb: (cmd: string) => void) => {
    const listener = (_e: unknown, cmd: string) => cb(cmd)
    ipcRenderer.on(IPC.menuCommand, listener)
    return () => ipcRenderer.removeListener(IPC.menuCommand, listener)
  },
  onPtyData: (cb: (ev: { id: number; data: string }) => void) => {
    const listener = (_e: unknown, ev: { id: number; data: string }) => cb(ev)
    ipcRenderer.on(IPC.ptyData, listener)
    return () => ipcRenderer.removeListener(IPC.ptyData, listener)
  },
  onTermLine: (cb: (ev: TermLineEvent) => void) => {
    const listener = (_e: unknown, ev: TermLineEvent) => cb(ev)
    ipcRenderer.on(IPC.termLine, listener)
    return () => ipcRenderer.removeListener(IPC.termLine, listener)
  }
}

contextBridge.exposeInMainWorld('studio', api)

// The <webview> preview loads this preload (built alongside this file) to enable
// click-to-select inside the running app.
contextBridge.exposeInMainWorld(
  'studioPreviewPreloadUrl',
  pathToFileURL(join(__dirname, 'preview.js')).toString()
)
