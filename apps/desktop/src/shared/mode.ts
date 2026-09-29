/**
 * Builder Mode vs Developer Mode — "one core, two personalities" (ROADMAP §0 direction A).
 *
 * The premise that one interface serves both a non-coder and a professional developer is rejected:
 * a developer wants speed, keyboard, git, terminal and full density; a non-coder wants chat, preview
 * and never seeing code. Those are close to two products. Everything that MATTERS is shared — the
 * agent, the index, memory, undo/snapshots, the safety guards, the preview. Only the surface differs.
 *
 * This module is the single source of truth for "what does this mode show". It is PURE (no electron,
 * no DOM, no IO) so both the renderer and the main-process menu read the same table, and so the whole
 * thing is unit-testable headlessly.
 *
 * Two rules the table obeys:
 *  1. **Builder hides, it never breaks.** Every capability hidden in Builder Mode is still running —
 *     files stay open in memory, the index keeps building, undo keeps recording. Switching back
 *     restores the full IDE with nothing lost.
 *  2. **Nothing hidden is left reachable.** A hidden surface has its menu item, palette action and
 *     keyboard shortcut removed too — a menu entry that opens a panel the mode doesn't render is the
 *     same dead-control lie this codebase refuses everywhere else.
 */

export type StudioMode = 'builder' | 'developer'

/** Tabs of the unified bottom panel. Mirrors App.tsx's PanelTab (kept here so main can read it too). */
/* Insight left this list on 2026-09-03. The bottom panel is for short, continuously-updating tools
   — Activity, Problems, Changes, Workspaces, Terminal — and Insight had grown into a twenty-section
   document being read through a few hundred pixels of drawer. It is a workspace view now
   (`components/insight`), reached by the same `panel.insight` command the menu already carried. */
export type PanelTabId = 'activity' | 'problems' | 'changes' | 'company' | 'terminal'

/** The default for anyone who has never chosen: the full IDE, so nothing is ever hidden by surprise. */
export const DEFAULT_MODE: StudioMode = 'developer'

export interface ModeLabels {
  /** Left sidebar header + activity-bar rail button. */
  files: string
  /** Bottom-panel toggle in the top bar. */
  tools: string
  runPreview: string
  stopPreview: string
  undo: string
  /** Per-tab label overrides for the bottom panel. */
  panel: Partial<Record<PanelTabId, string>>
}

export interface ModeSurface {
  mode: StudioMode
  /** File tree, editor tabs, ⌘K inline edit, "Open file"/"Generate tests" buttons. */
  code: boolean
  terminal: boolean
  /** ⌘P Search Everywhere (it jumps to a line of code). */
  search: boolean
  extensions: boolean
  /** The Source Control sidebar view + the branch chip in the status bar. */
  git: boolean
  /** Company server / ATOMIC Workspaces. */
  workspaces: boolean
  /** The Problems tab (raw runtime/compile errors). Builder gets self-healing auto-fix instead. */
  problems: boolean
  /** The raw dev-server log tab. */
  activityLog: boolean
  /**
   * Insight's engineering half: architecture map, drift, design review/tokens, code ownership,
   * cross-repo graph, dead/tangled files, related-file finder. The plain-English half
   * (ship readiness, work safety, passport, do-these-next, health, security, run doctor,
   * what-the-AI-changed, decisions) shows in BOTH modes.
   */
  advancedInsight: boolean
  /** Builder Mode's dock is the product: it stays open rather than being a toggle you can lose. */
  dockAlwaysOn: boolean
  panelTabs: PanelTabId[]
  labels: ModeLabels
}

const DEVELOPER_LABELS: ModeLabels = {
  files: 'Explorer',
  tools: 'Tools',
  runPreview: 'Run preview',
  stopPreview: 'Stop preview',
  undo: 'Undo',
  panel: {}
}

const BUILDER_LABELS: ModeLabels = {
  files: 'Project',
  tools: 'Project',
  runPreview: 'Preview my app',
  stopPreview: 'Stop preview',
  undo: 'Undo last change',
  panel: { changes: 'History' }
}

const DEVELOPER_TABS: PanelTabId[] = ['activity', 'problems', 'changes', 'company', 'terminal']
const BUILDER_TABS: PanelTabId[] = ['changes']

