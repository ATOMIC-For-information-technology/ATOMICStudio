import { useCallback, useEffect, useRef, useState } from 'react'
import type { CheckId, CodeMapData, InsightDest, Loaded, MemoryData, OverviewData, ReviewData } from './types'
import { idle } from './types'
import { coverageNote } from '../../../../shared/coverage'

/**
 * Everything Insight loads, and the only place it is loaded.
 *
 * Two problems this exists to fix, both of them in the panel it replaces:
 *
 * 1. **Opening Insight fired fourteen IPC calls.** One effect ran nine loaders, and one of those
 *    (`loadWorkSafety`) was itself five calls in a `Promise.all` — architecture graphs, drift,
 *    ownership and the AI ledger were all computed for a user who wanted to know whether their work
 *    was saved. Loading is per-destination here: Overview costs four calls, and the other three
 *    slices cost nothing until they are opened.
 *
 * 2. **Nothing guarded against a late result.** Every loader read `if (project) setX(await …)` —
 *    the project was checked BEFORE the await and never after, so switching projects while a scan
 *    was in flight committed the old project's findings into the new project's view. Every commit
 *    now passes through `commit()`, which drops anything whose generation or project no longer
 *    matches. A generation is bumped by a project change AND by an explicit refresh, so a refresh
 *    cannot be overtaken by the request it replaced.
 *
 * There is no polling. Data refreshes when the project changes, when the caller's change token
 * moves (a file write, a git operation), or when the user asks.
 */

const emptyOverview = (): OverviewData => ({ insight: idle(), brain: idle(), safety: idle(), analytics: idle() })
const emptyReview = (): ReviewData => ({ security: idle(), dependency: idle(), runbook: idle(), design: idle(), debt: idle() })
const emptyCodeMap = (): CodeMapData => ({ arch: idle(), drift: idle(), owners: idle(), context: idle() })
const emptyMemory = (): MemoryData => ({ ledger: idle() })

/** A result that is real but incomplete says so; everything else is a plain success. */
function ok<T>(data: T, caveat?: string): Loaded<T> {
  return { phase: caveat ? 'partial' : 'ok', data, caveat, at: Date.now() }
}
function failed<T>(err: unknown): Loaded<T> {
  return { phase: 'error', data: null, error: err instanceof Error ? err.message : String(err), at: Date.now() }
}
const loading = <T,>(prev: Loaded<T>): Loaded<T> => ({ ...prev, phase: 'loading' })

/** Only ask again for something we have not already got (or were explicitly told to refresh). */
const needs = (l: Loaded<unknown>): boolean => l.phase === 'not-run' || l.phase === 'error'

/**
 * The same question for a DERIVED view, asked at the moment its destination is ENTERED.
 *
 * `needs` alone left a stale slice frozen for good: marking it stale keeps `phase: 'ok'`, and the
 * staged effect below is the only thing that ever loads Code Map — so once a file write marked the
 * graph stale, re-opening the destination found it "already got" and nothing refreshed it until the
 * project changed or the user pressed Refresh by hand. The import graph then went on answering a
 * question about the project as it stood several files ago, and "Possibly unused" said "nobody
 * imports it" about a file whose importer it had never read.
 *
 * `entered` keeps the reload tied to NAVIGATION, which is what makes it affordable. Re-reading is
 * worth a rebuilt import graph when someone arrives at the screen; it is not worth one every time
 * the effect happens to re-fire for another reason while the tab merely sits open, and that is the
 * expense staged loading exists to avoid. A reader already looking at Code Map when the project
 * changes underneath them keeps the graph they have, and `insight-codemap.tsx` says out loud that
 * it is behind rather than quietly refreshing it.
 *
 * Deliberately NOT extended to Review, for the reason its own comment at the call site gives: a
 * review check is a scan the USER asked for, so an unrelated save must not silently throw it away.
 * Code Map's three slices load themselves the instant the tab is clicked — nobody asked for the
 * previous answer, so keeping it protects nothing and costs correctness.
 */
const needsFresh = (l: Loaded<unknown>, entered: boolean): boolean => needs(l) || (entered && l.stale === true)

