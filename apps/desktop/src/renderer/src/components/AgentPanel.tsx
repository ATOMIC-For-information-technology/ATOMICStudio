import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, AgentMode, AgentState, BlastRadius, BuildReceipt, ConfigAdvisory, DevServerState, GitInfo, ProviderInfo, StagedEdit, StagedSecretGuard, VerifyResult } from '../../../shared/types'
import { Icon } from './Icon'
import { MultiAgentBoard } from './MultiAgentBoard'
import { BuildReceiptCard } from './agent-panel/build-receipt'
import {
  ActiveContext,
  ActivityFeed,
  AgentHeader,
  AgentInput,
  ArtifactPanel,
  AttentionStrip,
  CollapsibleSection,
  Conversation,
  DiffPreview,
  ExecutionTimeline,
  MissionHero,
  WorkspaceHealth,
  buildTimeline,
  deriveActiveFiles,
  deriveActivity,
  deriveAppliedFiles,
  deriveArtifacts,
  deriveAttention,
  deriveContext,
  deriveConversation,
  deriveDiffFiles,
  deriveHealth,
  deriveMission,
  derivePhase,
  truncateTitle,
  useCollapsed
} from './agent-panel'

/** One entry in the agent thread: prose for the chat, tool chips for the timeline. */
type ThreadItem =
  | { id: number; ts: number; kind: 'user' | 'ai' | 'done' | 'err'; text: string }
  | { id: number; ts: number; kind: 'tool'; tool: string; detail: string; ok: boolean }
  | { id: number; ts: number; kind: 'warn'; command: string }

type NewThreadItem =
  | { kind: 'user' | 'ai' | 'done' | 'err'; text: string }
  | { kind: 'tool'; tool: string; detail: string; ok: boolean }
  | { kind: 'warn'; command: string }

/** An edit that landed on disk this session, kept with its post-apply syntax check. */
interface AppliedEdit {
  edit: StagedEdit
  verify?: VerifyResult
}

/**
 * Right dock (🤖 Agent) — the Mission Control layout: a fixed header (status,
 * elapsed time, title, mode, New Chat), the pinned Mission hero
 * (phase + progress + fact chips) with the attention strip under it, then the
 * scrollable sections (timeline, activity, context, artifacts, chat, Diff
 * Preview with Apply/Reject), a pinned Workspace Health strip, and the bottom
 * input. All
 * logic is the classic dock's: one event subscription, staged-edit apply/
 * reject, recently-applied verify badges, seed prefill — only the layout is
 * new. Everything on screen derives from real agent data (see derive.ts).
 */
