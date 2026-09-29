import React, { useMemo, useState } from 'react'
import { InsightHeader } from './insight-header'
import { InsightOverview } from './insight-overview'
import { InsightReview } from './insight-review'
import { InsightCodeMap } from './insight-codemap'
import { InsightMemory } from './insight-memory'
import { useInsightData } from './use-insight-data'
import { deriveArchView, deriveChecks, deriveHealth, deriveVerdict, goTarget, hasReviewResults } from './derive'
import { buildActionPlan, buildShipReadiness } from '../../../../shared/actionplan'
import { buildHandoff, buildPassport, settingsCheckup } from '../../../../shared/passport'
import { workSafety } from '../../../../shared/worksafety'
import type { ActionItem, ActionSignals, FixVerification } from '../../../../shared/actionplan'
import type { DiffLine } from '../../../../shared/types'
import type { InsightDest } from './types'

export interface InsightViewProps {
  projectPath: string
  projectName: string
  /** `surface.advancedInsight` — Builder Mode gets Overview and Review only. */
  advanced: boolean
  /** `surface.code` — without a code surface there is nothing to open a file INTO. */
  canOpenFiles: boolean
  /** Bumped by the host on a file write or git operation; marks results stale, reloads Overview. */
  changeToken: number
  explainText: string
  explainBusy: boolean
  backupBusy: boolean
  genTestMsg: string | null
  verifyResult: FixVerification | null
  restoreDiff: { file: string; inBackup: boolean; lines: DiffLine[] } | null
  restoreArmed: boolean
  onClose: () => void
  onOpenFile: (path: string) => void
  onOpenFileAtLine: (file: string, line?: number) => void
  /** The signals travel WITH the item: the host no longer holds the scan results. */
  onFixWithAi: (item: ActionItem, signals: ActionSignals) => void
  onGenerateTests: () => void
  onExplain: () => void
  onBackUpNow: () => void
  onCompare: (file: string) => void
  onArmRestore: (armed: boolean) => void
  onRestore: (file: string) => void
  onCloseDiff: () => void
  onExportCompliance: () => void
  onTokensApplied: (written?: string[]) => void
  onReverted: (files: string[]) => void
  onMsg: (type: 'ok' | 'err', text: string) => void
}

const ALL: { id: InsightDest; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'review', label: 'Review' },
  { id: 'codemap', label: 'Code Map' },
  { id: 'memory', label: 'Memory' }
]

/**
 * Insight, as a workspace view rather than a drawer.
 *
 * It outgrew the bottom panel: twenty stacked sections in a pane a few hundred pixels tall, with a
 * row of jump buttons bolted on to compensate for the scrolling. The bottom panel is the right home
 * for short, continuously-updating tools — Activity, Problems, Changes, Workspaces, Terminal — and
 * the wrong one for the screen a person reads to decide what to do next. So this takes the editor
 * area, the way Extensions and Settings already do.
 *
 * Four destinations, not twenty sections:
 *   Overview  — is my work safe, is it shippable, what next, what IS this
 *   Review    — the five checks, in one workflow, each honest about what it read
 *   Code Map  — everything rebuildable by reading the code and the git history
 *   Memory    — everything that reading the code could never tell you
 *
 * It is NOT a file: no path, no dirty dot, no save, no Monaco. Pretending otherwise would put a
 * save action on a screen with nothing to save.
 */