export function normalizeMode(raw: unknown): StudioMode {
  return raw === 'builder' || raw === 'developer' ? raw : DEFAULT_MODE
}

export function modeSurface(mode: StudioMode): ModeSurface {
  const builder = mode === 'builder'
  return {
    mode,
    code: !builder,
    terminal: !builder,
    search: !builder,
    extensions: !builder,
    git: !builder,
    workspaces: !builder,
    problems: !builder,
    activityLog: !builder,
    advancedInsight: !builder,
    dockAlwaysOn: builder,
    panelTabs: builder ? [...BUILDER_TABS] : [...DEVELOPER_TABS],
    labels: builder ? BUILDER_LABELS : DEVELOPER_LABELS
  }
}

/**
 * Commands Builder Mode does not show — a CURATED list of exact ids, not a prefix heuristic.
 * These ids are the ones `menu.ts` sends and the ⌘⇧P palette registers; both filter through
 * `commandAllowed`, so a hidden surface has no keyboard or menu back-door left open.
 */
export const BUILDER_HIDDEN_COMMANDS: readonly string[] = [
  // code files
  'file.newFile',
  'file.newFolder',
  'file.save',
  'file.saveAll',
  'file.closeEditor',
  // code editing
  'edit.find',
  'edit.replace',
  'edit.comment',
  'edit.format',
  'edit.ai',
  // selection (every item is a Monaco cursor command)
  'sel.expand',
  'sel.shrink',
  'sel.copyLineUp',
  'sel.copyLineDown',
  'sel.moveLineUp',
  'sel.moveLineDown',
  'sel.cursorAbove',
  'sel.cursorBelow',
  'sel.allOccurrences',
  // navigation into code
  'go.file',
  'go.symbol',
  'go.line',
  'go.nextTab',
  'go.prevTab',
  // dev surfaces
  'view.search',
  'view.extensions',
  // the dock is permanent in Builder Mode, so "Hide Agent" would be a control that does nothing
  'view.toggleAgent',
  'panel.activity',
  'panel.problems',
  'view.scm',
  'panel.company',
  'panel.terminal',
  'term.new',
  'term.show',
  'term.clear',
  'term.close',
  'run.genTests'
]

const HIDDEN = new Set(BUILDER_HIDDEN_COMMANDS)

/** True when this mode shows the command at all (menu item, palette action, shortcut). */
export function commandAllowed(mode: StudioMode, id: string): boolean {
  return mode === 'developer' || !HIDDEN.has(id)
}

export interface ModeDescription {
  title: string
  /** One line, plain English, no jargon — this is what a first-time user reads to choose. */
  tagline: string
  /** What this mode shows/hides. Written as facts, so the choice is never a surprise. */
  bullets: string[]
}

export function describeMode(mode: StudioMode): ModeDescription {
  if (mode === 'builder') {
    return {
      title: 'Builder',
      tagline: "Describe what you want and watch it happen. You never have to look at code.",
      bullets: [
        'Chat with the AI, live preview, and one-click undo',
        'No code editor, file tree, terminal or git',
        'Everything you build is still saved and still recoverable'
      ]
    }
  }
  return {
    title: 'Developer',
    tagline: 'The full IDE: editor, files, terminal, git and every shortcut.',
    bullets: [
      'Code editor, file tree, search, terminal, GitHub and workspaces',
      'The complete Insight report, including architecture and design',
      'Everything Builder Mode has, plus the machinery'
    ]
  }
}

/** The toast shown right after a switch — says what just changed, so nothing looks broken. */
export function modeSwitchNote(to: StudioMode): string {
  return to === 'builder'
    ? 'Builder mode: the code editor, files and terminal are hidden. Your work is untouched — switch back any time.'
    : 'Developer mode: the editor, files, terminal and git tools are back.'
}

/**
 * Anything still open in the editor when Builder Mode hides it. Files are NOT closed and typing is
 * NOT thrown away — this is an FYI, not a warning, so it never blocks the switch.
 * Returns '' when there is nothing to say.
 */
export function unsavedCarryOverNote(dirtyCount: number): string {
  if (dirtyCount <= 0) return ''
  const files = dirtyCount === 1 ? '1 file' : `${dirtyCount} files`
  return `${files} with unsaved typing stayed open — switch back to Developer mode to save ${dirtyCount === 1 ? 'it' : 'them'}.`
}