export function AgentPanel(props: {
  projectPath: string
  providerId: string
  model: string
  /** The full provider catalog — only used by Relay's "hand off using this provider" picker. */
  providers: ProviderInfo[]
  onApplied: (paths: string[], opts?: { skipVerify?: boolean; actor?: 'ai' | 'disk' }) => void
  onProblems: (items: { message: string; file?: string }[]) => void
  seed: { text: string; nonce: number } | null
  /** Builder Mode hides git everywhere else, so the Git status row goes with it. */
  showGit?: boolean
}): React.JSX.Element {
  const { projectPath, providerId, model } = props

  /** The AI Build Receipt for the most recent run — what it did, measured. */
  const [receipt, setReceipt] = useState<BuildReceipt | null>(null)
  const [rollingBack, setRollingBack] = useState(false)
  const [mode, setMode] = useState<AgentMode>('build')
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const [thread, setThread] = useState<ThreadItem[]>([])
  const [staged, setStaged] = useState<StagedEdit[]>([])
  const [applied, setApplied] = useState<AppliedEdit[]>([])
  const [snap, setSnap] = useState<AgentState | null>(null)
  const [devServer, setDevServer] = useState<DevServerState | null>(null)
  // Apply-moment guardrails, async-enriched per touched path (Wave 13/16).
  const [blast, setBlast] = useState<Record<string, BlastRadius>>({})
  const [config, setConfig] = useState<Record<string, ConfigAdvisory>>({})
  const [secrets, setSecrets] = useState<Record<string, StagedSecretGuard>>({})
  // Workspace Health's Git row — read on mount and refreshed after each apply.
  const [git, setGit] = useState<GitInfo | null>(null)

  const nextId = useRef(1)
  // The event subscription is bound once on mount — route prop callbacks through a
  // ref so it always calls the latest versions without resubscribing.
  const propsRef = useRef(props)
  propsRef.current = props

  /* --- Relay: hand this run's result to a second PROVIDER when it finishes ---
     Turn-based, not concurrent — the backend's serial run queue already guarantees two runs are
     never simultaneously active, and this doesn't touch that. It's a one-shot: arm it, send, the
     next 'done' for THAT run fires exactly one follow-up `agentStart`, using the exact same
     mechanism `send()` already uses. Everything the event listener below reads is mirrored into
     refs (same reason `propsRef` exists) since the listener is bound once on mount and would
     otherwise see stale state. */
  const [relayArmed, setRelayArmed] = useState(false)
  const [relayProviderId, setRelayProviderId] = useState('')
  const relayLive = useRef({ mode: 'build' as AgentMode, relayProviderId })
  relayLive.current = { mode, relayProviderId }
  /** Set at send() time when Relay is armed; matched against the 'started' event's instruction to
   *  find which runId is this specific send (agentStart's response carries no runId). */
  const relayCapturing = useRef<{ instruction: string; providerId: string } | null>(null)
  const relayWaitingRunId = useRef<number | null>(null)
  const relayStep1 = useRef<{ providerId: string } | null>(null)

  // Default the relay provider to something OTHER than the currently active one — "have a second
  // model review the first one's work" is the common case, not something to configure by hand.
  // Runs once real providers arrive; never overrides a choice the user already made.
  useEffect(() => {
    if (relayProviderId || props.providers.length === 0) return
    const other = props.providers.find((p) => p.id !== providerId)
    setRelayProviderId(other?.id ?? props.providers[0].id)
  }, [props.providers, providerId, relayProviderId])

  const { toggle, isCollapsed } = useCollapsed()

  // Scroll target for the attention strip's "Review" action.
  const diffRef = useRef<HTMLDivElement>(null)

  function reviewDiff(): void {
    if (isCollapsed('diff')) toggle('diff')
    requestAnimationFrame(() => {
      diffRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const push = useCallback((item: NewThreadItem) => {
    setThread((t) => [...t, { ...item, id: nextId.current++, ts: Date.now() }])
  }, [])

  // Re-read the ground truth after lifecycle moves: a queued run may be draining,
  // so one run finishing does NOT mean the dock is idle.
  const refreshState = useCallback(() => {
    void window.studio.agentState().then((s) => {
      setSnap(s)
      setRunning(s.running)
      setStaged(s.staged)
    })
  }, [])

  // This container is never unmounted across a project switch (App.tsx just
  // re-renders it with a new projectPath prop) — so every run-scoped piece of
  // state has to be cleared by hand here, or the previous project's session
  // (stale chat, stale staged diffs, stale guardrail maps) leaks into the
  // newly-opened project, and Apply/Reject can act on stale paths.
  useEffect(() => {
    setThread([])
    setStaged([])
    setApplied([])
    setSnap(null)
    setDevServer(null)
    setBlast({})
    setConfig({})
    setSecrets({})
    setGit(null)
    refreshState()
  }, [projectPath, refreshState])

  // Mount: restore an in-progress run, load dev-server state, then
  // stream every agent lifecycle event.
  useEffect(() => {
    refreshState()
    void window.studio.getDevServerState().then(setDevServer)
    const offDev = window.studio.onDevServerState(setDevServer)
    const off = window.studio.onAgentEvent((ev: AgentEvent) => {
      switch (ev.type) {
        case 'started':
          setRunning(true)
          refreshState()
          // Claim this runId for Relay only if it matches the instruction just sent while armed —
          // a text match, not just "the next started event," since another run could in principle
          // start in between (queued elsewhere) before this one's turn comes.
          if (relayCapturing.current && ev.instruction === relayCapturing.current.instruction) {
            relayWaitingRunId.current = ev.runId
            relayStep1.current = { providerId: relayCapturing.current.providerId }
            relayCapturing.current = null
          }
          break
        case 'queued':
          refreshState()
          break
        case 'assistant':
          push({ kind: 'ai', text: ev.text })
          // Keeps snap.active.turns live for the Teammate Board (was previously
          // a separate, higher-frequency poll living only in MultiAgentBoard).
          refreshState()
          break
        case 'tool':
          push({ kind: 'tool', tool: ev.tool, detail: ev.detail, ok: ev.ok })
          refreshState()
          break
        case 'command-blocked':
          push({ kind: 'warn', command: ev.command })
          break
        case 'staged':
          setStaged((cur) => {
            const i = cur.findIndex((e) => e.id === ev.edit.id)
            if (i < 0) return [...cur, ev.edit]
            const next = cur.slice()
            next[i] = ev.edit
            return next
          })
          // Keeps snap.active.stagedCount live for the Teammate Board.
          refreshState()
          break
        case 'applied':
          // Build mode auto-applies right after staging: move the card to
          // "Recently applied" with its verify result.
          setStaged((cur) => cur.filter((e) => e.id !== ev.edit.id))
          setApplied((cur) => [...cur, { edit: ev.edit, verify: ev.verify }])
          propsRef.current.onApplied([ev.edit.path])
          break
        case 'done':
          push({ kind: 'done', text: ev.summary })
          // The receipt is the run's conclusion in measurements — see build-receipt.tsx.
          if (ev.receipt) setReceipt(ev.receipt)
          refreshState()
          if (relayWaitingRunId.current === ev.runId) {
            relayWaitingRunId.current = null
            const step1 = relayStep1.current
            const { mode: toMode, relayProviderId: toProvider } = relayLive.current
            const files = ev.receipt?.files.map((f) => f.path).join(', ')
            const followUp = [
              `A prior agent (provider: ${step1?.providerId ?? 'unknown'}) just finished: "${ev.summary}"`,
              files ? `Files it changed: ${files}.` : '',
              'Review this work and continue.'
            ].filter(Boolean).join(' ')
            // Visible in the transcript, not a silent background action — the whole point of Relay
            // is that the handoff is something you can see happen.
            push({ kind: 'done', text: `Handed off to ${toProvider}…` })
            void window.studio.agentStart({
              projectPath: propsRef.current.projectPath,
              instruction: followUp,
              mode: toMode,
              provider: toProvider
            })
          }
          break
        case 'error':
          push({ kind: 'err', text: ev.error })
          refreshState()
          if (relayWaitingRunId.current === ev.runId) relayWaitingRunId.current = null
          break
      }
    })
    return () => {
      off()
      offDev()
    }
  }, [push, refreshState])

  // "Fix with AI" seeds the input with a targeted instruction — prefill only, never auto-send.
  const lastNonce = useRef<number | null>(null)
  useEffect(() => {
    if (props.seed && props.seed.nonce !== lastNonce.current && props.seed.text) {
      lastNonce.current = props.seed.nonce
      setInput(props.seed.text)
    }
  }, [props.seed])

  // Wave 13/16 guardrails: blast radius + wiring/config per touched path, secret
  // scan for staged edits. Async-enriched — the cards render first, chips fade in.
  const touchedKey = useMemo(() => {
    const set = new Set<string>()
    for (const e of staged) set.add(e.path)
    for (const a of applied) set.add(a.edit.path)
    return [...set].sort().join('\n')
  }, [staged, applied])

  useEffect(() => {
    if (!touchedKey) return
    const paths = touchedKey.split('\n')
    let alive = true
    void window.studio
      .blastRadius(projectPath, paths)
      .then((r) => { if (alive) setBlast((cur) => ({ ...cur, ...r })) })
      .catch(() => undefined)
    void window.studio
      .configGuard(paths)
      .then((r) => { if (alive) setConfig((cur) => ({ ...cur, ...r })) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [touchedKey, projectPath])

  // Workspace Health's Git row: read on mount / project change, and refreshed
  // after each apply (a commit-free workflow can still change the working tree).
  useEffect(() => {
    let alive = true
    void window.studio.gitInfo(projectPath).then((i) => { if (alive) setGit(i) }).catch(() => undefined)
    return () => { alive = false }
  }, [projectPath, applied.length])

  useEffect(() => {
    if (staged.length === 0) {
      setSecrets({})
      return
    }
    let alive = true
    void window.studio
      .scanStagedSecrets()
      .then((r) => { if (alive) setSecrets(r) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [touchedKey])

  async function send(): Promise<void> {
    const instruction = input.trim()
    if (!instruction) return
    push({ kind: 'user', text: instruction })
    setInput('')
    if (relayArmed) relayCapturing.current = { instruction, providerId }
    const res = await window.studio.agentStart({
      projectPath,
      instruction,
      mode,
      provider: providerId,
      model: model.trim() || undefined
    })
    if (res.queued) push({ kind: 'done', text: 'Queued — this runs when the current task finishes' })
    if (!res.ok) {
      push({ kind: 'err', text: res.error ?? 'Could not start the agent' })
      relayCapturing.current = null
    }
  }

  async function apply(ids: string[] | 'all'): Promise<void> {
    const res = await window.studio.agentApply(ids)
    if (!res.ok) {
      push({ kind: 'err', text: res.error ?? 'Apply failed' })
      return
    }
    setStaged((cur) => (ids === 'all' ? [] : cur.filter((e) => !ids.includes(e.id))))
    propsRef.current.onApplied(res.applied)
    const problems = res.verify
      .filter((v) => !v.ok)
      .map((v) => ({ message: v.error ?? 'Syntax check failed', file: v.path }))
    if (problems.length > 0) propsRef.current.onProblems(problems)
  }

  async function reject(ids: string[] | 'all'): Promise<void> {
    const state = await window.studio.agentReject(ids)
    setStaged(state.staged)
  }

  function newChat(): void {
    void window.studio.agentNewChat()
    setThread([])
    setStaged([])
    setApplied([])
    setBlast({})
    setConfig({})
    setSecrets({})
  }

  // ---- Derived view-models (pure — see agent-panel/derive.ts) ---------------

  const toolItems = useMemo(
    () => thread.filter((t): t is Extract<ThreadItem, { kind: 'tool' }> => t.kind === 'tool'),
    [thread]
  )
  const msgs = useMemo(() => deriveConversation(thread), [thread])
  const steps = useMemo(() => buildTimeline(toolItems, running), [toolItems, running])
  /* Compact mode.
     Below this height (measured, not guessed: at 1024×680 with the bottom panel open the dock gets
     ~250px) the dock cannot show its middle sections without slicing one — a half-rendered
     chat message reads as a rendering bug, and at 1024×680 with the bottom panel open there is
     genuinely less room than header + board + hero + attention + sections + input need. Rather than
     shave pixels off everything, the middle collapses to a single honest line and the user decides
     whether to spend the space. */
  const COMPACT_BELOW = 380
  const panelRef = useRef<HTMLDivElement>(null)
  const [dockHeight, setDockHeight] = useState(0)
  const [forceExpanded, setForceExpanded] = useState(false)
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setDockHeight(el.clientHeight))
    ro.observe(el)
    setDockHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])
  const compact = dockHeight > 0 && dockHeight < COMPACT_BELOW && !forceExpanded

  const artifacts = useMemo(() => {
    const list = deriveArtifacts(msgs, applied)
    if (!receipt) return list
    /* The receipt goes FIRST: of everything in this list it is the only item that shows the change
       actually working, rather than describing it. */
    return [
      {
        id: 'receipt',
        title: 'Build receipt',
        summary: `${receipt.files.length} file${receipt.files.length === 1 ? '' : 's'} · ${receipt.checks.passed}/${receipt.checks.ran} checks · ~${receipt.tokens.estTokens.toLocaleString()} tokens`,
        body: receipt.summary,
        icon: 'check' as const,
        image: receipt.snapshot
      },
      ...list
    ]
  }, [msgs, applied, receipt])
  const diffFiles = useMemo(() => deriveDiffFiles(staged), [staged])
  const appliedFiles = useMemo(() => deriveAppliedFiles(applied), [applied])
  const { current: currentFile } = useMemo(() => deriveActiveFiles(staged, applied), [staged, applied])
  const activityItems = useMemo(() => deriveActivity(applied), [applied])
  const contextData = useMemo(
    () => deriveContext({ projectPath, currentFile: currentFile ?? null, blast }),
    [projectPath, currentFile, blast]
  )

  const objective =
    snap?.active?.instruction ??
    (snap?.finished && snap.finished.length > 0 ? snap.finished[snap.finished.length - 1].instruction : '')
  const lastTool = toolItems.length > 0 ? toolItems[toolItems.length - 1] : null
  const currentTask = running && lastTool ? `${lastTool.tool}: ${lastTool.detail}`.trim() : null
  const mission = deriveMission({
    objective,
    currentTask,
    currentFile: currentFile ?? null,
    stagedCount: staged.length,
    appliedCount: applied.length
  })

  const latestVerify = useMemo(() => {
    for (let i = applied.length - 1; i >= 0; i--) {
      if (applied[i].verify) return applied[i].verify ?? null
    }
    return null
  }, [applied])

  // Hero: honest phase + aggregate confidence across every edit this session.
  const phase = derivePhase({
    running,
    mode,
    stagedCount: staged.length,
    appliedCount: applied.length,
    hasVerify: latestVerify !== null
  })
  const heroConfidence = useMemo(() => {
    const confs = [...staged.map((e) => e.confidence), ...applied.map((a) => a.edit.confidence)]
    if (confs.length === 0) return null
    return Math.round(confs.reduce((sum, c) => sum + c, 0) / confs.length)
  }, [staged, applied])

  // Attention strip: staged approvals, held secrets, blocked commands, failed checks.
  const hasBlockedCommand = useMemo(() => thread.some((t) => t.kind === 'warn'), [thread])
  const attentionItems = useMemo(
    () => deriveAttention({ stagedCount: staged.length, secrets, hasBlockedCommand, latestVerify }),
    [staged.length, secrets, hasBlockedCommand, latestVerify]
  )
  /** What the compact line reports, so collapsing the middle never hides that something happened. */
  const compactSummary = useMemo(() => {
    const bits: string[] = []
    const tasks = (snap?.finished?.length ?? 0) + (snap?.active ? 1 : 0)
    if (tasks) bits.push(`${tasks} task${tasks === 1 ? '' : 's'}`)
    if (diffFiles.length) bits.push(`${diffFiles.length} file${diffFiles.length === 1 ? '' : 's'} to review`)
    if (steps.length) bits.push(`${steps.length} step${steps.length === 1 ? '' : 's'}`)
    if (artifacts.length) bits.push(`${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`)
    return bits.join(' · ')
  }, [snap, diffFiles.length, steps.length, artifacts.length])

  const healthRows = useMemo(
    () =>
      deriveHealth({
        running,
        queued: snap?.queued ?? 0,
        verify: latestVerify,
        devServer,
        git: props.showGit === false ? null : git,
        hasBlockedCommand
      }),
    [running, snap, latestVerify, devServer, git, hasBlockedCommand, props.showGit]
  )

  // Same source as the Mission Hero's title (mission.objective) — the header and the
  // Hero must never show two independently-sourced sentences for "the objective".
  const title = mission.objective ? truncateTitle(mission.objective, 42) : 'Agent'

  return (
    <div className={`agent-panel ${compact ? 'ap-compact-mode' : ''}`} ref={panelRef}>
      <AgentHeader
        busy={running}
        title={title}
        mode={mode}
        startedAt={snap?.active?.startedAt ?? null}
        onModeChange={setMode}
        onNewChat={newChat}
      />

      <div className="ap-relay-row">
        <button
          type="button"
          className={`ap-icon-btn ${relayArmed ? 'active' : ''}`}
          onClick={() => setRelayArmed((v) => !v)}
          title="When this run finishes, hand its result to a second provider as context — not simultaneous, one after the other"
        >
          <Icon name="arrow-enter" size={12} /> Relay
        </button>
        {relayArmed && (
          <>
            <select
              className="ap-select"
              value={relayProviderId}
              onChange={(e) => setRelayProviderId(e.target.value)}
              title="Hand off using this provider"
            >
              {props.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Hidden only when the dock is too short to hold it — and its count moves into the compact
          line above, so nothing disappears without being accounted for. */}
      {!compact && <MultiAgentBoard state={snap} />}

      <div className="ap-hero-zone">
        <MissionHero
          objective={mission.objective}
          phase={phase}
          progress={mission.progress}
          running={running}
          currentTask={mission.currentTask}
          currentFile={mission.currentFile}
          filesChanged={staged.length + applied.length}
          confidence={heroConfidence}
        />
      </div>

      {/* OUTSIDE the hero zone on purpose. The zone compresses when the dock is short, and anything
          inside it compresses with it — which is how "No API key set" ended up drawn underneath the
          Workspace Health heading at the minimum window size. Attention is the one thing that must
          never be squeezed, so it sits in its own row that does not shrink. */}
      <AttentionStrip items={attentionItems} onReview={reviewDiff} />

      {compact ? (
        <div className="ap-compact">
          <span className="ap-compact-text">
            {compactSummary || 'Nothing to review yet'}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setForceExpanded(true)}>
            Show
          </button>
        </div>
      ) : null}

      <div className="ap-scroll" hidden={compact}>
        {receipt && (
          <BuildReceiptCard
            receipt={receipt}
            rollingBack={rollingBack}
            onRollback={async (id) => {
              setRollingBack(true)
              const res = await window.studio.restoreCheckpoint(id)
              setRollingBack(false)
              propsRef.current.onApplied(res.restored ?? [], { actor: 'disk' })
              push({ kind: 'done', text: `Rolled the run back — ${(res.restored ?? []).length} file(s) restored.` })
              setReceipt(null)
            }}
          />
        )}

        <CollapsibleSection
          id="timeline"
          title="Execution Timeline"
          info="Every tool call this run made, in order. Repeats collapse, so four reads read as one row with a count."
          hint={steps.length > 0 ? `${steps.length}` : undefined}
          collapsed={isCollapsed('timeline', steps.length === 0)}
          onToggle={toggle}
        >
          <ExecutionTimeline steps={steps} busy={running} startedAt={snap?.active?.startedAt ?? null} />
        </CollapsibleSection>

        <CollapsibleSection
          id="activity"
          title="Activity"
          info="What actually landed on disk: one row per edit, plus the syntax check that ran after it."
          hint={activityItems.length > 0 ? `${activityItems.length}` : undefined}
          collapsed={isCollapsed('activity', activityItems.length === 0)}
          onToggle={toggle}
        >
          <ActivityFeed items={activityItems} />
        </CollapsibleSection>

        <CollapsibleSection
          id="context"
          title="Context"
          info="Where the agent is working right now — the folder, the current file, and how many files depend on it."
          hint={contextData.currentFile ? '1' : undefined}
          collapsed={isCollapsed('context', !contextData.currentFile)}
          onToggle={toggle}
        >
          <ActiveContext context={contextData} />
        </CollapsibleSection>

        <CollapsibleSection
          id="artifacts"
          title="Artifacts"
          info="Long explanations lifted out of the chat as cards, plus a summary of the files changed this session."
          hint={artifacts.length > 0 ? `${artifacts.length}` : undefined}
          collapsed={isCollapsed('artifacts', artifacts.length === 0)}
          onToggle={toggle}
        >
          <ArtifactPanel artifacts={artifacts} />
        </CollapsibleSection>

        <CollapsibleSection id="chat" title="Chat" info="The conversation itself — what you asked, and what it said back." collapsible={false} collapsed={false} onToggle={toggle}>
          <Conversation messages={msgs} streaming={running} />
        </CollapsibleSection>

        <div ref={diffRef}>
          <CollapsibleSection
            id="diff"
            title="Diff Preview"
            info="The code changes, with Apply and Reject. The chips on each row are the guardrails: confidence, blast radius, blind edit, and any secret held back."
            hint={staged.length > 0 ? `${staged.length} staged` : undefined}
            collapsed={isCollapsed('diff', staged.length === 0 && appliedFiles.length === 0)}
            onToggle={toggle}
          >
            <DiffPreview
              files={diffFiles}
              applied={appliedFiles}
              blast={blast}
              config={config}
              secrets={secrets}
              onApply={(ids) => void apply(ids)}
              onReject={(ids) => void reject(ids)}
            />
          </CollapsibleSection>
        </div>
      </div>

      <CollapsibleSection id="health" title="Workspace Health" info="Live status of the checks, the agent, the preview server and git — what to know before you ship." collapsed={isCollapsed('health')} onToggle={toggle}>
        <WorkspaceHealth rows={healthRows} />
      </CollapsibleSection>

      <AgentInput
        value={input}
        busy={running}
        onChange={setInput}
        onSend={() => void send()}
        onStop={() => {
          void window.studio.agentCancel()
          // A cancelled run may never emit another event for this runId (cancelled/stopped are
          // AgentTask.status values, not separate AgentEvent types) — clear here rather than wait
          // for a 'done'/'error' that might not come.
          relayWaitingRunId.current = null
        }}
      />
    </div>
  )
}
