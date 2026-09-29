/**
 * Run Doctor — the deterministic "how do I run this, and why won't it?" preflight. A non-coder's
 * single most frequent wall on any AI-generated or freshly-cloned repo. PURE fold over signals the
 * app already computes (projectBrain + package.json scripts + dependencyAudit + .env presence) into
 * one ranked, calm, plain-English checklist: install → env → database → start, with copy-to-run
 * commands. Copy-only (never auto-executes); env vars are NAMES only, never values; no model.
 */
export type RunSeverity = 'blocker' | 'setup' | 'info'
export type RunKind = 'install' | 'env' | 'db' | 'start'

export interface RunStep {
  kind: RunKind
  severity: RunSeverity
  title: string
  detail: string
  /** A copy-to-run shell command, when there is a concrete one. */
  command?: string
  /** A best-effort GUESS (e.g. an inferred Python start) — never presented as THE command. */
  guess?: boolean
}
export interface Runbook {
  verdict: string
  ready: 'ready' | 'setup-needed' | 'blocked'
  steps: RunStep[]
  partial: boolean
}

export interface RunbookInput {
  packageManager?: string // npm | pnpm | yarn | bun
  hasPackageJson: boolean
  hasLockfile: boolean
  scripts: Record<string, string>
  /** Imported-but-undeclared packages (from Dependency Health) — a fresh install won't fetch them. */
  phantomPackages: string[]
  /** Env var NAMES the code reads but that aren't declared (never values). */
  missingEnv: string[]
  hasEnvFile: boolean
  hasEnvExample: boolean
  dbModels: number
  isStaticHtml: boolean
  partial: boolean
  // Python (optional — a project with no package.json but Python signals). Node stays primary.
  hasRequirementsTxt?: boolean
  hasPyproject?: boolean
  pythonPackageManager?: string // 'pip' | 'poetry'
  pythonEntry?: string // e.g. main.py | app.py | manage.py
  pythonFrameworks?: string[]
}

const list = (a: string[], n = 8): string => a.slice(0, n).join(', ') + (a.length > n ? ', …' : '')