export function InsightView(props: InsightViewProps): React.JSX.Element {
  const [dest, setDest] = useState<InsightDest>('overview')
  const destinations = props.advanced ? ALL : ALL.filter((d) => d.id === 'overview' || d.id === 'review')
  // A mode switch must never strand the view on a destination that mode does not have.
  const active = destinations.some((d) => d.id === dest) ? dest : 'overview'

  const data = useInsightData(props.projectPath, active, props.changeToken)

  const arch = useMemo(() => deriveArchView(data.codemap.arch.data), [data.codemap.arch.data])
  // The debt check re-reads the index; whichever of the two is fresher is the one to fold from.
  const insight = data.review.debt.data ?? data.overview.insight.data
  const health = useMemo(() => deriveHealth(insight, data.review.security.data, arch), [insight, data.review.security.data, arch])

  /**
   * Record today's measurement, so the trend has something to draw.
   *
   * THE BUG THIS CLOSES. The four-destination rebuild kept every half of this feature except the
   * write: `analytics.ts` persists the series, `use-insight-data.ts` reads it back, and
   * `deriveHealth`'s own comment says "the trend stored in analytics.json is this exact number" —
   * but no renderer had called `analyticsRecord` since. The store was therefore always empty, and
   * the sparkline is gated on `analytics.length > 1`, so a shipped feature could never once appear.
   * The health card showed a score it never remembered.
   *
   * Recording from HERE, beside the health useMemo, is what `analytics.ts`'s header asks for: "the
   * renderer owns the numbers (the health useMemo); this module only persists what it's handed."
   * Re-recording as `health` changes is deliberate rather than wasteful — the main process replaces
   * a same-day row rather than stacking, precisely so a baseline written with `secrets: null` is
   * upgraded once the security scan fills it in.
   */
  React.useEffect(() => {
    if (!health || !props.projectPath) return
    void window.studio.analyticsRecord(props.projectPath, {
      score: health.score,
      debtCount: health.debtCount,
      secrets: health.secrets,
      fileCount: health.files,
      // Nothing in this app counts agent runs per project — the field has no producer anywhere.
      // Zero is what the series has always stored: a placeholder, not a measurement, and it must
      // not be surfaced as one until something actually counts them.
      agentRunsDone: 0
    })
  }, [health, props.projectPath])

  const signals: ActionSignals = useMemo(
    () => ({
      insight,
      security: data.review.security.data,
      design: data.review.design.data,
      drift: data.codemap.drift.data,
      dependency: data.review.dependency.data
    }),
    [insight, data.review.security.data, data.review.design.data, data.codemap.drift.data, data.review.dependency.data]
  )

  const plan = useMemo(() => buildActionPlan(signals), [signals])
  const ship = useMemo(() => buildShipReadiness(plan, signals), [plan, signals])
  const passport = useMemo(() => buildPassport(data.overview.brain.data), [data.overview.brain.data])
  const checkup = useMemo(() => settingsCheckup(data.overview.brain.data?.envVars ?? []), [data.overview.brain.data])
  const ws = useMemo(() => (data.overview.safety.data ? workSafety(data.overview.safety.data.input) : null), [data.overview.safety.data])
  const checks = useMemo(() => deriveChecks(data.review), [data.review])
  const verdict = useMemo(() => deriveVerdict({ ws, ship, plan, checks }), [ws, ship, plan, checks])

  /**
   * "Go" on an action row: show the reader the evidence behind the item.
   *
   * A file opens in the editor; anything else switches to the destination that DISPLAYS the finding
   * (`goTarget` decides which). Opening a file needs a code surface, so without one the row falls
   * back to the destination rather than offering a button that does nothing — Builder Mode has no
   * editor to open into.
   */
  const onGo = (item: ActionItem): void => {
    const t = goTarget(item)
    if (!t) return
    if ('file' in t && props.canOpenFiles) props.onOpenFile(t.file)
    else if ('dest' in t) setDest(t.dest)
    else setDest('review')
  }

  /** The one primary button. What it does depends on which state won the verdict. */
  const onPrimary = (): void => {
    const id = verdict.action?.id
    if (id === 'backup') props.onBackUpNow()
    else if (id === 'review' || id === 'blocker') setDest('review')
    else if (id === 'fix' && plan.items[0]) props.onFixWithAi(plan.items[0], signals)
  }

  return (
    <div className="iv" role="region" aria-label="Insight">
      <InsightHeader
        projectName={props.projectName}
        lastAt={data.lastAt}
        busy={data.busy}
        dest={active}
        destinations={destinations}
        onDest={setDest}
        onRefresh={data.refresh}
        onClose={props.onClose}
      />
      <div className="iv-body" id="iv-panel" role="tabpanel" aria-labelledby={`iv-tab-${active}`} tabIndex={-1}>
        <div className="iv-measure">
          {active === 'overview' && (
            <InsightOverview
              data={data.overview}
              verdict={verdict}
              plan={plan}
              health={health}
              passport={passport}
              checkup={checkup}
              analytics={data.overview.analytics.data ?? []}
              explainText={props.explainText}
              explainBusy={props.explainBusy}
              backupBusy={props.backupBusy}
              genTestMsg={props.genTestMsg}
              verifyResult={props.verifyResult}
              restoreDiff={props.restoreDiff}
              restoreArmed={props.restoreArmed}
              canGenerateTests={props.canOpenFiles}
              onPrimary={onPrimary}
              onFixWithAi={(item) => props.onFixWithAi(item, signals)}
              onGo={onGo}
              onGenerateTests={props.onGenerateTests}
              onExplain={props.onExplain}
              onCompare={props.onCompare}
              onArmRestore={props.onArmRestore}
              onRestore={props.onRestore}
              onCloseDiff={props.onCloseDiff}
              onCopyHandoff={() => {
                const c = navigator.clipboard
                // Only claim "Copied" when a clipboard actually exists — never a false confirmation.
                if (c) {
                  void c.writeText(buildHandoff(passport, plan)).catch(() => {})
                  props.onMsg('ok', 'Copied the handoff summary — paste it anywhere.')
                } else props.onMsg('err', 'Copy is unavailable here — select the text manually.')
              }}
            />
          )}
          {active === 'review' && (
            <InsightReview
              projectPath={props.projectPath}
              data={data.review}
              checks={checks}
              busy={data.busy}
              hasResults={hasReviewResults(data.review)}
              advanced={props.advanced}
              canOpenFiles={props.canOpenFiles}
              onRunAll={() => void data.runAllChecks()}
              onRunCheck={(id) => void data.runCheck(id)}
              onOpenFileAtLine={props.onOpenFileAtLine}
              onOpenFile={props.onOpenFile}
              onFixWithAi={(item) => props.onFixWithAi(item, signals)}
              onGenerateTests={props.onGenerateTests}
              onExportCompliance={props.onExportCompliance}
              onTokensApplied={props.onTokensApplied}
              onCopy={(text) => {
                const c = navigator.clipboard
                // Only claim "Copied" when a clipboard actually exists — never a false confirmation.
                if (c) {
                  void c.writeText(text).catch(() => {})
                  props.onMsg('ok', 'Copied.')
                } else props.onMsg('err', 'Copy is unavailable here — select the text manually.')
              }}
            />
          )}
          {active === 'codemap' && (
            <InsightCodeMap
              data={data.codemap}
              arch={arch}
              brain={data.overview.brain.data}
              insight={insight}
              canOpenFiles={props.canOpenFiles}
              onOpenFile={props.onOpenFile}
              onFindRelated={(seed) => void data.findRelated(seed)}
              onSetBaseline={() => void data.setBaseline()}
              onFixWithAi={(item) => props.onFixWithAi(item, signals)}
            />
          )}
          {active === 'memory' && (
            <InsightMemory
              projectPath={props.projectPath}
              data={data.memory}
              changeToken={props.changeToken}
              canOpenFiles={props.canOpenFiles}
              onOpenFile={props.onOpenFile}
              onMsg={props.onMsg}
              onReverted={props.onReverted}
            />
          )}
        </div>
      </div>
    </div>
  )
}