export interface InsightData {
  overview: OverviewData
  review: ReviewData
  codemap: CodeMapData
  memory: MemoryData
  /** The newest commit time across every slice — "last analysed" in the header. */
  lastAt: number | null
  busy: boolean
  refresh: () => void
  runCheck: (id: CheckId) => Promise<void>
  runAllChecks: () => Promise<void>
  findRelated: (seed: string) => Promise<void>
  setBaseline: () => Promise<void>
  reloadOwners: () => Promise<void>
}

export function useInsightData(projectPath: string | null, dest: InsightDest, changeToken: number): InsightData {
  const [overview, setOverview] = useState<OverviewData>(emptyOverview)
  const [review, setReview] = useState<ReviewData>(emptyReview)
  const [codemap, setCodemap] = useState<CodeMapData>(emptyCodeMap)
  const [memory, setMemory] = useState<MemoryData>(emptyMemory)
  const [busy, setBusy] = useState(false)

  /* The two halves of identity. A result is committed only if BOTH still match: the generation
     catches a refresh overtaking itself, the path catches a project switch. */
  const gen = useRef(0)
  const pathRef = useRef<string | null>(projectPath)

  const commit = useCallback((g: number, p: string | null, fn: () => void) => {
    if (g !== gen.current || p !== pathRef.current) return
    fn()
  }, [])

  /** Start a guarded request. Returns the identity to hand back to `commit`. */
  const begin = useCallback((): { g: number; p: string | null } => ({ g: gen.current, p: pathRef.current }), [])

  // Project switch: bump the generation (every in-flight result is now stale) and drop the cache.
  useEffect(() => {
    gen.current++
    pathRef.current = projectPath
    setOverview(emptyOverview())
    setReview(emptyReview())
    setCodemap(emptyCodeMap())
    setMemory(emptyMemory())
  }, [projectPath])

  /* ── loaders, one per destination ───────────────────────────────────────────────────────── */

  const loadOverview = useCallback(async () => {
    const path = projectPath
    if (!path) return
    const { g, p } = begin()
    setOverview((o) => ({ insight: loading(o.insight), brain: loading(o.brain), safety: loading(o.safety), analytics: loading(o.analytics) }))
    setBusy(true)
    const settle = <T,>(key: keyof OverviewData, run: Promise<T>, caveat?: (v: T) => string | undefined): Promise<void> =>
      run.then(
        (v) => commit(g, p, () => setOverview((o) => ({ ...o, [key]: ok(v, caveat?.(v)) }))),
        (e) => commit(g, p, () => setOverview((o) => ({ ...o, [key]: failed(e) })))
      )
    await Promise.all([
      // The index caps what it reads; a capped read must not be reported as a complete one.
      // The index stops at MAX_FILES and says so in its own coverage record — reuse the app's
      // wording rather than inventing a second sentence that could drift from it.
      settle('insight', window.studio.projectInsight(path), (v) => coverageNote(v.coverage) || undefined),
      settle('brain', window.studio.projectBrain(path)),
      settle('analytics', window.studio.analyticsList(path)),
      Promise.all([
        window.studio.gitInfo(path),
        window.studio.gitTimeline(path),
        window.studio.getUndoHistory(),
        window.studio.undoCheckpoints(),
        window.studio.gitWorkingStat(path)
      ]).then(
        ([info, timeline, hist, cps, stat]) =>
          commit(g, p, () =>
            setOverview((o) => ({
              ...o,
              safety: ok(
                {
                  input: {
                    isRepo: info.isRepo,
                    isRepoRoot: info.isRepoRoot,
                    isIgnored: info.isIgnored,
                    changedFiles: stat.total,
                    changedFilesExact: stat.exact,
                    lastCommitTs: timeline[0]?.ts ?? 0,
                    sessionEdits: hist.length,
                    restorePoints: cps.length,
                    now: Date.now()
                  },
                  changed: stat.files,
                  total: stat.total
                },
                stat.exact ? undefined : 'Git reported more changed files than it listed, so the count is a floor.'
              )
            }))
          ),
        (e) => commit(g, p, () => setOverview((o) => ({ ...o, safety: failed(e) })))
      )
    ])
    commit(g, p, () => setBusy(false))
  }, [projectPath, begin, commit])

  const loadCodeMap = useCallback(async () => {
    const path = projectPath
    if (!path) return
    const { g, p } = begin()
    setCodemap((c) => ({ ...c, arch: loading(c.arch), drift: loading(c.drift), owners: loading(c.owners) }))
    const settle = <T,>(key: keyof CodeMapData, run: Promise<T>, caveat?: (v: T) => string | undefined): Promise<void> =>
      run.then(
        (v) => commit(g, p, () => setCodemap((c) => ({ ...c, [key]: ok(v, caveat?.(v)) }))),
        (e) => commit(g, p, () => setCodemap((c) => ({ ...c, [key]: failed(e) })))
      )
    await Promise.all([
      settle('arch', window.studio.architectureMap(path), (v) => (v.partial ? 'The graph exceeded the analysis limit, so parts of this project are missing from it.' : undefined)),
      settle('drift', window.studio.archDrift(path), (v) => (v.hasBaseline && v.partial ? 'This project exceeds the analysis limits, so some differences may be ranking artifacts rather than real drift.' : undefined)),
      settle('owners', window.studio.gitAuthorship(path))
    ])
  }, [projectPath, begin, commit])

  const loadMemory = useCallback(async () => {
    const path = projectPath
    if (!path) return
    const { g, p } = begin()
    setMemory((m) => ({ ledger: loading(m.ledger) }))
    try {
      const v = await window.studio.ledgerList(path)
      commit(g, p, () => setMemory({ ledger: ok(v) }))
    } catch (e) {
      commit(g, p, () => setMemory({ ledger: failed(e) }))
    }
  }, [projectPath, begin, commit])

  /* A file or git change does NOT re-run analyses — a user who ran a security scan should not have
     it silently thrown away because they saved a file. Results are marked stale instead, and the
     cheap always-live slices (Overview) reload.

     THIS EFFECT LOADS OVERVIEW ITSELF, and has to. Emptying the slice and leaving the staged effect
     below to notice looks tidier and does not work: both effects run in the same commit, so that
     one still sees the pre-empty `overview` in its render closure, finds nothing that `needs`
     loading, and never runs again because its deps did not move a second time. Overview then sat on
     "Not read yet" after every save — on the one screen whose whole job is answering "did my last
     change get saved?".

     It also has to sit BELOW the loaders rather than beside its sibling effect, so `loadOverview`
     is in scope to be called and to be depended on honestly. */
  const firstToken = useRef(true)
  useEffect(() => {
    if (firstToken.current) {
      firstToken.current = false
      return
    }
    const mark = <T,>(l: Loaded<T>): Loaded<T> => (l.phase === 'ok' || l.phase === 'partial' ? { ...l, stale: true } : l)
    setReview((r) => ({ security: mark(r.security), dependency: mark(r.dependency), runbook: mark(r.runbook), design: mark(r.design), debt: mark(r.debt) }))
    setCodemap((c) => ({ arch: mark(c.arch), drift: mark(c.drift), owners: mark(c.owners), context: c.context }))
    setOverview(emptyOverview()) // cheap, and it is the answer to "did my last change get saved?"
    void loadOverview()
  }, [changeToken, loadOverview])

  /* ── staged: a destination loads when it is opened, and not before ──────────────────────── */

  /**
   * The destination this effect last acted on, so it can tell NAVIGATION from a re-fire.
   *
   * `changeToken` is deliberately NOT a dependency here. Adding it does not work: this effect and
   * the token effect above run in the SAME commit, so this one would still read the pre-empty
   * `overview` out of its render closure and decide nothing needed loading. That is why the token
   * effect calls `loadOverview` itself, and why this effect stays what its heading says it is —
   * the thing that loads a destination when the destination is opened.
   */
  const lastDest = useRef<InsightDest | null>(null)

  useEffect(() => {
    if (!projectPath) return
    const entered = lastDest.current !== dest
    lastDest.current = dest
    if (dest === 'overview' && Object.values(overview).some(needs)) void loadOverview()
    if (dest === 'codemap' && [codemap.arch, codemap.drift, codemap.owners].some((s) => needsFresh(s, entered))) void loadCodeMap()
    if (dest === 'memory' && needs(memory.ledger)) void loadMemory()
    // Review deliberately loads NOTHING on open: every one of its checks is a real scan the user
    // asked for, and running five of them because a tab was clicked is the behaviour being removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slices are read, not depended on
  }, [dest, projectPath, loadOverview, loadCodeMap, loadMemory])

  /* ── review checks ──────────────────────────────────────────────────────────────────────── */

  const runCheck = useCallback(
    async (id: CheckId): Promise<void> => {
      const path = projectPath
      if (!path) return
      const { g, p } = begin()
      setReview((r) => ({ ...r, [id]: loading(r[id] as Loaded<unknown>) }))
      try {
        if (id === 'security') {
          const v = await window.studio.securityScan(path)
          commit(g, p, () => setReview((r) => ({ ...r, security: ok(v, coverageNote(v.coverage) || undefined) })))
        } else if (id === 'dependency') {
          const v = await window.studio.dependencyAudit(path)
          commit(g, p, () => setReview((r) => ({ ...r, dependency: ok(v, 'Checks your manifest and lockfile for consistency — it does not contact the npm registry, so it cannot tell you a package is out of date.') })))
        } else if (id === 'runbook') {
          const v = await window.studio.runbook(path)
          commit(g, p, () => setReview((r) => ({ ...r, runbook: ok(v, v.partial ? 'This is a big project, so the picture may be incomplete.' : undefined) })))
        } else if (id === 'design') {
          const v = await window.studio.designReview(path)
          commit(g, p, () => setReview((r) => ({ ...r, design: ok(v) })))
        } else {
          const v = await window.studio.projectInsight(path)
          // `hasTests: false` on a capped index means "none in what we read" — never "none exist".
          commit(g, p, () => setReview((r) => ({ ...r, debt: ok(v, coverageNote(v.coverage) || undefined) })))
        }
      } catch (e) {
        commit(g, p, () => setReview((r) => ({ ...r, [id]: failed(e) })))
      }
    },
    [projectPath, begin, commit]
  )

  /* Serial, not `Promise.all`: these are five real scans over the same files, and firing them at
     once is what made the old panel stall. Results appear as each one lands. */
  const runAllChecks = useCallback(async (): Promise<void> => {
    setBusy(true)
    for (const id of ['security', 'dependency', 'runbook', 'design', 'debt'] as CheckId[]) {
      await runCheck(id)
    }
    setBusy(false)
  }, [runCheck])

  const findRelated = useCallback(
    async (seed: string): Promise<void> => {
      const path = projectPath
      if (!path || !seed.trim()) return
      const { g, p } = begin()
      setCodemap((c) => ({ ...c, context: loading(c.context) }))
      try {
        const v = await window.studio.contextPack(path, seed.trim())
        commit(g, p, () => setCodemap((c) => ({ ...c, context: ok(v) })))
      } catch (e) {
        commit(g, p, () => setCodemap((c) => ({ ...c, context: failed(e) })))
      }
    },
    [projectPath, begin, commit]
  )

  const setBaseline = useCallback(async (): Promise<void> => {
    const path = projectPath
    if (!path) return
    await window.studio.saveArchBaseline(path)
    const { g, p } = begin()
    const v = await window.studio.archDrift(path)
    commit(g, p, () => setCodemap((c) => ({ ...c, drift: ok(v) })))
  }, [projectPath, begin, commit])

  const reloadOwners = useCallback(async (): Promise<void> => {
    const path = projectPath
    if (!path) return
    const { g, p } = begin()
    const v = await window.studio.gitAuthorship(path)
    commit(g, p, () => setCodemap((c) => ({ ...c, owners: ok(v) })))
  }, [projectPath, begin, commit])

  const refresh = useCallback(() => {
    gen.current++ // anything already in flight belongs to the run being replaced
    setOverview(emptyOverview())
    setCodemap(emptyCodeMap())
    setMemory(emptyMemory())
    void loadOverview()
    if (dest === 'codemap') void loadCodeMap()
    if (dest === 'memory') void loadMemory()
  }, [dest, loadOverview, loadCodeMap, loadMemory])

  const times = [
    overview.insight.at, overview.brain.at, overview.safety.at, overview.analytics.at,
    review.security.at, review.dependency.at, review.runbook.at, review.design.at, review.debt.at,
    codemap.arch.at, codemap.drift.at, codemap.owners.at, memory.ledger.at
  ].filter((t): t is number => typeof t === 'number')

  return {
    overview,
    review,
    codemap,
    memory,
    lastAt: times.length ? Math.max(...times) : null,
    busy,
    refresh,
    runCheck,
    runAllChecks,
    findRelated,
    setBaseline,
    reloadOwners
  }
}