export function buildRunbook(input: RunbookInput): Runbook {
  const pm = input.packageManager || 'npm'
  const steps: RunStep[] = []
  // Python is "primary" only when there's no package.json (a JS+Python repo stays Node-driven).
  const pythonPrimary = !input.hasPackageJson && !!(input.hasRequirementsTxt || input.hasPyproject || input.pythonEntry)

  // A static site with no package.json (and not a Python project): there's nothing to install.
  if (input.isStaticHtml && !input.hasPackageJson && !pythonPrimary) {
    steps.push({
      kind: 'start',
      severity: 'info',
      title: 'Open it in a browser',
      detail: 'This looks like a static site — open index.html directly, or serve the folder.',
      command: 'npx serve .'
    })
    return { verdict: 'Static site — just open index.html.', ready: 'ready', steps, partial: input.partial }
  }

  // 1. Install
  if (input.hasPackageJson) {
    steps.push({
      kind: 'install',
      severity: 'setup',
      title: 'Install dependencies',
      detail: input.hasLockfile ? 'Install the exact locked dependencies.' : 'No lockfile — this fetches the dependencies, but the versions may not be reproducible.',
      command: `${pm} install`
    })
    if (input.phantomPackages.length)
      steps.push({
        kind: 'install',
        severity: 'blocker',
        title: 'Missing packages',
        detail: `Your code imports ${list(input.phantomPackages, 6)} but they aren't in package.json — a fresh install won't fetch them, so the app will crash on start. Add them first.`
      })
  } else if (pythonPrimary) {
    const cmd =
      input.pythonPackageManager === 'poetry' ? 'poetry install' : input.hasRequirementsTxt ? 'pip install -r requirements.txt' : input.hasPyproject ? 'pip install .' : null
    if (cmd) steps.push({ kind: 'install', severity: 'setup', title: 'Install Python dependencies', detail: 'Install the packages this project needs.', command: cmd })
  }

  // 2. Environment variables (NAMES only)
  if (input.missingEnv.length) {
    if (input.hasEnvFile)
      steps.push({ kind: 'env', severity: 'info', title: 'Check your .env', detail: `This app reads ${list(input.missingEnv)} — double-check your .env has them.` })
    else
      steps.push({
        kind: 'env',
        severity: 'setup',
        title: 'Set environment variables',
        detail: input.hasEnvExample ? `Copy .env.example to .env and fill in ${list(input.missingEnv)}.` : `Create a .env file with ${list(input.missingEnv)} before running.`,
        command: input.hasEnvExample ? 'cp .env.example .env' : undefined
      })
  }

  // 3. Database
  if (input.dbModels > 0)
    steps.push({
      kind: 'db',
      severity: 'setup',
      title: 'Set up the database',
      detail: `This app uses a database (${input.dbModels} model${input.dbModels === 1 ? '' : 's'}) — make sure it's running and migrated.`
    })

  // 4. Start
  const startScript = input.scripts.dev ? 'dev' : input.scripts.start ? 'start' : input.scripts.serve ? 'serve' : null
  if (input.hasPackageJson && startScript) steps.push({ kind: 'start', severity: 'info', title: 'Start the app', detail: `Run the ${startScript} script.`, command: `${pm} run ${startScript}` })
  else if (input.hasPackageJson) steps.push({ kind: 'start', severity: 'info', title: 'Start the app', detail: 'No dev/start/serve script in package.json — check its "scripts" for how to run it.' })
  else if (pythonPrimary) {
    const django = (input.pythonFrameworks ?? []).some((f) => /django/i.test(f)) || input.pythonEntry === 'manage.py'
    const guessCmd = django ? 'python manage.py runserver' : input.pythonEntry ? `python ${input.pythonEntry}` : null
    if (guessCmd)
      steps.push({ kind: 'start', severity: 'info', title: 'Start the app (best guess)', detail: `Probably \`${guessCmd}\` — but this is a guess; check the README for the exact command.`, command: guessCmd, guess: true })
    else steps.push({ kind: 'start', severity: 'info', title: 'Start the app', detail: "Couldn't tell how to start it — check the README for the run command." })
  }

  // Nothing detected (no package.json, not a static site) — a non-JS or unrecognized project. Don't
  // hand back a green "ready"; say honestly we couldn't work out how to run it.
  if (steps.length === 0)
    steps.push({
      kind: 'start',
      severity: 'info',
      title: "Couldn't detect how to run this",
      detail: "No package.json or index.html here — check the project's README for how to install and start it."
    })

  // A GUESS command never counts as THE start command in the verdict (never say "Looks ready — run <guess>").
  const start = steps.find((s) => s.kind === 'start' && s.command && !s.guess)
  const guessStart = steps.find((s) => s.kind === 'start' && s.command && s.guess)
  const noRunnable = steps.length === 1 && steps[0].title.startsWith("Couldn't detect")
  // A GUESSED start (e.g. a bare `main.py`) is NOT a confident green. Guess-ness must feed the traffic
  // light too, not just the verdict text — otherwise a script we only *inferred* how to run reads as
  // "Looks ready to run.", the exact false-confidence Run Doctor exists to avoid.
  const guessOnly = !start && !!guessStart
  const hasSetup = steps.some((s) => s.severity === 'setup')
  const ready = steps.some((s) => s.severity === 'blocker') ? 'blocked' : hasSetup || noRunnable || guessOnly ? 'setup-needed' : 'ready'
  const verdict = noRunnable
    ? "Couldn't work out how to run this — check the project's README."
    : ready === 'blocked'
      ? 'Fix the blocker(s) below before this will run.'
      : ready === 'setup-needed'
        ? guessOnly && !hasSetup
          ? `Best guess: run ${guessStart?.command} — but check the README to confirm.`
          : `A few setup steps, then ${start ? `run ${start.command}` : guessStart ? 'start it (the best-guess command is in the steps below — check the README)' : 'run the app'}.`
        : start
          ? `Looks ready — run ${start.command}.`
          : 'Looks ready to run.'
  return { verdict, ready, steps, partial: input.partial }
}
