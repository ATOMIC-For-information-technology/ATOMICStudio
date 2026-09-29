/* eslint-disable */
/**
 * ATOMIC Studio — Source Control refresh benchmark (development instrumentation).
 *
 * Measures what ONE panel refresh costs, before and after the 2026-09-02 consolidation:
 *
 *   before  the exact commands the old path ran — `gitInfo` (rev-parse, then status / log /
 *           branch / show-prefix / check-ignore in parallel) plus the five IPC calls the panel
 *           fired beside it (branches, conflicts, MERGE_HEAD, timeline, remotes): 12 processes.
 *   after   `gitSnapshot`: one `status --porcelain=v2 --branch -z` (+ check-ignore on a clean tree).
 *
 * Runs UNDER Electron like the other suites (the git runner imports `electron`), against
 * throwaway repositories, so it needs no key, no network and touches nothing of yours:
 *
 *   cd apps/desktop && npx electron scripts/bench-git.cjs
 *
 * Times are wall-clock medians of N runs on THIS machine — compare the two columns, not the
 * absolute numbers. Process counts are exact and machine-independent.
 */
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execSync } = require('node:child_process')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'studio-git-bench-')))

const REPO = path.resolve(__dirname, '../../..')
const SRC = path.resolve(__dirname, '../src')
const WORKDIR = path.resolve(__dirname, '../.git-bench')
const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')
fs.rmSync(WORKDIR, { recursive: true, force: true })
fs.mkdirSync(WORKDIR, { recursive: true })
execSync(
  `"${esbuild}" ` +
    ['git', 'git-exec', 'git-core', 'git-snapshot', 'git-insight', 'forge', 'forge-github', 'forge-atomic', 'terminal', 'keyvault', 'util', 'identity', 'audit', 'policy', 'roles', 'watcher', 'fs-service']
      .map((m) => `"${path.join(SRC, 'main', m + '.ts')}"`).filter((f) => fs.existsSync(f.slice(1, -1))).join(' ') +
    ` --outdir="${path.join(WORKDIR, 'main')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)
execSync(
  `"${esbuild}" ` +
    ['types', 'git-porcelain', 'unidiff', 'conflicts', 'scriptrisk', 'worksafety', 'roles', 'ipc', 'mode'].map((m) => `"${path.join(SRC, 'shared', m + '.ts')}"`).join(' ') +
    ` --outdir="${path.join(WORKDIR, 'shared')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)

const gh = require(path.join(WORKDIR, 'main', 'git.js'))
const { git, gitProcessCount } = require(path.join(WORKDIR, 'main', 'git-exec.js'))
const q = { shell: '/bin/bash', stdio: 'pipe' }
const RUNS = parseInt(process.env.BENCH_RUNS || '5', 10)

/** The old refresh, command for command (see git-core.ts@2026-09-01 `gitInfo` and GitPanel.refreshRepo). */
async function legacyRefresh(p) {
  const inRepo = await git(p, 'rev-parse --is-inside-work-tree')
  if (inRepo.code !== 0) return
  await Promise.all([
    Promise.all([
      git(p, 'rev-parse --abbrev-ref HEAD'),
      git(p, 'status --porcelain'),
      git(p, 'log --oneline -n 10'),
      git(p, `branch --format='%(refname:short)'`),
      git(p, 'rev-parse --show-prefix'),
      git(p, 'check-ignore -q .')
    ]),
    gh.gitBranches(p),
    gh.gitConflicts(p),
    gh.gitMergeInProgress(p),
    gh.gitTimeline(p),
    gh.gitRemotes(p)
  ])
}

async function measure(label, fn) {
  const times = []
  let procs = 0
  for (let i = 0; i < RUNS; i++) {
    const p0 = gitProcessCount()
    const t0 = process.hrtime.bigint()
    await fn()
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
    procs = gitProcessCount() - p0
  }
  times.sort((a, b) => a - b)
  return { label, procs, ms: times[Math.floor(times.length / 2)] }
}

function makeRepo(name, setup) {
  const dir = path.join(WORKDIR, name)
  fs.mkdirSync(dir, { recursive: true })
  execSync(`git init -q -b main "${dir}" && git -C "${dir}" config user.email b@b && git -C "${dir}" config user.name B`, q)
  fs.writeFileSync(path.join(dir, 'README.md'), '# bench\n')
  execSync(`git -C "${dir}" add -A && git -C "${dir}" commit -qm init`, q)
  return setup(dir) || dir
}

function dirty(dir, n, sub = 'many') {
  fs.mkdirSync(path.join(dir, sub), { recursive: true })
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, sub, `f${i}.txt`), `${i}\n`)
}

app.whenReady().then(async () => {
  const fixtures = [
    ['clean repository', makeRepo('clean', () => {})],
    ['MM + 50 changes', makeRepo('mm', (d) => {
      fs.writeFileSync(path.join(d, 'README.md'), '# bench\nstaged\n')
      execSync(`git -C "${d}" add README.md`, q)
      fs.writeFileSync(path.join(d, 'README.md'), '# bench\nstaged\nunstaged\n')
      dirty(d, 50)
    })],
    ['1,000 changed files', makeRepo('big', (d) => dirty(d, 1000))],
    ['subfolder of a 1,000-file repo', makeRepo('mono', (d) => {
      dirty(d, 1000)
      dirty(d, 10, 'pkg/app/src')
      return path.join(d, 'pkg', 'app')
    })],
    ['merge conflict', makeRepo('conflict', (d) => {
      fs.writeFileSync(path.join(d, 'c.txt'), 'base\n')
      execSync(`git -C "${d}" add -A && git -C "${d}" commit -qm base && git -C "${d}" checkout -q -b theirs`, q)
      fs.writeFileSync(path.join(d, 'c.txt'), 'theirs\n')
      execSync(`git -C "${d}" commit -qam theirs && git -C "${d}" checkout -q main`, q)
      fs.writeFileSync(path.join(d, 'c.txt'), 'ours\n')
      execSync(`git -C "${d}" commit -qam ours && (git -C "${d}" merge theirs >/dev/null 2>&1 || true)`, q)
    })]
  ]

  const rows = []
  for (const [label, dir] of fixtures) {
    const before = await measure('before', () => legacyRefresh(dir))
    const after = await measure('after', () => gh.gitSnapshot(dir))
    const snap = await gh.gitSnapshot(dir)
    rows.push({ label, before, after, rowsReported: snap.changes.length, conflicts: snap.conflicts.length })
  }

  console.log(`\nSource Control refresh — ${RUNS}-run medians, ${os.cpus()[0]?.model || os.platform()}\n`)
  console.log('| Repository state | Before: processes | Before: ms | After: processes | After: ms | Rows reported |')
  console.log('|---|---:|---:|---:|---:|---:|')
  for (const r of rows) {
    console.log(`| ${r.label} | ${r.before.procs} | ${r.before.ms.toFixed(1)} | ${r.after.procs} | ${r.after.ms.toFixed(1)} | ${r.rowsReported}${r.conflicts ? ` (+${r.conflicts} conflicted)` : ''} |`)
  }
  console.log('\nBefore = the 12 commands the 2026-09-01 panel ran per refresh; After = gitSnapshot (2026-09-02).')
  fs.rmSync(WORKDIR, { recursive: true, force: true })
  app.exit(0)
})
