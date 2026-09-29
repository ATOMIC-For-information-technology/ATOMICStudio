/* eslint-disable */
/**
 * ATOMIC Studio — Phase 10 agent headless test.
 *
 * Runs UNDER Electron (like test-full-loop.cjs) against the real built main
 * modules, with the deterministic MOCK provider (STUDIO_MOCK_AI=1) so no API
 * key or credits are ever needed. Exercises the full loop:
 *
 *   tool protocol parse → list/read/search/run tools → staged writes (never
 *   disk) → plan-mode write refusal → unsafe-command refusal → apply (snapshot)
 *   → undo → reject → cancel guard → path-traversal guard.
 *
 *   cd apps/desktop && npm run build && STUDIO_MOCK_AI=1 npx electron scripts/test-agent.cjs
 */
process.env.STUDIO_MOCK_AI = '1'
process.env.STUDIO_MOCK_MEDIA = '1'

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const os = require('node:os')

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'studio-agent-test-')))

const OUT = path.resolve(__dirname, '../out/main')
// The built main process is a single CJS bundle; require it via a jail that
// prevents app.whenReady side effects? No — the agent lives in chunks. We
// instead re-require the source modules through electron-vite's build output.
// out/main/index.js bundles everything; agent functions are not exported.
// So: build a tiny secondary entry? Simpler: transpile the TS sources with
// esbuild on the fly, like test-full-loop.cjs does.
const { execSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '../../..')
const SRC = path.resolve(__dirname, '../src')
const WORKDIR = path.resolve(__dirname, '../.agent-test')
const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')

fs.rmSync(WORKDIR, { recursive: true, force: true })
fs.mkdirSync(WORKDIR, { recursive: true })

// Transpile the main-process modules the agent needs (CJS, node platform).
execSync(
  `"${esbuild}" ` +
    ['agent', 'providers', 'fs-service', 'diff', 'terminal', 'undo', 'keyvault', 'util', 'index-service', 'static-server', 'git', 'git-exec', 'git-core', 'git-history', 'git-snapshot', 'git-insight', 'forge', 'forge-github', 'forge-atomic', 'forge-gitlab', 'identity', 'remote', 'git-provision', 'audit', 'ai-edit', 'workspaces', 'docker', 'projects', 'policy', 'insight', 'ledger', 'security', 'compliance', 'decisions', 'analytics', 'drift', 'design', 'models', 'apply-tokens', 'impact', 'dependency', 'testgen', 'runbook', 'watcher', 'mcp', 'extensions', 'previewctl', 'memory', 'memory-file', 'process-manager', 'mode', 'menu', 'media', 'pty']
      .map((m) => `"${path.join(SRC, 'main', m + '.ts')}"`)
      .join(' ') +
    ` --outdir="${path.join(WORKDIR, 'main')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)
// shared/types is types-only — esbuild emits an empty module. shared/replay is a
// pure fold used by a headless unit test, so transpile it too.
execSync(
  `"${esbuild}" "${path.join(SRC, 'shared', 'types.ts')}" "${path.join(SRC, 'shared', 'replay.ts')}" "${path.join(SRC, 'shared', 'design-tokens.ts')}" "${path.join(SRC, 'shared', 'actionplan.ts')}" "${path.join(SRC, 'shared', 'runbook.ts')}" "${path.join(SRC, 'shared', 'passport.ts')}" "${path.join(SRC, 'shared', 'worksafety.ts')}" "${path.join(SRC, 'shared', 'orphans.ts')}" "${path.join(SRC, 'shared', 'fragile.ts')}" "${path.join(SRC, 'shared', 'tangles.ts')}" "${path.join(SRC, 'shared', 'deletesafety.ts')}" "${path.join(SRC, 'shared', 'scriptrisk.ts')}" "${path.join(SRC, 'shared', 'coverage.ts')}" "${path.join(SRC, 'shared', 'ansi.ts')}" "${path.join(SRC, 'shared', 'ipc.ts')}" "${path.join(SRC, 'shared', 'mode.ts')}" "${path.join(SRC, 'shared', 'roles.ts')}" "${path.join(SRC, 'shared', 'media.ts')}" "${path.join(SRC, 'shared', 'conflicts.ts')}" "${path.join(SRC, 'shared', 'file-icons.ts')}" "${path.join(SRC, 'shared', 'git-porcelain.ts')}" "${path.join(SRC, 'shared', 'unidiff.ts')}" "${path.join(SRC, 'shared', 'gitnames.ts')}" "${path.join(SRC, 'shared', 'gitref.ts')}" "${path.join(SRC, 'shared', 'gitlog.ts')}" --outdir="${path.join(WORKDIR, 'shared')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)

// The Git panel's pure fold. It lives in the renderer but touches no DOM and no window.studio —
// its own header says it is "testable without an Electron window", which was aspirational until
// this line: nothing exercised it. The staged/unstaged split is the part most likely to be subtly
// wrong, and it is the part a screenshot cannot check.
execSync(
  `"${esbuild}" "${path.join(SRC, 'renderer', 'src', 'components', 'git-panel', 'derive.ts')}" "${path.join(SRC, 'renderer', 'src', 'components', 'git-panel', 'coordinator.ts')}" ` +
    `--outdir="${path.join(WORKDIR, 'gitpanel')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)

// The Explorer's tree model — pure, and transpiled on its own because esbuild rebuilds the shared
// directory structure when one command spans two source folders (the git-panel outputs would move
// down a level and every require here would miss).
execSync(
  `"${esbuild}" "${path.join(SRC, 'renderer', 'src', 'components', 'explorer', 'model.ts')}" ` +
    `--outdir="${path.join(WORKDIR, 'explorer')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)

// ---------------------------------------------------------------- fixture project
const PROJ = path.join(WORKDIR, 'proj')
let cleanupCounter = 0
/** Remove OUR uniquely-named test file from the real Trash, so running the suite leaves no residue.
 *  Name-matched exactly against a pid-stamped name, so it can never touch a user's own file. */
function purgeFromTrash(uniqueName) {
  if (process.platform !== 'darwin') return // only macOS exposes the bin as a plain folder
  try {
    const t = path.join(require('node:os').homedir(), '.Trash', uniqueName)
    if (fs.existsSync(t) && /^atomic-trash-test-\d+-\d+\.(txt|png)$/.test(uniqueName)) fs.rmSync(t, { force: true })
  } catch { /* best effort — never fail a test over cleanup */ }
}
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true })
fs.writeFileSync(path.join(PROJ, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2))
fs.writeFileSync(path.join(PROJ, 'src/app.js'), `function greet() {\n  return 'hello'\n}\nmodule.exports = { greet }\n`)
fs.writeFileSync(path.join(PROJ, 'src/util.js'), `const MAGIC_TOKEN_XYZ = 42\nmodule.exports = { MAGIC_TOKEN_XYZ }\n`)

// ---------------------------------------------------------------- scripted model
// Reply sequence for the BUILD run: the "model" explores, hits every guard, edits.
const buildScript = [
  // 1. list
  'Let me see the project.\nACTION list_files',
  // 2. search
  'Looking for the magic token.\nACTION search MAGIC_TOKEN_XYZ',
  // 3. read
  'I will read the app file.\nACTION read_file src/app.js',
  // 4. path traversal attempt (must be refused, loop continues)
  'ACTION read_file ../../../etc/hosts',
  // 5. unsafe command (must be refused + surfaced)
  'ACTION run rm -rf /',
  // 6. safe command
  'ACTION run node src/app.js',
  // 7. write without fence (protocol error path)
  'ACTION write src/app.js\nno fence here',
  // 8. proper write
  "Updating the greeting.\nACTION write src/app.js\n```js\nfunction greet() {\n  return 'hello ATOMIC'\n}\nmodule.exports = { greet }\n```",
  // 9. second file (new file)
  'Adding a constants file.\nACTION write src/constants.js\n```js\nmodule.exports = { BRAND: "ATOMIC" }\n```',
  // 10. done
  'ACTION done\nUpdated the greeting and added a constants file.'
]

const planScript = [
  'ACTION read_file src/app.js',
  'ACTION write src/app.js\n```js\nhacked\n```', // must be refused in plan mode
  'ACTION done\nProposed: change the greeting text.'
]

const SCRIPT_FILE = path.join(WORKDIR, 'script.json')

/** Write a fresh reply script AND reset the mock's cursor so it starts at reply 0. */
function writeScript(replies) {
  fs.writeFileSync(SCRIPT_FILE, JSON.stringify(replies))
  fs.rmSync(SCRIPT_FILE + '.idx', { force: true })
}

// ---------------------------------------------------------------- harness
const results = []
let failed = 0
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed++
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `\n          ↳ ${detail}` : ''}`)
}
async function step(name, fn) {
  try {
    const detail = await fn()
    record(name, true, detail || '')
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err))
  }
}

app.whenReady().then(async () => {
  console.log('\n\x1b[1mATOMIC Studio — Phase 10 agent headless test\x1b[0m\n')

  const agent = require(path.join(WORKDIR, 'main', 'agent.js'))
  const undo = require(path.join(WORKDIR, 'main', 'undo.js'))
  const terminal = require(path.join(WORKDIR, 'main', 'terminal.js'))
  const gitView = require(path.join(WORKDIR, 'gitpanel', 'derive.js'))

  const events = []
  const emit = (ev) => events.push(ev)
  const byType = (t) => events.filter((e) => e.type === t)

  // ---------- provider registry ----------
  await step('provider registry includes Kimi (Moonshot, OpenAI-compatible)', () => {
    const providers = require(path.join(WORKDIR, 'main', 'providers.js'))
    const kimi = providers.PROVIDERS.find((p) => p.id === 'kimi')
    if (!kimi) throw new Error('kimi missing from PROVIDERS')
    if (kimi.kind !== 'openai') throw new Error(`kind = ${kimi.kind}`)
    if (kimi.baseURL !== 'https://api.moonshot.ai/v1') throw new Error(`baseURL = ${kimi.baseURL}`)
    if (!kimi.needsKey) throw new Error('kimi must require an API key')
    if (!kimi.defaultModel) throw new Error('no default model')
    // Real incident: `kimi-latest` was Moonshot's own auto-tracking alias for their newest flagship —
    // they discontinued it 2026-01-28 and it started 404ing outright, which read as a broken/unpaid key
    // for six months before anyone noticed. This pins the CURRENT model so a revert to the dead alias
    // (or another provider-side rename) fails loudly here instead of silently in a paid user's agent run.
    if (kimi.defaultModel === 'kimi-latest') throw new Error('kimi-latest was discontinued by Moonshot on 2026-01-28 — it 404s. Use their current flagship instead.')
    if (kimi.defaultModel !== 'kimi-k3') throw new Error(`expected the current flagship 'kimi-k3', got '${kimi.defaultModel}' — if Moonshot renamed it again, update this pin, don't just delete the check`)
    return `${kimi.label} · ${kimi.baseURL} · default ${kimi.defaultModel}`
  })

  // ---------- protocol parser unit checks ----------
  await step('git view: the staged/unstaged split, including a file that is in BOTH', () => {
    const { splitChanges } = gitView
    const r = splitChanges([
      { file: 'a.ts', x: 'M', y: ' ' },   // staged only
      { file: 'b.ts', x: ' ', y: 'M' },   // working tree only
      { file: 'c.ts', x: 'M', y: 'M' },   // staged an edit, then edited again — BOTH lists
      { file: 'd.ts', x: '?', y: '?' },   // untracked
      { file: 'e.ts', x: 'U', y: 'U' },   // conflicted
      { file: 'f.ts', x: 'A', y: 'A' }    // also unmerged (both added)
    ])
    const names = (rows) => rows.map((x) => x.file).sort().join(',')
    if (names(r.staged) !== 'a.ts,c.ts') throw new Error(`staged: ${names(r.staged)}`)
    // c.ts MUST appear twice. Deduplicating it is how someone commits believing an edit was
    // included that was not — the file header calls this out and it is worth an assertion.
    if (names(r.unstaged) !== 'b.ts,c.ts,d.ts') throw new Error(`unstaged: ${names(r.unstaged)}`)
    if (r.conflicts.sort().join(',') !== 'e.ts,f.ts') throw new Error(`conflicts: ${r.conflicts}`)
    if (r.unstaged.find((x) => x.file === 'd.ts').kind !== 'new') throw new Error('untracked must read as new')
    return 'both-lists case preserved; ?? is new; U/U and A/A are conflicts'
  })

  await step('git view: an in-flight stage moves the row at once, and rolls back cleanly', () => {
    const { applyPendingMoves } = gitView
    const base = {
      isRepo: true, isRepoRoot: true, isIgnored: false, branch: 'main', ahead: 0, behind: 0,
      staged: [{ file: 'a.ts', code: 'M', kind: 'modified' }],
      unstaged: [{ file: 'b.ts', code: 'M', kind: 'modified' }],
      conflicts: [], merging: false, clean: false
    }
    const staging = applyPendingMoves(base, new Map([['b.ts', 'staged']]))
    if (staging.staged.map((r) => r.file).sort().join(',') !== 'a.ts,b.ts') throw new Error('b.ts did not move to staged')
    if (staging.unstaged.length !== 0) throw new Error('b.ts still shown as unstaged')

    const unstaging = applyPendingMoves(base, new Map([['a.ts', 'unstaged']]))
    if (unstaging.unstaged.map((r) => r.file).sort().join(',') !== 'a.ts,b.ts') throw new Error('a.ts did not move to unstaged')

    // Rolling back is just dropping the entry — no second round-trip, and the original view returns.
    const rolled = applyPendingMoves(base, new Map())
    if (rolled !== base) throw new Error('an empty pending map must return the SAME view object')

    // A row git has already caught up with must not be duplicated into its destination.
    const already = applyPendingMoves(base, new Map([['a.ts', 'staged']]))
    if (already.staged.filter((r) => r.file === 'a.ts').length !== 1) throw new Error('duplicated a row')
    return 'moves instantly, no duplicates, and an empty map is identity'
  })

  await step('git view: a row knows its own leaf, folder and icon', () => {
    const { splitRow, fileGlyph } = gitView
    const deep = splitRow('apps/desktop/src/main/index.ts')
    if (deep.name !== 'index.ts' || deep.dir !== 'apps/desktop/src/main') throw new Error(JSON.stringify(deep))
    // A file at the repo root has no directory half to draw — an empty string, not 'undefined'
    // or '.', because the component renders it only when truthy.
    const root = splitRow('README.md')
    if (root.name !== 'README.md' || root.dir !== '') throw new Error(JSON.stringify(root))

    if (fileGlyph('src/App.tsx') !== 'file-code') throw new Error('tsx should be code')
    if (fileGlyph('package.json') !== 'braces') throw new Error('json should be braces')
    // The dotfile case: '.gitignore' has ONE dot, at index 0. Treating that as "no extension"
    // is the off-by-one that would give every dotfile the generic icon.
    if (fileGlyph('.gitignore') !== 'file') throw new Error('.gitignore should fall through to the generic icon')
    if (fileGlyph('.env') !== 'settings') throw new Error('.env should read as configuration')
    if (fileGlyph('a/b/c') !== 'file') throw new Error('an extensionless file should not crash or guess')
    return 'leaf/dir split, and the icon comes from the extension including the dotfile edge'
  })

  await step('git view: where this project pushes, and the no-upstream case that plain push fails on', () => {
    const { deriveRemote, remoteHost } = gitView
    // Every URL shape git accepts must yield a host a person recognises, because this string is
    // what the panel shows INSTEAD of the URL.
    if (remoteHost('ssh://git@203.0.113.10/srv/atomic/git/studio.git') !== '203.0.113.10') throw new Error('ssh:// host')
    if (remoteHost('git@github.com:me/x.git') !== 'github.com') throw new Error('scp-style host')
    if (remoteHost('https://user@gitlab.internal/g/x.git') !== 'gitlab.internal') throw new Error('https host with userinfo')
    if (remoteHost('/Volumes/stick/x.git') !== 'this machine') throw new Error('a local path is still a real remote')
    if (remoteHost('') !== '') throw new Error('no url, no host')

    const none = deriveRemote([], undefined)
    if (none.state !== 'no-remote') throw new Error('an empty remote list is not "connected"')

    // THE case this exists for: a remote is configured but the branch has never been pushed.
    // `git push` with no arguments FAILS here, so it must not read as 'connected'.
    const fresh = deriveRemote([{ name: 'origin', fetchUrl: 'ssh://git@host/x.git', pushUrl: 'ssh://git@host/x.git' }], undefined)
    if (fresh.state !== 'no-upstream') throw new Error('a remote without an upstream must be its own state')
    if (fresh.host !== 'host') throw new Error('host not derived')

    const ok = deriveRemote([{ name: 'origin', fetchUrl: 'ssh://git@host/x.git', pushUrl: '' }], 'origin/main')
    if (ok.state !== 'connected') throw new Error('tracking branch means connected')
    // pushUrl is empty here; a `git remote -v` with only a fetch line must still show a host.
    if (ok.url !== 'ssh://git@host/x.git') throw new Error('fell back to nothing instead of the fetch URL')

    // No 'origin'? Use whatever single remote there is rather than claiming none exists.
    const odd = deriveRemote([{ name: 'upstream', fetchUrl: 'ssh://git@h2/x.git', pushUrl: 'ssh://git@h2/x.git' }], undefined)
    if (odd.name !== 'upstream' || odd.host !== 'h2') throw new Error('a non-origin remote was ignored')
    return 'ssh/scp/https/path hosts; no-remote, no-upstream and connected are three different answers'
  })

  await step('parseAction: plain tool line + preamble', () => {
    const p = agent.parseAction('Reading it.\nACTION read_file src/x.ts')
    if ('error' in p) throw new Error(p.error)
    if (p.tool !== 'read_file' || p.arg !== 'src/x.ts' || p.preamble !== 'Reading it.') throw new Error(JSON.stringify(p))
    return 'ok'
  })
  await step('parseAction: a native tool-calling model cannot create folders named after its own markup', () => {
    // The exact shape OpenCode Zen produced on 2026-09-01. Stripping only <tool_call> left
    // `<arg_key>path</arg_key><arg_value>README.md</arg_value>` as the PATH, and the slashes inside
    // `</arg_key>` made fs-service build a directory tree out of XML fragments.
    const real = [
      '<tool_call>ACTION',
      'write<arg_key>path</arg_key>',
      '<arg_value>README.md</arg_value></tool_call>',
      '```md',
      '# hello',
      '```'
    ].join('\n')
    const p1 = agent.parseAction(real)
    if (p1.error) throw new Error(`refused a recoverable shape: ${p1.error}`)
    if (p1.tool !== 'write') throw new Error(`tool ${p1.tool}`)
    if (p1.arg !== 'README.md') throw new Error(`path came out as ${JSON.stringify(p1.arg)}`)
    if (!p1.body.includes('# hello')) throw new Error('body lost')

    // Belt: unknown markup we have not taught it about must be REFUSED, never written.
    const alien = 'ACTION write <path>src/x.ts</path>\n```ts\nx\n```'
    const p2 = agent.parseAction(alien)
    if (!p2.error) throw new Error(`wrote a path with angle brackets: ${JSON.stringify(p2.arg)}`)
    if (!/plain text/i.test(p2.error)) throw new Error('the refusal must tell the model what to do instead')

    // And the ordinary form still works.
    const p3 = agent.parseAction('ACTION write src/App.tsx\n```tsx\nok\n```')
    if (p3.error || p3.arg !== 'src/App.tsx') throw new Error('plain form broke')
    return 'arg markup unwrapped, split ACTION rejoined, unknown markup refused with guidance'
  })

  await step('parseAction: write requires a fenced body', () => {
    const bad = agent.parseAction('ACTION write a.txt\nno fence')
    if (!('error' in bad)) throw new Error('accepted a write without a fence')
    const good = agent.parseAction('ACTION write a.txt\n```\nBODY\n```')
    if ('error' in good || good.body !== 'BODY') throw new Error(JSON.stringify(good))
    return 'ok'
  })
  await step('parseAction: done captures the summary', () => {
    const p = agent.parseAction('ACTION done\nAll finished.')
    if ('error' in p || p.tool !== 'done' || !p.body.includes('All finished')) throw new Error(JSON.stringify(p))
    return 'ok'
  })
  await step('isAgentSafeCommand: allowlist + no chaining', () => {
    const t = terminal.isAgentSafeCommand
    const good = [
      'ls', 'git status', 'npm run build', 'npm test', 'npx tsc --noEmit', 'node src/app.js',
      // Fix: the agent could diagnose "dependencies are missing" but never install them itself —
      // it could only tell a non-coder to open the Terminal panel and do it by hand.
      'npm install', 'npm i', 'npm i -D lodash', 'npm install react@18',
      'yarn', 'yarn install', 'yarn add react', 'pnpm install', 'pnpm add react',
      'bun install', 'bun add react', 'pip install -r requirements.txt', 'poetry install',
      // Real bug report: the agent wrote its own tasks.js, then tried `node tasks.js add "Buy milk"`
      // to prove it worked, and got refused — a `"quoted argument with a space"` is completely
      // normal CLI usage, not an attack. Same for a plain numeric/word arg.
      'node tasks.js add "Buy milk"', 'node tasks.js remove 1', `node tasks.js add 'Buy milk'`
    ]
    const bad = [
      'rm -rf /', 'curl http://x', 'npm run build && rm -rf /', 'git status; rm x', 'echo hi > f', 'cat x | sh',
      // Installers must stay just as injection-safe as every other pattern here.
      'npm install $(rm -rf ~)', 'npm install `evil`', 'npm install pkg && rm -rf /',
      'npm install pkg; rm -rf /', 'npm install pkg > out.txt', 'yarn add pkg | sh',
      // `node` args are quoted-string-or-bare-word now (not "anything") — command substitution and
      // backticks inside the quotes must still be refused, or a quoted arg becomes an injection hole.
      'node tasks.js add "$(rm -rf ~)"', 'node tasks.js add "`whoami`"', 'node tasks.js; rm -rf /'
    ]
    for (const c of good) if (!t(c)) throw new Error(`should allow: ${c}`)
    for (const c of bad) if (t(c)) throw new Error(`should refuse: ${c}`)
    // Wave 21: the safe list still says yes to `npm run <script>`, but the SCRIPT ITSELF is now read.
    // Against the real project on disk (a package.json with no scripts key) nothing is refused.
    if (terminal.scriptVerdictFor(PROJ, 'ls') !== null) throw new Error('a non-npm-run command has no script verdict')
    const ordinary = terminal.scriptVerdictFor(PROJ, 'npm run build')
    if (!ordinary || ordinary.risk !== 'safe') throw new Error('an undeclared script on a real project must stay allowed: ' + JSON.stringify(ordinary))
    // Now give that project a genuinely dangerous shortcut and prove it is refused BY BODY.
    const pkgPath = path.join(PROJ, 'package.json')
    const original = fs.readFileSync(pkgPath, 'utf8')
    try {
      const pkg = JSON.parse(original)
      pkg.scripts = { ...(pkg.scripts || {}), build: 'vite build', postbuild: 'wrangler pages deploy dist' }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
      const v = terminal.scriptVerdictFor(PROJ, 'npm run build')
      if (!v || v.risk !== 'risky') throw new Error('a postbuild deploy in the REAL package.json must be refused: ' + JSON.stringify(v))
      if (!/wrangler/.test(v.matched || '')) throw new Error('the refusal must quote the real command: ' + JSON.stringify(v))
    } finally {
      fs.writeFileSync(pkgPath, original) // leave the fixture byte-identical
    }
    if (fs.readFileSync(pkgPath, 'utf8') !== original) throw new Error('fixture package.json was not restored')
    // `node <file>` is ALSO on the safe list — a deploy.js at the project root is completely ordinary,
    // so the wave's promise would be hollow if only npm scripts were inspected.
    fs.writeFileSync(path.join(PROJ, 'deploy.js'), "require('child_process').execSync('wrangler pages deploy dist')\n")
    const nodeV = terminal.scriptVerdictFor(PROJ, 'node deploy.js')
    if (!nodeV || nodeV.risk !== 'risky') throw new Error('`node deploy.js` that deploys must be refused: ' + JSON.stringify(nodeV))
    fs.writeFileSync(path.join(PROJ, 'harmless.js'), "console.log('hello')\n")
    const okV = terminal.scriptVerdictFor(PROJ, 'node harmless.js')
    if (!okV || okV.risk !== 'safe') throw new Error('an ordinary node script must still run: ' + JSON.stringify(okV))
    const outside = terminal.scriptVerdictFor(PROJ, 'node ../../../etc/passwd')
    if (!outside || outside.risk === 'safe') throw new Error('a file OUTSIDE the project cannot be vetted, so it must not be waved through: ' + JSON.stringify(outside))
    // Arguments after the filename must not let a script slip past the check entirely.
    fs.writeFileSync(path.join(PROJ, 'deploy2.js'), "require('child_process').execSync('vercel --prod')\n")
    const withArgs = terminal.scriptVerdictFor(PROJ, 'node deploy2.js --yes')
    if (!withArgs || withArgs.risk !== 'risky') throw new Error('`node deploy2.js --yes` must still be inspected: ' + JSON.stringify(withArgs))
    fs.rmSync(path.join(PROJ, 'deploy2.js'), { force: true })
    // npm's lifecycle aliases run project scripts WITHOUT the word "run" — the documented dangerous case.
    const pkgPath2 = path.join(PROJ, 'package.json')
    const orig2 = fs.readFileSync(pkgPath2, 'utf8')
    try {
      const pkg2 = JSON.parse(orig2)
      pkg2.scripts = { test: 'prisma migrate reset --force' }
      fs.writeFileSync(pkgPath2, JSON.stringify(pkg2, null, 2))
      const t1 = terminal.scriptVerdictFor(PROJ, 'npm test')
      if (!t1 || t1.risk !== 'risky') throw new Error('`npm test` must classify the test script, not skip it: ' + JSON.stringify(t1))
      pkg2.scripts = { postinstall: 'wrangler pages deploy dist' }
      fs.writeFileSync(pkgPath2, JSON.stringify(pkg2, null, 2))
      const t2 = terminal.scriptVerdictFor(PROJ, 'npm ci')
      if (!t2 || t2.risk !== 'risky') throw new Error('`npm ci` runs install hooks — a postinstall deploy must be caught: ' + JSON.stringify(t2))
    } finally {
      fs.writeFileSync(pkgPath2, orig2)
    }
    if (terminal.scriptVerdictFor(PROJ, 'node missing.js') !== null) throw new Error('a missing file is calm (node errors on its own)')
    fs.rmSync(path.join(PROJ, 'deploy.js'), { force: true })
    fs.rmSync(path.join(PROJ, 'harmless.js'), { force: true })
    return `${good.length} allowed, ${bad.length} refused, package.json postbuild + node deploy.js refused`
  })

  // ---------- BUILD-mode run ----------
  writeScript(buildScript)
  process.env.STUDIO_MOCK_SCRIPT = SCRIPT_FILE

  const appJsBefore = fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8')

  await step('build run completes with done', async () => {
    const res = await agent.startAgent(
      { projectPath: PROJ, instruction: 'Improve the greeting', mode: 'build', provider: 'mock' },
      emit
    )
    if (!res.ok) throw new Error(res.error)
    const done = byType('done')
    if (done.length !== 1) throw new Error(`done events: ${done.length}; errors: ${JSON.stringify(byType('error'))}`)
    return done[0].summary.slice(0, 60)
  })

  await step('tools ran: list_files, search, read_file, run', () => {
    const tools = byType('tool').map((e) => e.tool)
    for (const t of ['list_files', 'search', 'read_file', 'run']) if (!tools.includes(t)) throw new Error(`missing ${t} in ${tools}`)
    return tools.join(', ')
  })

  await step('path traversal was refused (no crash, loop continued)', () => {
    const bad = byType('tool').find((e) => e.tool === 'read_file' && e.detail.includes('..'))
    if (!bad) throw new Error('traversal attempt not recorded')
    if (bad.ok) throw new Error('traversal read reported ok=true')
    return bad.detail
  })

  await step('unsafe command was blocked and surfaced', () => {
    const blocked = byType('command-blocked')
    if (blocked.length !== 1 || !blocked[0].command.includes('rm -rf')) throw new Error(JSON.stringify(blocked))
    return blocked[0].command
  })

  await step('2 edits auto-applied (1 modified + 1 new) — build mode has no approval step', () => {
    // Real bug this design fixes: the agent used to stage a write, then immediately try to run it,
    // and fail because nothing was on disk yet — build mode now writes to disk the instant it stages,
    // so `staged` is empty again by the time the run resolves, and disk already has both files.
    const applied = byType('applied')
    if (applied.length !== 2) throw new Error(`applied: ${applied.length}`)
    const appEdit = applied.find((e) => e.edit.path === 'src/app.js').edit
    const newEdit = applied.find((e) => e.edit.path === 'src/constants.js').edit
    if (appEdit.isNew) throw new Error('app.js edit wrong')
    if (!newEdit.isNew) throw new Error('constants.js should be isNew')
    if (fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8') === appJsBefore) throw new Error('app.js was not written to disk')
    if (!fs.existsSync(path.join(PROJ, 'src/constants.js'))) throw new Error('constants.js was not written to disk')
    if (agent.getAgentState().staged.length !== 0) throw new Error('nothing should remain staged after a normal (non-secret) write')
    return `+${appEdit.added} −${appEdit.removed} on app.js; new file auto-applied`
  })

  await step('diff marks the changed line', () => {
    const appEdit = byType('applied').find((e) => e.edit.path === 'src/app.js').edit
    const adds = appEdit.diff.filter((l) => l.kind === 'add').map((l) => l.text)
    if (!adds.some((t) => t.includes('hello ATOMIC'))) throw new Error(`adds: ${JSON.stringify(adds)}`)
    return adds[0]
  })

  await step('auto-apply is undoable, and a redundant manual apply is a safe no-op', async () => {
    const now = fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8')
    if (!now.includes('hello ATOMIC')) throw new Error('app.js not updated')
    if (!undo.canUndo()) throw new Error('not undoable')
    const res = await agent.applyStaged('all') // nothing left staged — must not error or touch anything
    if (!res.ok || res.applied.length !== 0) throw new Error(JSON.stringify(res))
    return 'undoable; re-apply with nothing staged is a no-op'
  })

  await step('undo restores an edited file byte-for-byte and REMOVES a newly-created one', () => {
    undo.undo() // constants.js — did NOT exist before → REMOVED, not left as an empty file
    if (fs.existsSync(path.join(PROJ, 'src/constants.js'))) throw new Error('a newly-created file should be REMOVED by undo, not left empty')
    undo.undo() // app.js — existed before → restored byte-for-byte
    const now = fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8')
    if (now !== appJsBefore) throw new Error('app.js not restored')
    return 'app.js byte-identical; new constants.js removed by undo'
  })

  // ---------- PLAN-mode run ----------
  events.length = 0
  writeScript(planScript)

  await step('plan mode refuses writes and stages nothing', async () => {
    const before = fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8')
    const res = await agent.startAgent(
      { projectPath: PROJ, instruction: 'Plan a greeting change', mode: 'plan', provider: 'mock' },
      emit
    )
    if (!res.ok) throw new Error(res.error)
    if (byType('done').length !== 1) throw new Error('plan run did not finish')
    const writeChip = byType('tool').find((e) => e.tool === 'write')
    if (!writeChip || writeChip.ok) throw new Error('plan-mode write was not refused')
    if (agent.getAgentState().staged.length !== 0) throw new Error('plan mode staged an edit')
    if (fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8') !== before) throw new Error('plan mode touched disk')
    return 'write refused, nothing staged, disk untouched'
  })

  await step('Secret Leak Guard is the one write that still stays staged, and reject clears it', async () => {
    // Auto-apply's one carve-out (Secret Handling Protocol): a likely hardcoded key/password is left
    // staged instead of written to disk unseen. That is now the ONLY real reason "reject" still exists.
    writeScript([
      'ACTION write src/leaky-write.js\n```js\nconst AWS = "AKIA1234567890ABCDEF"\nmodule.exports = { AWS }\n```',
      'ACTION done\nwrote it'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'add aws const', mode: 'build', provider: 'mock' }, emit)
    if (fs.existsSync(path.join(PROJ, 'src/leaky-write.js'))) throw new Error('a likely secret must NOT be auto-applied to disk')
    if (byType('applied').some((e) => e.edit.path === 'src/leaky-write.js')) throw new Error('secret-flagged write must not emit "applied"')
    if (agent.getAgentState().staged.length !== 1) throw new Error('expected 1 staged (the secret-flagged edit)')
    agent.rejectStaged('all')
    if (agent.getAgentState().staged.length !== 0) throw new Error('reject did not clear')
    if (fs.existsSync(path.join(PROJ, 'src/leaky-write.js'))) throw new Error('rejected edit must not exist on disk')
    return 'ok — secret held back from auto-apply, then rejected cleanly'
  })

  await step('conversation memory: a follow-up continues the same transcript', async () => {
    agent.resetSession()
    writeScript(['ACTION done\nFirst run done.'])
    await agent.startAgent({ projectPath: PROJ, instruction: 'first goal', mode: 'build', provider: 'mock' }, emit)
    const after1 = agent.sessionLength()
    if (after1 < 2) throw new Error(`transcript too short after run 1: ${after1}`)
    writeScript(['ACTION done\nFollow-up done.'])
    await agent.startAgent({ projectPath: PROJ, instruction: 'follow-up goal', mode: 'build', provider: 'mock' }, emit)
    const after2 = agent.sessionLength()
    if (after2 <= after1) throw new Error(`transcript did not grow: ${after1} → ${after2}`)
    return `transcript ${after1} → ${after2} messages across runs`
  })

  await step('newChat resets the conversation', async () => {
    const before = agent.sessionLength()
    writeScript(['ACTION done\nFresh chat.'])
    await agent.startAgent(
      { projectPath: PROJ, instruction: 'fresh goal', mode: 'build', provider: 'mock', newChat: true },
      emit
    )
    const after = agent.sessionLength()
    if (after >= before) throw new Error(`newChat did not reset: ${before} → ${after}`)
    return `${before} → ${after} messages after newChat`
  })

  await step('verify-after-apply catches a broken JS file', async () => {
    writeScript([
      'ACTION write src/broken.js\n```js\nfunction oops( {\n  return 1\n}\n```',
      'ACTION done\nWrote it.'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'break it', mode: 'build', provider: 'mock' }, emit)
    const applied = byType('applied').find((e) => e.edit.path === 'src/broken.js')
    if (!applied) throw new Error('broken.js was not auto-applied')
    if (!applied.verify) throw new Error('no verify result for broken.js')
    if (applied.verify.ok) throw new Error('syntax error was NOT caught')
    undo.undo() // clean up
    return `caught: ${applied.verify.error}`
  })

  await step('verify-after-apply passes a valid JS file', async () => {
    writeScript([
      'ACTION write src/fine.js\n```js\nmodule.exports = 1\n```',
      'ACTION done\nWrote it.'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'fine file', mode: 'build', provider: 'mock' }, emit)
    const applied = byType('applied').find((e) => e.edit.path === 'src/fine.js')
    if (!applied || !applied.verify || !applied.verify.ok) throw new Error(JSON.stringify(applied))
    undo.undo()
    return 'clean file verified ok'
  })

  const indexService = require(path.join(WORKDIR, 'main', 'index-service.js'))
  const staticServer = require(path.join(WORKDIR, 'main', 'static-server.js'))

  await step('symbol index lists exports across files', () => {
    const idx = indexService.buildSymbolIndex(PROJ)
    if (!idx.includes('src/app.js: greet')) throw new Error(`index: ${idx}`)
    if (!idx.includes('MAGIC_TOKEN_XYZ')) throw new Error(`missing util symbol: ${idx}`)
    return idx.replace(/\n/g, ' · ')
  })

  await step('symbols tool locates a definition with file:line', () => {
    const hit = indexService.findSymbol(PROJ, 'greet')
    if (!/^src\/app\.js:1 greet/m.test(hit)) throw new Error(hit)
    return hit.split('\n')[0]
  })

  await step('agent seed includes the symbol index; ACTION symbols works', async () => {
    writeScript(['ACTION symbols greet', 'ACTION done\nFound it.'])
    events.length = 0
    await agent.startAgent(
      { projectPath: PROJ, instruction: 'where is greet?', mode: 'plan', provider: 'mock', newChat: true },
      emit
    )
    const chip = byType('tool').find((e) => e.tool === 'symbols')
    if (!chip || !chip.ok) throw new Error(`symbols chip: ${JSON.stringify(chip)}`)
    return `symbols tool ran (${chip.detail})`
  })

  await step('static server serves HTML with live-reload injected + blocks traversal', async () => {
    const site = path.join(WORKDIR, 'site')
    fs.mkdirSync(site, { recursive: true })
    fs.writeFileSync(path.join(site, 'index.html'), '<html><body><h1>Static OK</h1></body></html>')
    fs.writeFileSync(path.join(site, 'style.css'), 'h1{color:red}')
    const handle = await staticServer.startStaticServer(site, () => {})
    try {
      const page = await fetch(handle.url).then((r) => r.text())
      if (!page.includes('Static OK')) throw new Error('index.html not served')
      if (!page.includes('__studio_reload')) throw new Error('live-reload script not injected')
      const css = await fetch(handle.url + 'style.css')
      if (!css.headers.get('content-type')?.includes('text/css')) throw new Error('wrong css MIME')
      const evil = await fetch(handle.url + '..%2f..%2fscript.json')
      if (evil.status === 200) throw new Error('path traversal served a file outside the root')
      return `served at ${handle.url}, traversal → ${evil.status}`
    } finally {
      handle.close()
    }
  })

  await step('writeFile creates missing parent folders (a fresh project has no src/ yet)', async () => {
    // Real bug report: the agent scaffolds a brand-new project and proposes `src/Calculator.java`
    // before `src/` exists. writeFile used to call writeFileSync directly with no mkdir, so Apply
    // failed with ENOENT on the very first file of a new nested folder — the agent's own "build me
    // a small project" flow was broken for exactly the case it exists to handle.
    const fsvc = require(path.join(WORKDIR, 'main', 'fs-service.js'))
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-newproj-'))
    try {
      const res = fsvc.writeFile(root, 'src/Calculator.java', 'public class Calculator {}\n')
      if (!res.ok) throw new Error('writeFile into a non-existent folder must create it, not fail: ' + JSON.stringify(res))
      const abs = path.join(root, 'src', 'Calculator.java')
      if (!fs.existsSync(abs)) throw new Error('file was not actually written')
      if (fs.readFileSync(abs, 'utf8') !== 'public class Calculator {}\n') throw new Error('wrong content written')
      // Two levels deep, to prove it is not a one-level special case.
      const res2 = fsvc.writeFile(root, 'src/main/deep/Nested.java', 'class Nested {}\n')
      if (!res2.ok || !fs.existsSync(path.join(root, 'src/main/deep/Nested.java'))) throw new Error('multi-level missing folders must all be created: ' + JSON.stringify(res2))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    return 'src/Calculator.java in a folder that does not exist yet → folder created, file written, content correct; multi-level nesting too'
  })

  await step('parseAnsi: real ANSI-colored command output renders as styled segments, not garbage text', async () => {
    // "The terminal must look like a real terminal" — colored git/npm/test output previously showed as
    // raw \x1b[32m escape-code garbage (FORCE_COLOR was always 0). Now the interactive terminal opts
    // into color and this parser turns the codes into styled spans instead of visible junk.
    const { parseAnsi } = require(path.join(WORKDIR, 'shared', 'ansi.js'))
    const green = parseAnsi('\x1b[32m✓ 12 passed\x1b[0m')
    if (green.length !== 1 || green[0].text !== '✓ 12 passed' || green[0].fg !== '#98c379') throw new Error('green SGR must color the text: ' + JSON.stringify(green))
    const boldRed = parseAnsi('\x1b[1;31mERROR\x1b[0m: broken')
    if (boldRed.length !== 2 || boldRed[0].text !== 'ERROR' || !boldRed[0].bold || boldRed[0].fg !== '#e06c75') throw new Error('bold+red combined SGR wrong: ' + JSON.stringify(boldRed))
    if (boldRed[1].text !== ': broken' || boldRed[1].fg) throw new Error('style must reset after \\x1b[0m: ' + JSON.stringify(boldRed))
    // Cursor-movement / clear-line / OSC-title sequences must vanish silently, never show as literal junk.
    const spinner = parseAnsi('\x1b[2K\x1b[1Gspinner frame')
    if (spinner.map((s) => s.text).join('') !== 'spinner frame') throw new Error('non-color escapes must be stripped, not shown: ' + JSON.stringify(spinner))
    const title = parseAnsi('\x1b]0;window title\x07visible text')
    if (title.map((s) => s.text).join('') !== 'visible text') throw new Error('OSC (window-title) sequences must be stripped: ' + JSON.stringify(title))
    // Plain text with no codes at all must pass through byte-identical.
    const plain = parseAnsi('nothing fancy here')
    if (plain.length !== 1 || plain[0].text !== 'nothing fancy here' || plain[0].fg) throw new Error('plain text must be untouched: ' + JSON.stringify(plain))
    return 'green/bold-red SGR colored correctly, reset clears style, cursor-movement + OSC-title escapes stripped silently, plain text untouched'
  })

  await step('watchProject detects changes made OUTSIDE the app (Finder/terminal/npm install), debounced', async () => {
    // Real bug report: the file tree only ever reflected the app's OWN writes. Anything that changed the
    // project another way — a terminal command, npm install, Finder, git checkout — looked like nothing
    // happened until some unrelated app action happened to bump the tree.
    const { watchProject } = require(path.join(WORKDIR, 'main', 'watcher.js'))
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-watch-'))
    const seen = []
    const stop = watchProject(root, (paths) => seen.push(paths))
    try {
      await sleep(200) // let the watcher actually attach before the first write
      fs.writeFileSync(path.join(root, 'external.txt'), 'hi')
      await sleep(700) // past the 350ms debounce
      if (!seen.length) throw new Error('an external file creation must be detected')
      const flat = seen.flat()
      if (!flat.includes('external.txt')) throw new Error('the changed path must be reported: ' + JSON.stringify(seen))

      // A whole node_modules install (real npm-install shape: many files, nested, rapid) must collapse
      // into total silence — noise-filtered, not merely coalesced into one big noisy batch.
      seen.length = 0
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
      for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(root, 'node_modules', 'pkg', `f${i}.js`), 'x')
      await sleep(700)
      if (seen.flat().some((p) => p.includes('node_modules'))) throw new Error('node_modules churn must never reach the renderer: ' + JSON.stringify(seen))

      // A real source file changed DURING that same noisy window must still get through — the filter
      // must reject node_modules specifically, not go silent on everything while it's busy.
      seen.length = 0
      fs.mkdirSync(path.join(root, 'src'), { recursive: true })
      fs.writeFileSync(path.join(root, 'src', 'App.tsx'), 'export {}')
      await sleep(700)
      if (!seen.flat().some((p) => p === 'src/App.tsx' || p.endsWith('/App.tsx'))) throw new Error('a real source file must still be reported: ' + JSON.stringify(seen))

      // A rapid burst of edits to ONE file must debounce into a single batch, not one event per write.
      seen.length = 0
      for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, 'src', 'burst.txt'), String(i))
      await sleep(700)
      if (seen.length !== 1) throw new Error('a rapid burst on one file must debounce into ONE batch, not ' + seen.length)
    } finally {
      stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
    return 'external create detected; node_modules churn silently filtered; a real file changed in the same window still reported; a rapid burst debounces to one batch'
  })

  await step('undo timeline: history() lists entries, undoTo() rewinds LIFO to a point', async () => {
    const fsvc = require(path.join(WORKDIR, 'main', 'fs-service.js'))
    const before = undo.history().length
    const f1 = fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8')
    const f2 = fs.readFileSync(path.join(PROJ, 'src/util.js'), 'utf8')
    fsvc.writeFile(PROJ, 'src/app.js', f1 + '// t1\n')
    fsvc.writeFile(PROJ, 'src/util.js', f2 + '// t2\n')
    fsvc.writeFile(PROJ, 'src/app.js', f1 + '// t1\n// t3\n')
    const h = undo.history()
    if (h.length !== before + 3) throw new Error(`history: ${before} → ${h.length}`)
    if (!h[h.length - 1].ts || !h[h.length - 1].label) throw new Error('entry missing ts/label')
    const restored = undo.undoTo(before) // rewind all three at once
    if (restored.length !== 3) throw new Error(`restored ${restored.length}`)
    if (fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8') !== f1) throw new Error('app.js not rewound')
    if (fs.readFileSync(path.join(PROJ, 'src/util.js'), 'utf8') !== f2) throw new Error('util.js not rewound')
    if (undo.history().length !== before) throw new Error('history not trimmed')
    return `3 changes → one revert-to-point → both files byte-identical`
  })

  await step('undoDiff(index): per-change diff = what that one edit did', async () => {
    const fsvc = require(path.join(WORKDIR, 'main', 'fs-service.js'))
    const base = undo.history().length // next snapshot lands here
    const orig = fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8')
    fsvc.writeFile(PROJ, 'src/app.js', orig + '// MARK_A\n') // snapshot @ base, previous = orig
    fsvc.writeFile(PROJ, 'src/app.js', orig + '// MARK_A\n// MARK_B\n') // snapshot @ base+1
    // First edit: before=orig, after=next-snapshot.previous (=orig+MARK_A) → shows MARK_A added.
    const dA = undo.undoDiff(base)
    if (!dA.some((l) => l.kind === 'add' && l.text.includes('MARK_A'))) throw new Error('diff A missing added MARK_A: ' + JSON.stringify(dA))
    if (dA.some((l) => l.text.includes('MARK_B'))) throw new Error('diff A leaked the later edit')
    // Second edit: before=orig+MARK_A, after=current file → shows MARK_B added (MARK_A now context/folded).
    const dB = undo.undoDiff(base + 1)
    if (!dB.some((l) => l.kind === 'add' && l.text.includes('MARK_B'))) throw new Error('diff B missing added MARK_B: ' + JSON.stringify(dB))
    if (dB.some((l) => l.kind === 'add' && l.text.includes('MARK_A'))) throw new Error('diff B wrongly re-added MARK_A')
    if (undo.undoDiff(9999).length !== 0) throw new Error('out-of-range index should be []')
    // Reused-index freshness (the invariant the Replay diff-cache fix relies on): pop the top
    // snapshot, then edit a DIFFERENT file so it snapshots at the SAME integer index. undoDiff
    // for that index must reflect the NEW file's change, never the popped one's stale diff.
    undo.undoTo(base + 1) // pop the MARK_B snapshot (index base+1); app.js keeps MARK_A
    const utilOrig = fs.readFileSync(path.join(PROJ, 'src/util.js'), 'utf8')
    fsvc.writeFile(PROJ, 'src/util.js', utilOrig + '// REUSED_IDX\n') // snapshots at reused index base+1
    const dReuse = undo.undoDiff(base + 1)
    if (!dReuse.some((l) => l.kind === 'add' && l.text.includes('REUSED_IDX'))) throw new Error('reused index did not reflect the NEW change: ' + JSON.stringify(dReuse))
    if (dReuse.some((l) => l.text.includes('MARK_B'))) throw new Error('reused index served the popped change’s stale diff')
    undo.undoTo(base) // clean up: rewind + trim stack so the fixtures stay byte-identical
    if (fs.readFileSync(path.join(PROJ, 'src/app.js'), 'utf8') !== orig) throw new Error('app.js not restored')
    if (fs.readFileSync(path.join(PROJ, 'src/util.js'), 'utf8') !== utilOrig) throw new Error('util.js not restored')
    return `per-change diff isolates each edit; reused index stays fresh; out-of-range → []`
  })

  await step('a second start while running is QUEUED (background agents), not refused', async () => {
    writeScript(['ACTION run node src/app.js', 'ACTION done\nok'])
    events.length = 0
    const p = agent.startAgent({ projectPath: PROJ, instruction: 'x', mode: 'build', provider: 'mock' }, emit)
    const second = await agent.startAgent({ projectPath: PROJ, instruction: 'y', mode: 'build', provider: 'mock' }, emit)
    if (!second.ok || !second.queued) throw new Error(JSON.stringify(second))
    await p
    await new Promise((r) => setTimeout(r, 600)) // queued run drains with the same script
    if (agent.getAgentState().running || agent.getAgentState().queued) throw new Error('queue did not drain')
    return 'second start queued, drained cleanly'
  })

  await step('Multi-Agent Board: finished ring records status+turns; queue exposes instructions', async () => {
    // A completed run lands in the finished ring as 'done' with a turn count.
    writeScript(['ACTION read_file src/app.js', 'ACTION done\nlooked at it'])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'inspect the app', mode: 'build', provider: 'mock', newChat: true }, emit)
    let st = agent.getAgentState()
    if (st.active) throw new Error('active should be null when idle')
    const last = (st.finished || [])[0]
    if (!last || last.status !== 'done' || last.instruction !== 'inspect the app') throw new Error('finished run not recorded: ' + JSON.stringify((st.finished || []).slice(0, 2)))
    if (last.turns < 1 || typeof last.startedAt !== 'number' || typeof last.endedAt !== 'number') throw new Error('turns/timestamps missing')
    // While one runs, a second is queued and exposed as a task with its instruction.
    writeScript(['ACTION run node src/app.js', 'ACTION done\nok'])
    events.length = 0
    const p = agent.startAgent({ projectPath: PROJ, instruction: 'first background task', mode: 'build', provider: 'mock', newChat: true }, emit)
    const second = await agent.startAgent({ projectPath: PROJ, instruction: 'second background task', mode: 'build', provider: 'mock' }, () => {})
    if (!second.queued) throw new Error('second start was not queued')
    st = agent.getAgentState()
    if (!st.active || st.active.status !== 'running') throw new Error('no running active task while busy')
    if (!(st.queuedTasks || []).some((t) => t.instruction === 'second background task' && t.status === 'queued')) throw new Error('queued task instruction not exposed: ' + JSON.stringify(st.queuedTasks))
    await p
    await new Promise((r) => setTimeout(r, 700))
    if (agent.getAgentState().running) throw new Error('queue did not drain')
    return `finished[done · ${last.turns} turns]; queuedTasks carried the instruction`
  })

  await step('Queue is confined to ONE project (shared staged-Map safety)', async () => {
    writeScript(['ACTION run node src/app.js', 'ACTION done\nok'])
    const p = agent.startAgent({ projectPath: PROJ, instruction: 'A task', mode: 'build', provider: 'mock', newChat: true }, emit)
    // Same project → queues.
    const same = await agent.startAgent({ projectPath: PROJ, instruction: 'A follow-up', mode: 'build', provider: 'mock' }, () => {})
    if (!same.queued) throw new Error('same-project follow-up should queue')
    // Different project while busy → REFUSED (would corrupt the global staged Map on apply).
    const other = await agent.startAgent({ projectPath: PROJ + '-other', instruction: 'B task', mode: 'build', provider: 'mock' }, () => {})
    if (other.ok || !/another project/i.test(other.error || '')) throw new Error('cross-project queue not refused: ' + JSON.stringify(other))
    await p
    await new Promise((r) => setTimeout(r, 800))
    if (agent.getAgentState().running) throw new Error('queue did not drain')
    return 'same-project queues; cross-project refused'
  })

  await step('Cancel clears the pending queue (queued runs stop too)', async () => {
    writeScript(['ACTION run node src/app.js', 'ACTION done\nok'])
    const p = agent.startAgent({ projectPath: PROJ, instruction: 'C1 running', mode: 'build', provider: 'mock', newChat: true }, emit)
    const q = await agent.startAgent({ projectPath: PROJ, instruction: 'C2 queued', mode: 'build', provider: 'mock' }, () => {})
    if (!q.queued) throw new Error('C2 should queue')
    if (!agent.getAgentState().queuedTasks.some((t) => t.instruction === 'C2 queued')) throw new Error('C2 not in the queue')
    agent.cancelAgent()
    if (agent.getAgentState().queued !== 0) throw new Error('cancel did not clear the queue')
    await p
    await new Promise((r) => setTimeout(r, 800))
    if (agent.getAgentState().running || agent.getAgentState().queued) throw new Error('did not settle after cancel')
    return 'cancel cleared the pending queue'
  })

  // ---------- Enterprise: git (real git, local bare origin — zero network) ----------
  const ghMod = require(path.join(WORKDIR, 'main', 'git.js'))
  const conflicts = require(path.join(WORKDIR, 'shared', 'conflicts.js'))
  const REPO_DIR = path.join(WORKDIR, 'gitrepo')
  const ORIGIN = path.join(WORKDIR, 'origin.git')

  await step('git: info/commit/push against a local bare origin', async () => {
    const { execSync: x } = require('node:child_process')
    fs.mkdirSync(REPO_DIR, { recursive: true })
    x(`git init -q -b main "${REPO_DIR}" && git init -q --bare "${ORIGIN}"`, { shell: '/bin/bash' })
    x(`git -C "${REPO_DIR}" config user.email t@t && git -C "${REPO_DIR}" config user.name T`, { shell: '/bin/bash' })
    fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'hello\n')
    x(`git -C "${REPO_DIR}" add -A && git -C "${REPO_DIR}" commit -qm init && git -C "${REPO_DIR}" remote add origin "${ORIGIN}" && git -C "${REPO_DIR}" push -qu origin main`, { shell: '/bin/bash' })

    fs.writeFileSync(path.join(REPO_DIR, 'feature.js'), 'module.exports = 1\n')
    const info = await ghMod.gitInfo(REPO_DIR)
    if (!info.isRepo || info.branch !== 'main') throw new Error(JSON.stringify({ isRepo: info.isRepo, branch: info.branch }))
    if (!info.changes.some((c) => c.file === 'feature.js')) throw new Error(`changes: ${JSON.stringify(info.changes)}`)

    // gitCommit no longer stages implicitly (2026-08-31): an unstaged tree has nothing to commit.
    const nothing = await ghMod.gitCommit(REPO_DIR, 'add feature')
    if (nothing.ok) throw new Error('committed with an empty index — implicit `add -A` is back')
    const staged = await ghMod.gitStage(REPO_DIR, ['feature.js'])
    if (!staged.ok || staged.staged !== 1) throw new Error(JSON.stringify(staged))
    const commit = await ghMod.gitCommit(REPO_DIR, 'add feature')
    if (!commit.ok) throw new Error(commit.error)
    const push = await ghMod.gitPush(REPO_DIR)
    if (!push.ok) throw new Error(push.error)
    const originLog = x(`git -C "${ORIGIN}" log --oneline -n 1`, { shell: '/bin/bash' }).toString()
    if (!originLog.includes('add feature')) throw new Error(`origin log: ${originLog}`)
    return `pushed for real → origin HEAD = "${originLog.trim()}"`
  })

  await step('git: branch create + switch + empty-message guard', async () => {
    const bad = await ghMod.gitCommit(REPO_DIR, '   ')
    if (bad.ok) throw new Error('empty commit message accepted')
    const mk = await ghMod.gitCheckout(REPO_DIR, 'feature/x', true)
    if (!mk.ok) throw new Error(mk.error)
    let info = await ghMod.gitInfo(REPO_DIR)
    if (info.branch !== 'feature/x') throw new Error(`branch = ${info.branch}`)
    const back = await ghMod.gitCheckout(REPO_DIR, 'main', false)
    if (!back.ok) throw new Error(back.error)
    const evil = await ghMod.gitCheckout(REPO_DIR, 'x; rm -rf /', false)
    if (evil.ok) throw new Error('shell-metacharacter branch name accepted')
    return 'created feature/x, switched back, injection refused'
  })

  await step('git: stage / unstage round-trip keeps the two lists honest', async () => {
    const { execSync: x } = require('node:child_process')
    fs.writeFileSync(path.join(REPO_DIR, 'a.js'), 'let a = 1\n')
    fs.writeFileSync(path.join(REPO_DIR, 'b.js'), 'let b = 1\n')
    const st = await ghMod.gitStage(REPO_DIR, ['a.js'])
    if (!st.ok) throw new Error(st.error)

    // The porcelain columns must survive: a.js staged (X set), b.js not (untracked).
    const info = await ghMod.gitInfo(REPO_DIR)
    const a = info.changes.find((c) => c.file === 'a.js')
    const b = info.changes.find((c) => c.file === 'b.js')
    if (!a || a.x !== 'A') throw new Error(`a.js X column = ${JSON.stringify(a)}`)
    if (!b || b.x !== '?') throw new Error(`b.js X column = ${JSON.stringify(b)}`)

    const stat = await ghMod.gitStagedStat(REPO_DIR)
    if (!stat.files.some((f) => f.file === 'a.js')) throw new Error(`staged stat: ${JSON.stringify(stat.files)}`)
    if (stat.files.some((f) => f.file === 'b.js')) throw new Error('unstaged file leaked into the staged list')

    const un = await ghMod.gitUnstage(REPO_DIR, ['a.js'])
    if (!un.ok) throw new Error(un.error)
    const after = await ghMod.gitStagedStat(REPO_DIR)
    if (after.files.length !== 0) throw new Error(`still staged: ${JSON.stringify(after.files)}`)
    x(`git -C "${REPO_DIR}" clean -qfd`, { shell: '/bin/bash' })
    return 'staged a.js, saw it in the index only, unstaged it again'
  })

  await step('git: merge conflict surfaces as DATA, resolves, and completes', async () => {
    const { execSync: x } = require('node:child_process')
    const q = { shell: '/bin/bash' }
    x(`git -C "${REPO_DIR}" checkout -q main`, q)
    fs.writeFileSync(path.join(REPO_DIR, 'conf.txt'), 'base\n')
    x(`git -C "${REPO_DIR}" add -A && git -C "${REPO_DIR}" commit -qm base`, q)
    x(`git -C "${REPO_DIR}" checkout -q -b theirs`, q)
    fs.writeFileSync(path.join(REPO_DIR, 'conf.txt'), 'theirs\n')
    x(`git -C "${REPO_DIR}" commit -qam theirs`, q)
    x(`git -C "${REPO_DIR}" checkout -q main`, q)
    fs.writeFileSync(path.join(REPO_DIR, 'conf.txt'), 'ours\n')
    x(`git -C "${REPO_DIR}" commit -qam ours`, q)

    const merged = await ghMod.gitMerge(REPO_DIR, 'theirs')
    if (merged.ok) throw new Error('expected a conflict')
    if (merged.error) throw new Error(`conflict reported as an error: ${merged.error}`)
    if (!merged.conflicts.includes('conf.txt')) throw new Error(JSON.stringify(merged.conflicts))
    if (!(await ghMod.gitMergeInProgress(REPO_DIR))) throw new Error('MERGE_HEAD missing')

    // Completing mid-conflict must be refused, and so must a hand-"resolved" file that
    // still carries markers - precisely the case git itself would let through.
    const early = await ghMod.gitMergeContinue(REPO_DIR)
    if (early.ok) throw new Error('merge completed with a file still unresolved')

    const raw = fs.readFileSync(path.join(REPO_DIR, 'conf.txt'), 'utf8')
    const hunks = conflicts.parseConflicts(raw)
    if (hunks.length !== 1) throw new Error(`parsed ${hunks.length} hunks from real git output`)

    await ghMod.gitResolveFile(REPO_DIR, 'conf.txt') // staged, markers still in it
    const marked = await ghMod.gitCommit(REPO_DIR, 'sneak markers in')
    if (marked.ok) throw new Error('committed a file containing conflict markers')

    fs.writeFileSync(path.join(REPO_DIR, 'conf.txt'), conflicts.resolveHunk(raw, hunks[0], 'incoming'))
    const res = await ghMod.gitResolveFile(REPO_DIR, 'conf.txt')
    if (!res.ok) throw new Error(res.error)
    if ((await ghMod.gitConflicts(REPO_DIR)).length !== 0) throw new Error('still unmerged')
    const done = await ghMod.gitMergeContinue(REPO_DIR)
    if (!done.ok) throw new Error(done.error)
    if (fs.readFileSync(path.join(REPO_DIR, 'conf.txt'), 'utf8').trim() !== 'theirs') throw new Error('wrong side kept')
    return 'conflict to data, markers refused at commit, resolved, merged'
  })

  await step('git: branches report ahead/behind, and hostile URLs are refused', async () => {
    const branches = await ghMod.gitBranches(REPO_DIR)
    const cur = branches.find((b) => b.current)
    if (!cur || cur.name !== 'main') throw new Error(JSON.stringify(branches))
    if (typeof cur.ahead !== 'number' || typeof cur.behind !== 'number') throw new Error('ahead/behind missing')
    if (cur.ahead < 1) throw new Error(`expected local commits ahead of origin, got ${cur.ahead}`)

    // Git OPTION injection, not shell injection: a "URL" starting with a dash is read as a
    // flag, and --upload-pack turns a clone into code execution on this machine.
    for (const bad of ['--upload-pack=touch /tmp/x', '-u evil', 'javascript:x', '', 'ext::sh -c evil']) {
      if (ghMod.isSafeGitUrl(bad)) throw new Error(`accepted hostile URL: ${bad}`)
    }
    for (const good of ['ssh://git@box.internal/srv/atomic/git/x.git', 'git@box:x.git', 'https://h/x.git', '/srv/repos/x.git']) {
      if (!ghMod.isSafeGitUrl(good)) throw new Error(`rejected valid URL: ${good}`)
    }
    const clone = await ghMod.gitClone('--upload-pack=touch /tmp/x', WORKDIR)
    if (clone.ok) throw new Error('cloned a flag-shaped URL')
    return `main is ${cur.ahead} ahead; 5 hostile URLs refused, 4 valid accepted`
  })

  await step('conflicts.ts: diff3 base section is parsed and never survives a resolve', async () => {
    const diff3 = 'a\n<<<<<<< HEAD\nours\n||||||| base\nancestor\n=======\ntheirs\n>>>>>>> topic\nz\n'
    const [h] = conflicts.parseConflicts(diff3)
    if (!h) throw new Error('diff3 hunk not parsed')
    if (h.baseStart === undefined) throw new Error('base section not detected - it would survive into the file')
    for (const choice of ['current', 'incoming', 'both']) {
      const out = conflicts.resolveHunk(diff3, h, choice)
      if (conflicts.hasConflictMarkers(out)) throw new Error(`markers survived a '${choice}' resolve`)
      if (out.includes('ancestor')) throw new Error(`diff3 ancestor text survived a '${choice}' resolve`)
    }
    // A stray marker is not a parseable hunk, but must still block a commit.
    if (conflicts.parseConflicts('x\n=======\ny\n').length !== 0) throw new Error('invented a hunk from a stray marker')
    if (!conflicts.hasConflictMarkers('x\n=======\ny\n')) throw new Error('stray marker would reach a commit')
    // An unterminated conflict must not yield a hunk with a guessed end.
    if (conflicts.parseConflicts('<<<<<<< HEAD\nours\n').length !== 0) throw new Error('guessed an end for an unterminated conflict')
    return 'diff3 base dropped on all 3 choices; stray + unterminated markers handled'
  })

  await step('git hotspots: aggregates commits + churn per file over history', async () => {
    // Make readme.md the hottest file with two more commits (3 total).
    const { execSync: x } = require('node:child_process')
    fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'hello\nworld\n')
    x(`git -C "${REPO_DIR}" commit -qam edit1`, { shell: '/bin/bash' })
    fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'hello\nworld\nagain\n')
    x(`git -C "${REPO_DIR}" commit -qam edit2`, { shell: '/bin/bash' })
    // A rename must NOT create a phantom "{old => new}" hotspot (--no-renames).
    const { execSync: xr } = require('node:child_process')
    fs.writeFileSync(path.join(REPO_DIR, 'oldname.js'), 'module.exports = 0\n')
    xr(`git -C "${REPO_DIR}" add -A && git -C "${REPO_DIR}" commit -qm addold`, { shell: '/bin/bash' })
    xr(`git -C "${REPO_DIR}" mv oldname.js newname.js && git -C "${REPO_DIR}" commit -qm rename`, { shell: '/bin/bash' })
    const hot = await ghMod.gitHotspots(REPO_DIR)
    if (!Array.isArray(hot) || hot.length === 0) throw new Error(`no hotspots: ${JSON.stringify(hot)}`)
    const readme = hot.find((h) => h.file === 'readme.md')
    if (!readme || readme.commits < 3) throw new Error(`readme not hottest: ${JSON.stringify(hot)}`)
    if (typeof readme.churn !== 'number' || readme.churn <= 0) throw new Error('churn not counted')
    if (hot[0].file !== 'readme.md') throw new Error(`expected readme.md #1, got ${hot[0].file}`)
    if (hot.some((h) => /=>|[{}]/.test(h.file))) throw new Error(`phantom rename path in hotspots: ${JSON.stringify(hot.map((h) => h.file))}`)
    if (!hot.some((h) => h.file === 'newname.js')) throw new Error('renamed-to file not counted as its own path')
    // Opening a SUBFOLDER of a repo must yield PROJECT-relative paths scoped to that folder — the same
    // namespace as the index/debt/architecture folds. Repo-root-relative paths here silently empty the
    // Fragile watchlist (nothing joins) and it falsely reads "your busiest files look clean".
    const sub = path.join(REPO_DIR, 'hotpkg') // own folder: the authorship test below owns `pkg/`
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'deep.js'), 'module.exports = 1\n')
    xr(`git -C "${REPO_DIR}" add -A && git -C "${REPO_DIR}" commit -qm deep`, { shell: '/bin/bash' })
    const subHot = await ghMod.gitHotspots(sub)
    if (!subHot.some((h) => h.file === 'deep.js')) throw new Error(`subfolder hotspots must be project-relative ("deep.js", not "pkg/app/deep.js"): ${JSON.stringify(subHot.map((h) => h.file))}`)
    if (subHot.some((h) => h.file === 'readme.md')) throw new Error('subfolder hotspots must be scoped to that folder, not the whole repo')
    // A dir outside any git repo returns [] and never throws (os.tmpdir is not a repo).
    const nonRepo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-nonrepo-'))
    try {
      const none = await ghMod.gitHotspots(nonRepo)
      if (!Array.isArray(none) || none.length) throw new Error('non-repo path should give []')
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true })
    }
    return `readme.md hottest: ${readme.commits} commits, churn ${readme.churn}`
  })

  await step('Work-Safety: workSafety fold + gitWorkingStat + gitShowHead/restore reversibility', async () => {
    const ws = require(path.join(WORKDIR, 'shared', 'worksafety.js'))
    const undoMod = require(path.join(WORKDIR, 'main', 'undo.js'))
    const os = require('node:os')
    const { execSync: x } = require('node:child_process')
    // --- F1: workSafety() PURE fold (hand-built inputs, no I/O) ---
    const NOW = 1_700_000_000_000
    const dirty = ws.workSafety({ isRepo: true, isRepoRoot: true, changedFiles: 3, lastCommitTs: NOW - 3 * 86400_000, sessionEdits: 5, restorePoints: 2, now: NOW })
    if (dirty.band !== 'amber' || !/3 changed files/.test(dirty.verdict)) throw new Error('uncommitted changes → amber + count: ' + JSON.stringify(dirty))
    if (!dirty.canBackup) throw new Error('a repo ROOT with changes must offer Back up now')
    if (!dirty.lines.some((l) => /3 days ago/.test(l)) || !dirty.lines.some((l) => /5 AI edits and 2 restore points/.test(l))) throw new Error('lines must name last-backup age + session-only counts: ' + JSON.stringify(dirty.lines))
    const clean = ws.workSafety({ isRepo: true, isRepoRoot: true, changedFiles: 0, lastCommitTs: NOW - 1000, sessionEdits: 0, restorePoints: 0, now: NOW })
    if (clean.band !== 'green' || clean.canBackup) throw new Error('clean repo → green, no backup button: ' + JSON.stringify(clean))
    // Review fix: a SUBFOLDER of a bigger repo must NOT offer one-click backup (would commit the parent) — warn instead.
    const sub = ws.workSafety({ isRepo: true, isRepoRoot: false, changedFiles: 2, lastCommitTs: NOW - 1000, sessionEdits: 0, restorePoints: 0, now: NOW })
    if (sub.canBackup) throw new Error('a subfolder project must NOT offer one-click Back up now')
    if (!sub.lines.some((l) => /inside a bigger project/i.test(l))) throw new Error('a subfolder must explain why backup is not offered: ' + JSON.stringify(sub.lines))
    // Review fix: a non-git project is AMBER (a nudge), never RED — the files persist on disk; only undo is session-only.
    const noRepoRisk = ws.workSafety({ isRepo: false, isRepoRoot: false, changedFiles: 0, lastCommitTs: 0, sessionEdits: 4, restorePoints: 0, now: NOW })
    if (noRepoRisk.band !== 'amber' || noRepoRisk.canBackup) throw new Error('non-repo (even with session edits) → amber, no backup: ' + JSON.stringify(noRepoRisk))
    if (ws.workSafety({ isRepo: false, isRepoRoot: false, changedFiles: 0, lastCommitTs: 0, sessionEdits: 0, restorePoints: 0, now: NOW }).band !== 'amber') throw new Error('non-repo, no work → amber')
    // formatChangedFiles sentences (names only).
    if (ws.formatChangedFiles({ file: 'a.js', kind: 'modified', added: 4, removed: 1 }) !== 'Modified: a.js (+4 / −1)') throw new Error('modified sentence wrong')
    if (ws.formatChangedFiles({ file: 'b.js', kind: 'new', added: 9, removed: 0 }) !== 'Brand-new: b.js (+9)') throw new Error('new sentence wrong')
    if (ws.formatChangedFiles({ file: 'c.js', kind: 'deleted', added: 0, removed: 7 }) !== 'Deleted: c.js') throw new Error('deleted sentence wrong')
    // --- F2/F3: against a fresh isolated temp git repo (project = repo root) ---
    const wdir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-ws-'))
    try {
      x(`git -C "${wdir}" init -q && git -C "${wdir}" config user.email t@t && git -C "${wdir}" config user.name T`, { shell: '/bin/bash' })
      fs.writeFileSync(path.join(wdir, 'a.js'), 'line1\nline2\n')
      fs.writeFileSync(path.join(wdir, 'del.js'), 'to be deleted\n')
      fs.writeFileSync(path.join(wdir, 'logo.bin'), Buffer.from([0, 1, 2, 255, 254]))
      fs.writeFileSync(path.join(wdir, 'rn.js'), 'renamed\n')
      x(`git -C "${wdir}" add -A && git -C "${wdir}" commit -qm init`, { shell: '/bin/bash' })
      // Working changes: modify a.js, add untracked new.txt, delete a text + a BINARY file, rename rn.js.
      fs.writeFileSync(path.join(wdir, 'a.js'), 'line1\nline2\nline3\nline4\n')
      fs.writeFileSync(path.join(wdir, 'new.txt'), 'brand new\n')
      fs.rmSync(path.join(wdir, 'del.js'), { force: true })
      fs.rmSync(path.join(wdir, 'logo.bin'), { force: true })
      x(`git -C "${wdir}" mv rn.js rn2.js`, { shell: '/bin/bash' })
      const statList = await ghMod.gitWorkingStat(wdir)
      // Wave 22: gitWorkingStat now returns {files,total,capped,exact} so the count can be honest.
      const stat = statList.files
      if (statList.total !== stat.length || statList.capped) throw new Error('a small tree must report an exact, uncapped total: ' + JSON.stringify({ total: statList.total, capped: statList.capped }))
      if (!statList.exact) throw new Error('a small tree is never truncated, so exact must be true')
      const byf = (f) => stat.find((s) => s.file === f)
      if (!byf('a.js') || byf('a.js').kind !== 'modified' || byf('a.js').added < 1) throw new Error('modified file must have numeric adds: ' + JSON.stringify(byf('a.js')))
      if (!byf('new.txt') || byf('new.txt').kind !== 'new') throw new Error('untracked file must be Brand-new (never dropped)')
      if (!byf('del.js') || byf('del.js').kind !== 'deleted') throw new Error('a deleted text file must be labelled deleted: ' + JSON.stringify(byf('del.js')))
      // Review fix: a DELETED BINARY (numstat "-\t-") must still be "deleted", not mislabelled "modified".
      if (!byf('logo.bin') || byf('logo.bin').kind !== 'deleted') throw new Error('a deleted BINARY must be labelled deleted (name-status D), not modified: ' + JSON.stringify(byf('logo.bin')))
      // Review fix: a rename with --no-renames splits into deleted old + new — NEVER a phantom "{old => new}".
      if (stat.some((s) => /=>|[{}]/.test(s.file))) throw new Error('phantom rename path leaked into gitWorkingStat: ' + JSON.stringify(stat.map((s) => s.file)))
      if (!byf('rn.js') || byf('rn.js').kind !== 'deleted' || !byf('rn2.js')) throw new Error('a rename must show the old path deleted + the new path present: ' + JSON.stringify(stat))
      // gitShowHead returns the COMMITTED content; a not-yet-committed path → null; unsafe paths → null.
      const committed = await ghMod.gitShowHead(wdir, 'a.js')
      if (committed !== 'line1\nline2\n') throw new Error('gitShowHead must return the committed blob: ' + JSON.stringify(committed))
      if ((await ghMod.gitShowHead(wdir, 'new.txt')) !== null) throw new Error('a not-yet-committed file → null (nothing to restore to)')
      for (const bad of ['../etc/passwd', 'a.js; echo hi', 'a.js`whoami`', '/abs/path']) if ((await ghMod.gitShowHead(wdir, bad)) !== null) throw new Error('unsafe path must be rejected: ' + bad)
      // Restore composition = snapshot(current) then write(committed); undo() brings the current back (reversible).
      const absA = path.join(wdir, 'a.js')
      undoMod.snapshot(absA, 'restore a.js')
      fs.writeFileSync(absA, committed)
      if (fs.readFileSync(absA, 'utf8') !== 'line1\nline2\n') throw new Error('restore must write the committed content')
      undoMod.undo()
      if (fs.readFileSync(absA, 'utf8') !== 'line1\nline2\nline3\nline4\n') throw new Error('restore must be reversible via undo')
    } finally {
      fs.rmSync(wdir, { recursive: true, force: true })
    }
    // --- Review fix: SUBFOLDER of a repo → project-relative paths + gitShowHead resolves the subfolder's own file ---
    const sup = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-ws-mono-'))
    try {
      fs.mkdirSync(path.join(sup, 'proj', 'src'), { recursive: true })
      x(`git -C "${sup}" init -q && git -C "${sup}" config user.email t@t && git -C "${sup}" config user.name T`, { shell: '/bin/bash' })
      fs.writeFileSync(path.join(sup, 'sibling.js'), 'unrelated\n') // a sibling OUTSIDE the project
      fs.writeFileSync(path.join(sup, 'proj', 'src', 'f.js'), 'orig\n')
      x(`git -C "${sup}" add -A && git -C "${sup}" commit -qm init`, { shell: '/bin/bash' })
      const proj = path.join(sup, 'proj')
      fs.writeFileSync(path.join(proj, 'src', 'f.js'), 'orig\nchanged\n')
      fs.writeFileSync(path.join(sup, 'sibling.js'), 'unrelated\nEDITED\n') // dirty sibling must NOT appear
      const sstat = (await ghMod.gitWorkingStat(proj)).files
      if (!sstat.some((s) => s.file === 'src/f.js')) throw new Error('subfolder paths must be PROJECT-relative (src/f.js), got: ' + JSON.stringify(sstat.map((s) => s.file)))
      if (sstat.some((s) => /sibling\.js/.test(s.file))) throw new Error('a dirty SIBLING outside the project must NOT be listed: ' + JSON.stringify(sstat.map((s) => s.file)))
      // gitShowHead with the project-relative path returns the subfolder file's committed content (not a doubled path).
      if ((await ghMod.gitShowHead(proj, 'src/f.js')) !== 'orig\n') throw new Error('gitShowHead must resolve the subfolder file via HEAD:./: ' + JSON.stringify(await ghMod.gitShowHead(proj, 'src/f.js')))
      // gitInfo reports the subfolder as NOT the repo root.
      const info = await ghMod.gitInfo(proj)
      if (!info.isRepo || info.isRepoRoot) throw new Error('a subfolder must be isRepo=true, isRepoRoot=false: ' + JSON.stringify({ isRepo: info.isRepo, isRepoRoot: info.isRepoRoot }))
    } finally {
      fs.rmSync(sup, { recursive: true, force: true })
    }
    // non-repo → [] (never throws).
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-ws-nonrepo-'))
    try {
      const nonRepoStat = await ghMod.gitWorkingStat(nonRepo)
      if (nonRepoStat.files.length || nonRepoStat.total !== 0) throw new Error('non-repo gitWorkingStat must be empty')
      if (!nonRepoStat.exact) throw new Error('an empty non-repo list is honestly EXACT — there is nothing to miscount')
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true })
    }
    return 'workSafety bands/subfolder-warn/non-repo-amber; gitWorkingStat modified/new/deleted/binary-deleted/rename(no-phantom); subfolder project-relative + no sibling; gitShowHead safe; restore reversible'
  })

  await step('git authorship: per-file owners by commit count; non-repo → []; no rename phantom', async () => {
    // REPO_DIR by now: readme.md has init + edit1 + edit2 (3 commits), all author "T";
    // plus oldname.js → newname.js rename from the hotspots test.
    // Add one ALIAS commit — same email t@t, different name "Theodore" — which must
    // DEDUP into the single "T" owner (email-based identity), not a second author.
    fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'hello\nworld\nagain\nalias\n')
    require('node:child_process').execSync(`git -C "${REPO_DIR}" -c user.name=Theodore -c user.email=t@t commit -qam alias`, { shell: '/bin/bash' })
    const own = await ghMod.gitAuthorship(REPO_DIR)
    if (!Array.isArray(own) || own.length === 0) throw new Error('no authorship: ' + JSON.stringify(own))
    const readme = own.find((o) => o.file === 'readme.md')
    if (!readme || readme.authors[0].name !== 'T' || readme.authors[0].commits < 4) throw new Error('readme owner wrong: ' + JSON.stringify(readme))
    if (readme.authors.length !== 1) throw new Error('name aliases under one email were not deduped: ' + JSON.stringify(readme.authors))
    if (readme.authors[0].email !== 't@t') throw new Error('canonical email missing: ' + JSON.stringify(readme.authors[0]))
    if (own.some((o) => /=>|[{}]/.test(o.file))) throw new Error('phantom rename path in authorship: ' + JSON.stringify(own.map((o) => o.file)))
    if (!own.some((o) => o.file === 'newname.js')) throw new Error('renamed-to file not counted under its own path')
    // rollupOwners folds files → directory owners (pure), deduped by EMAIL.
    const roll = ghMod.rollupOwners(own)
    const rootDir = roll.find((m) => m.dir === '.')
    if (!rootDir || rootDir.owners[0].name !== 'T') throw new Error('rollup owner wrong: ' + JSON.stringify(roll))
    if (rootDir.owners.filter((o) => o.email === 't@t').length !== 1) throw new Error('rollup did not dedup one identity across files: ' + JSON.stringify(rootDir.owners))
    // Same NAME, DIFFERENT email = two DIFFERENT people → stay two owners (identity = email).
    fs.writeFileSync(path.join(REPO_DIR, 'shared.js'), 'module.exports = 1\n')
    const xc = require('node:child_process').execSync
    xc(`git -C "${REPO_DIR}" add -A && git -C "${REPO_DIR}" -c user.name=Sam -c user.email=sam@a commit -qm s1`, { shell: '/bin/bash' })
    fs.writeFileSync(path.join(REPO_DIR, 'shared.js'), 'module.exports = 2\n')
    xc(`git -C "${REPO_DIR}" -c user.name=Sam -c user.email=sam@b commit -qam s2`, { shell: '/bin/bash' })
    const shared = (await ghMod.gitAuthorship(REPO_DIR)).find((o) => o.file === 'shared.js')
    if (!shared || shared.authors.length !== 2) throw new Error('same name / different email must stay two owners: ' + JSON.stringify(shared))
    // Scoping: authorship for a SUBFOLDER of a repo returns only that folder's
    // files, PROJECT-relative (no repo-root files, no path prefix).
    const sub = path.join(REPO_DIR, 'pkg')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'inner.js'), 'module.exports = 1\n')
    require('node:child_process').execSync(`git -C "${REPO_DIR}" add -A && git -C "${REPO_DIR}" commit -qm addpkg`, { shell: '/bin/bash' })
    const subOwn = await ghMod.gitAuthorship(sub)
    if (!subOwn.some((o) => o.file === 'inner.js')) throw new Error('subfolder file not project-relative: ' + JSON.stringify(subOwn.map((o) => o.file)))
    if (subOwn.some((o) => o.file === 'readme.md' || o.file.includes('/'))) throw new Error('subfolder authorship leaked repo-root files: ' + JSON.stringify(subOwn.map((o) => o.file)))
    // A dir outside any git repo → [] and never throws.
    const nonRepo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-noauthor-'))
    try {
      if ((await ghMod.gitAuthorship(nonRepo)).length) throw new Error('non-repo should give []')
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true })
    }
    return `readme owner T; subfolder scoped+relativized; rollup ok; non-repo → []`
  })

  await step('crossRepoGraph: owners merged by lowercased email across repos; hotspots repo-qualified; junk skipped', async () => {
    const x = require('node:child_process').execSync
    const r1 = path.join(WORKDIR, 'cr-repo1')
    const r2 = path.join(WORKDIR, 'cr-repo2')
    const r3 = path.join(WORKDIR, 'dup', 'cr-repo1') // SAME basename as r1, different repo
    for (const [dir, email] of [[r1, 'Sam@Example.com'], [r2, 'sam@example.com'], [r3, 'SAM@example.com']]) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
      x(`git init -q -b main "${dir}"`, { shell: '/bin/bash' })
      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = 1\n') // colliding dir 'src' + file across repos
      x(`git -C "${dir}" add -A && git -C "${dir}" -c user.name=Sam -c user.email=${email} commit -qm c1`, { shell: '/bin/bash' })
    }
    const notgit = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cr-notgit-')) // truly outside any repo
    try {
      // Includes a subfolder of r1 (→ dedupes to r1 by git toplevel), a non-git dir, a missing
      // path, and an exact DUPLICATE — those collapse/skip; r3 shares r1's basename but is a
      // DISTINCT repo → 3 aggregate, with the colliding display name disambiguated.
      const graph = await ghMod.crossRepoGraph([r1, r2, r3, path.join(r1, 'src'), notgit, path.join(WORKDIR, 'cr-missing'), r1])
      if (graph.repos.length !== 3) throw new Error('expected 3 aggregated repos (subfolder/dup/non-git/missing skipped, r3 distinct): ' + JSON.stringify(graph.repos))
      if (new Set(graph.repos).size !== 3) throw new Error('same-basename repos must get distinct display names: ' + JSON.stringify(graph.repos))
      if (graph.owners.length !== 1) throw new Error('same person (diff-case email) must merge to ONE owner: ' + JSON.stringify(graph.owners))
      const sam = graph.owners[0]
      if ((sam.email || '').toLowerCase() !== 'sam@example.com' || sam.repos !== 3) throw new Error('Sam should span 3 DISTINCT repos (counted by root, not basename): ' + JSON.stringify(sam))
      if (sam.commits < 3) throw new Error('cross-repo commit weight not summed: ' + JSON.stringify(sam))
      // The identically-named src/app.js in each repo must be REPO-QUALIFIED (3 distinct hotspots).
      const spots = graph.hotspots.filter((h) => /\/src\/app\.js$/.test(h.file))
      if (spots.length !== 3 || new Set(spots.map((h) => h.file)).size !== 3) throw new Error('hotspots not repo-qualified (collision): ' + JSON.stringify(graph.hotspots.map((h) => h.file)))
    } finally {
      fs.rmSync(notgit, { recursive: true, force: true })
    }
    return 'owners merged by lowercased email across 3 repos (same-basename distinct); src/app.js repo-qualified; dup/non-git/missing skipped'
  })

  // ---------- Explorer: file-icon theme + normalised tree model (2026-09-02) ----------
  const fileIcons = require(path.join(WORKDIR, 'shared', 'file-icons.js'))
  const explorer = require(path.join(WORKDIR, 'explorer', 'model.js'))
  const setiTheme = JSON.parse(
    fs.readFileSync(path.join(SRC, 'renderer', 'src', 'assets', 'file-icons', 'seti', 'vs-seti-icon-theme.json'), 'utf8')
  )

  await step('file icons: VS Code matching order — name, multi-dot extension, extension, language, default', () => {
    const { resolveIconId, extensionCandidates, languageIdFor, decodeFontCharacter } = fileIcons
    // Longest-first extension candidates; a dotfile's whole tail is its extension.
    if (extensionCandidates('app.spec.ts').join('|') !== 'spec.ts|ts') throw new Error('multi-dot order: ' + extensionCandidates('app.spec.ts'))
    if (extensionCandidates('.gitignore').join('|') !== 'gitignore') throw new Error('dotfile extension: ' + extensionCandidates('.gitignore'))
    if (extensionCandidates('noext').length !== 0) throw new Error('a name with no dot has no extension')
    if (extensionCandidates('trailing.').length !== 0) throw new Error('a trailing dot is not an extension')

    // A hand-built theme proves the ORDER, independent of what Seti happens to contain.
    const theme = {
      iconDefinitions: { name: {}, qualified: {}, multi: {}, simple: {}, lang: {}, def: {}, folder: {}, folderOpen: {} },
      file: 'def',
      folder: 'folder',
      folderExpanded: 'folderOpen',
      fileNames: { 'index.ts': 'name', 'src/index.ts': 'qualified' },
      fileExtensions: { 'spec.ts': 'multi', ts: 'simple' },
      languageIds: { typescript: 'lang' }
    }
    if (resolveIconId(theme, { name: 'index.ts', parentName: 'src' }) !== 'qualified') throw new Error('parent-qualified filename must win')
    if (resolveIconId(theme, { name: 'index.ts', parentName: 'lib' }) !== 'name') throw new Error('exact filename')
    if (resolveIconId(theme, { name: 'a.spec.ts' }) !== 'multi') throw new Error('multi-dot extension')
    if (resolveIconId(theme, { name: 'a.ts' }) !== 'simple') throw new Error('simple extension')
    if (resolveIconId(theme, { name: 'a.mts' }) !== 'lang') throw new Error('language fallback (mts -> typescript)')
    if (resolveIconId(theme, { name: 'a.unknownzz' }) !== 'def') throw new Error('default fallback')
    // Case-insensitive on every path.
    if (resolveIconId(theme, { name: 'INDEX.TS' }) !== 'name') throw new Error('filename match must be case-insensitive')
    if (resolveIconId(theme, { name: 'A.SPEC.TS' }) !== 'multi') throw new Error('extension match must be case-insensitive')
    if (resolveIconId(theme, { name: 'Index.ts', parentName: 'SRC' }) !== 'qualified') throw new Error('parent match must be case-insensitive')
    // Folders, expanded and not; and a theme with NO folder icon returns null rather than a file icon.
    if (resolveIconId(theme, { name: 'src', isDir: true }) !== 'folder') throw new Error('folder icon')
    if (resolveIconId(theme, { name: 'src', isDir: true, expanded: true }) !== 'folderOpen') throw new Error('expanded folder icon')
    if (resolveIconId({ iconDefinitions: {}, file: 'def' }, { name: 'src', isDir: true }) !== null) throw new Error('a theme with no folder icon must yield null, not the file icon')
    // Light variant overrides only what it declares.
    const dual = { ...theme, light: { fileExtensions: { ts: 'lightSimple' } }, iconDefinitions: { ...theme.iconDefinitions, lightSimple: {} } }
    if (resolveIconId(dual, { name: 'a.ts' }, 'light') !== 'lightSimple') throw new Error('light override')
    if (resolveIconId(dual, { name: 'index.ts' }, 'light') !== 'name') throw new Error('light must fall through to the base for keys it does not declare')

    if (languageIdFor('Dockerfile') !== 'dockerfile' || languageIdFor('docker-compose.yml') !== 'dockercompose') throw new Error('filename languages')
    if (languageIdFor('.env.local') !== 'dotenv') throw new Error('prefix language (.env.local)')
    // The theme writes the escape as text: the JS literal below is a backslash followed by E001,
    // which must decode to the actual PUA character the font draws.
    if (decodeFontCharacter('\\E001') !== '') throw new Error('font character decode')
    if (decodeFontCharacter('\\e001') !== '') throw new Error('lower-case hex escape')
    if (decodeFontCharacter(undefined) !== null) throw new Error('missing font character')
    return 'qualified > name > multi-dot > extension > language > default; case-insensitive; light layering; null for a folder-less theme'
  })

  await step('file icons: the bundled Seti theme resolves the everyday types to their real glyphs', () => {
    const { resolveFileIcon } = fileIcons
    const id = (n) => (resolveFileIcon(setiTheme, { name: n }) || {}).id
    const expect = {
      'app.js': '_javascript', 'app.mjs': '_javascript', 'app.cjs': '_javascript',
      'main.ts': '_typescript', 'App.tsx': '_react', 'App.jsx': '_react', 'types.d.ts': '_typescript',
      'a.spec.js': '_javascript_1', 'a.test.ts': '_typescript_1',
      'package.json': '_json', 'tsconfig.json': '_tsconfig', 'vite.config.ts': '_vite', 'webpack.config.js': '_webpack',
      '.gitignore': '_git', '.npmrc': '_npm_1', 'Dockerfile': '_docker', 'docker-compose.yml': '_docker_3',
      'App.vue': '_vue', 'App.svelte': '_svelte', 'main.py': '_python', 'main.go': '_go2', 'main.rs': '_rust',
      'Main.java': '_java', 'README.md': '_info', 'notes.md': '_markdown', 'style.css': '_css',
      'index.html': '_html_3', 'conf.yaml': '_yml', 'x.toml': '_config', 'logo.png': '_image', 'a.zip': '_zip_1', '.env': '_config'
    }
    for (const [name, want] of Object.entries(expect)) {
      const got = id(name)
      if (got !== want) throw new Error(`${name}: expected ${want}, got ${got}`)
    }
    // A JavaScript file must be the theme's OWN javascript glyph and colour, not a generic page.
    const js = resolveFileIcon(setiTheme, { name: 'server.js' })
    if (js.color !== '#cbcb41' || !js.char) throw new Error('javascript glyph/colour: ' + JSON.stringify(js))
    if (resolveFileIcon(setiTheme, { name: 'x.unknownzz' }).id !== '_default') throw new Error('unknown extension falls back to the default file icon')
    // Seti genuinely has no folder icons — VS Code draws only the twisty, and so must we.
    if (resolveFileIcon(setiTheme, { name: 'src', isDir: true }) !== null) throw new Error('Seti must yield no folder icon')
    return `${Object.keys(expect).length} everyday types map to their real Seti glyphs; JS is #cbcb41`
  })

  await step('file icons: an imported theme is DATA — traversal, URLs and executable keys are refused', () => {
    const { validateIconTheme } = fileIcons
    const ok = validateIconTheme({ iconDefinitions: { a: { iconPath: 'icons/a.svg' } }, fonts: [{ src: [{ path: './f.woff', format: 'woff' }] }] })
    if (!ok.ok || ok.assets.length !== 2) throw new Error('a well-formed theme must pass: ' + JSON.stringify(ok))
    const bad = [
      [{ iconDefinitions: { a: { iconPath: '../../etc/passwd.svg' } } }, 'traversal'],
      [{ iconDefinitions: { a: { iconPath: '/etc/passwd.svg' } } }, 'absolute path'],
      [{ iconDefinitions: { a: { iconPath: 'https://evil.example/a.svg' } } }, 'remote URL'],
      [{ iconDefinitions: { a: { iconPath: 'data:image/svg+xml;base64,AAA' } } }, 'data URL'],
      [{ iconDefinitions: { a: { iconPath: 'a.exe' } } }, 'non-asset extension'],
      [{ iconDefinitions: { a: {} }, main: './extension.js' }, 'executable entry point'],
      [{ iconDefinitions: { a: {} }, contributes: {} }, 'contribution point'],
      [{ iconDefinitions: { a: {} }, activationEvents: ['*'] }, 'activation events'],
      [{ iconDefinitions: { a: { fontCharacter: 42 } } }, 'non-string fontCharacter'],
      [{ nope: 1 }, 'no iconDefinitions'],
      ['not an object', 'not an object'],
      [{ iconDefinitions: { a: {} }, fonts: [{ src: [{ path: '../x.woff' }] }] }, 'font traversal']
    ]
    for (const [theme, why] of bad) {
      const res = validateIconTheme(theme)
      if (res.ok) throw new Error(`accepted a theme it should refuse (${why})`)
      if (!res.error) throw new Error(`refused "${why}" with no reason`)
    }
    if (validateIconTheme({ iconDefinitions: { a: { iconPath: 'a.svg' } } }, 0).ok) throw new Error('asset-count limit not enforced')
    return `${bad.length} malformed/hostile themes refused with a reason each; a valid one passes with its assets listed`
  })

  await step('explorer model: flatten, compact folders, sorting, and lazy depth', () => {
    const { flatten, sortEntries } = explorer
    const d = (path, isDir, extra) => Object.assign({ name: path.split('/').pop(), path, isDir }, extra || {})
    // Folders first, then case-insensitive natural order.
    const sorted = sortEntries([d('b.ts', false), d('A', true), d('a.ts', false), d('file10', false), d('file2', false), d('B', true)]).map((e) => e.name)
    if (sorted.join('|') !== 'A|B|a.ts|b.ts|file2|file10') throw new Error('sort: ' + sorted.join('|'))
    if (sortEntries([d('B', true), d('a.ts', false)], 'name').map((e) => e.name).join('|') !== 'a.ts|B') throw new Error('sort=name must not group folders first')

    // Only EXPANDED, LOADED folders contribute rows: this is what makes the cost proportional to
    // what is on screen rather than to the repository.
    const children = new Map([
      ['', [d('src', true), d('readme.md', false)]],
      ['src', [d('src/app.ts', false)]]
    ])
    let rows = flatten({ children, expanded: new Set(), loading: new Set() })
    if (rows.map((r) => r.label).join('|') !== 'src|readme.md') throw new Error('collapsed tree must show only the root: ' + rows.map((r) => r.label))
    rows = flatten({ children, expanded: new Set(['src']), loading: new Set() })
    if (rows.map((r) => r.label).join('|') !== 'src|app.ts|readme.md') throw new Error('expanded: ' + rows.map((r) => r.label))
    if (rows[1].depth !== 1 || rows[1].parentName !== 'src') throw new Error('child depth/parentName: ' + JSON.stringify(rows[1]))

    // Compact folders: a single-child chain of folders becomes ONE row whose path is the tail.
    const chain = new Map([
      ['', [d('com', true)]],
      ['com', [d('com/example', true)]],
      ['com/example', [d('com/example/app', true)]],
      ['com/example/app', [d('com/example/app/Main.java', false)]]
    ])
    const exp = new Set(['com', 'com/example', 'com/example/app'])
    const compact = flatten({ children: chain, expanded: exp, loading: new Set() })
    if (compact[0].label !== 'com/example/app' || compact[0].path !== 'com/example/app') throw new Error('compact chain: ' + JSON.stringify(compact[0]))
    if (compact[0].segments.length !== 3) throw new Error('each segment must stay clickable')
    if (compact[1].label !== 'Main.java' || compact[1].depth !== 1) throw new Error('chain child depth')
    const loose = flatten({ children: chain, expanded: exp, loading: new Set() }, { compactFolders: false })
    if (loose[0].label !== 'com' || loose.length !== 4) throw new Error('compactFolders:false must draw every level: ' + loose.map((r) => r.label))
    // A chain never walks through a SYMLINK — that is how a compactor enters a loop.
    const linked = new Map([['', [d('a', true)]], ['a', [d('a/b', true, { isSymlink: true })]]])
    const lrows = flatten({ children: linked, expanded: new Set(['a', 'a/b']), loading: new Set() })
    if (lrows[0].label !== 'a') throw new Error('a symlinked child must not be absorbed into its parent row')
    return 'folders-first natural sort; only expanded+loaded folders project rows; compact chains, off-switch, and symlink stop'
  })

  await step('explorer model: expansion, targeted invalidation, reveal and type-ahead', () => {
    const { toggleExpanded, collapseAll, invalidate, foldersToInvalidate, ancestorsOf, typeAheadTarget, flatten } = explorer
    let exp = toggleExpanded(new Set(), 'src')
    if (!exp.has('src')) throw new Error('expand')
    if (toggleExpanded(exp, 'src').has('src')) throw new Error('collapse')
    if (!toggleExpanded(exp, 'src', true).has('src')) throw new Error('explicit open must be idempotent')

    // Collapse All must NOT drop cached listings — reopening a folder afterwards has to be instant.
    const cached = new Map([['', []], ['src', []]])
    if (collapseAll().size !== 0) throw new Error('collapseAll')
    if (cached.size !== 2) throw new Error('collapseAll must not touch the listing cache')

    // A change invalidates only its own folder.
    if (foldersToInvalidate(['src/app.ts']).join('|') !== 'src') throw new Error('one file invalidates its parent only')
    if (foldersToInvalidate(['a.txt']).join('|') !== '') throw new Error('a root file invalidates the root')
    if (foldersToInvalidate(['src/a.ts', 'src/b.ts', 'lib/c.ts']).sort().join('|') !== 'lib|src') throw new Error('coalesced per folder')
    if (foldersToInvalidate(['src/a.ts', '']).join('|') !== '') throw new Error('an unnamed change must invalidate the whole tree')
    const after = invalidate(new Map([['', 1], ['src', 2], ['lib', 3]]), ['src'])
    if (after.has('src') || !after.has('lib') || !after.has('')) throw new Error('invalidate must be targeted: ' + [...after.keys()])

    if (ancestorsOf('a/b/c/d.ts').join('|') !== 'a|a/b|a/b/c') throw new Error('ancestors: ' + ancestorsOf('a/b/c/d.ts'))
    if (ancestorsOf('top.ts').length !== 0) throw new Error('a root file has no ancestors')

    const rows = flatten({ children: new Map([['', [
      { name: 'alpha.ts', path: 'alpha.ts', isDir: false },
      { name: 'beta.ts', path: 'beta.ts', isDir: false },
      { name: 'Bravo.ts', path: 'Bravo.ts', isDir: false }
    ]]]), expanded: new Set(), loading: new Set() })
    // Search starts AFTER the current row and wraps, so a repeated letter cycles.
    if (typeAheadTarget(rows, -1, 'b') !== 1) throw new Error('type-ahead first match')
    if (typeAheadTarget(rows, 1, 'b') !== 2) throw new Error('type-ahead must advance to the next match')
    if (typeAheadTarget(rows, 2, 'b') !== 1) throw new Error('type-ahead must wrap')
    if (typeAheadTarget(rows, 0, 'zz') !== -1) throw new Error('no match')
    if (typeAheadTarget([], 0, 'a') !== -1) throw new Error('empty list')
    return 'expansion toggles; Collapse All keeps the cache; invalidation is per-folder and coalesced; ancestors + wrapping type-ahead'
  })

  await step('explorer model: a 20,000-file folder stays a windowed projection', () => {
    const { flatten } = explorer
    const { windowRange } = gitView
    const big = Array.from({ length: 20000 }, (_, i) => ({ name: `f${i}.ts`, path: `big/f${i}.ts`, isDir: false }))
    const children = new Map([['', [{ name: 'big', path: 'big', isDir: true }]], ['big', big]])
    const t0 = Date.now()
    const rows = flatten({ children, expanded: new Set(['big']), loading: new Set() })
    const ms = Date.now() - t0
    if (rows.length !== 20001) throw new Error('rows: ' + rows.length)
    // The projection is a list; what MOUNTS is the window over it.
    const r = windowRange(0, 800, 22, rows.length)
    if (r.end - r.start > 60) throw new Error(`${r.end - r.start} rows would mount for an 800px viewport`)
    if (r.padBottom !== (rows.length - r.end) * 22) throw new Error('spacer must account for every unrendered row')
    return `20,001 rows projected in ${ms}ms; ${r.end - r.start} would mount at 800px`
  })

  // ---------- Local Git Power step 1: the execution + validation spine ----------
  const gitref = require(path.join(WORKDIR, 'shared', 'gitref.js'))

  await step('gitref: a ref that is shaped like an option is refused, not quoted', () => {
    // Argument injection. An argv array makes these shell-SAFE and leaves them option-SHAPED, which
    // is the whole reason this validator exists alongside gitArgv rather than instead of it.
    const attacks = [
      '--upload-pack=/bin/sh', '--exec=id', '-o/tmp/pwned', '-f', '--output=/tmp/x',
      '--', '-', '--all'
    ]
    for (const a of attacks) if (gitref.validRef(a)) throw new Error(`accepted option-shaped ref ${JSON.stringify(a)}`)

    // Shell metacharacters and traversal/range syntax.
    const bad = [
      'HEAD; rm -rf /', 'main && id', 'a`id`b', 'a$(id)b', 'main|tee', 'x>y', 'a b',
      'main..feature', 'main...feature', 'HEAD@{1}', 'refs/heads/x.lock', 'ref~1', 'ref^2',
      'a:b', 'a\\b', 'a?b', 'a*b', 'a[b', 'has\nnewline', 'has\ttab', 'nul\u0000here',
      '/leading', 'trailing/', 'double//slash', '.hidden', 'ends.', 'refs/.x/y', '', 'x'.repeat(257)
    ]
    for (const b of bad) if (gitref.validRef(b)) throw new Error(`accepted bad ref ${JSON.stringify(b)}`)

    // ...while everything a real user actually types still works. A validator that refuses ordinary
    // names gets worked around, and a worked-around validator protects nothing.
    const good = [
      'main', 'HEAD', 'feature/my-branch', 'release/v1.2.3', 'fix_thing', 'v1.0.0',
      'a1b2c3d', '0f7c1e2d9a4b6c8e0f1a2b3c4d5e6f7a8b9c0d1e', 'refs/heads/main', 'my-branch'
    ]
    for (const g of good) if (!gitref.validRef(g)) throw new Error(`refused legitimate ref ${JSON.stringify(g)}`)
    return `${attacks.length} option-shaped and ${bad.length} malformed refs refused, ${good.length} real ones accepted`
  })

  await step('gitref: paths cannot escape the project or pose as flags', () => {
    const bad = [
      '../../etc/passwd', '..\\..\\windows\\system32', 'a/../../b', '/absolute/path', '/etc/passwd',
      '\\\\server\\share', 'C:\\Windows\\system32', 'c:/windows', '-rf', '--exclude=x',
      'has\u0000nul', 'has\nnewline', '', 'x'.repeat(401)
    ]
    for (const b of bad) if (gitref.validRepoPath(b)) throw new Error(`accepted bad path ${JSON.stringify(b)}`)

    // `..` as a SUBSTRING is fine — only as a whole component is it traversal. A file really can be
    // called `my..file.txt`, and refusing it would be a bug with no workaround.
    const good = ['src/main.tsx', 'a/b/c.ts', 'my..file.txt', 'name with spaces.md', 'dir/.hidden', 'x.test.ts']
    for (const g of good) if (!gitref.validRepoPath(g)) throw new Error(`refused legitimate path ${JSON.stringify(g)}`)
    return `${bad.length} traversal/absolute/flag paths refused, ${good.length} ordinary ones accepted`
  })

  await step('gitref: safeArg strips NUL, trims and caps, and keeps text a user legitimately typed', () => {
    if (gitref.safeArg('nul\u0000byte') !== 'nulbyte') throw new Error('NUL not stripped')
    if (gitref.safeArg('  padded  ') !== 'padded') throw new Error('not trimmed')
    if (gitref.safeArg('   ') !== null) throw new Error('whitespace-only must be null')
    if (gitref.safeArg('') !== null) throw new Error('empty must be null')
    if (gitref.safeArg(undefined) !== null) throw new Error('non-string must be null')
    if (gitref.safeArg('x'.repeat(2000)).length !== 1000) throw new Error('not capped at 1000')
    // A leading dash is KEPT on purpose: "-1 regression" is a real stash message. Safety comes from
    // the caller passing it as the value half of --flag=value, never as a bare positional.
    if (gitref.safeArg('-1 regression') !== '-1 regression') throw new Error('leading dash must survive')
    return 'NUL stripped, trimmed, capped at 1000, leading dash preserved deliberately'
  })

  await step('gitArgv: a filename full of shell metacharacters is data, not a command', async () => {
    const { spawnSync } = require('node:child_process')
    const repo = path.join(WORKDIR, 'argv-repo')
    fs.mkdirSync(repo, { recursive: true })
    const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')

    // A filename that a shell would EXECUTE part of. Legal on disk; poison in a command string.
    const evil = 'a $(touch pwned) `touch pwned2` ;touch pwned3.txt'
    fs.writeFileSync(path.join(repo, evil), 'hello\n')
    fs.writeFileSync(path.join(repo, 'ordinary.txt'), 'plain\n')
    g('add', '-A')
    g('commit', '-qm', 'add both files')

    const gitExec = require(path.join(WORKDIR, 'main', 'git-exec.js'))
    // The path goes after `--`, exactly as gitref's contract requires.
    const res = await gitExec.gitArgv(repo, ['log', '--format=%s', '--', evil])
    if (res.code !== 0) throw new Error(`gitArgv failed: code ${res.code}`)
    if (!res.output.includes('add both files')) throw new Error(`git did not see the file as a path: ${JSON.stringify(res.output)}`)

    // The real assertion: nothing in that filename ran. With a shell runner, all three would exist.
    for (const artefact of ['pwned', 'pwned2', 'pwned3.txt']) {
      if (fs.existsSync(path.join(repo, artefact))) throw new Error(`shell executed the filename — ${artefact} was created`)
    }

    // And `--` genuinely separates: a path that looks like a flag stays a path.
    const dashName = '-f.txt'
    fs.writeFileSync(path.join(repo, dashName), 'dash\n')
    g('add', '-A')
    g('commit', '-qm', 'add dash file')
    const dash = await gitExec.gitArgv(repo, ['log', '--format=%s', '--', dashName])
    if (dash.code !== 0 || !dash.output.includes('add dash file')) {
      throw new Error(`a file named ${dashName} was not treated as a path: code ${dash.code} ${JSON.stringify(dash.output)}`)
    }
    return 'command substitution in a filename never executed; `--` kept a flag-shaped name a path'
  })

  await step('gitlog: a body with newlines, a root commit and a merge all survive the parser', () => {
    const gitlog = require(path.join(WORKDIR, 'shared', 'gitlog.js'))
    const R = gitlog.REC, F = gitlog.FIELD
    const rec = (f) => R + f.join(F)
    const raw = [
      // An ordinary commit whose BODY has blank lines and a bullet list. This is the case the old
      // line-splitting reader could not represent at all, which is why it carried no body.
      rec(['a'.repeat(40), 'aaaaaaa', 'b'.repeat(40) + ' ' + 'c'.repeat(40), 'Ada', 'ada@x.dev', '1757000000',
           'HEAD -> main, origin/main, tag: v1.0', 'a merge', 'line one\n\n- bullet\n- another\n']),
      // Root commit: no parents at all.
      rec(['d'.repeat(40), 'ddddddd', '', 'Bo', 'bo@x.dev', '1756000000', '', 'first commit', '']),
      // A body containing the FIELD separator itself — re-joined, not truncated at it.
      rec(['e'.repeat(40), 'eeeeeee', 'd'.repeat(40), 'Cy', 'cy@x.dev', '1756500000', '', 'weird', 'before' + F + 'after']),
      // A malformed record (hash is not an object id) is dropped rather than emitted unaddressable.
      rec(['not-a-hash', 'zzz', '', 'Dee', 'dee@x.dev', '1756000000', '', 'bad', ''])
    ].join('')

    const commits = gitlog.parseGitLog(raw)
    if (commits.length !== 3) throw new Error(`expected 3 commits, got ${commits.length}`)

    const [merge, root, weird] = commits
    if (merge.parents.length !== 2) throw new Error('merge must keep both parents')
    if (merge.body !== 'line one\n\n- bullet\n- another') throw new Error(`body mangled: ${JSON.stringify(merge.body)}`)
    if (merge.ts !== 1757000000 * 1000) throw new Error('timestamp must be epoch ms')
    if (merge.short !== 'aaaaaaa' || merge.hash.length !== 40) throw new Error('short is for display, hash addresses')
    if (merge.refs.length !== 3 || merge.refs[2] !== 'tag: v1.0') throw new Error(`refs: ${JSON.stringify(merge.refs)}`)
    if (root.parents.length !== 0) throw new Error('a root commit has no parents')
    if (weird.body !== 'before' + F + 'after') throw new Error('a body containing the separator must survive')
    return '3 records parsed (merge, root, separator-in-body); 1 malformed record dropped'
  })

  await step('gitLog: pages a real history, never over-reports the last page, and follows a rename', async () => {
    const { spawnSync } = require('node:child_process')
    const repo = path.join(WORKDIR, 'log-repo')
    fs.mkdirSync(repo, { recursive: true })
    const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(path.join(repo, 'f.txt'), `v${i}\n`)
      g('add', '-A')
      g('commit', '-qm', `commit ${i}`)
    }

    const gh = require(path.join(WORKDIR, 'main', 'git-history.js'))
    const p1 = await gh.gitLog(repo, { limit: 3 })
    if (p1.commits.length !== 3) throw new Error(`page 1: ${p1.commits.length}`)
    if (p1.nextSkip !== 3) throw new Error(`page 1 cursor: ${p1.nextSkip}`)
    if (p1.commits[0].subject !== 'commit 7') throw new Error('newest must come first')

    const p2 = await gh.gitLog(repo, { skip: p1.nextSkip, limit: 3 })
    if (p2.commits.length !== 3 || p2.nextSkip !== 6) throw new Error(`page 2: ${p2.commits.length}/${p2.nextSkip}`)

    // The LAST page must report no cursor. Getting this wrong is how a "Load more" row survives past
    // the end of a history and hands the user an empty page.
    const p3 = await gh.gitLog(repo, { skip: p2.nextSkip, limit: 3 })
    if (p3.commits.length !== 1) throw new Error(`page 3: ${p3.commits.length}`)
    if (p3.nextSkip !== null) throw new Error('the last page must not offer another')

    // No page may repeat a commit — the panel dedupes, but it should not have to.
    const seen = new Set([...p1.commits, ...p2.commits, ...p3.commits].map((c) => c.hash))
    if (seen.size !== 7) throw new Error(`pages overlapped: ${seen.size} unique of 7`)

    // Search is LITERAL: a regex metacharacter matches nothing rather than being interpreted.
    const found = await gh.gitLog(repo, { grep: 'commit 4' })
    if (found.commits.length !== 1) throw new Error(`grep: ${found.commits.length}`)
    const literal = await gh.gitLog(repo, { grep: 'commit .' })
    if (literal.commits.length !== 0) throw new Error('grep must be fixed-string, not a regex')

    // A ref shaped like an option is dropped, not passed to git.
    const injected = await gh.gitLog(repo, { refs: ['--all', '-o/tmp/pwned'], limit: 3 })
    if (injected.commits.length !== 3) throw new Error('option-shaped refs must be dropped, not executed')
    if (fs.existsSync('/tmp/pwned')) throw new Error('an option-shaped ref reached git')

    // File history follows a rename.
    g('mv', 'f.txt', 'renamed.txt')
    g('commit', '-qm', 'rename it')
    const hist = await gh.gitLog(repo, { path: 'renamed.txt', limit: 20 })
    if (hist.commits.length < 8) throw new Error(`--follow did not cross the rename: ${hist.commits.length}`)
    return '3 pages with an exact final cursor, no overlap, literal grep, refs sanitised, rename followed'
  })

  // ---------- Source Control (2026-09-02): one-process status, exact diffs, coordination ----------
  const porcelain = require(path.join(WORKDIR, 'shared', 'git-porcelain.js'))
  const unidiff = require(path.join(WORKDIR, 'shared', 'unidiff.js'))
  const coordMod = require(path.join(WORKDIR, 'gitpanel', 'coordinator.js'))
  const watcherMod = require(path.join(WORKDIR, 'main', 'watcher.js'))

  await step('porcelain v2: renames, unmerged, untracked, NUL-safe paths and the branch header', () => {
    const NUL = '\0'
    const raw = [
      '# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 h1 h2 src/a.ts',
      '1 .M N... 100644 100644 100644 h1 h2 src/b.ts',
      '1 MM N... 100644 100644 100644 h1 h2 src/c.ts',
      '2 R. N... 100644 100644 100644 h1 h2 R100 new name.ts', 'old name.ts',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conf.txt',
      '? untracked  with  spaces.txt',
      '? weird\nname.txt',
      '?  leading-space.txt',
      '! ignored.txt'
    ].join(NUL) + NUL
    const st = porcelain.parsePorcelainV2(raw, '')
    if (st.branch !== 'main' || st.upstream !== 'origin/main' || st.ahead !== 2 || st.behind !== 1) throw new Error('branch header: ' + JSON.stringify(st))
    if (st.detached || st.initial || st.headOid !== 'abc123') throw new Error('head flags: ' + JSON.stringify(st))
    const by = (f) => st.changes.find((c) => c.file === f)
    if (!by('src/a.ts') || by('src/a.ts').x !== 'M' || by('src/a.ts').y !== ' ') throw new Error('staged-only row: ' + JSON.stringify(by('src/a.ts')))
    if (!by('src/b.ts') || by('src/b.ts').x !== ' ' || by('src/b.ts').y !== 'M') throw new Error('unstaged-only row: ' + JSON.stringify(by('src/b.ts')))
    if (!by('src/c.ts') || by('src/c.ts').x !== 'M' || by('src/c.ts').y !== 'M') throw new Error('MM row lost a column')
    const rn = by('new name.ts')
    if (!rn || rn.orig !== 'old name.ts' || rn.x !== 'R') throw new Error('rename must carry its original path from the NUL-separated field: ' + JSON.stringify(rn))
    if (!by('conf.txt') || !by('conf.txt').unmerged || !st.conflicts.includes('conf.txt')) throw new Error('unmerged row not flagged')
    if (!by('untracked  with  spaces.txt')) throw new Error('double spaces inside a path were collapsed')
    if (!by('weird\nname.txt')) throw new Error('a newline inside a filename must survive -z parsing')
    if (!by(' leading-space.txt')) throw new Error('a leading space was trimmed off a filename')
    if (!by('ignored.txt') || by('ignored.txt').x !== '!') throw new Error('ignored row')
    if (st.repoTotal !== 9 || st.outsideStaged !== 0) throw new Error(`totals: ${st.repoTotal}/${st.outsideStaged}`)
    // Special head states.
    const det = porcelain.parsePorcelainV2('# branch.oid deadbeef\0# branch.head (detached)\0', '')
    if (!det.detached || det.branch !== '') throw new Error('detached HEAD not detected')
    const init = porcelain.parsePorcelainV2('# branch.oid (initial)\0# branch.head main\0? a.txt\0', '')
    if (!init.initial || init.branch !== 'main' || init.changes.length !== 1) throw new Error('initial repo not detected')
    // A subfolder project: rows outside the prefix are counted, not listed; inside rows are stripped.
    const sub = porcelain.parsePorcelainV2(['1 M. N... 100644 100644 100644 h h sub/x.ts', '1 A. N... 100644 100644 100644 h h other/y.ts', '1 .M N... 100644 100644 100644 h h other/z.ts', '? sub/deep/n.txt'].join('\0') + '\0', 'sub/')
    if (sub.changes.map((c) => c.file).join('|') !== 'x.ts|deep/n.txt') throw new Error('prefix stripping: ' + JSON.stringify(sub.changes.map((c) => c.file)))
    if (sub.outsideStaged !== 1) throw new Error(`staged rows outside the folder must be counted (commit includes them): ${sub.outsideStaged}`)
    if (sub.repoTotal !== 4) throw new Error('repoTotal')
    // Malformed record: never guess a path.
    const bad = porcelain.parsePorcelainV2('1 M.\0', '')
    if (bad.changes.length !== 0) throw new Error('a malformed record produced a row')
    return 'staged/unstaged/MM/rename(orig)/unmerged/untracked/ignored; spaces, newline, leading space kept; detached + initial; subfolder scoping'
  })

  await step('unified diff parser: hunks, the "--- " content trap, binary, truncation', () => {
    const text = [
      'diff --git a/f.txt b/f.txt', 'index 1..2 100644', '--- a/f.txt', '+++ b/f.txt',
      '@@ -1,4 +1,4 @@', ' keep', '-- dashes', '--- three', '+plus', '+++ three plus', ' end', '\\ No newline at end of file'
    ].join('\n')
    const d = unidiff.parseUnifiedDiff(text)
    const kinds = d.lines.map((l) => l.kind + ':' + l.text).join('|')
    if (!kinds.startsWith('fold:@@ -1,4 +1,4 @@|ctx:keep|del:- dashes|del:-- three|add:plus|add:++ three plus|ctx:end|fold:(no newline')) throw new Error('parsed wrong: ' + kinds)
    if (d.added !== 2 || d.removed !== 2 || d.binary || d.truncated) throw new Error('counts: ' + JSON.stringify({ a: d.added, r: d.removed, b: d.binary, t: d.truncated }))
    const bin = unidiff.parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')
    if (!bin.binary || bin.lines.length) throw new Error('binary not detected')
    const big = unidiff.parseUnifiedDiff('@@ -1,10 +1,10 @@\n' + Array.from({ length: 10 }, (_, i) => ' l' + i).join('\n'), 5)
    if (!big.truncated || big.lines.length !== 5) throw new Error('truncation keeps the head: ' + big.lines.length)
    return 'a deleted line beginning with "-- " is content, not a header; binary + truncation flagged'
  })

  await step('refresh coordinator: debounce coalesces a burst, one in flight, stale results dropped', async () => {
    // Fake clock: timers fire only when the test says so, so the assertions are exact.
    let now = 0
    const timers = new Map()
    let tid = 0
    const fake = {
      set: (fn, ms) => { const id = ++tid; timers.set(id, { at: now + ms, fn }); return id },
      clear: (id) => timers.delete(id),
      now: () => now
    }
    const tick = (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() } }
    const applied = []
    let resolvers = []
    const fetch = () => new Promise((res) => resolvers.push(res))
    const c = new coordMod.RefreshCoordinator(fetch, (v) => applied.push(v), 100, fake)
    // Three watcher bursts inside the window → ONE run.
    c.request(); c.request(); c.request()
    if (c.stats.runs !== 0 || c.stats.coalesced !== 2) throw new Error('debounce: ' + JSON.stringify(c.stats))
    tick(100)
    if (c.stats.runs !== 1 || !c.stats.inFlight) throw new Error('one run after the window: ' + JSON.stringify(c.stats))
    // A request while in flight is coalesced into a single trailing run.
    c.request(true); c.request(true)
    if (c.stats.runs !== 1) throw new Error('a second run started while one was in flight')
    resolvers.shift()('first'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0))
    if (applied.join() !== 'first') throw new Error('first result not applied: ' + applied)
    if (c.stats.runs !== 2 || !c.stats.inFlight) throw new Error('trailing run missing: ' + JSON.stringify(c.stats))
    // Invalidate (project switched) before the trailing run resolves → its result is DROPPED.
    c.invalidate()
    resolvers.shift()('stale'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0))
    if (applied.includes('stale')) throw new Error('a result from before invalidate() was applied')
    if (c.stats.dropped !== 1) throw new Error('drop not counted: ' + JSON.stringify(c.stats))
    // Immediate bypasses the debounce entirely.
    c.request(true)
    if (c.stats.runs !== 3) throw new Error('immediate did not run at once')
    resolvers.shift()('fresh'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0))
    if (applied.join() !== 'first,fresh') throw new Error('final: ' + applied)
    // After dispose nothing runs and nothing applies.
    c.dispose(); c.request(true)
    if (c.stats.runs !== 3) throw new Error('ran after dispose')
    return '3 requests → 1 run; in-flight requests → 1 trailing run; invalidated result dropped; immediate + dispose honoured'
  })

  await step('git view: windowing, section list model, keyboard selection rules', () => {
    const { buildItems, windowRange, selectByClick, moveFocus, actionTargets, reconcileSelection, commitBlocker, deriveGitView, EMPTY_SELECTION } = gitView
    const big = Array.from({ length: 1000 }, (_, i) => ({ status: 'M', x: ' ', y: 'M', file: `src/f${i}.ts` }))
    const snap = { isRepo: true, isRepoRoot: true, isIgnored: false, branch: 'main', detached: false, initial: false, headOid: 'x', upstream: null, ahead: 0, behind: 0, merging: false, rebasing: false,
      changes: [{ status: 'M', x: 'M', y: ' ', file: 's.ts' }, { status: 'MM', x: 'M', y: 'M', file: 'both.ts' }, ...big], total: 1002, truncated: false, outsideStaged: 0, conflicts: [], perf: { processes: 1, ms: 1 } }
    const view = deriveGitView(snap)
    if (view.staged.length !== 2 || view.unstaged.length !== 1001) throw new Error(`split ${view.staged.length}/${view.unstaged.length}`)
    const items = buildItems(view, { staged: false, unstaged: false, conflicts: false, history: true }, { loaded: false, loading: false, commits: [], openCommit: null, commitFiles: {} })
    const sections = items.filter((i) => i.kind === 'section').map((i) => i.id).join(',')
    if (sections !== 'staged,unstaged,history') throw new Error('section order: ' + sections)
    // 300px panel, 22px rows: a handful of rows mounted out of a thousand.
    const r = windowRange(0, 300, 22, items.length)
    if (r.end - r.start > 60) throw new Error(`too many rows mounted for 300px: ${r.end - r.start}`)
    const mid = windowRange(11000, 300, 22, items.length)
    if (mid.start > 500 || mid.end < 500 + 14 || mid.padTop !== mid.start * 22) throw new Error('mid-scroll window wrong: ' + JSON.stringify(mid))
    const tail = windowRange(1e9, 300, 22, items.length)
    if (tail.end !== items.length || tail.padBottom !== 0) throw new Error('tail window must clamp: ' + JSON.stringify(tail))
    // Shift-click from a staged row across the "Changes" header selects ROWS only.
    let sel = selectByClick(items, EMPTY_SELECTION, 1, {})
    sel = selectByClick(items, sel, 5, { shift: true })
    if (sel.selected.size !== 4 || [...sel.selected].some((k) => k.startsWith('section'))) throw new Error('shift range: ' + [...sel.selected])
    // ⌘-click toggles one row in and out.
    const t1 = selectByClick(items, sel, 6, { toggle: true })
    if (t1.selected.size !== 5) throw new Error('toggle in')
    if (selectByClick(items, t1, 6, { toggle: true }).selected.size !== 4) throw new Error('toggle out')
    // Arrow without shift selects the focused row alone; Space acts on the focused row's list only.
    const m = moveFocus(items, t1, 4, false)
    if (m.selected.size !== 1 || m.focusKey !== items[4].key) throw new Error('arrow selects the focused row')
    const targets = actionTargets(items, t1, 'unstaged')
    if (targets.length !== 3 || targets.some((row) => row.file === 's.ts')) throw new Error('targets must stay in one list: ' + JSON.stringify(targets))
    // A row that left the list leaves the selection; focus falls back to null, not a neighbour.
    const gone = reconcileSelection(items.filter((i) => i.key !== items[4].key), { focusKey: items[4].key, anchorKey: items[4].key, selected: new Set([items[4].key, items[5].key]) })
    if (gone.focusKey !== null || gone.selected.size !== 1) throw new Error('reconcile: ' + JSON.stringify({ f: gone.focusKey, n: gone.selected.size }))
    // Commit blockers say WHY.
    if (!/Nothing staged/.test(commitBlocker({ ...view, staged: [], outsideStaged: 0 }, 'msg', false))) throw new Error('empty index reason')
    if (!/message/.test(commitBlocker(view, '  ', false))) throw new Error('empty message reason')
    if (commitBlocker(view, 'fix', false) !== null) throw new Error('should be committable')
    if (!/conflict/.test(commitBlocker({ ...view, conflicts: ['a'] }, 'fix', false))) throw new Error('conflict reason')
    return `1002 changes → ${r.end - r.start} rows mounted at 300px; shift range skips headers; targets stay per-list`
  })

  await step('watcher: which .git entries matter', () => {
    const rel = watcherMod.isGitMetaRelevant
    for (const noise of ['objects/ab/cdef', 'index.lock', 'refs/heads/main.lock', 'lfs/x', 'hooks/pre-commit']) if (rel(noise)) throw new Error('noise treated as a signal: ' + noise)
    for (const sig of ['index', 'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'FETCH_HEAD', 'packed-refs', 'refs/heads/main', 'refs/remotes/origin/main', 'logs/HEAD', 'config', 'rebase-merge/head-name', '']) if (!rel(sig)) throw new Error('signal dropped: ' + sig)
    return 'objects/, *.lock and hooks ignored; index/HEAD/refs/merge state fire'
  })

  await step('gitSnapshot: one process, and every repository state the panel must read correctly', async () => {
    const { execSync: x } = require('node:child_process')
    const q = { shell: '/bin/bash' }
    const os = require('node:os')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-scm-'))
    const R = path.join(root, 'repo')
    const O = path.join(root, 'origin.git')
    const procs = () => ghMod.gitProcessCount()
    const counted = async (fn) => { const before = procs(); const v = await fn(); return [v, procs() - before] }
    const notes = []
    try {
      // A directory that is not a repo: one process says so.
      const [none, nProc] = await counted(() => ghMod.gitSnapshot(root))
      if (none.isRepo || nProc !== 1) throw new Error(`non-repo: isRepo=${none.isRepo} processes=${nProc}`)

      // --- initial repo, no HEAD ---
      x(`git init -q -b main "${R}" && git -C "${R}" config user.email t@t && git -C "${R}" config user.name T`, q)
      fs.writeFileSync(path.join(R, 'a.js'), 'one\ntwo\n')
      const [init, iProc] = await counted(() => ghMod.gitSnapshot(R))
      if (!init.isRepo || !init.initial || init.branch !== 'main' || init.changes.length !== 1 || init.changes[0].x !== '?') throw new Error('initial: ' + JSON.stringify(init))
      if (iProc > 3) throw new Error(`initial snapshot cost ${iProc} processes`)
      await ghMod.gitStage(R, ['a.js'])
      const staged0 = await ghMod.gitSnapshot(R)
      if (staged0.changes[0].x !== 'A') throw new Error('staged in an initial repo: ' + JSON.stringify(staged0.changes))
      const un = await ghMod.gitUnstage(R, ['a.js']) // no HEAD → rm --cached path
      if (!un.ok || (await ghMod.gitSnapshot(R)).changes[0].x !== '?') throw new Error('unstage without HEAD')
      await ghMod.gitStage(R, ['a.js'])
      x(`git -C "${R}" commit -qm init`, q)

      // --- clean repo: status + check-ignore, nothing else ---
      const [clean, cProc] = await counted(() => ghMod.gitSnapshot(R))
      if (!clean.isRepo || clean.changes.length !== 0 || clean.initial || clean.isIgnored || clean.merging) throw new Error('clean: ' + JSON.stringify(clean))
      if (cProc > 2) throw new Error(`clean snapshot cost ${cProc} processes (status + check-ignore expected)`)
      if (clean.perf.processes !== cProc) throw new Error('perf.processes disagrees with the real count')
      if (clean.upstream !== null || clean.ahead !== 0) throw new Error('no upstream must read as null/0')
      notes.push(`clean=${cProc}p`)

      // --- MM: staged edit + a second working-tree edit; the two diffs must be DIFFERENT ---
      fs.writeFileSync(path.join(R, 'a.js'), 'one\ntwo\nthree-staged\n')
      await ghMod.gitStage(R, ['a.js'])
      fs.writeFileSync(path.join(R, 'a.js'), 'one\ntwo\nthree-staged\nfour-unstaged\n')
      const [mm, mProc] = await counted(() => ghMod.gitSnapshot(R))
      const row = mm.changes.find((c) => c.file === 'a.js')
      if (!row || row.x !== 'M' || row.y !== 'M') throw new Error('MM not reported: ' + JSON.stringify(mm.changes))
      if (mProc !== 1) throw new Error(`a dirty tree must cost exactly ONE process, got ${mProc}`)
      notes.push(`dirty=${mProc}p`)
      const sd = await ghMod.gitDiffFile(R, 'a.js', 'staged')
      const ud = await ghMod.gitDiffFile(R, 'a.js', 'unstaged')
      const adds = (d) => d.lines.filter((l) => l.kind === 'add').map((l) => l.text).join('|')
      if (adds(sd) !== 'three-staged') throw new Error('staged diff must be index↔HEAD only: ' + adds(sd))
      if (adds(ud) !== 'four-unstaged') throw new Error('unstaged diff must be worktree↔index only: ' + adds(ud))
      if (sd.mode !== 'staged' || ud.mode !== 'unstaged' || sd.added !== 1 || ud.added !== 1) throw new Error('diff metadata')

      // --- untracked, binary, deleted, rename ---
      fs.writeFileSync(path.join(R, 'new.txt'), 'n1\nn2\n')
      const nd = await ghMod.gitDiffFile(R, 'new.txt', 'untracked')
      if (nd.lines.length !== 2 || nd.lines.every((l) => l.kind !== 'add') || nd.added !== 2) throw new Error('untracked diff is the whole file as additions: ' + JSON.stringify(nd))
      fs.writeFileSync(path.join(R, 'img.bin'), Buffer.from([0, 1, 2, 3]))
      if (!(await ghMod.gitDiffFile(R, 'img.bin', 'untracked')).binary) throw new Error('binary untracked file must say so')
      x(`git -C "${R}" add -A && git -C "${R}" commit -qm more`, q)
      x(`git -C "${R}" mv new.txt moved.txt && git -C "${R}" rm -q img.bin`, q)
      const rn = await ghMod.gitSnapshot(R)
      const mv = rn.changes.find((c) => c.file === 'moved.txt')
      if (!mv || mv.x !== 'R' || mv.orig !== 'new.txt') throw new Error('staged rename with orig: ' + JSON.stringify(rn.changes))
      const del = rn.changes.find((c) => c.file === 'img.bin')
      if (!del || del.x !== 'D') throw new Error('staged delete: ' + JSON.stringify(rn.changes))
      const rd = await ghMod.gitDiffFile(R, 'moved.txt', 'staged', 'new.txt')
      if (rd.error || rd.binary) throw new Error('rename diff: ' + JSON.stringify(rd))
      x(`git -C "${R}" commit -qm mv`, q)

      // --- unusual filenames (spaces, quote, unicode, leading dash) round-trip through stage + diff ---
      const odd = ['sp ace.txt', 'quo"te.txt', 'ünï cødé.txt', '-dash.txt']
      for (const f of odd) fs.writeFileSync(path.join(R, f), f + '\n')
      const os1 = await ghMod.gitSnapshot(R)
      for (const f of odd) if (!os1.changes.some((c) => c.file === f && c.x === '?')) throw new Error('unusual name not listed verbatim: ' + f + ' in ' + JSON.stringify(os1.changes.map((c) => c.file)))
      const stg = await ghMod.gitStage(R, odd)
      if (!stg.ok) throw new Error('staging unusual names: ' + stg.error)
      const os2 = await ghMod.gitSnapshot(R)
      for (const f of odd) if (!os2.changes.some((c) => c.file === f && c.x === 'A')) throw new Error('unusual name not staged: ' + f)
      const dd = await ghMod.gitDiffFile(R, '-dash.txt', 'staged')
      if (dd.error || dd.added !== 1) throw new Error('a dash-named file must diff as a file, not a flag: ' + JSON.stringify(dd))
      x(`git -C "${R}" commit -qm odd`, q)

      // --- security: the diff channel refuses traversal and absolute paths ---
      for (const bad of ['../x', '/etc/passwd', 'a\nb']) {
        const r1 = await ghMod.gitDiffFile(R, bad, 'unstaged')
        const r2 = await ghMod.gitDiffFile(R, bad, 'untracked')
        if (!r1.error || !r2.error) throw new Error('unsafe path accepted by gitDiffFile: ' + JSON.stringify(bad))
      }

      // --- 1,000 changed files: still one process, and an exact total ---
      const many = path.join(R, 'many')
      fs.mkdirSync(many)
      for (let i = 0; i < 1000; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), `${i}\n`)
      const t0 = Date.now()
      const [big, bProc] = await counted(() => ghMod.gitSnapshot(R))
      const bigMs = Date.now() - t0
      if (big.total !== 1000 || big.changes.length !== 1000 || big.truncated) throw new Error(`1000 files: total=${big.total} rows=${big.changes.length} truncated=${big.truncated}`)
      if (bProc !== 1) throw new Error(`1000 files cost ${bProc} processes`)
      notes.push(`1000files=${bigMs}ms/${bProc}p`)
      // Legacy gitInfo is now a projection: no extra processes beyond the snapshot's.
      const [info, infoProc] = await counted(() => ghMod.gitInfo(R))
      if (info.changes.length !== 1000 || info.branch !== 'main' || infoProc > 3) throw new Error(`gitInfo: ${info.changes.length} rows, ${infoProc} processes`)
      fs.rmSync(many, { recursive: true, force: true })

      // --- a subfolder project: scoped rows, stripped paths, outside-staged counted, watcher target ---
      fs.mkdirSync(path.join(R, 'sub', 'deep'), { recursive: true })
      fs.writeFileSync(path.join(R, 'sub', 'deep', 'in.txt'), 'in\n')
      fs.writeFileSync(path.join(R, 'out.txt'), 'out\n')
      x(`git -C "${R}" add out.txt`, q)
      const [subSnap, sProc] = await counted(() => ghMod.gitSnapshot(path.join(R, 'sub')))
      if (subSnap.isRepoRoot || subSnap.changes.map((c) => c.file).join() !== 'deep/in.txt') throw new Error('subfolder rows: ' + JSON.stringify(subSnap.changes))
      if (subSnap.outsideStaged !== 1) throw new Error('a staged file outside the folder must be counted for the commit: ' + subSnap.outsideStaged)
      if (sProc !== 1) throw new Error(`subfolder snapshot cost ${sProc}`)
      const loc = ghMod.findRepo(path.join(R, 'sub', 'deep'))
      if (!loc || loc.prefix !== 'sub/deep/' || path.resolve(loc.root) !== path.resolve(R)) throw new Error('findRepo: ' + JSON.stringify(loc))
      x(`git -C "${R}" reset -q out.txt && rm -rf "${R}/sub" "${R}/out.txt"`, q)

      // --- upstream + ahead/behind, publish, detached ---
      x(`git init -q --bare "${O}" && git -C "${R}" remote add origin "${O}"`, q)
      const noUp = await ghMod.gitSnapshot(R)
      if (noUp.upstream !== null) throw new Error('remote without upstream must still read no-upstream')
      const remotes1 = await ghMod.gitRemotesCached(R)
      if (remotes1.length !== 1 || remotes1[0].name !== 'origin') throw new Error('remotes')
      x(`git -C "${R}" push -qu origin main`, q)
      fs.writeFileSync(path.join(R, 'ahead.txt'), 'x\n')
      x(`git -C "${R}" add -A && git -C "${R}" commit -qm ahead`, q)
      const up = await ghMod.gitSnapshot(R)
      if (up.upstream !== 'origin/main' || up.ahead !== 1 || up.behind !== 0) throw new Error('ahead/behind from the status header: ' + JSON.stringify({ u: up.upstream, a: up.ahead, b: up.behind }))
      x(`git -C "${R}" checkout -q --detach`, q)
      const det = await ghMod.gitSnapshot(R)
      if (!det.detached || det.branch !== '') throw new Error('detached: ' + JSON.stringify({ d: det.detached, b: det.branch }))
      x(`git -C "${R}" checkout -q main`, q)

      // --- cold caches: served from memory until the files git rewrites actually change ---
      const [b1, b1p] = await counted(() => ghMod.gitBranchesCached(R))
      const [b2, b2p] = await counted(() => ghMod.gitBranchesCached(R))
      if (b1p < 1 || b2p !== 0 || b2 !== b1) throw new Error(`branch cache: first=${b1p} second=${b2p}`)
      x(`git -C "${R}" branch feature/cached`, q)
      const [b3, b3p] = await counted(() => ghMod.gitBranchesCached(R))
      if (b3p < 1 || !b3.some((b) => b.name === 'feature/cached')) throw new Error('branch cache did not invalidate after `git branch`')
      const [t1, t1p] = await counted(() => ghMod.gitTimelineCached(R))
      const [, t2p] = await counted(() => ghMod.gitTimelineCached(R))
      if (t1p < 1 || t2p !== 0) throw new Error(`timeline cache: ${t1p}/${t2p}`)
      fs.writeFileSync(path.join(R, 'tl.txt'), 'y\n')
      x(`git -C "${R}" add -A && git -C "${R}" commit -qm tl`, q)
      const [t3] = await counted(() => ghMod.gitTimelineCached(R))
      if (t3.length !== t1.length + 1 || t3[0].subject !== 'tl') throw new Error('timeline cache stale after a commit')
      // `push -u` wrote branch.main.remote into .git/config, so the first read after it is an
      // honest miss; the SECOND is what must be served from memory.
      await ghMod.gitRemotesCached(R)
      const [, r2p] = await counted(() => ghMod.gitRemotesCached(R))
      if (r2p !== 0) throw new Error('remotes cache miss with an unchanged config')
      x(`git -C "${R}" remote add mirror "${O}"`, q)
      const [r3] = await counted(() => ghMod.gitRemotesCached(R))
      if (r3.length !== 2) throw new Error('remotes cache stale after `remote add`')

      // --- merge conflict: reported by the same one process, and the diff channel counts hunks ---
      fs.writeFileSync(path.join(R, 'conf.txt'), 'base\n')
      x(`git -C "${R}" add -A && git -C "${R}" commit -qm base && git -C "${R}" checkout -q -b theirs`, q)
      fs.writeFileSync(path.join(R, 'conf.txt'), 'theirs\n')
      x(`git -C "${R}" commit -qam theirs && git -C "${R}" checkout -q main`, q)
      fs.writeFileSync(path.join(R, 'conf.txt'), 'ours\n')
      x(`git -C "${R}" commit -qam ours`, q)
      await ghMod.gitMerge(R, 'theirs')
      const [cf, cfProc] = await counted(() => ghMod.gitSnapshot(R))
      if (!cf.merging || !cf.conflicts.includes('conf.txt') || cfProc !== 1) throw new Error('conflict snapshot: ' + JSON.stringify({ m: cf.merging, c: cf.conflicts, p: cfProc }))
      const cd = await ghMod.gitDiffFile(R, 'conf.txt', 'conflict')
      if (cd.conflictHunks !== 1) throw new Error('conflict hunk count: ' + JSON.stringify(cd))
      await ghMod.gitMergeAbort(R)
      if ((await ghMod.gitSnapshot(R)).merging) throw new Error('merging flag stale after abort')
      return notes.join(' · ') + ' · MM diffs exact · rename/orig · odd names · 1000 files exact · subfolder scoped · upstream/detached · caches invalidate on real changes · conflict'
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // ---------- Enterprise: company server via fake ssh (full chain, no server) ----------
  const remoteMod = require(path.join(WORKDIR, 'main', 'remote.js'))
  const auditMod = require(path.join(WORKDIR, 'main', 'audit.js'))
  const aiMod = require(path.join(WORKDIR, 'main', 'ai-edit.js'))
  const SERVER_DIR = path.join(WORKDIR, 'server')
  const FAKE_SSH = path.join(WORKDIR, 'fake-ssh.sh')

  await step('binOverride gate: packaged build ignores STUDIO_*_BIN; unpackaged honors it', async () => {
    const { binOverride, pickBin } = require(path.join(WORKDIR, 'main', 'util.js'))
    // Pure gate (deterministic, no Electron mock): packaged → fallback; unpackaged → env||fallback.
    if (pickBin(true, '/tmp/fake', 'docker') !== 'docker') throw new Error('packaged must ignore the env override')
    if (pickBin(false, '/tmp/fake', 'docker') !== '/tmp/fake') throw new Error('unpackaged must honor the env override')
    if (pickBin(false, undefined, 'docker') !== 'docker') throw new Error('unset env → fallback')
    if (pickBin(false, '', 'docker') !== 'docker') throw new Error('empty env → fallback')
    // Live wiring: the test harness runs UNPACKAGED, so binOverride honors a set env var
    // (this is exactly why every STUDIO_*_BIN fake below keeps working).
    const prev = process.env.STUDIO_BIN_PROBE
    process.env.STUDIO_BIN_PROBE = '/tmp/probe-bin'
    try {
      if (binOverride('STUDIO_BIN_PROBE', 'realbin') !== '/tmp/probe-bin') throw new Error('unpackaged harness should honor env')
      if (binOverride('STUDIO_BIN_UNSET_XYZ', 'realbin') !== 'realbin') throw new Error('unset → fallback')
    } finally {
      if (prev === undefined) delete process.env.STUDIO_BIN_PROBE
      else process.env.STUDIO_BIN_PROBE = prev
    }
    return 'packaged→fallback (un-spoofable); unpackaged honors env; empty/unset→fallback'
  })

  await step('ssh: every hostile host/user/port/key/command survives as ONE argv element', async () => {
    /**
     * THE BUG THIS LOCKS DOWN. `sshBase()` used to build a command STRING and hand it to a shell:
     *
     *   `${SSH()} -i ${JSON.stringify(cfg.keyPath)} -p ${port} … ${JSON.stringify(`${user}@${host}`)}`
     *
     * `JSON.stringify` emits double quotes, and a POSIX shell expands `$(...)`, backticks and `$VAR`
     * inside those. Host, user, key path and remote command all arrive from a settings form, a
     * config file or a control-plane response, so every one of them executed. Two assertions here,
     * and both are needed: the argv SHAPE (nothing concatenated, `--` before the destination) and a
     * LIVE run proving the payloads reached the child intact and nothing ran.
     */
    const RECORD = path.join(WORKDIR, 'ssh-argv.txt')
    const TRIP = path.join(WORKDIR, 'ssh-pwned')
    const REC = path.join(WORKDIR, 'ssh-recorder.js')
    // A NODE recorder, writing JSON. A line-per-argument shell recorder cannot represent a payload
    // that CONTAINS a newline — and "a newline in the host" is one of the cases under test, so the
    // recording format was hiding the very thing it was meant to prove.
    fs.writeFileSync(
      REC,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(RECORD)}, JSON.stringify(process.argv.slice(2)))\n`
    )
    fs.chmodSync(REC, 0o755)

    const payloads = [
      `h$(touch ${TRIP})`,
      'h`touch ' + TRIP + '`',
      `h;touch ${TRIP}`,
      `h\ntouch ${TRIP}`,
      `h && touch ${TRIP}`,
      '-oProxyCommand=touch ' + TRIP
    ]

    const prevBin = process.env.STUDIO_SSH_BIN
    process.env.STUDIO_SSH_BIN = REC
    try {
      for (const host of payloads) {
        const cfg = { host, user: `u;touch ${TRIP}`, port: 22, keyPath: `/k ey/$(touch ${TRIP})`, root: '/r' }
        const cmd = `sh -c 'echo $(touch ${TRIP})'`

        // --- shape ---
        const args = remoteMod.sshArgs(cfg, [], cmd)
        const dest = `${cfg.user}@${cfg.host}`
        if (!args.includes(dest)) throw new Error(`destination was not one element: ${JSON.stringify(args)}`)
        if (!args.includes(cfg.keyPath)) throw new Error('key path was not one element')
        if (!args.includes(cmd)) throw new Error('remote command was not one element')
        // `--` must come BEFORE the destination, or ssh's OWN option parser reads a host beginning
        // with '-' as a flag. An argv array stops the shell; only `--` stops ssh.
        const dd = args.indexOf('--')
        if (dd === -1 || dd > args.indexOf(dest)) throw new Error(`no end-of-options before the destination: ${JSON.stringify(args)}`)
        // Nothing may have been glued together into a mini command line.
        if (args.some((a) => /\s-o\s|\s-i\s|\s-p\s/.test(a))) throw new Error(`argv element looks concatenated: ${JSON.stringify(args)}`)

        // --- live ---
        fs.rmSync(RECORD, { force: true })
        await remoteMod.sshRun(cfg, cmd)
        const got = JSON.parse(fs.readFileSync(RECORD, 'utf8'))
        if (!got.includes(dest)) throw new Error(`the child did not receive the destination verbatim: ${JSON.stringify(got)}`)
        if (!got.includes(cmd)) throw new Error('the child did not receive the command verbatim')
        if (fs.existsSync(TRIP)) throw new Error(`a payload EXECUTED for host ${JSON.stringify(host)} — a shell parsed it`)
      }
    } finally {
      if (prevBin === undefined) delete process.env.STUDIO_SSH_BIN
      else process.env.STUDIO_SSH_BIN = prevBin
    }
    return `${payloads.length} injection payloads (\$(), backticks, ;, newline, &&, -o option injection) reached ssh as literal argv; none executed`
  })

  await step('company server: connect/list/read/write over (fake) ssh', async () => {
    fs.mkdirSync(path.join(SERVER_DIR, 'src'), { recursive: true })
    fs.mkdirSync(path.join(SERVER_DIR, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(SERVER_DIR, 'src', 'app.py'), 'print("company")\n')
    // Fake ssh: ignore every flag, execute the final argument (the remote command) locally.
    fs.writeFileSync(FAKE_SSH, '#!/bin/sh\n# -N = tunnel mode: just stay alive (tests kill us)\ncase " $* " in *" -N "*) exec sleep 30;; esac\nfor last; do :; done\nexec sh -c "$last"\n')
    fs.chmodSync(FAKE_SSH, 0o755)
    process.env.STUDIO_SSH_BIN = FAKE_SSH

    const cfg = { host: 'aws.example', user: 'deploy', port: 22, keyPath: '', root: SERVER_DIR }
    const policy = { confidential: true, allowExport: false, allowedProviders: ['mock'], fraudWebhook: undefined }

    const bad = await remoteMod.remoteConnect({ ...cfg, root: '/no/such/dir/xyz' }, policy)
    if (bad.ok) throw new Error('connected to a missing root')

    const ok = await remoteMod.remoteConnect(cfg, policy)
    if (!ok.ok) throw new Error(ok.error)

    const list = await remoteMod.remoteList(SERVER_DIR)
    if (!list.some((e) => e.name === 'src' && e.isDir)) throw new Error(JSON.stringify(list))
    if (list.some((e) => e.name === 'node_modules')) throw new Error('node_modules not hidden')

    const read = await remoteMod.remoteRead(`${SERVER_DIR}/src/app.py`)
    if (!read.ok || !read.content.includes('company')) throw new Error(JSON.stringify(read))

    const write = await remoteMod.remoteWrite(`${SERVER_DIR}/src/app.py`, 'print("edited from studio")\n')
    if (!write.ok) throw new Error(write.error)
    if (!fs.readFileSync(path.join(SERVER_DIR, 'src', 'app.py'), 'utf8').includes('edited from studio'))
      throw new Error('remote write did not land')

    const escape = await remoteMod.remoteRead('/etc/hosts')
    if (escape.ok) throw new Error('read outside the workspace root was allowed')

    const exec = await remoteMod.remoteExec('ls src')
    if (!exec.ok || !exec.output.includes('app.py')) throw new Error(JSON.stringify(exec))
    return 'connect ✓ list ✓ read ✓ write ✓ root-confined ✓ exec ✓'
  })

  await step('confidential mode: server code blocked from non-approved AI, audited', async () => {
    const blocked = await aiMod.editSelection({
      projectPath: '/', file: 'ssh://x/app.py', fileContent: 'a', startLine: 1, endLine: 1,
      selectedText: 'a', instruction: 'change it', provider: 'groq'
    })
    if (blocked.ok || !(blocked.error || '').includes('policy')) throw new Error(JSON.stringify(blocked))
    writeScript(['ok_replacement'])
    const allowed = await aiMod.editSelection({
      projectPath: '/', file: 'ssh://x/app.py', fileContent: 'a', startLine: 1, endLine: 1,
      selectedText: 'a', instruction: 'change it', provider: 'mock'
    })
    if (!allowed.ok) throw new Error(allowed.error)
    const tailLog = auditMod.auditTail()
    if (!tailLog.some((e) => e.event === 'ai-blocked')) throw new Error('ai-blocked not audited')
    if (!tailLog.some((e) => e.event === 'remote-save')) throw new Error('remote-save not audited')
    return 'groq blocked + audited; approved provider allowed'
  })

  await step('fraud report POSTs the audit tail to the company webhook', async () => {
    const http = require('node:http')
    let received = null
    const srv = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        received = JSON.parse(body)
        res.writeHead(200).end('ok')
      })
    })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${srv.address().port}/fraud`
    const res = await auditMod.reportFraud(url, 'test violation')
    srv.close()
    if (!res.ok || !res.delivered) throw new Error(JSON.stringify(res))
    if (!received || received.reason !== 'test violation' || !Array.isArray(received.recentAudit))
      throw new Error('webhook body malformed')
    if (!received.recentAudit.some((e) => e.event === 'fraud-report')) throw new Error('audit tail missing')
    remoteMod.remoteDisconnect()
    return `delivered with ${received.recentAudit.length} audit entries`
  })

  // ---------- ATOMIC Workspaces ----------
  const wsMod = require(path.join(WORKDIR, 'main', 'workspaces.js'))
  const keyvault = require(path.join(WORKDIR, 'main', 'keyvault.js'))
  const WS_ROOT = path.join(WORKDIR, 'ws-company')

  await step('workspaces: company provisioning (template, non-empty guard, registry)', async () => {
    const cfg = { host: 'byo.fake', user: 'deploy', port: 22, keyPath: '', root: WS_ROOT }
    const policy = { confidential: true, allowExport: false, allowedProviders: ['mock'] }

    const created = await wsMod.wsCreateCompany({ name: 'pharmacy-site', cfg, policy, template: 'static-html' })
    if (!created.ok) throw new Error(created.error)
    if (!fs.existsSync(path.join(WS_ROOT, 'index.html'))) throw new Error('template index.html missing on the "server"')
    if (!fs.existsSync(path.join(WS_ROOT, 'workspace.json'))) throw new Error('workspace.json missing')

    const again = await wsMod.wsCreateCompany({ name: 'clobber', cfg, policy })
    if (again.ok) throw new Error('non-empty root was NOT refused')

    const list = wsMod.wsList()
    if (!list.some((w) => w.name === 'pharmacy-site' && w.kind === 'company')) throw new Error(JSON.stringify(list))
    return `provisioned + guarded + registered (${created.workspace.id})`
  })

  await step('workspaces: open → health + connect + manifest', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'pharmacy-site')
    const res = await wsMod.wsOpen(w.id)
    if (!res.ok) throw new Error(res.error)
    if (!res.health?.ssh) throw new Error('health probe failed')
    if (res.manifest?.framework !== 'static-html') throw new Error(`manifest = ${JSON.stringify(res.manifest)}`)
    if (!wsMod.wsGet(w.id).lastOpened) throw new Error('lastOpened not stamped')
    return `health os=${res.health.os} cpus=${res.health.cpus} · manifest ${res.manifest.framework}`
  })

  await step('workspaces: secrets stored in keychain, injected into exec env', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'pharmacy-site')
    wsMod.wsSecretsSet(w.id, { MY_API_KEY: 's3cr3t-value!$x', DB_URL: 'postgres://u:p@h/db' })
    const names = wsMod.wsSecretNames(w.id)
    if (JSON.stringify(names) !== JSON.stringify(['DB_URL', 'MY_API_KEY'])) throw new Error(JSON.stringify(names))
    const reg = fs.readFileSync(path.join(app.getPath('userData'), 'workspaces.json'), 'utf8')
    if (reg.includes('s3cr3t')) throw new Error('SECRET LEAKED into the registry file')
    const res = await wsMod.wsExec(w.id, 'env | grep MY_API_KEY')
    if (!res.output.includes('s3cr3t-value!$x')) throw new Error(`secret not injected: ${res.output.slice(0, 120)}`)
    return 'names listable, values keychain-only, injected at runtime'
  })

  await step('workspaces: company snapshot → modify → restore', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'pharmacy-site')
    const snap = await wsMod.wsSnapshot(w.id, 'before-change', 'test snapshot')
    if (!snap.ok) throw new Error(snap.error)
    fs.writeFileSync(path.join(WS_ROOT, 'index.html'), 'RUINED')
    const snaps = await wsMod.wsSnapshots(w.id)
    if (!snaps.length || snaps[0].name !== 'before-change') {
      const sdir = path.join(WS_ROOT, '.studio-snapshots')
      const onDisk = fs.existsSync(sdir) ? fs.readdirSync(sdir) : 'NO_DIR'
      throw new Error(`snaps=${JSON.stringify(snaps)} onDisk=${JSON.stringify(onDisk)}`)
    }
    const rest = await wsMod.wsRestore(w.id, snaps[0].id)
    if (!rest.ok) throw new Error(rest.error)
    if (!fs.readFileSync(path.join(WS_ROOT, 'index.html'), 'utf8').includes('workspace is ready'))
      throw new Error('restore did not bring the file back')
    return `snapshot ${snaps[0].id} taken, file ruined, restored`
  })

  await step('workspaces: delete removes from registry, never the server files', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'pharmacy-site')
    const del = await wsMod.wsDelete(w.id, false)
    if (!del.ok) throw new Error(del.error)
    if (wsMod.wsList().some((x) => x.id === w.id)) throw new Error('still in registry')
    if (!fs.existsSync(path.join(WS_ROOT, 'index.html'))) throw new Error('server files were deleted!')
    remoteMod.remoteDisconnect()
    return 'forgotten locally, server untouched'
  })

  // ---------- ATOMIC Cloud against the REAL reference server ----------
  const { spawn } = require('node:child_process')
  const CLOUD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-cloud-'))
  const CLOUD_TOKEN = 'test-token-123'
  let cloudProc = null
  let cloudUrl = ''

  await step('cloud: reference server boots (ephemeral port) and rejects bad tokens', async () => {
    cloudProc = spawn(process.execPath, [path.join(REPO, 'server', 'atomic-workspaced.mjs')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ATOMIC_WS_TOKEN: CLOUD_TOKEN,
        ATOMIC_WS_ROOT: CLOUD_ROOT,
        ATOMIC_WS_PORT: '0',
        ATOMIC_WS_IDLE_MS: '400',
        ATOMIC_WS_SWEEP_MS: '150'
      }
    })
    const port = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('server did not boot')), 8000)
      cloudProc.stdout.on('data', (d) => {
        const m = String(d).match(/listening on [\d.]+:(\d+)/)
        if (m) {
          clearTimeout(to)
          resolve(m[1])
        }
      })
      cloudProc.stderr.on('data', (d) => console.error('  [server-err]', String(d).trim()))
      cloudProc.on('exit', (c, sig) => console.error('  [server exited]', c, sig))
    })
    cloudUrl = `http://127.0.0.1:${port}`
    const bad = await fetch(`${cloudUrl}/v1/workspaces`, { headers: { Authorization: 'Bearer wrong' } })
    if (bad.status !== 401) throw new Error(`bad token → ${bad.status}`)
    const none = await fetch(`${cloudUrl}/v1/workspaces`)
    if (none.status !== 401) throw new Error(`no token → ${none.status}`)
    return `${cloudUrl} · 401 on bad/missing token`
  })

  await step('cloud: create workspace → dir + template + ssh coordinates', async () => {
    wsMod.wsCloudSetup(cloudUrl)
    keyvault.setApiKey('atomic-cloud', CLOUD_TOKEN)
    const res = await wsMod.wsCreateCloud({ name: 'demo-shop', template: 'static-html' })
    if (!res.ok) throw new Error(res.error)
    const w = res.workspace
    if (w.kind !== 'cloud' || !w.cfg.root.includes(CLOUD_ROOT)) throw new Error(JSON.stringify(w.cfg))
    if (!fs.existsSync(path.join(w.cfg.root, 'index.html'))) throw new Error('cloud template missing')
    return `created ${w.id} at ${w.cfg.root}`
  })

  await step('cloud: idle auto-suspend, busy hold, auto-wake on open', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'demo-shop')
    // Idle out (idle=400ms, sweep=150ms).
    await new Promise((r) => setTimeout(r, 900))
    const auth = { headers: { Authorization: `Bearer ${CLOUD_TOKEN}` } }
    let state = (await (await fetch(`${cloudUrl}/v1/workspaces/${w.id}`, auth)).json()).state
    if (state !== 'suspended') throw new Error(`expected suspended, got ${state}`)

    // wsOpen must auto-wake it (fake ssh makes the data plane work).
    const open = await wsMod.wsOpen(w.id)
    if (!open.ok) throw new Error(open.error)
    if (!open.woke) throw new Error('auto-wake not reported')

    // Busy keepalive holds off the idle sweep.
    await fetch(`${cloudUrl}/v1/workspaces/${w.id}/keepalive`, { ...auth, method: 'POST', headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ busy: true }) })
    await new Promise((r) => setTimeout(r, 900))
    state = (await (await fetch(`${cloudUrl}/v1/workspaces/${w.id}`, auth)).json()).state
    if (state !== 'ready') throw new Error(`busy hold failed — state ${state}`)
    remoteMod.remoteDisconnect()
    wsMod.stopKeepalive()
    return 'suspended when idle · woke on open · busy signal holds suspend'
  })

  await step('cloud: snapshots + restore via the control plane', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'demo-shop')
    const snap = await wsMod.wsSnapshot(w.id, 'v1', 'first version')
    if (!snap.ok) throw new Error(snap.error)
    fs.writeFileSync(path.join(w.cfg.root, 'index.html'), 'BROKEN')
    const snaps = await wsMod.wsSnapshots(w.id)
    if (!snaps.length || snaps[0].name !== 'v1') throw new Error(JSON.stringify(snaps))
    const rest = await wsMod.wsRestore(w.id, snaps[0].id)
    if (!rest.ok) throw new Error(rest.error)
    if (!fs.readFileSync(path.join(w.cfg.root, 'index.html'), 'utf8').includes('cloud workspace is ready'))
      throw new Error('cloud restore failed')
    return `snapshot ${snaps[0].id} (${snaps[0].bytes} bytes) → restore ok`
  })

  await step('cloud: delete moves the workspace to trash (7-day recovery)', async () => {
    const w = wsMod.wsList().find((x) => x.name === 'demo-shop')
    const del = await wsMod.wsDelete(w.id, true)
    if (!del.ok) throw new Error(del.error)
    if (fs.existsSync(w.cfg.root)) throw new Error('workspace dir still live')
    const trash = fs.readdirSync(path.join(CLOUD_ROOT, '.trash'))
    if (!trash.some((t) => t.startsWith(w.id))) throw new Error(`not in trash: ${trash}`)
    cloudProc?.kill()
    return `trashed as ${trash[0]}`
  })


  // ---------- Phase 1: timeline, index v2, agent queue, tunnels ----------
  await step('git timeline: commits parsed with author/time/subject + per-commit files', async () => {
    const tl = await ghMod.gitTimeline(REPO_DIR)
    if (tl.length < 2) throw new Error(`only ${tl.length} commits`)
    if (!tl.some((c) => c.subject === 'add feature')) throw new Error(JSON.stringify(tl))
    if (!tl[0].hash || !tl[0].author || !tl[0].ts) throw new Error('missing fields')
    const files = await ghMod.gitCommitFiles(REPO_DIR, tl.find((c) => c.subject === 'add feature').hash)
    if (!files.some((f) => f.includes('feature.js'))) throw new Error(JSON.stringify(files))
    const evil = await ghMod.gitCommitFiles(REPO_DIR, 'x; rm -rf /')
    if (evil.length) throw new Error('bad hash accepted')
    return `${tl.length} commits · files for "add feature": ${files[0]}`
  })

  const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
  await step('AI index v2: background cache + imports + refresh + search-everywhere', async () => {
    fs.writeFileSync(path.join(PROJ, 'src/imp.js'), "const u = require('./util')\nmodule.exports = u\n")
    const idx = indexMod.buildProjectIndex(PROJ)
    if (!idx.files.some((f) => f.path === 'src/app.js' && f.symbols.some((s) => s.name === 'greet')))
      throw new Error('symbols missing')
    if (!idx.files.some((f) => f.path === 'src/imp.js' && f.imports.includes('./util')))
      throw new Error('imports missing')
    // Disk cache exists and is readable back.
    const cached = indexMod.getProjectIndex(PROJ)
    if (cached.builtAt !== idx.builtAt) throw new Error('memory cache miss')
    // Save-time refresh picks up a new symbol.
    fs.writeFileSync(path.join(PROJ, 'src/imp.js'), "const u = require('./util')\nfunction freshSymbol() {}\nmodule.exports = u\n")
    indexMod.refreshIndexedFile(PROJ, 'src/imp.js')
    const hits = indexMod.indexSearch(PROJ, 'freshsymbol')
    if (!hits.some((h) => h.kind === 'symbol' && h.path === 'src/imp.js')) throw new Error(JSON.stringify(hits))
    const impHits = indexMod.indexSearch(PROJ, './util')
    if (!impHits.some((h) => h.kind === 'import')) throw new Error('import search failed')
    return `indexed ${idx.files.length} files · refresh + symbol/import search ok`
  })

  await step('background agents: second instruction queues, then auto-runs', async () => {
    agent.resetSession()
    events.length = 0
    writeScript(['ACTION done\nRun A finished.', 'ACTION done\nRun B finished.'])
    const a = agent.startAgent({ projectPath: PROJ, instruction: 'task A', mode: 'plan', provider: 'mock', newChat: true }, emit)
    const b = await agent.startAgent({ projectPath: PROJ, instruction: 'task B', mode: 'plan', provider: 'mock' }, emit)
    if (!b.queued) throw new Error('second run was not queued')
    await a
    await new Promise((r) => setTimeout(r, 400)) // let the queued run drain
    const done = byType('done')
    if (done.length !== 2) throw new Error(`done events: ${done.length}`)
    if (byType('queued').length !== 1 || byType('started').length !== 2) throw new Error('event shape wrong')
    if (agent.getAgentState().queued !== 0) throw new Error('queue not drained')
    return 'queued at position 1 → auto-ran → both done'
  })

  await step('port forwarding: ssh -N tunnel opens, lists, closes', async () => {
    const cfg = { host: 'byo.fake', user: 'deploy', port: 22, keyPath: '', root: SERVER_DIR }
    const policy = { confidential: false, allowExport: true, allowedProviders: [] }
    const conn = await remoteMod.remoteConnect(cfg, policy)
    if (!conn.ok) throw new Error(conn.error)
    const t = await remoteMod.tunnelOpen(9313)
    if (!t.ok) throw new Error(t.error)
    if (remoteMod.tunnelList().length !== 1) throw new Error('tunnel not listed')
    remoteMod.tunnelClose(t.tunnel.id)
    if (remoteMod.tunnelList().length !== 0) throw new Error('tunnel not closed')
    const bad = await remoteMod.tunnelOpen(99999)
    if (bad.ok) throw new Error('invalid port accepted')
    remoteMod.remoteDisconnect()
    return `tunnel ${t.tunnel.localPort}←:9313 opened, listed, closed · invalid port refused`
  })

  // ---------- Phase 2: docker integration ----------
  await step('docker: compose detect + lifecycle via the CLI (fake bin), graceful when absent', async () => {
    const dockerMod = require(path.join(WORKDIR, 'main', 'docker.js'))
    const dproj = path.join(WORKDIR, 'dockerproj')
    fs.mkdirSync(dproj, { recursive: true })
    if (dockerMod.composeFile(dproj)) throw new Error('compose detected in empty dir')
    fs.writeFileSync(path.join(dproj, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
    if (dockerMod.composeFile(dproj) !== 'docker-compose.yml') throw new Error('compose not detected')

    // Fake docker CLI records its argv.
    const fakeDocker = path.join(WORKDIR, 'fake-docker.sh')
    const argsLog = path.join(WORKDIR, 'docker-args.txt')
    fs.writeFileSync(fakeDocker, `#!/bin/sh\necho "$@" >> ${JSON.stringify(argsLog)}\necho FAKE_DOCKER_OK\n`)
    fs.chmodSync(fakeDocker, 0o755)
    process.env.STUDIO_DOCKER_BIN = fakeDocker

    const lines = []
    const up = await dockerMod.composeRun(dproj, 'up', (l) => lines.push(l.text))
    if (!up.ok || !up.output.includes('FAKE_DOCKER_OK')) throw new Error(JSON.stringify(up))
    const logged = fs.readFileSync(argsLog, 'utf8')
    if (!logged.includes('compose up -d')) throw new Error(`argv: ${logged}`)
    if (!lines.some((t) => t.includes('FAKE_DOCKER_OK'))) throw new Error('output not streamed')

    // Graceful degradation when docker is missing entirely.
    process.env.STUDIO_DOCKER_BIN = path.join(WORKDIR, 'no-such-docker')
    const missing = await dockerMod.composeRun(dproj, 'ps', () => {})
    if (missing.ok || !missing.output.toLowerCase().includes('not installed')) throw new Error(JSON.stringify(missing))
    delete process.env.STUDIO_DOCKER_BIN
    return 'detected · up -d via CLI, streamed · friendly message when docker missing'
  })

  // ---------- Phase 3: team roles, subscribe, viewer read-only, enterprise policy ----------
  const T3_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-team-'))
  const OWNER_TOKEN = 'owner-token-t3'
  let t3Proc = null
  let t3Url = ''

  await step('team: owner invites editor+viewer; roles enforced on the control plane', async () => {
    t3Proc = spawn(process.execPath, [path.join(REPO, 'server', 'atomic-workspaced.mjs')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ATOMIC_WS_TOKEN: OWNER_TOKEN,
        ATOMIC_WS_ROOT: T3_ROOT,
        ATOMIC_WS_PORT: '0',
        ATOMIC_WS_SUBSCRIBE_LINK: 'https://pay.atomic.limited/cloud9'
      }
    })
    const port = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('server did not boot')), 8000)
      t3Proc.stdout.on('data', (d) => {
        const m = String(d).match(/listening on [\d.]+:(\d+)/)
        if (m) { clearTimeout(to); resolve(m[1]) }
      })
    })
    t3Url = `http://127.0.0.1:${port}`
    const H = (tok) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` })

    // Owner invites bob (editor) and vera (viewer) — tokens returned exactly once.
    const bob = await (await fetch(`${t3Url}/v1/team`, { method: 'POST', headers: H(OWNER_TOKEN), body: JSON.stringify({ name: 'bob', role: 'editor' }) })).json()
    const vera = await (await fetch(`${t3Url}/v1/team`, { method: 'POST', headers: H(OWNER_TOKEN), body: JSON.stringify({ name: 'vera', role: 'viewer' }) })).json()
    if (!bob.token || !vera.token) throw new Error('invite tokens missing')

    // Identities resolve.
    const bobMe = await (await fetch(`${t3Url}/v1/me`, { headers: H(bob.token) })).json()
    // `editor` is a LEGACY name and is now canonicalised to `dev` on write, so members.json
    // converges on one vocabulary. The legacy name still works as input — only the stored value
    // changed. The behavioural assertions below are the ones that matter, and one of them
    // (bobDelete → 403) caught a real privilege escalation on 2026-09-01: the DELETE guard used
    // to read `role === 'editor'`, so a member stored as `dev` walked straight past it.
    if (bobMe.role !== 'dev') throw new Error(`bob role ${bobMe.role}`)

    // Editor can create; viewer cannot; editor cannot delete; viewer can read.
    const created = await (await fetch(`${t3Url}/v1/workspaces`, { method: 'POST', headers: H(bob.token), body: JSON.stringify({ name: 'team-ws', template: 'static-html' }) })).json()
    if (!created.id) throw new Error('editor create failed')
    const veraCreate = await fetch(`${t3Url}/v1/workspaces`, { method: 'POST', headers: H(vera.token), body: JSON.stringify({ name: 'nope' }) })
    if (veraCreate.status !== 403) throw new Error(`viewer create → ${veraCreate.status}`)
    const bobDelete = await fetch(`${t3Url}/v1/workspaces/${created.id}`, { method: 'DELETE', headers: H(bob.token) })
    if (bobDelete.status !== 403) throw new Error(`editor delete → ${bobDelete.status}`)
    const veraList = await fetch(`${t3Url}/v1/workspaces`, { headers: H(vera.token) })
    if (veraList.status !== 200) throw new Error('viewer read failed')
    // Team management is owner-only.
    const bobTeam = await fetch(`${t3Url}/v1/team`, { headers: H(bob.token) })
    if (bobTeam.status !== 403) throw new Error(`editor team access → ${bobTeam.status}`)

    // Revoke bob → token dead.
    await fetch(`${t3Url}/v1/team/bob`, { method: 'DELETE', headers: H(OWNER_TOKEN) })
    const bobAfter = await fetch(`${t3Url}/v1/me`, { headers: H(bob.token) })
    if (bobAfter.status !== 401) throw new Error(`revoked bob → ${bobAfter.status}`)

    // Billing touchpoint: link served, Studio never processes payment.
    const sub = await (await fetch(`${t3Url}/v1/subscribe`, { headers: H(vera.token) })).json()
    if (sub.link !== 'https://pay.atomic.limited/cloud9') throw new Error(JSON.stringify(sub))
    global.__t3 = { vera: vera.token, wsId: created.id }
    return 'invite/roles/revoke/subscribe all enforced'
  })

  await step('team: viewer opens a cloud workspace READ-ONLY through the client', async () => {
    const { vera, wsId } = global.__t3
    wsMod.wsCloudSetup(t3Url)
    keyvault.setApiKey('atomic-cloud', OWNER_TOKEN)
    // Register the workspace locally as the owner, then switch to vera's key.
    const list = await (await fetch(`${t3Url}/v1/workspaces`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } })).json()
    const cw = list.find((w) => w.id === wsId)
    // Client-side registry entry mirroring wsCreateCloud's shape:
    keyvault.setApiKey('atomic-cloud', vera)
    const role = await wsMod.wsCloudRole()
    if (role !== 'viewer') throw new Error(`role ${role}`)
    // Open through the client (fake ssh data plane) → policy must be readOnly.
    const res = await wsMod.wsCreateCloud({ name: 'viewer-probe' }).catch(() => null) // viewer cannot create
    if (res && res.ok) throw new Error('viewer created a workspace')
    // Manually register the existing ws (as if synced earlier) and open it.
    const reg = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'workspaces.json'), 'utf8'))
    reg.workspaces.push({ id: cw.id, name: cw.name, kind: 'cloud', cfg: { host: 'byo.fake', user: 'deploy', port: 22, keyPath: '', root: cw.ssh.root }, policy: { confidential: false, allowExport: true, allowedProviders: [] }, cloudUrl: t3Url, createdAt: Date.now(), lastOpened: null, state: 'ready' })
    fs.writeFileSync(path.join(app.getPath('userData'), 'workspaces.json'), JSON.stringify(reg))
    const open = await wsMod.wsOpen(cw.id)
    if (!open.ok) throw new Error(open.error)
    const write = await remoteMod.remoteWrite(`${cw.ssh.root}/index.html`, 'HACKED')
    if (write.ok || !(write.error || '').includes('view-only')) throw new Error(JSON.stringify(write))
    const exec = await remoteMod.remoteExec('ls')
    if (exec.ok || !exec.output.includes('view-only')) throw new Error('viewer exec allowed')
    remoteMod.remoteDisconnect()
    wsMod.stopKeepalive()
    keyvault.setApiKey('atomic-cloud', OWNER_TOKEN)
    t3Proc?.kill()
    return 'viewer: role detected, writes + exec refused with a friendly message'
  })

  await step('enterprise policy: managed file forces confidential + allowlist + export block', async () => {
    const polFile = path.join(WORKDIR, 'enterprise-policy.json')
    fs.writeFileSync(polFile, JSON.stringify({ allowedProviders: ['mock', 'ollama'], enforceConfidential: true, blockExport: true, fraudWebhook: 'https://sec.corp/hook' }))
    process.env.STUDIO_ENTERPRISE_POLICY = polFile
    const policyMod = require(path.join(WORKDIR, 'main', 'policy.js'))
    policyMod.resetPolicyCache()
    const ep = policyMod.enterprisePolicy()
    if (!ep.managed || !ep.enforceConfidential) throw new Error(JSON.stringify(ep))

    const merged = policyMod.applyEnterprisePolicy({ confidential: false, allowExport: true, allowedProviders: ['groq'] })
    if (!merged.confidential || merged.allowExport || JSON.stringify(merged.allowedProviders) !== '["mock","ollama"]' || merged.fraudWebhook !== 'https://sec.corp/hook')
      throw new Error(JSON.stringify(merged))

    // A direct connect gets the company rules regardless of what the user picked.
    const conn = await remoteMod.remoteConnect(
      { host: 'byo.fake', user: 'deploy', port: 22, keyPath: '', root: SERVER_DIR },
      { confidential: false, allowExport: true, allowedProviders: ['groq'] }
    )
    if (!conn.ok) throw new Error(conn.error)
    const live = remoteMod.remotePolicy()
    if (!live.confidential || live.allowExport) throw new Error(JSON.stringify(live))
    remoteMod.remoteDisconnect()
    delete process.env.STUDIO_ENTERPRISE_POLICY
    policyMod.resetPolicyCache()
    return 'managed: confidential forced, export blocked, providers pinned, webhook defaulted'
  })

  await step('parseAction tolerates how weak models really write the line', async () => {
    // Both shapes were observed from a free model and both used to be rejected outright, which made
    // the agent answer "No ACTION line found", the model repeat itself, and the Loop Breaker halt.
    const glued = agent.parseAction("I'll explore the project root to understand the layout.ACTION list_files")
    if (glued.error || glued.tool !== 'list_files') throw new Error(`glued: ${JSON.stringify(glued)}`)

    const tagged = agent.parseAction('Let me look around.\n<tool_call> ACTION list_files </tool_call>')
    if (tagged.error || tagged.tool !== 'list_files') throw new Error(`tagged: ${JSON.stringify(tagged)}`)

    // A well-formed line still wins over an earlier mention inside prose.
    const both = agent.parseAction('I could use ACTION list_files here, but first:\nACTION read_file src/a.ts')
    if (both.error || both.tool !== 'read_file' || both.arg !== 'src/a.ts') throw new Error(`both: ${JSON.stringify(both)}`)

    // An unknown verb is still not an action — the tolerant pass must not execute arbitrary prose.
    const bogus = agent.parseAction('The ACTION verb here is not a tool at all.')
    if (!bogus.error) throw new Error(`bogus parsed as ${JSON.stringify(bogus)}`)

    // Fenced write bodies still parse when the line is glued to a sentence.
    const w = agent.parseAction('Writing it now.ACTION write src/x.ts\n```ts\nconst a = 1\n```')
    if (w.error || w.tool !== 'write' || w.arg !== 'src/x.ts' || w.body !== 'const a = 1')
      throw new Error(`write: ${JSON.stringify(w)}`)
    return 'glued, <tool_call>-wrapped, precedence, unknown-verb and fenced-write all correct'
  })

  // ---------- Wave 1: insight, git supercharge, smart terminal ----------
  await step('project insight: tech-debt radar over the index (oversized/dead/todo/untested)', async () => {
    const insMod = require(path.join(WORKDIR, 'main', 'insight.js'))
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    // Build a fixture with a debt signal: a TODO + a file with no tests.
    fs.writeFileSync(path.join(PROJ, 'src/todo.js'), '// TODO: refactor this\n// FIXME later\nfunction todoFn() {}\nmodule.exports = { todoFn }\n')
    indexMod.buildProjectIndex(PROJ)
    const ins = indexMod.projectInsight(PROJ)
    if (!ins.fileCount || !ins.totalSymbols) throw new Error(JSON.stringify(ins).slice(0, 120))
    if (!ins.debt.some((d) => d.kind === 'todo' && d.path === 'src/todo.js')) throw new Error('TODO not detected')
    if (ins.hasTests) throw new Error('fixture has no tests but hasTests=true')
    if (!ins.debt.some((d) => d.kind === 'untested')) throw new Error('untested signal missing')
    const summary = indexMod.insightSummary(PROJ)
    if (!summary.includes('Files indexed')) throw new Error('summary malformed')
    return `${ins.fileCount} files · ${ins.debt.length} debt signals`
  })

  await step('Project Brain: stack + db schema + env vars + graph + hotspots (no model)', async () => {
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const bp = path.join(WORKDIR, 'brainproj')
    fs.mkdirSync(path.join(bp, 'src'), { recursive: true })
    fs.mkdirSync(path.join(bp, 'prisma'), { recursive: true })
    fs.writeFileSync(path.join(bp, 'package.json'), JSON.stringify({ name: 'b', dependencies: { react: '^18', express: '^4' } }))
    fs.writeFileSync(path.join(bp, 'prisma/schema.prisma'), 'model User {\n  id Int @id\n}\nmodel Order {\n  id Int @id\n}\n')
    fs.writeFileSync(path.join(bp, '.env.example'), 'FOO=\nBAR=has-a-default\n')
    fs.mkdirSync(path.join(bp, 'src/lib'), { recursive: true })
    fs.writeFileSync(path.join(bp, 'src/lib/db.js'), 'const db = {}\nmodule.exports = { db }\n')
    fs.writeFileSync(path.join(bp, 'src/util.js'), 'function util() { return 1 }\nmodule.exports = { util }\n')
    // config.js uses a relative import, an npm import, AND the '@/' project alias.
    fs.writeFileSync(path.join(bp, 'src/config.js'), "import { db } from '@/lib/db'\nconst React = require('react')\nconst { util } = require('./util')\nconst foo = process.env.FOO\nmodule.exports = { foo, util, React, db }\n")
    fs.writeFileSync(path.join(bp, 'src/server.js'), "const app = require('./config')\nmodule.exports = app\n")
    indexMod.buildProjectIndex(bp)

    // architectureMap: nodes, resolved in-project edges, external deps
    const map = indexMod.architectureMap(bp)
    if (!map.nodes.some((n) => n.path === 'src/config.js')) throw new Error('config node missing')
    if (!map.nodes.some((n) => n.path === 'src/server.js' && n.isEntry)) throw new Error('server should be an entry node')
    if (!map.edges.some((e) => e.from === 'src/config.js' && e.to === 'src/util.js')) throw new Error(`edge config→util missing: ${JSON.stringify(map.edges)}`)
    if (!map.externalDeps.some((d) => d.name === 'react')) throw new Error('react external dep missing')
    // '@/lib/db' is a project alias — must be an EDGE, never an external dep.
    if (!map.edges.some((e) => e.from === 'src/config.js' && e.to === 'src/lib/db.js')) throw new Error(`@/ alias edge missing: ${JSON.stringify(map.edges)}`)
    if (map.externalDeps.some((d) => /^@\//.test(d.name))) throw new Error(`@/ alias wrongly listed as external dep: ${JSON.stringify(map.externalDeps)}`)

    // projectBrain composes it all
    const brain = await indexMod.projectBrain(bp)
    if (!brain.stack.frameworks.includes('React') || !brain.stack.frameworks.includes('Express')) throw new Error(`frameworks: ${JSON.stringify(brain.stack.frameworks)}`)
    const prisma = brain.dbSchema.find((d) => /prisma/.test(d.source))
    if (!prisma || !prisma.models.includes('User') || !prisma.models.includes('Order')) throw new Error(`db schema: ${JSON.stringify(brain.dbSchema)}`)
    const foo = brain.envVars.find((v) => v.name === 'FOO')
    const bar = brain.envVars.find((v) => v.name === 'BAR')
    if (!foo || !foo.declared || !foo.referenced) throw new Error(`FOO env wrong: ${JSON.stringify(brain.envVars)}`)
    if (!bar || !bar.declared || bar.referenced) throw new Error(`BAR should be declared-not-referenced: ${JSON.stringify(brain.envVars)}`)
    if (!brain.entryPoints.some((p) => /server\.js$/.test(p))) throw new Error(`entry points: ${JSON.stringify(brain.entryPoints)}`)
    if (!Array.isArray(brain.hotspots)) throw new Error('hotspots not an array')
    if (typeof brain.generatedAt !== 'number' || brain.partial !== false) throw new Error('generatedAt/partial wrong')
    // Cache HIT: second call returns the same object until the index rebuilds.
    if ((await indexMod.projectBrain(bp)) !== brain) throw new Error('brain not cached')
    // Cache INVALIDATION: touching the index must yield a FRESH brain object.
    while (Date.now() <= brain.generatedAt) { /* ensure the rebuild stamp is strictly newer */ }
    indexMod.refreshIndexedFile(bp, 'src/util.js') // bumps idx.builtAt past generatedAt
    const brain2 = await indexMod.projectBrain(bp)
    if (brain2 === brain) throw new Error('brain cache not invalidated after index rebuild')
    return `React/Express · ${prisma.models.length} models · FOO+BAR env · ${map.edges.length} edges · cache hit+invalidate`
  })

  await step('Team Brain: detects house style (tabs/single/no-semi/default/kebab); mixed → no block', async () => {
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const hp = path.join(WORKDIR, 'houseproj')
    fs.mkdirSync(path.join(hp, 'src'), { recursive: true })
    // tabs · single quotes · no semicolons · default export · kebab file names
    const f = (fn) => "import x from 'y'\nexport default function " + fn + "() {\n\treturn 'hi'\n}\n"
    fs.writeFileSync(path.join(hp, 'src/my-widget.js'), f('myWidget'))
    fs.writeFileSync(path.join(hp, 'src/data-loader.js'), f('dataLoader'))
    fs.writeFileSync(path.join(hp, 'src/user-card.js'), f('userCard'))
    indexMod.buildProjectIndex(hp)
    const hs = indexMod.detectHouseStyle(hp)
    if (hs.indent !== 'tabs') throw new Error(`indent: ${hs.indent}`)
    if (hs.quotes !== 'single') throw new Error(`quotes: ${hs.quotes}`)
    if (hs.semicolons !== false) throw new Error(`semicolons: ${hs.semicolons}`)
    if (hs.exportStyle !== 'default') throw new Error(`exportStyle: ${hs.exportStyle}`)
    if (hs.fileNaming !== 'kebab') throw new Error(`fileNaming: ${hs.fileNaming}`)
    if (hs.sampledFiles !== 3) throw new Error(`sampled: ${hs.sampledFiles}`)
    const prompt = indexMod.houseStylePrompt(hp)
    if (!/HOUSE STYLE/.test(prompt) || !/tabs/.test(prompt) || !/single quotes/.test(prompt) || !/default exports/.test(prompt)) throw new Error(`prompt: ${prompt}`)
    // Space-indented fixture WITH JSDoc block comments — the " * " lines (1 lead
    // space) must NOT defeat the 2-vs-4 indent classification.
    const sp = path.join(WORKDIR, 'spaceproj')
    fs.mkdirSync(path.join(sp, 'src'), { recursive: true })
    const g = (fn) => '/**\n * A helper.\n */\nexport const ' + fn + ' = () => {\n  const a = 1;\n  const b = 2;\n  const c = 3;\n  return a + b + c;\n}\n'
    fs.writeFileSync(path.join(sp, 'src/alpha.js'), g('alpha'))
    fs.writeFileSync(path.join(sp, 'src/beta.js'), g('beta'))
    fs.writeFileSync(path.join(sp, 'src/gamma.js'), g('gamma'))
    indexMod.buildProjectIndex(sp)
    const hs2 = indexMod.detectHouseStyle(sp)
    if (hs2.indent !== '2-spaces') throw new Error(`space indent not detected past JSDoc: ${hs2.indent}`)
    if (hs2.exportStyle !== 'named') throw new Error(`named export not detected: ${hs2.exportStyle}`)
    if (hs2.semicolons !== true) throw new Error(`semicolons not detected: ${hs2.semicolons}`)
    // A project with no code files yields no house-style block (nothing to enforce).
    const emptyp = path.join(WORKDIR, 'emptyhouse')
    fs.mkdirSync(emptyp, { recursive: true })
    fs.writeFileSync(path.join(emptyp, 'notes.txt'), 'just prose, not code\n')
    indexMod.buildProjectIndex(emptyp)
    if (indexMod.houseStylePrompt(emptyp) !== '') throw new Error('empty project should give no house-style block')
    return `tabs/single/no-semi/default/kebab + 2-space/named/semi (past JSDoc); empty → ''`
  })

  await step('Auto-Context Packs: file-seed pulls imports + importers; query-seed degrades to search', async () => {
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const bp = path.join(WORKDIR, 'brainproj') // fixture from the Project Brain step (config→util, @/lib/db, server→config)
    indexMod.buildProjectIndex(bp)
    const pack = indexMod.contextPack(bp, 'src/config.js')
    if (pack.seedKind !== 'file') throw new Error('file seed not recognized: ' + pack.seedKind)
    const byPath = Object.fromEntries(pack.files.map((f) => [f.path, f]))
    if (!byPath['src/config.js'] || byPath['src/config.js'].reason !== 'seed' || byPath['src/config.js'].score !== 100) throw new Error('seed missing/wrong')
    if (!byPath['src/util.js'] || byPath['src/util.js'].reason !== 'import') throw new Error('relative import (util) missing: ' + JSON.stringify(pack.files.map((f) => f.path)))
    if (!byPath['src/lib/db.js'] || byPath['src/lib/db.js'].reason !== 'import') throw new Error('@/ alias import (lib/db) missing')
    if (!byPath['src/server.js'] || byPath['src/server.js'].reason !== 'importer') throw new Error('importer (server) missing')
    // An absolute seed normalizes to project-relative and still resolves as a file.
    if (indexMod.contextPack(bp, path.join(bp, 'src/config.js')).seedKind !== 'file') throw new Error('absolute seed not normalized')
    // A free-text seed degrades to a direct file-name/symbol scan (NOT indexSearch,
    // whose import hits could starve real matches).
    const q = indexMod.contextPack(bp, 'util')
    if (q.seedKind !== 'query') throw new Error('query seed misclassified: ' + q.seedKind)
    if (!q.files.some((f) => /util/i.test(f.path))) throw new Error('query did not find util')
    // A query that matches only a SYMBOL (not any path) must still find the file:
    // 'foo' is a symbol in src/config.js whose path contains no "foo".
    const bySymbol = indexMod.contextPack(bp, 'foo')
    if (!bySymbol.files.some((f) => f.path === 'src/config.js')) throw new Error('symbol-only query did not find config.js: ' + JSON.stringify(bySymbol.files.map((f) => f.path)))
    return `file-seed: seed+imports(${Object.keys(byPath).length}) incl @/ alias + importer; query name+symbol scan ok`
  })

  await step('Project Decisions: add/list (newest-first); decisionsPrompt injects; empty → ""', async () => {
    const dec = require(path.join(WORKDIR, 'main', 'decisions.js'))
    const dp = path.join(WORKDIR, 'decproj')
    fs.mkdirSync(dp, { recursive: true })
    dec.addDecision(dp, { title: 'Auth uses JWT, not sessions', detail: 'stateless API' })
    dec.addDecision(dp, { title: 'Prices are records, never charges' })
    const list = dec.listDecisions(dp)
    if (list.length !== 2 || list[0].title !== 'Prices are records, never charges') throw new Error('decisions not newest-first: ' + JSON.stringify(list))
    dec.addDecision(dp, { title: '' }) // titleless is noise → ignored
    if (dec.listDecisions(dp).length !== 2) throw new Error('titleless decision was stored')
    const prompt = dec.decisionsPrompt(dp)
    if (!/PROJECT DECISIONS/.test(prompt) || !/Auth uses JWT/.test(prompt)) throw new Error('decisionsPrompt missing content: ' + prompt)
    if (dec.decisionsPrompt(path.join(WORKDIR, 'nodecisions')) !== '') throw new Error('empty project should yield no decisions block')
    // One corrupt/half-written line must not discard the rest.
    const decFile = path.join(app.getPath('userData'), 'decisions', require('node:crypto').createHash('sha1').update(dp).digest('hex') + '.jsonl')
    fs.appendFileSync(decFile, '{"ts":9,"title":"truncated\n') // a broken line
    dec.addDecision(dp, { title: 'Use PostgreSQL on Hetzner' })
    const after = dec.listDecisions(dp)
    if (!after.some((d) => d.title === 'Use PostgreSQL on Hetzner') || !after.some((d) => d.title === 'Auth uses JWT, not sessions')) throw new Error('a corrupt line discarded valid decisions: ' + JSON.stringify(after.map((d) => d.title)))
    // The agent actually INJECTS decisions into the SYSTEM prompt, BEFORE the protocol
    // (verified via the mock's system-capture hook).
    dec.addDecision(PROJ, { title: 'Never touch the payments table', detail: 'compliance' })
    const sysLog = path.join(WORKDIR, 'system-capture.txt')
    process.env.STUDIO_MOCK_SYSTEM_LOG = sysLog
    try {
      writeScript(['ACTION done\nnoted'])
      events.length = 0
      await agent.startAgent({ projectPath: PROJ, instruction: 'noop', mode: 'build', provider: 'mock', newChat: true }, emit)
    } finally {
      delete process.env.STUDIO_MOCK_SYSTEM_LOG
    }
    const captured = fs.readFileSync(sysLog, 'utf8')
    if (!/PROJECT DECISIONS/.test(captured) || !/Never touch the payments table/.test(captured)) throw new Error('decisions not injected into the agent SYSTEM prompt')
    if (!(captured.indexOf('PROJECT DECISIONS') < captured.indexOf('You are the ATOMIC Studio agent'))) throw new Error('decisions must be injected BEFORE the protocol rules')
    return `2 decisions newest-first; titleless+corrupt-line survived; injected into SYSTEM before protocol`
  })

  await step('Analytics-over-time: same-day snapshots dedupe (replace); list ascending, not reversed', async () => {
    const an = require(path.join(WORKDIR, 'main', 'analytics.js'))
    const ap = path.join(WORKDIR, 'anproj')
    fs.mkdirSync(ap, { recursive: true })
    an.analyticsRecord(ap, { score: 70, debtCount: 3, secrets: null, fileCount: 10, agentRunsDone: 0 })
    an.analyticsRecord(ap, { score: 85, debtCount: 1, secrets: 0, fileCount: 10, agentRunsDone: 2 }) // same day → REPLACES
    const rows = an.analyticsList(ap)
    if (rows.length !== 1) throw new Error('same-day snapshots were not deduped: ' + rows.length)
    if (rows[0].score !== 85 || rows[0].secrets !== 0) throw new Error('dedupe kept the wrong (stale) row: ' + JSON.stringify(rows[0]))
    // A row stamped a different day appends and stays in ascending (time-axis) order.
    const p2 = path.join(WORKDIR, 'anproj2')
    fs.mkdirSync(p2, { recursive: true })
    const file = path.join(app.getPath('userData'), 'analytics', require('node:crypto').createHash('sha1').update(p2).digest('hex') + '.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ts: Date.parse('2020-01-01'), score: 50, debtCount: 5, secrets: null, fileCount: 8, agentRunsDone: 0 }) + '\n')
    an.analyticsRecord(p2, { score: 90, debtCount: 0, secrets: 0, fileCount: 8, agentRunsDone: 1 }) // today → appends
    const two = an.analyticsList(p2)
    if (two.length !== 2) throw new Error('different-day row did not append: ' + two.length)
    if (!(two[0].ts < two[1].ts)) throw new Error('list not ascending (must not be reversed): ' + JSON.stringify(two.map((r) => r.ts)))
    if (two[0].score !== 50 || two[1].score !== 90) throw new Error('order wrong: ' + JSON.stringify(two.map((r) => r.score)))
    return `same-day deduped (kept newest); different day appended; ascending order`
  })

  await step('Architecture Drift: baseline == current → no drift; a new module shows as added', async () => {
    const driftMod = require(path.join(WORKDIR, 'main', 'drift.js'))
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const dpr = path.join(WORKDIR, 'driftproj')
    fs.mkdirSync(path.join(dpr, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dpr, 'src/a.js'), "const x = require('./b')\nmodule.exports = x\n")
    fs.writeFileSync(path.join(dpr, 'src/b.js'), "const r = require('react')\nmodule.exports = 1\n")
    indexMod.buildProjectIndex(dpr)
    const base = driftMod.saveArchBaseline(dpr)
    if (typeof base.capturedAt !== 'number' || !(base.map.nodes.length >= 2)) throw new Error('baseline malformed: ' + JSON.stringify(base).slice(0, 120))
    let d = driftMod.archDrift(dpr)
    if (!d.hasBaseline) throw new Error('baseline not detected')
    if (d.modules.added.length || d.modules.removed.length || d.edges.added.length || d.edges.removed.length || d.externalDeps.added.length) throw new Error('baseline==current should be no drift: ' + JSON.stringify(d))
    // Add a new module that imports an existing one and a new external dep.
    fs.writeFileSync(path.join(dpr, 'src/c.js'), "const a = require('./a')\nconst axios = require('axios')\nmodule.exports = a\n")
    indexMod.buildProjectIndex(dpr)
    d = driftMod.archDrift(dpr)
    if (!d.modules.added.includes('src/c.js')) throw new Error('new module not detected as drift: ' + JSON.stringify(d.modules))
    if (!d.edges.added.some((e) => e.from === 'src/c.js' && e.to === 'src/a.js')) throw new Error('new edge not detected: ' + JSON.stringify(d.edges.added))
    if (!d.externalDeps.added.includes('axios')) throw new Error('new external dep not detected: ' + JSON.stringify(d.externalDeps))
    if (d.partial !== false) throw new Error('small full-graph baseline should not be flagged partial')
    // Full-graph mode lifts the top-20 external-dep cap so drift is exact: a file
    // importing 25 packages shows all 25 in full mode but only 20 in the capped Live Map.
    const many = 'const p = [' + Array.from({ length: 25 }, (_, i) => `require('pkg${i}')`).join(', ') + ']\nmodule.exports = p\n'
    fs.writeFileSync(path.join(dpr, 'src/many.js'), many)
    indexMod.buildProjectIndex(dpr)
    if (indexMod.architectureMap(dpr).externalDeps.length !== 20) throw new Error('capped map should still cap deps at 20')
    if (!(indexMod.architectureMap(dpr, { full: true }).externalDeps.length > 20)) throw new Error('full map should expose all 25 deps')
    driftMod.saveArchBaseline(dpr) // re-baseline with the 25 deps
    if (driftMod.archDrift(dpr).partial !== false) throw new Error('full-graph baseline with 25 deps should NOT be partial (< MAX_FILES)')
    // extractImports: a >40-import file keeps ALL imports (cap lifted) AND is
    // ORDER-STABLE, so an auto-sorter reordering imports can't cause phantom edge drift.
    const src45 = Array.from({ length: 45 }, (_, i) => `import x${i} from './m${i}'`).join('\n')
    const imps = indexMod.extractImports(src45)
    if (imps.length !== 45) throw new Error('extractImports cap not lifted past 40: ' + imps.length)
    const rev = indexMod.extractImports(src45.split('\n').reverse().join('\n'))
    if (JSON.stringify(imps) !== JSON.stringify(rev)) throw new Error('extractImports is not order-stable (reorder would cause phantom drift)')
    // A project with no baseline → hasBaseline:false, empty diffs.
    const nb = driftMod.archDrift(path.join(WORKDIR, 'nobaseline'))
    if (nb.hasBaseline || nb.modules.added.length) throw new Error('no-baseline project should report hasBaseline:false')
    // diffArch is truly SET-based: a reordered-but-identical map has zero drift.
    const shuffled = {
      nodes: [...base.map.nodes].reverse(),
      edges: [...base.map.edges].reverse(),
      externalDeps: [...base.map.externalDeps].reverse()
    }
    const same = driftMod.diffArch(base.map, shuffled)
    if (same.modules.added.length || same.modules.removed.length || same.edges.added.length || same.edges.removed.length || same.externalDeps.added.length || same.externalDeps.removed.length)
      throw new Error('diffArch is order-sensitive (not set-based): ' + JSON.stringify(same))
    // A truncated/old-shape baseline on disk must NOT crash archDrift.
    const badProj = path.join(WORKDIR, 'badbaseline')
    fs.mkdirSync(path.join(badProj, 'src'), { recursive: true })
    fs.writeFileSync(path.join(badProj, 'src/z.js'), 'module.exports = 1\n')
    indexMod.buildProjectIndex(badProj)
    const bFile = path.join(app.getPath('userData'), 'arch-baseline', require('node:crypto').createHash('sha1').update(badProj).digest('hex') + '.json')
    fs.mkdirSync(path.dirname(bFile), { recursive: true })
    fs.writeFileSync(bFile, JSON.stringify({ capturedAt: 1, map: { nodes: [] } })) // missing edges/externalDeps
    const bad = driftMod.archDrift(badProj) // must not throw
    if (bad.hasBaseline) throw new Error('a malformed baseline should be treated as no baseline, not diffed')
    return `no-drift on baseline; +module/+edge/+dep detected; order-independent; malformed baseline safe`
  })

  await step('Development Replay: foldReplay merges ledger + history + runs, newest-first, STRICTLY per-project', async () => {
    const { foldReplay } = require(path.join(WORKDIR, 'shared', 'replay.js'))
    const P = '/proj/A'
    const events = foldReplay({
      ledger: [{ ts: 100, file: 'src/x.js', why: 'add x', model: 'm' }],
      history: [
        { label: 'A old', file: '/proj/A/a1.js', ts: 200 }, // idx 0 A — a project-B edit sits ABOVE it → UNSAFE to revert
        { label: 'B edit', file: '/proj/B/secret.env', ts: 250 }, // idx 1 B — filtered out (not shown)
        { label: 'A new', file: '/proj/A/a2.js', ts: 300 } // idx 2 A — top of stack → SAFE to revert
      ],
      finished: [
        { runId: 1, instruction: 'build the thing', projectPath: P, mode: 'build', status: 'done', turns: 4, stagedCount: 1, startedAt: 380, endedAt: 400 },
        { runId: 2, instruction: 'other project run', projectPath: '/proj/B', mode: 'build', status: 'done', turns: 2, stagedCount: 0, startedAt: 500, endedAt: 520 }
      ],
      project: P
    })
    const ts = events.map((e) => e.ts)
    for (let i = 1; i < ts.length; i++) if (ts[i] > ts[i - 1]) throw new Error('not newest-first: ' + JSON.stringify(ts))
    // Cross-project leaks excluded (run AND manual change from project B).
    if (events.some((e) => /other project/.test(e.title))) throw new Error('cross-project run leaked')
    if (events.some((e) => e.file && /\/proj\/B\//.test(e.file))) throw new Error("another project's file leaked into the story")
    if (!events.some((e) => e.kind === 'agent-run' && e.title === 'build the thing')) throw new Error('this-project run missing')
    if (!events.some((e) => e.kind === 'ai-edit' && e.file === 'src/x.js')) throw new Error('ledger edit missing')
    // 'A new' is the top of the global stack → revert is cross-project-SAFE (stackIndex set).
    const safeChange = events.find((e) => e.kind === 'change' && e.title === 'A new')
    if (!safeChange || safeChange.stackIndex !== 2) throw new Error('safe change stackIndex wrong (full-array position 2): ' + JSON.stringify(safeChange))
    // 'A old' has a project-B edit above it → reverting would clobber B → NO revert offered.
    const unsafeChange = events.find((e) => e.kind === 'change' && e.title === 'A old')
    if (!unsafeChange || unsafeChange.stackIndex != null) throw new Error('cross-project-unsafe change must NOT offer revert (stackIndex omitted): ' + JSON.stringify(unsafeChange))
    if (events.length !== 4) throw new Error('expected 4 events (2 A changes shown, B run + B change excluded): ' + events.length)
    return `4 events, newest-first; B excluded; safe change reverts, cross-project-unsafe change does not`
  })

  await step('explainer / git-draft / output-explain via mock provider', async () => {
    const insMod = require(path.join(WORKDIR, 'main', 'insight.js'))
    // Personas were removed (each was one sentence appended to the system prompt, and the default
    // was an empty string); this step keeps the three AI helpers that shipped alongside them.
    if (insMod.PERSONAS || insMod.personaSystem) throw new Error('persona registry should be gone')

    // Mock provider deterministic replies for the three AI helpers.
    process.env.STUDIO_MOCK_SCRIPT = SCRIPT_FILE
    writeScript(['EXPLAINED_PROJECT'])
    const ex = await insMod.explainProject(PROJ, 'mock')
    if (!ex.ok || ex.text !== 'EXPLAINED_PROJECT' || !ex.insight) throw new Error(JSON.stringify(ex).slice(0, 120))

    writeScript(['feat: add greeting'])
    const commit = await insMod.draftGitText('commit', 'diff --git a/x b/x\n+hello', 'mock')
    if (!commit.ok || commit.text !== 'feat: add greeting') throw new Error(JSON.stringify(commit))
    const empty = await insMod.draftGitText('commit', '   ', 'mock')
    if (empty.ok) throw new Error('empty diff accepted')

    writeScript(['That command failed because the port was busy.'])
    const out = await insMod.explainOutput('Error: EADDRINUSE :3000', 'mock')
    if (!out.ok || !out.text.includes('port')) throw new Error(JSON.stringify(out))
    return 'explainer + commit-draft + output-explain all ok'
  })

  await step('a run with no persona field still completes (persona removed from AgentRunRequest)', async () => {
    writeScript(['ACTION done\nDone.'])
    events.length = 0
    const res = await agent.startAgent({ projectPath: PROJ, instruction: 'x', mode: 'plan', provider: 'mock', newChat: true }, emit)
    if (!res.ok) throw new Error(JSON.stringify(res))
    if (byType('done').length !== 1) throw new Error('run did not finish')
    return 'agent runs without a persona field'
  })

  // ---------- Wave 2: named guarantees ----------
  const providersMod = require(path.join(WORKDIR, 'main', 'providers.js'))

  await step('spend meter: usage ledger records requests/tokens/model; cap refuses past ceiling', async () => {
    // mock isn't metered — exercise the cap logic with a stub metered provider by
    // driving recordUsage through a real (openai-kind) that we won't call; instead
    // verify via the exported helpers + a groq-shaped complete that errors on no key.
    providersMod.resetUsage()
    providersMod.setSpendCap(0)
    let u = providersMod.getUsage()
    if (u.requests !== 0 || u.estTokens !== 0) throw new Error('usage not reset')
    // A metered provider with no key returns before recording — usage stays 0.
    const noKey = await providersMod.complete({ providerId: 'groq', system: 'x', user: 'y' })
    if (noKey.ok) throw new Error('groq without key should fail')
    if (providersMod.getUsage().requests !== 0) throw new Error('failed call recorded usage')
    // Model receipt: a mock call returns the model and does NOT meter.
    process.env.STUDIO_MOCK_SCRIPT = SCRIPT_FILE
    writeScript(['hello'])
    const mk = await providersMod.complete({ providerId: 'mock', system: 's', user: 'u' })
    if (!mk.ok || mk.model !== 'scripted') throw new Error(`model receipt: ${JSON.stringify(mk)}`)
    if (providersMod.getUsage().requests !== 0) throw new Error('mock should not be metered')
    // Cap enforcement: force usage past a cap and confirm a metered call refuses.
    providersMod.setSpendCap(1) // 1 token cap
    // Manually push usage over the cap via a metered-provider-shaped path: simulate
    // by setting a tiny cap then calling groq (no key → returns before cap check?).
    // The cap check runs BEFORE the key check, so an over-cap metered call refuses.
    // Seed usage: call the openai path is network — instead assert the guard directly.
    const capState = providersMod.getUsage()
    if (capState.capTokens !== 1) throw new Error('cap not set')
    return `usage tracked, mock unmetered, model receipt="${mk.model}", cap=${capState.capTokens}`
  })

  await step('spend cap: a big prompt is refused BEFORE dispatch (pre-flight, no network)', async () => {
    // ollama is metered (kind openai) but needs no key. With cap=1 and a large
    // prompt, the pre-flight check must refuse WITHOUT ever hitting the network —
    // a single oversized request can't blow past the cap and only get caught next
    // time. (If it dispatched, it would hang/ECONNREFUSED, not return "budget".)
    providersMod.resetUsage()
    providersMod.setSpendCap(1)
    const big = 'x'.repeat(10_000)
    const blocked = await providersMod.complete({ providerId: 'ollama', system: big, user: big })
    if (blocked.ok) throw new Error('big prompt was not refused')
    if (!/budget cap/i.test(blocked.error || '')) throw new Error(`wrong refusal: ${blocked.error}`)
    // Usage must be untouched — a refused call never bills.
    if (providersMod.getUsage().requests !== 0) throw new Error('refused call was billed')
    // And an unlimited cap never blocks (mock is unmetered anyway).
    providersMod.setSpendCap(0)
    const ok = await providersMod.complete({ providerId: 'mock', system: 's', user: 'u' })
    if (!ok.ok) throw new Error('unlimited cap blocked a call')
    return 'oversized prompt refused pre-flight, unbilled; unlimited cap passes'
  })

  await step('Air-Gapped Mode: complete() blocks outbound providers; local + mock stay allowed', async () => {
    const policyMod = require(path.join(WORKDIR, 'main', 'policy.js'))
    policyMod.setAirGap(true)
    try {
      // An outbound provider is refused BEFORE the needs-key check (and never dispatched).
      const blocked = await providersMod.complete({ providerId: 'anthropic', system: 's', user: 'u' })
      if (blocked.ok || !/air-gapped/i.test(blocked.error || '')) throw new Error(`anthropic not air-gap-blocked: ${JSON.stringify(blocked)}`)
      // The test mock must stay allowed, or the whole suite would break under air-gap.
      const mock = await providersMod.complete({ providerId: 'mock', system: 's', user: 'u' })
      if (!mock.ok) throw new Error('mock blocked under air-gap')
      // Ollama is local → it passes the guard and reaches dispatch (fails only on
      // the local connection), proving it was NOT air-gap-refused.
      const local = await providersMod.complete({ providerId: 'ollama', system: 's', user: 'u' })
      if (!local.ok && /air-gapped/i.test(local.error || '')) throw new Error('ollama wrongly air-gap-blocked')
    } finally {
      policyMod.setAirGap(false)
      policyMod.resetPolicyCache()
    }
    // Cleared → anthropic passes the air-gap guard and now fails only on the missing key.
    const off = await providersMod.complete({ providerId: 'anthropic', system: 's', user: 'u' })
    if (off.ok || /air-gapped/i.test(off.error || '')) throw new Error(`air-gap did not clear: ${JSON.stringify(off)}`)
    if (!/api key/i.test(off.error || '')) throw new Error(`expected missing-key after air-gap off: ${off.error}`)

    // MDM floor: an enterprise-policy-forced air-gap CANNOT be lifted by setAirGap(false).
    const policyFile = path.join(WORKDIR, 'airgap-policy.json')
    fs.writeFileSync(policyFile, JSON.stringify({ airGap: true }))
    const prevEnv = process.env.STUDIO_ENTERPRISE_POLICY
    process.env.STUDIO_ENTERPRISE_POLICY = policyFile
    try {
      policyMod.resetPolicyCache()
      policyMod.setAirGap(false) // user tries to turn it off…
      if (policyMod.getAirGap() !== true) throw new Error('MDM-forced air-gap was liftable by the user')
      const stillBlocked = await providersMod.complete({ providerId: 'anthropic', system: 's', user: 'u' })
      if (stillBlocked.ok || !/air-gapped/i.test(stillBlocked.error || '')) throw new Error('MDM air-gap did not block a provider')
    } finally {
      if (prevEnv === undefined) delete process.env.STUDIO_ENTERPRISE_POLICY
      else process.env.STUDIO_ENTERPRISE_POLICY = prevEnv
      policyMod.resetPolicyCache()
      policyMod.setAirGap(false)
    }
    return 'anthropic blocked when air-gapped; mock+ollama allowed; user-clear works; MDM floor un-liftable'
  })

  await step('Time-Machine checkpoints: restore rewinds a run', async () => {
    const fsvc = require(path.join(WORKDIR, 'main', 'fs-service.js'))
    const f = path.join(PROJ, 'src/cp.js')
    fs.writeFileSync(f, 'v0\n')
    const cpId = undo.checkpoint('Before: test run')
    fsvc.writeFile(PROJ, 'src/cp.js', 'v1\n')
    fsvc.writeFile(PROJ, 'src/cp.js', 'v2\n')
    if (!undo.checkpoints().some((c) => c.id === cpId)) throw new Error('checkpoint not listed')
    const restored = undo.restoreToCheckpoint(cpId)
    if (restored.length < 1) throw new Error('nothing restored')
    if (fs.readFileSync(f, 'utf8') !== 'v0\n') throw new Error(`restore left ${fs.readFileSync(f, 'utf8')}`)
    return `checkpoint restored ${restored.length} change(s) → back to v0`
  })

  await step('Time-Machine: a checkpoint drained past by plain Undo is pruned, never resurrected', async () => {
    // The actual bug the fix targets: undo PAST a checkpoint, then do unrelated
    // work — the stale mark must be gone, not silently revert the new work.
    const fsvc = require(path.join(WORKDIR, 'main', 'fs-service.js'))
    const f = path.join(PROJ, 'src/zombie.js')
    fs.writeFileSync(f, 'base\n')
    fsvc.writeFile(PROJ, 'src/zombie.js', 'pre\n') // one snapshot BELOW the checkpoint
    const cp = undo.checkpoint('Before: run B')
    fsvc.writeFile(PROJ, 'src/zombie.js', 'b1\n') // one snapshot ABOVE it
    undo.undo() // pop b1 → file "pre"; mark still valid (at its own depth)
    undo.undo() // pop pre → drains BELOW the mark → mark must be pruned now
    // Unrelated new work pushes the stack back above the mark's old depth.
    fsvc.writeFile(PROJ, 'src/zombie.js', 'u1\n')
    fsvc.writeFile(PROJ, 'src/zombie.js', 'u2\n')
    if (undo.checkpoints().some((c) => c.id === cp)) throw new Error('drained checkpoint was not pruned')
    const zombie = undo.restoreToCheckpoint(cp) // must be a no-op on a dead mark
    if (zombie.length) throw new Error('stale checkpoint resurrected and reverted unrelated work')
    if (fs.readFileSync(f, 'utf8') !== 'u2\n') throw new Error(`resurrection clobbered work → ${fs.readFileSync(f, 'utf8')}`)
    return 'drained checkpoint pruned; unrelated work survived (no resurrection)'
  })

  await step('Loop Breaker: agent halts after repeating the same error', async () => {
    // The model keeps trying to read a file outside the root (always ERROR).
    writeScript([
      'ACTION read_file ../../../etc/hosts',
      'ACTION read_file ../../../etc/hosts',
      'ACTION read_file ../../../etc/hosts',
      'ACTION read_file ../../../etc/hosts',
      'ACTION done\nshould not reach'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'loop', mode: 'build', provider: 'mock', newChat: true }, emit)
    const err = byType('error')
    if (!err.some((e) => /stuck/i.test(e.error))) throw new Error(`no loop-break error: ${JSON.stringify(err)}`)
    if (byType('done').length) throw new Error('reached done despite the loop')
    return 'halted on the 3rd identical error'
  })

  await step('Loop Breaker: halts on a repeatedly FAILING run (nonzero exit, not "ERROR:")', async () => {
    // Regression: run failures read "exit code: 1", not "ERROR:"/"REFUSED:" — the
    // old prefix-only breaker never tripped on a build/test that keeps failing.
    fs.writeFileSync(path.join(PROJ, 'fail.js'), 'process.exit(1)\n')
    writeScript([
      'ACTION run node fail.js',
      'ACTION run node fail.js',
      'ACTION run node fail.js',
      'ACTION run node fail.js',
      'ACTION done\nshould not reach'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'keep running the failing script', mode: 'build', provider: 'mock', newChat: true }, emit)
    if (!byType('error').some((e) => /stuck/i.test(e.error))) throw new Error('failing run did not trip the breaker')
    if (byType('done').length) throw new Error('reached done despite the failing loop')
    return 'halted on the 3rd identical failing run'
  })

  await step('Loop Breaker: failing run whose OUTPUT prints "exit code: 0" still trips it', async () => {
    // Regression: the reset regex must be anchored to ^ — a command that fails
    // (exit 1) but echoes "exit code: 0" in its output must NOT read as success.
    fs.writeFileSync(path.join(PROJ, 'fail0.js'), 'console.log("exit code: 0 for step A"); process.exit(1)\n')
    writeScript([
      'ACTION run node fail0.js',
      'ACTION run node fail0.js',
      'ACTION run node fail0.js',
      'ACTION run node fail0.js',
      'ACTION done\nshould not reach'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'run the deceptive failing script', mode: 'build', provider: 'mock', newChat: true }, emit)
    if (!byType('error').some((e) => /stuck/i.test(e.error))) throw new Error('deceptive failing run did not trip the breaker')
    if (byType('done').length) throw new Error('reached done despite the failing loop')
    return 'anchored regex: output "exit code: 0" no longer masks a real failure'
  })

  await step('Loop Breaker: a SUCCESSFUL read whose content starts "ERROR:" never trips it', async () => {
    // Regression: the breaker keyed on the observation prefix, so reading a file
    // that literally begins with "ERROR:" three times looked like a stuck loop.
    fs.writeFileSync(path.join(PROJ, 'log.txt'), 'ERROR: something logged here\nmore lines\n')
    writeScript([
      'ACTION read_file log.txt',
      'ACTION read_file log.txt',
      'ACTION read_file log.txt',
      'ACTION done\nread the log three times, no problem'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'inspect the log', mode: 'build', provider: 'mock', newChat: true }, emit)
    if (byType('error').some((e) => /stuck/i.test(e.error))) throw new Error('false loop-break on a successful read')
    if (!byType('done').length) throw new Error('did not finish normally')
    return 'three clean reads → finished, no false stall'
  })

  await step('What-Changed ledger: records only APPLIED edits (with {file,why,model})', async () => {
    const ledgerMod = require(path.join(WORKDIR, 'main', 'ledger.js'))
    const APPLY_PROJ = path.join(WORKDIR, 'ledgerproj')
    fs.mkdirSync(path.join(APPLY_PROJ, 'src'), { recursive: true })
    writeScript([
      "ACTION write src/led.js\n```js\nmodule.exports = 2\n```",
      'ACTION done\nwrote led.js'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: APPLY_PROJ, instruction: 'add a constant for the banner', mode: 'build', provider: 'mock', newChat: true }, emit)
    // Build mode auto-applies — the ledger records at that same moment, no separate apply step needed.
    const list = ledgerMod.ledgerList(APPLY_PROJ)
    const hit = list.find((e) => e.file === 'src/led.js')
    if (!hit || !hit.why.includes('banner') || hit.model !== 'scripted') throw new Error(JSON.stringify(list.slice(0, 3)))
    const found = ledgerMod.ledgerSearch(APPLY_PROJ, 'banner')
    if (!found.some((e) => e.file === 'src/led.js')) throw new Error('search missed it')
    return `ledger records on apply only: "${hit.file}" — "${hit.why.slice(0, 24)}…" via ${hit.model}`
  })

  await step('Confidence Meter: read-before-write, size ratio, and new-file signals on staged edits', async () => {
    fs.writeFileSync(path.join(PROJ, 'src/app.js'), "function greet() {\n  return 'hi'\n}\nmodule.exports = { greet }\n")
    fs.writeFileSync(path.join(PROJ, 'src/plain.js'), 'module.exports = 1\n')
    // A 20-line file so a blind ONE-line change is a 'surgical' (low) size ratio.
    const bigLines = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n'
    fs.writeFileSync(path.join(PROJ, 'src/surgical.js'), bigLines)
    // A tiny file rewritten far bigger → a 'sweeping' (ratio > 1) change.
    fs.writeFileSync(path.join(PROJ, 'src/sweep.js'), 'const a = 1\nconst b = 2\n')
    writeScript([
      'ACTION read_file src/app.js', // read this file first
      "ACTION write src/app.js\n```js\nfunction greet() {\n  return 'hello there'\n}\nmodule.exports = { greet }\n```",
      "ACTION write src/plain.js\n```js\nmodule.exports = 2\n```", // blind edit (for read-vs-blind)
      'ACTION write src/surgical.js\n```js\n' + bigLines.replace('const v0 = 0', 'const v0 = 999') + '```', // blind + surgical
      'ACTION write src/sweep.js\n```js\nconst x = 1\nconst y = 2\nconst z = 3\nconst w = 4\nconst q = 5\nconst r = 6\n```', // blind + sweeping
      "ACTION write src/brandnew.js\n```js\nmodule.exports = { NEW: true }\n```", // new file
      'ACTION write src/leak.js\n```js\nconst AWS = "AKIA1234567890ABCDEF"\nmodule.exports = { AWS }\n```', // secret leak (for the staged-secret guard)
      'ACTION write src/bigleak.js\n```js\n' + Array.from({ length: 3001 }, (_, i) => 'const v' + i + ' = ' + i).join('\n') + '\nconst AWS = "AKIA1234567890ABCDEF"\n```', // >3000 lines → diff collapses to a marker
      'ACTION done\nstaged edits'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'edit files', mode: 'build', provider: 'mock', newChat: true }, emit)
    const edits = byType('staged').map((e) => e.edit)
    const app = edits.find((e) => e.path === 'src/app.js')
    const plain = edits.find((e) => e.path === 'src/plain.js')
    const surgical = edits.find((e) => e.path === 'src/surgical.js')
    const sweep = edits.find((e) => e.path === 'src/sweep.js')
    const fresh = edits.find((e) => e.path === 'src/brandnew.js')
    if (!app || app.readBeforeWrite !== true || app.beforeLines <= 0) throw new Error(`app signals wrong: ${JSON.stringify(app)}`)
    if (!plain || plain.readBeforeWrite !== false) throw new Error('plain.js should be a blind edit')
    if (!fresh || fresh.isNew !== true || fresh.readBeforeWrite !== false || fresh.sizeRatio !== 0) throw new Error(`new-file signals wrong: ${JSON.stringify(fresh)}`)
    if (typeof app.confidence !== 'number' || typeof fresh.confidence !== 'number') throw new Error('confidence missing')
    if (!(app.confidence > plain.confidence)) throw new Error(`read-first (${app.confidence}) should beat blind (${plain.confidence})`)
    // Size-ratio tiers (both blind): a surgical change must outscore a sweeping one.
    if (!surgical || surgical.readBeforeWrite !== false) throw new Error('surgical.js should be a blind edit')
    if (!sweep || sweep.readBeforeWrite !== false) throw new Error('sweep.js should be a blind edit')
    if (!(surgical.sizeRatio <= 0.25)) throw new Error(`surgical ratio not small: ${surgical.sizeRatio}`)
    if (!(sweep.sizeRatio > 1)) throw new Error(`sweep ratio not sweeping: ${sweep.sizeRatio}`)
    if (!(surgical.confidence > sweep.confidence)) throw new Error(`surgical (${surgical.confidence}) should beat sweeping (${sweep.confidence}) on size alone`)
    // Wave 16: Blind-Edit badge — a PURE predicate over the same staged signals. A blind edit is an
    // EXISTING file overwritten without a prior read; a brand-new file (isNew) is NEVER blind (nothing
    // to read) — that guard is why it must not scare on every new file.
    const { isBlindEdit } = require(path.join(WORKDIR, 'shared', 'actionplan.js'))
    if (isBlindEdit(app) !== false) throw new Error('read-first app.js must NOT be a blind edit')
    if (isBlindEdit(fresh) !== false) throw new Error('a brand-new file (isNew) must NEVER be a blind edit')
    for (const b of [plain, surgical, sweep]) if (isBlindEdit(b) !== true) throw new Error('an unread existing-file overwrite must be a blind edit: ' + b.path)
    // Wave 16: Secret Leak Guard — the same scanner over a staged edit's ADDED lines. The leak file is
    // flagged (count≥1, critical) with a GENERIC message (never the value); clean staged files are not.
    const sg = agent.scanStagedSecrets()
    if (!sg['src/leak.js'] || sg['src/leak.js'].count < 1 || sg['src/leak.js'].severity !== 'critical') throw new Error('a staged AWS-key leak must be flagged critical: ' + JSON.stringify(sg['src/leak.js']))
    if (/AKIA/.test(sg['src/leak.js'].message)) throw new Error('the staged-secret message must be generic, never the matched value')
    for (const clean of ['src/app.js', 'src/plain.js', 'src/brandnew.js']) if (sg[clean]) throw new Error('a clean staged file must NOT be flagged as a secret: ' + clean)
    // Wave 16 review fix 3: a >3000-line staged edit collapses to a diff marker (no real added lines);
    // the guard falls back to scanning the full staged content so a pasted key is still caught, not missed.
    if (!sg['src/bigleak.js'] || sg['src/bigleak.js'].severity !== 'critical') throw new Error('a secret in a >3000-line (diff-collapsed) staged file must still be flagged: ' + JSON.stringify(sg['src/bigleak.js']))
    // toPublic must carry the fields all the way to the 'applied' event (the #1 silent-drop bug) —
    // app.js auto-applied immediately, so it is gone from getAgentState().staged by now; the event
    // stream is the durable record of what toPublic actually produced at stage time.
    const appliedApp = byType('applied').find((e) => e.edit.path === 'src/app.js')
    if (!appliedApp || typeof appliedApp.edit.confidence !== 'number' || appliedApp.edit.readBeforeWrite !== true)
      throw new Error('confidence fields dropped by toPublic')
    // A fresh run must reset the read-set: re-editing app.js WITHOUT reading it is now blind.
    agent.rejectStaged('all')
    writeScript(["ACTION write src/app.js\n```js\nmodule.exports = { greet: () => 'x' }\n```", 'ACTION done\nblind rewrite'])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'rewrite blindly', mode: 'build', provider: 'mock', newChat: true }, emit)
    const app2 = byType('staged').map((e) => e.edit).find((e) => e.path === 'src/app.js')
    if (!app2 || app2.readBeforeWrite !== false) throw new Error('read-set not reset between runs')
    agent.rejectStaged('all')
    // Reading back the agent's OWN staged draft must NOT count as reading the file. A plain write now
    // auto-applies instantly, so the only way a draft STAYS staged (unapplied, genuinely re-readable as
    // "staged, not disk") long enough for this to matter is the Secret Leak Guard hold-back — use that
    // as the vehicle, same as everywhere else this file now needs a real still-staged edit.
    fs.writeFileSync(path.join(PROJ, 'src/draft.js'), 'module.exports = 1\n')
    writeScript([
      'ACTION write src/draft.js\n```js\nconst AWS = "AKIA1234567890ABCDEF"\nmodule.exports = { AWS: "2" }\n```', // blind, held back by Secret Leak Guard (readBeforeWrite=false)
      'ACTION read_file src/draft.js', // reads its OWN staged draft (fromStaged) — must not count
      'ACTION write src/draft.js\n```js\nconst AWS = "AKIA1234567890ABCDEF"\nmodule.exports = { AWS: "3" }\n```', // still blind, still held back
      'ACTION done\ndraft edits'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'edit draft', mode: 'build', provider: 'mock', newChat: true }, emit)
    const draft = byType('staged').map((e) => e.edit).filter((e) => e.path === 'src/draft.js').pop()
    if (!draft || draft.readBeforeWrite !== false) throw new Error('reading own staged draft wrongly counted as read-before-write')
    if (agent.getAgentState().staged.find((s) => s.path === 'src/draft.js') === undefined) throw new Error('secret-flagged draft.js should still be staged, not applied')
    agent.rejectStaged('all')
    return `read-first=${app.confidence}% · surgical=${surgical.confidence}% > sweeping=${sweep.confidence}% · new=${fresh.confidence}% · reset ✓ · draft-read≠read ✓`
  })

  await step('What-Changed ledger: a REJECTED stage never enters the ledger', async () => {
    // A plain write auto-applies now (no approval step), so the only thing left to reject before it
    // ever reaches the ledger is the Secret Leak Guard's hold-back case.
    const ledgerMod = require(path.join(WORKDIR, 'main', 'ledger.js'))
    const REJ_PROJ = path.join(WORKDIR, 'rejproj')
    fs.mkdirSync(path.join(REJ_PROJ, 'src'), { recursive: true })
    writeScript([
      'ACTION write src/nope.js\n```js\nconst AWS = "AKIA1234567890ABCDEF"\nmodule.exports = { AWS }\n```',
      'ACTION done\nstaged nope.js'
    ])
    events.length = 0
    await agent.startAgent({ projectPath: REJ_PROJ, instruction: 'change I will reject', mode: 'build', provider: 'mock', newChat: true }, emit)
    if (agent.getAgentState().staged.length !== 1) throw new Error('secret-flagged write should have stayed staged, not applied')
    agent.rejectStaged('all')
    await agent.applyStaged('all') // nothing left to apply
    if (ledgerMod.ledgerList(REJ_PROJ).some((e) => e.file === 'src/nope.js')) throw new Error('rejected edit leaked into the ledger')
    if (fs.existsSync(path.join(REJ_PROJ, 'src/nope.js'))) throw new Error('rejected edit was written to disk')
    return 'rejected stage left no ledger row and no file'
  })

  await step('Pre-Ship Security Gate: catches secrets, passes a clean project', async () => {
    const secMod = require(path.join(WORKDIR, 'main', 'security.js'))
    const secProj = path.join(WORKDIR, 'secproj', 'src')
    fs.mkdirSync(secProj, { recursive: true })
    fs.writeFileSync(path.join(secProj, 'clean.js'), 'export const x = 1\n')
    let rep = secMod.scanProject(path.join(WORKDIR, 'secproj'))
    if (!rep.ok || rep.findings.length) throw new Error(`clean project flagged: ${JSON.stringify(rep.findings)}`)
    // Seed a hardcoded AWS key + a private key + a placeholder (must NOT flag).
    fs.writeFileSync(path.join(secProj, 'config.js'), 'const AWS = "AKIA1234567890ABCDEF"\nconst apiKey = "your-key-here"\n')
    fs.writeFileSync(path.join(WORKDIR, 'secproj', '.env'), 'SECRET=abc123hardcodedvalue\n')
    rep = secMod.scanProject(path.join(WORKDIR, 'secproj'))
    if (rep.ok) throw new Error('secrets not caught')
    if (!rep.findings.some((f) => f.severity === 'critical' && /AWS/.test(f.message))) throw new Error('AWS key missed: ' + JSON.stringify(rep.findings))
    if (!rep.findings.some((f) => /\.env/.test(f.file) || /\.env/.test(f.message))) throw new Error('.env not flagged')
    if (rep.findings.some((f) => /your-key-here/i.test(f.message))) throw new Error('placeholder wrongly flagged')
    return `clean passes; ${rep.findings.length} findings on the seeded project`
  })

  await step('Security Gate: modern key shapes + placeholder-substring + .env.sample exclusion', async () => {
    const secMod = require(path.join(WORKDIR, 'main', 'security.js'))
    const p = path.join(WORKDIR, 'secproj2')
    const src = path.join(p, 'src')
    fs.mkdirSync(src, { recursive: true })
    // sk-proj- (new OpenAI project keys) and a PKCS#8 header must be caught.
    fs.writeFileSync(path.join(src, 'a.js'), 'const k = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV1234567890"\n')
    fs.writeFileSync(path.join(src, 'key.txt'), '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n')
    // A real key on a line that ALSO contains "example" elsewhere must still flag
    // (placeholder tested against the matched secret, not the whole line).
    fs.writeFileSync(path.join(src, 'b.js'), 'fetch("https://example.com", { key: "sk-live1234567890ABCDEFGH" })\n')
    // .env.sample is meant to be committed → must NOT be flagged as a leaked .env.
    fs.writeFileSync(path.join(p, '.env.sample'), 'SECRET=replace-me\n')
    // Ordinary kebab-case identifiers embed "sk-"/"disk-"/"task-" — the broadened
    // openai-key rule must NOT false-flag these on a clean project.
    fs.writeFileSync(path.join(src, 'kebab.js'), [
      'import helper from "../services/task-scheduler-background-worker-module"',
      'const cls = "disk-space-usage-indicator-widget-large-variant"',
      'const dep = "task-management-controller-helper-utility-service"'
    ].join('\n') + '\n')
    const rep = secMod.scanProject(p)
    if (!rep.findings.some((f) => /a\.js$/.test(f.file))) throw new Error('sk-proj- key missed')
    if (!rep.findings.some((f) => f.severity === 'critical' && /key\.txt$/.test(f.file))) throw new Error('PKCS#8 private key missed')
    if (!rep.findings.some((f) => /b\.js$/.test(f.file))) throw new Error('real key on an example line missed')
    if (rep.findings.some((f) => /\.env\.sample$/.test(f.file))) throw new Error('.env.sample wrongly flagged')
    if (rep.findings.some((f) => /kebab\.js$/.test(f.file))) throw new Error('kebab-case identifiers wrongly flagged as an API key')
    // Wave 16: scanLines is the EXTRACTED per-line loop shared by the whole-project gate AND the staged
    // guard (same RULES + PLACEHOLDER, so they can't drift). The passing scanProject asserts above already
    // prove the extract preserved behavior; here we pin scanLines directly.
    const sl = secMod.scanLines(['const AWS = "AKIA1234567890ABCDEF"', 'const ok = "your-key-here"', 'const plain = 1'])
    if (sl.length !== 1 || sl[0].severity !== 'critical' || sl[0].line !== 1) throw new Error('scanLines: exactly one critical AWS finding on line 1 (placeholder+plain clean): ' + JSON.stringify(sl))
    if (/AKIA/.test(sl[0].message)) throw new Error('scanLines message must be the generic rule text, never the matched value')
    return `sk-proj + PKCS#8 + example-line key caught; .env.sample + kebab-case ignored (${rep.findings.length} findings); scanLines pins the shared loop`
  })

  await step('Upload-Safety: .gitignore leak check — which secret files would be pushed to GitHub', async () => {
    const secMod = require(path.join(WORKDIR, 'main', 'security.js'))
    const si = secMod.scanIgnore
    // A conservative gitignore matcher over PRESENT paths: .env protected; id_rsa/dist/app.js/.DS_Store flagged.
    const r1 = si('node_modules\n.env\n', ['.env', 'id_rsa', 'dist/app.js', '.DS_Store'])
    const f1 = r1.map((x) => x.path)
    if (f1.includes('.env')) throw new Error('.env listed in .gitignore must be protected')
    for (const p of ['id_rsa', 'dist/app.js', '.DS_Store']) if (!f1.includes(p)) throw new Error('unignored ' + p + ' must be flagged')
    if (!r1.find((x) => x.path === 'id_rsa').sensitive) throw new Error('id_rsa must be classified sensitive')
    if (r1.find((x) => x.path === 'dist/app.js').sensitive) throw new Error('dist/app.js is junk, not a secret')
    // *.pem glob, /leading-slash anchor, dir/ trailing-slash each protect correctly.
    if (si('*.pem\n', ['secret.pem']).length !== 0) throw new Error('*.pem must protect secret.pem')
    if (si('*.pem\n', ['keys/secret.pem']).length !== 0) throw new Error('*.pem must protect a .pem at any depth')
    if (si('/dist\n', ['dist/app.js']).length !== 0) throw new Error('/dist must protect dist/app.js')
    if (si('/dist\n', ['src/dist/x.js']).length !== 1) throw new Error('/dist is anchored — must NOT protect a nested src/dist')
    if (si('logs/\n', ['logs/x.txt']).length !== 0) throw new Error('logs/ must protect everything under logs')
    // `**/name` protects that file at ANY depth (incl. root) — no false leak.
    if (si('**/id_rsa\n', ['id_rsa']).length !== 0) throw new Error('**/id_rsa must protect a root id_rsa')
    if (si('**/id_rsa\n', ['keys/deep/id_rsa']).length !== 0) throw new Error('**/id_rsa must protect a nested id_rsa')
    // negation: !keep.key un-protects that one file, the rest stay protected.
    const rn = si('*.key\n!keep.key\n', ['keep.key', 'other.key'])
    if (!rn.some((x) => x.path === 'keep.key')) throw new Error('!keep.key must un-protect keep.key')
    if (rn.some((x) => x.path === 'other.key')) throw new Error('other.key must stay protected by *.key')
    // A .gitignore covering ALL sensitive files → ZERO leaks (never a false "you're leaking this").
    if (si('id_rsa\n*.pem\ncredentials.json\n', ['id_rsa', 'keys/a.pem', 'credentials.json']).length !== 0) throw new Error('a covering .gitignore must yield ZERO leaks')
    // Review fix (FALSE POSITIVE): git can't re-include a file whose PARENT DIR is excluded, so
    // `secrets/` + `!secrets/keep.pem` leaves keep.pem IGNORED → must NOT be flagged as a leak.
    if (si('secrets/\n!secrets/keep.pem\n', ['secrets/keep.pem']).length !== 0) throw new Error('a `!` under an excluded dir must NOT re-include (false leak): ' + JSON.stringify(si('secrets/\n!secrets/keep.pem\n', ['secrets/keep.pem'])))
    // …but a direct-file `*.key` + `!keep.key` DOES re-include (flag keep.key) — negation of a leaf file.
    if (!si('*.key\n!keep.key\n', ['keep.key']).some((x) => x.path === 'keep.key')) throw new Error('a leaf-file `!keep.key` must still un-protect keep.key')
    // Review fix (FALSE NEGATIVE): a modern OpenSSH key (id_ed25519) with no matching .gitignore is a leak.
    const ed = secMod.scanIgnore('node_modules\n', ['deploy/id_ed25519'])
    if (!ed.some((x) => x.path === 'deploy/id_ed25519' && x.sensitive)) throw new Error('id_ed25519 must be recognized as a sensitive leak')
    // Review fix (dir-only): `logs/` matches a DIRECTORY, never a same-named FILE — so a FILE `logs` is not protected.
    if (si('logs/\n', ['logs']).length !== 1) throw new Error('a directory pattern (logs/) must NOT protect a same-named FILE')
    // e2e: scanProject over a project with an unignored id_rsa → a HIGH "would be uploaded" finding.
    const up = path.join(WORKDIR, 'uploadfx')
    fs.mkdirSync(path.join(up, 'src'), { recursive: true })
    fs.writeFileSync(path.join(up, 'id_rsa'), 'PRIVATE\n')
    fs.writeFileSync(path.join(up, '.gitignore'), 'node_modules\n')
    const u1 = secMod.scanProject(up)
    if (!u1.findings.some((f) => /id_rsa$/.test(f.file) && f.severity === 'high' && /uploaded to GitHub/i.test(f.message))) throw new Error('an unignored id_rsa must be a high upload-safety finding: ' + JSON.stringify(u1.findings))
    // …and adding it to .gitignore clears the leak (no false alarm once protected).
    fs.writeFileSync(path.join(up, '.gitignore'), 'node_modules\nid_rsa\n')
    if (secMod.scanProject(up).findings.some((f) => /id_rsa$/.test(f.file))) throw new Error('an ignored id_rsa must NOT be flagged')
    // Dedup: a present .env yields EXACTLY ONE .env finding (committed-.env rule) — the upload check never doubles it.
    fs.rmSync(path.join(up, 'id_rsa'), { force: true })
    fs.writeFileSync(path.join(up, '.env'), 'SECRET=abc123realvalue\n')
    const u3 = secMod.scanProject(up)
    if (u3.findings.filter((f) => /(^|\/)\.env$/.test(f.file)).length !== 1) throw new Error('a present .env must yield EXACTLY ONE finding (deduped): ' + JSON.stringify(u3.findings.filter((f) => /\.env/.test(f.file))))
    return 'scanIgnore: *.ext/anchor/dir-slash/negation/dedup; e2e unignored id_rsa → high leak, .gitignore clears it, .env deduped'
  })

  await step('Design Review: palette, hardcoded-vs-token, near-duplicate colors, minified CSS', async () => {
    const dz = require(path.join(WORKDIR, 'main', 'design.js'))
    const dproj = path.join(WORKDIR, 'designproj', 'src')
    fs.mkdirSync(dproj, { recursive: true })
    fs.writeFileSync(path.join(dproj, 'styles.css'),
      ':root{--brand:#3b82f6;--shadow:0 1px 2px #112233}\n/* gold accent planned */\n.a{color:#3b82f6;padding:12px;font-size:14px;width:99px}\n.b{color:#3b82fa;margin:8px}\n.c{color:var(--brand);gap:16px}\n')
    // A minified single-line CSS must still be analyzed (full-content scan, not per-line).
    fs.writeFileSync(path.join(dproj, 'min.css'), '.x{background:rgb(59,130,246)}.y{border-color:#EF4444}')
    // Wave 8: hsl() + named colors, with decoys that must NOT be matched.
    // hsl(120,60%,50%) → #33cc33 (a UNIQUE hex not otherwise in the palette).
    fs.writeFileSync(path.join(dproj, 'named.css'),
      '.h{color:hsl(120,60%,50%)}\n.r{color:red}\n.red{color:pink}\n:root{--red:1}\n.t{background:transparent}\n')
    // HTML prose must NOT be scanned for named colors (common English words).
    fs.writeFileSync(path.join(dproj, 'prose.html'), '<p>The sky is blue and roses are red.</p>\n')
    // Wave 10: modern hsl — turn/rad/grad hue units + slash-alpha all describe h=90 →
    // the SAME unique #669933 (s/l chosen so every channel is an integer, off the .5 rounding
    // cusp), so a project using any modern color syntax is read completely.
    // .bad seeds MALFORMED hsl (a bare "." hue): [\d.]+ matches it but parseFloat is NaN — it
    // must be REJECTED (no "#..NaN" corrupt color), while the valid leading-dot ".25turn" works.
    fs.writeFileSync(path.join(dproj, 'modern.css'),
      '.m1{color:hsl(0.25turn 50% 40%)}\n.m2{color:hsl(1.5708rad 50% 40%)}\n.m3{color:hsl(100grad 50% 40%)}\n.m4{border-color:hsl(90 50% 40% / .5)}\n.bad{color:hsl(. 50% 40%)}\n')
    const rev = dz.designReview(path.join(WORKDIR, 'designproj'))
    if (rev.filesScanned < 2) throw new Error('style files not scanned: ' + rev.filesScanned)
    if (!rev.palette.some((c) => c.value === '#3b82f6')) throw new Error('palette missing #3b82f6: ' + JSON.stringify(rev.palette))
    // rgb(59,130,246) [min.css] normalizes to #3b82f6 → SAME palette entry as the hex (higher count).
    const brand = rev.palette.find((c) => c.value === '#3b82f6')
    if (!brand || !brand.isToken || brand.count < 3) throw new Error('#3b82f6 token/collapse wrong: ' + JSON.stringify(brand))
    // #ef4444 comes ONLY from the minified file → proves minified extraction.
    if (!rev.palette.some((c) => c.value === '#ef4444')) throw new Error('minified color #ef4444 not extracted: ' + JSON.stringify(rev.palette.map((c) => c.value)))
    // A color inside a multi-value custom property (--shadow: … #112233) is a TOKEN, not hardcoded.
    const shadow = rev.palette.find((c) => c.value === '#112233')
    if (!shadow || !shadow.isToken) throw new Error('multi-value token def color miscounted as hardcoded: ' + JSON.stringify(shadow))
    if (rev.tokensUsed < 1) throw new Error('var(--brand) not counted as a token use')
    if (rev.hardcodedColors < 1) throw new Error('hardcoded colors not counted')
    // #3b82f6 vs #3b82fa are near-duplicates (RGB distance 4).
    if (!rev.nearDuplicates.some((p) => (p.a === '#3b82f6' && p.b === '#3b82fa') || (p.a === '#3b82fa' && p.b === '#3b82f6'))) throw new Error('near-duplicate not detected: ' + JSON.stringify(rev.nearDuplicates))
    if (!rev.spacingScale.includes(12) || !rev.spacingScale.includes(8) || !rev.spacingScale.includes(16)) throw new Error('spacing scale wrong: ' + JSON.stringify(rev.spacingScale))
    // width:99px is NOT a spacing property → must not pollute the spacing scale.
    if (rev.spacingScale.includes(99)) throw new Error('non-spacing px (width) leaked into spacing scale: ' + JSON.stringify(rev.spacingScale))
    if (!rev.fontSizeScale.includes(14)) throw new Error('font-size scale wrong: ' + JSON.stringify(rev.fontSizeScale))
    // Wave 8: named color `red` (in a CSS value) is captured as #ff0000.
    if (!rev.palette.some((c) => c.value === '#ff0000')) throw new Error('named color red not extracted: ' + JSON.stringify(rev.palette.map((c) => c.value)))
    // hsl(120,60%,50%) converts to the UNIQUE #33cc33 (proves conversion, not masked by a hex).
    if (!rev.palette.some((c) => c.value === '#33cc33')) throw new Error('hsl → #33cc33 conversion missing: ' + JSON.stringify(rev.palette.map((c) => c.value)))
    // Wave 10: turn/rad/grad hue units + slash-alpha (all h=90) fold to the UNIQUE #669933, count 4.
    const modern = rev.palette.find((c) => c.value === '#669933')
    if (!modern) throw new Error('hsl turn/rad/grad → #669933 missing: ' + JSON.stringify(rev.palette.map((c) => c.value)))
    if (modern.count !== 4) throw new Error('turn/rad/grad/slash-alpha should all normalize to #669933 (count 4): ' + JSON.stringify(modern))
    // Malformed hsl(. …) must be rejected — no NaN-bearing color ever enters the palette.
    if (rev.palette.some((c) => /NaN/i.test(c.value))) throw new Error('malformed hsl leaked a NaN color: ' + JSON.stringify(rev.palette.map((c) => c.value)))
    if (!rev.palette.some((c) => c.value === '#ffc0cb')) throw new Error('value pink not captured') // .red{color:pink} → pink IS a value
    // Decoys/false-positives that must NOT create colors:
    if (rev.palette.find((c) => c.value === '#ff0000').count !== 1) throw new Error('decoy .red/--red wrongly counted as red: ' + JSON.stringify(rev.palette.find((c) => c.value === '#ff0000')))
    if (rev.palette.some((c) => c.value === '#ffd700')) throw new Error('a color word in a CSS COMMENT (gold) was counted')
    if (rev.palette.some((c) => c.value === '#0000ff')) throw new Error('a color word in HTML PROSE (blue) was counted')
    // Empty (no style files) degrades gracefully.
    const empty = path.join(WORKDIR, 'designempty')
    fs.mkdirSync(empty, { recursive: true })
    fs.writeFileSync(path.join(empty, 'readme.txt'), 'no styles here')
    const er = dz.designReview(empty)
    if (er.filesScanned !== 0 || !/No style files/.test(er.verdict)) throw new Error('empty design review not graceful: ' + JSON.stringify(er))
    return `palette+token+hardcoded+near-dup(${rev.nearDuplicates.length})+scales+hsl(deg/turn/rad/grad)+named; minified scanned; empty ok`
  })

  await step('Design tokens auto-extract: hardcoded colors → :root{} tokens; near-dups fold to one', async () => {
    const { extractTokens } = require(path.join(WORKDIR, 'shared', 'design-tokens.js'))
    // A near-duplicate pair (both hardcoded) must collapse into ONE token.
    const review = {
      ok: false, verdict: '', filesScanned: 3, hardcodedColors: 0, tokensUsed: 0, spacingScale: [], fontSizeScale: [],
      palette: [
        { value: '#3b82f6', count: 10, isToken: false }, // most-used hardcoded → --blue-400
        { value: '#3b82fa', count: 3, isToken: false }, // near-dup of #3b82f6 → folds in
        { value: '#ef4444', count: 5, isToken: false }, // 2nd group → --red-400
        { value: '#0ea5e9', count: 4, isToken: true } // a token already → EXCLUDED
      ],
      nearDuplicates: [{ a: '#3b82f6', b: '#3b82fa', distance: 4 }]
    }
    const out = extractTokens(review)
    if (!out.css.startsWith(':root {')) throw new Error('css not a :root block: ' + out.css)
    // Two groups: {#3b82f6 ∪ #3b82fa} and {#ef4444}. The token color = the rep (#0ea5e9 excluded).
    if (out.tokens.length !== 2) throw new Error('expected 2 tokens (near-dup folded, token excluded): ' + JSON.stringify(out.tokens))
    // Names are the color's own hue family + lightness step (usage-ranked order preserved).
    if (out.tokens[0].name !== 'blue-400' || out.tokens[0].value !== '#3b82f6') throw new Error('token 0 wrong: ' + JSON.stringify(out.tokens[0]))
    if (out.tokens[1].name !== 'red-400' || out.tokens[1].value !== '#ef4444') throw new Error('token 1 wrong: ' + JSON.stringify(out.tokens[1]))
    if (out.tokens.some((t) => t.value === '#0ea5e9')) throw new Error('an existing token color leaked into extraction')
    if (out.css.includes('#3b82fa')) throw new Error('near-duplicate not folded (both colors emitted)')
    if (!out.css.includes('--blue-400: #3b82f6') || !out.css.includes('--red-400: #ef4444')) throw new Error('css body wrong: ' + out.css)
    // Collision dedup: two DISTINCT (non-near-dup) blues both name to blue-400 → the 2nd
    // gets a numeric suffix so the :root block stays valid (no duplicate var name).
    const dedup = extractTokens({
      ...review,
      palette: [
        { value: '#3b82f6', count: 10, isToken: false },
        { value: '#5b8def', count: 8, isToken: false } // also blue-400, but NOT listed as a near-dup
      ],
      nearDuplicates: []
    })
    if (dedup.tokens.map((t) => t.name).join(',') !== 'blue-400,blue-400-2') throw new Error('collision not deduped: ' + JSON.stringify(dedup.tokens))
    if (new Set(dedup.tokens.map((t) => t.name)).size !== dedup.tokens.length) throw new Error('duplicate token idents emitted')
    // A fully-tokenized (or empty) review → nothing to extract.
    const none = extractTokens({ ...review, palette: [{ value: '#111', count: 1, isToken: true }], nearDuplicates: [] })
    if (none.tokens.length || none.css !== '') throw new Error('all-token review should extract nothing')
    return `2 tokens (near-dup folded, token excluded); hue-family names + collision dedup`
  })

  await step('apply-tokens: safe hex→var (8-digit/shorthand/comment/string/decl/var guards); undoable', async () => {
    const at = require(path.join(WORKDIR, 'main', 'apply-tokens.js'))
    const undo = require(path.join(WORKDIR, 'main', 'undo.js'))
    const proj = path.join(WORKDIR, 'applytokens')
    fs.mkdirSync(proj, { recursive: true })
    const tokens = [{ name: 'brand', value: '#3b82f6' }, { name: 'accent', value: '#ef4444' }]
    // Every guarded form below MUST be left untouched; only the 3 bare literals convert.
    const original =
      '.x{color:#3b82f6;background:#3b82f6aa;border:#39f}\n' + // hit(.x); 8-digit skip; 3-digit skip
      '.y{color:#EF4444}\n' + // hit(.y) — case-insensitive
      '/* keep #3b82f6 */ .z{color:#3b82f6}\n' + // comment skip; then hit(.z)
      '// scss line #3b82f6\n' + // line-comment skip
      ':root{--brand:#3b82f6}\n' + // token-def decl skip
      '.q::before{content:"#3b82f6"}\n' + // string skip
      '.w{color:var(--x, #3b82f6)}\n' // existing var() (fallback) skip
    fs.writeFileSync(path.join(proj, 'a.css'), original)
    fs.writeFileSync(path.join(proj, 'comp.vue'), '<style>.v{color:#3b82f6}</style>') // .vue is NOT a CSS file → excluded
    fs.mkdirSync(path.join(proj, 'sub'), { recursive: true })

    const plans = at.planApplyTokens(proj, tokens)
    if (plans.length !== 1 || plans[0].file !== 'a.css') throw new Error('only a.css should plan (vue excluded): ' + JSON.stringify(plans.map((p) => p.file)))
    // EXACTLY 3 — if any guard leaked (8-digit/3-digit/comment×2/decl/string/var) the count rises.
    if (plans[0].replacements !== 3) throw new Error('guard leak — expected 3 replacements, got ' + plans[0].replacements)
    if (!plans[0].diff.some((l) => l.kind === 'add' && /var\(--brand\)/.test(l.text))) throw new Error('diff missing the var(--brand) rewrite')

    // Apply to a.css (also the block target → one combined write = one snapshot).
    const before = undo.history().length
    const blockCss = ':root {\n  --brand: #3b82f6;\n  --accent: #ef4444;\n}'
    const res = at.applyTokens(proj, ['a.css'], tokens, blockCss, 'a.css')
    if (!res.ok || res.filesWritten !== 1) throw new Error('apply result wrong: ' + JSON.stringify(res))
    const after = fs.readFileSync(path.join(proj, 'a.css'), 'utf8')
    if (!after.startsWith(':root {\n  --brand: #3b82f6;')) throw new Error('token :root block not prepended')
    if ((after.match(/var\(--brand\)/g) || []).length !== 2) throw new Error('.x and .z should both be var(--brand)')
    if (!/var\(--accent\)/.test(after)) throw new Error('.y should be var(--accent)')
    // Guarded literals must survive verbatim in the rewritten file.
    for (const survivor of ['#3b82f6aa', '#39f', 'content:"#3b82f6"', 'var(--x, #3b82f6)']) {
      if (!after.includes(survivor)) throw new Error('a guarded literal was mangled: ' + survivor)
    }
    if (undo.history().length !== before + 1) throw new Error('apply should be ONE snapshot (one Undo), got ' + (undo.history().length - before))
    // Undoable: one revert restores the file byte-for-byte.
    undo.undoTo(before)
    if (fs.readFileSync(path.join(proj, 'a.css'), 'utf8') !== original) throw new Error('undo did not restore a.css byte-for-byte')
    return 'planApplyTokens: 3 safe hits (all guards held), vue excluded; applyTokens: block+var, one-snapshot undo'
  })

  await step('apply-tokens hardening: url(//) no longer over-masks; token-def survives; non-CSS/dup/traversal guarded', async () => {
    const at = require(path.join(WORKDIR, 'main', 'apply-tokens.js'))
    const proj = path.join(WORKDIR, 'applyhard')
    fs.mkdirSync(proj, { recursive: true })
    const tokens = [{ name: 'brand', value: '#3b82f6' }, { name: 'accent', value: '#ef4444' }]
    // A `//` inside an UNQUOTED url must not mask the color sharing its line (the review bug).
    fs.writeFileSync(path.join(proj, 'urls.css'),
      '.hero{background:url(//cdn.example.com/h.jpg) center,#3b82f6}\n' +
      '.d{background:url(data:image/png;base64,ab//cd),#ef4444}\n')
    // A hex in the token's OWN --decl value must be left alone even when a quoted string in that
    // value contains a `;` (else it becomes the self-referential --brand: var(--brand)).
    fs.writeFileSync(path.join(proj, 'decl.css'), ':root{--brand:"x;y" #3b82f6}\n')
    fs.writeFileSync(path.join(proj, 'app.js'), '.z{color:#3b82f6}') // non-CSS → never touched
    const plans = at.planApplyTokens(proj, tokens)
    const urls = plans.find((p) => p.file === 'urls.css')
    if (!urls || urls.replacements !== 2) throw new Error('url(//) over-mask regression — expected 2, got ' + (urls && urls.replacements))
    if (plans.some((p) => p.file === 'decl.css')) throw new Error('token-def hex wrongly planned for rewrite (self-reference risk)')
    if (plans.some((p) => p.file === 'app.js')) throw new Error('a non-CSS file was planned')

    // applyTokens: a DUPLICATED block-target file must prepend the :root block exactly once.
    const blockCss = ':root {\n  --brand: #3b82f6;\n  --accent: #ef4444;\n}'
    const dup = at.applyTokens(proj, ['urls.css', 'urls.css'], tokens, blockCss, 'urls.css')
    if (!dup.ok || dup.filesWritten !== 1) throw new Error('dedupe failed: ' + JSON.stringify(dup))
    const urlsAfter = fs.readFileSync(path.join(proj, 'urls.css'), 'utf8')
    if ((urlsAfter.match(/:root \{/g) || []).length !== 1) throw new Error('block prepended more than once')
    if ((urlsAfter.match(/var\(--brand\)/g) || []).length !== 1 || !/var\(--accent\)/.test(urlsAfter)) throw new Error('url-line colors not converted')

    // A non-CSS checkedFile and a traversal path must both be refused (no write).
    const evil = path.join(WORKDIR, 'evil-outside.css')
    fs.writeFileSync(evil, '.e{color:#3b82f6}')
    const guarded = at.applyTokens(proj, ['app.js', '../evil-outside.css'], tokens, '', '')
    if (guarded.filesWritten !== 0) throw new Error('non-CSS / traversal path was written: ' + JSON.stringify(guarded))
    if (fs.readFileSync(path.join(proj, 'app.js'), 'utf8') !== '.z{color:#3b82f6}') throw new Error('non-CSS app.js was mutated')
    if (fs.readFileSync(evil, 'utf8') !== '.e{color:#3b82f6}') throw new Error('traversal write escaped the project root')
    return 'url(//) converts; token-def + non-CSS + dup + traversal all guarded'
  })

  await step('apply-tokens beyond hex: rgb()/hsl()/3-digit fold to var; alpha forms left opaque-safe', async () => {
    const at = require(path.join(WORKDIR, 'main', 'apply-tokens.js'))
    const proj = path.join(WORKDIR, 'applybeyond')
    fs.mkdirSync(proj, { recursive: true })
    // rgb(59,130,246)=#3b82f6, hsl(90,50%,40%)=#669933 (integer channels), #3cf=#33ccff.
    const tokens = [{ name: 'brand', value: '#3b82f6' }, { name: 'green', value: '#669933' }, { name: 'ok', value: '#33ccff' }]
    const original =
      '.rgb{color:rgb(59,130,246)}\n' + // → var(--brand)
      '.hsl{color:hsl(90,50%,40%)}\n' + // → var(--green)
      '.short{color:#3cf}\n' + // 3-digit → var(--ok)
      '.a8{color:#3b82f6ff}\n' + // 8-hex alpha → SKIP
      '.rgba{color:rgba(59,130,246,0.5)}\n' + // rgba → SKIP
      '.rgb4{color:rgb(59,130,246,0.5)}\n' + // 4-arg comma rgb (alpha, NOT rgba) → SKIP
      '.slash{color:rgb(59 130 246 / .5)}\n' + // slash-alpha → SKIP
      '.h4{background:#3b8f}\n' // 4-hex → SKIP
    fs.writeFileSync(path.join(proj, 's.css'), original)
    const plans = at.planApplyTokens(proj, tokens)
    if (!plans[0] || plans[0].replacements !== 3) throw new Error('expected 3 non-hex/short folds, got ' + (plans[0] && plans[0].replacements))
    const res = at.applyTokens(proj, ['s.css'], tokens, '', '')
    if (!res.ok || res.filesWritten !== 1) throw new Error('apply failed: ' + JSON.stringify(res))
    const after = fs.readFileSync(path.join(proj, 's.css'), 'utf8')
    for (const v of ['var(--brand)', 'var(--green)', 'var(--ok)']) if (!after.includes(v)) throw new Error('missing fold: ' + v)
    // Every alpha-bearing literal must survive VERBATIM (normColor would have made it opaque).
    for (const survivor of ['#3b82f6ff', 'rgba(59,130,246,0.5)', 'rgb(59,130,246,0.5)', 'rgb(59 130 246 / .5)', '#3b8f']) {
      if (!after.includes(survivor)) throw new Error('an alpha literal was wrongly rewritten: ' + survivor)
    }
    if (/rgb\(59,130,246\)/.test(after)) throw new Error('opaque rgb() not folded')
    return 'rgb()/hsl()/3-digit fold to var; 8-hex/4-hex/rgba/hsla/slash-alpha all left opaque-safe'
  })

  await step('Fix-First Action Plan: ranks security>tests>debt>design; folds untested; drift needs baseline; empty→All clear', async () => {
    const { buildActionPlan, buildShipReadiness, fixInstruction, verifyFix, kindProblemCount, depInstallBreakers } = require(path.join(WORKDIR, 'shared', 'actionplan.js'))
    const empty = buildActionPlan({})
    if (empty.items.length || !/All clear/.test(empty.summary)) throw new Error('empty signals should be All clear: ' + JSON.stringify(empty))
    const plan = buildActionPlan({
      insight: { fileCount: 10, totalSymbols: 5, languages: {}, topImports: [], entryPoints: [], hasTests: false,
        debt: [
          { kind: 'untested', path: '(project)', detail: 'no tests' },
          { kind: 'oversized', path: 'src/big.js', detail: '800 lines' },
          { kind: 'todo', path: 'src/x.js', detail: '3 TODOs' }
        ] },
      security: { ok: false, verdict: 'bad', filesScanned: 3, findings: [{ severity: 'critical', file: 'a', line: 1, message: 'AWS key' }] },
      design: { ok: false, verdict: '', palette: [], hardcodedColors: 4, tokensUsed: 0, nearDuplicates: [], spacingScale: [], fontSizeScale: [], filesScanned: 2 },
      drift: { hasBaseline: false, capturedAt: null, partial: false, modules: { added: [], removed: [] }, edges: { added: [], removed: [] }, externalDeps: { added: [], removed: [] } }
    })
    const kinds = plan.items.map((i) => i.kind)
    if (plan.items[0].kind !== 'security' || plan.items[0].severity !== 'critical') throw new Error('critical security must rank first: ' + JSON.stringify(plan.items))
    if (kinds.filter((k) => k === 'tests').length !== 1) throw new Error('the (project) untested pseudo-row must fold to ONE tests item: ' + JSON.stringify(kinds))
    const debtIdx = kinds.indexOf('debt')
    const designIdx = kinds.indexOf('design')
    if (debtIdx < 0 || designIdx < 0 || debtIdx > designIdx) throw new Error('a medium debt item must sort above the low design nitpick: ' + JSON.stringify(kinds))
    if (kinds.includes('drift')) throw new Error('no drift item without a baseline: ' + JSON.stringify(kinds))
    if (!/critical/.test(plan.summary)) throw new Error('summary should flag critical: ' + plan.summary)
    const withDrift = buildActionPlan({ drift: { hasBaseline: true, capturedAt: 1, partial: false, modules: { added: [], removed: ['src/gone.js'] }, edges: { added: [], removed: [] }, externalDeps: { added: [], removed: [] } } })
    if (!withDrift.items.some((i) => i.kind === 'drift')) throw new Error('a baseline + a removal should yield a drift item')
    // A fully-tokenized project (0 hardcoded) with a near-dup TOKEN pair must NOT read "0 hardcoded colors".
    const dz = buildActionPlan({ design: { ok: false, verdict: '', palette: [], hardcodedColors: 0, tokensUsed: 3, nearDuplicates: [{ a: '#ff0000', b: '#ff0001', distance: 1 }], spacingScale: [], fontSizeScale: [], filesScanned: 1 } })
    const di = dz.items.find((i) => i.kind === 'design')
    if (!di || /0 hardcoded/.test(di.detail)) throw new Error('design item must not say "0 hardcoded colors": ' + JSON.stringify(di))
    // Fix with AI: a security instruction names the file:line ONLY — never the finding message (Secret Handling Protocol).
    const instr = fixInstruction({ severity: 'critical', kind: 'security', title: 'Fix 1 security issue', detail: '1 critical.' },
      { security: { ok: false, verdict: '', filesScanned: 1, findings: [{ severity: 'critical', file: 'src/config.ts', line: 3, message: 'AWS key AKIAXXSECRETVAL hardcoded' }] } })
    if (!/src\/config\.ts:3/.test(instr)) throw new Error('fix instruction must name the file:line: ' + instr)
    if (/AKIAXXSECRETVAL/.test(instr)) throw new Error('fix instruction LEAKED a secret value from the finding message: ' + instr)
    // debt uses its own detail (no signals); empty signals + drift never throw.
    if (!/debt/i.test(fixInstruction({ severity: 'medium', kind: 'debt', title: 'Clean up code debt', detail: '2 oversized files.' }))) throw new Error('debt instruction wrong')
    // A debt row about ONE file (the Fragile-files watchlist) must seed a single-file instruction —
    // never the project-wide "remove unused/dead files" refactor, which from one click would let the
    // agent delete files the user never looked at.
    const oneFile = fixInstruction({ severity: 'medium', kind: 'debt', title: 'Clean up src/utils/format.ts', detail: 'todo.', file: 'src/utils/format.ts' })
    if (!oneFile.includes('src/utils/format.ts')) throw new Error('a per-file debt instruction must NAME the file: ' + oneFile)
    if (/remove unused|dead files/i.test(oneFile)) throw new Error('a per-file debt instruction must not order a project-wide delete: ' + oneFile)
    if (!/not change or delete any other file/i.test(oneFile)) throw new Error('a per-file debt instruction must fence the agent to that file: ' + oneFile)
    if (fixInstruction({ severity: 'medium', kind: 'debt', title: 'Clean up code debt', detail: '2 oversized files.' }).includes('single file')) throw new Error('a plan-level debt item (no file) must keep the project-wide instruction')
    if (typeof fixInstruction({ severity: 'medium', kind: 'drift', title: 'Review architecture drift', detail: '1 removed.' }) !== 'string') throw new Error('drift fallback must be a string')
    // Wave 18: Dependency Health folds into the ONE plan. A phantom / wildcard is an install-breaker →
    // a HIGH deps item ranked above debt/design; kindProblemCount counts ONLY install-breakers.
    const depRep = { ok: false, verdict: '', depCount: 5, hasLockfile: true, findings: [
      { severity: 'medium', kind: 'phantom', package: 'left-pad', message: 'imported but not declared' },
      { severity: 'high', kind: 'unpinned', package: 'react', message: 'wildcard' },
      { severity: 'low', kind: 'unused', package: 'lodash', message: 'never imported' }
    ] }
    const depHigh = buildActionPlan({ dependency: depRep, insight: { fileCount: 10, totalSymbols: 5, languages: {}, topImports: [], entryPoints: [], hasTests: true, debt: [{ kind: 'oversized', path: 'a', detail: '' }] }, design: { ok: false, verdict: '', palette: [], hardcodedColors: 2, tokensUsed: 0, nearDuplicates: [], spacingScale: [], fontSizeScale: [], filesScanned: 1 } })
    const dk = depHigh.items.map((i) => i.kind)
    const depItem = depHigh.items.find((i) => i.kind === 'deps')
    if (!depItem || depItem.severity !== 'high') throw new Error('a phantom/wildcard must yield a HIGH deps item: ' + JSON.stringify(depItem))
    if (dk.indexOf('deps') > dk.indexOf('debt') || dk.indexOf('deps') > dk.indexOf('design')) throw new Error('a high deps item must rank above debt/design: ' + JSON.stringify(dk))
    // Review fix: kindProblemCount('deps') counts ALL findings (so a lockfile/tidy fix reads "Fixed", not
    // a spurious "No change") — while depInstallBreakers stays = phantom + high-unpinned for severity/ship-red.
    if (kindProblemCount('deps', { dependency: depRep }) !== 3) throw new Error('deps count = ALL findings (phantom+wildcard+unused=3): ' + kindProblemCount('deps', { dependency: depRep }))
    if (depInstallBreakers(depRep).length !== 2) throw new Error('depInstallBreakers = phantom + high-unpinned (2)')
    // A no-lockfile item verifies correctly: before=1 (all findings) → after 0 = "Fixed", not "No change".
    if (kindProblemCount('deps', { dependency: { ok: false, verdict: '', depCount: 3, hasLockfile: false, findings: [{ severity: 'medium', kind: 'no-lockfile', package: '(project)', message: 'x' }] } }) !== 1) throw new Error('a no-lockfile item must count as 1 so Fix-Verify can read "Fixed"')
    // low-only report → a low deps item; no-lockfile → medium; null/clean → NO deps item (never a false clean bill).
    const lowItem = buildActionPlan({ dependency: { ok: false, verdict: '', depCount: 3, hasLockfile: true, findings: [{ severity: 'low', kind: 'unused', package: 'lodash', message: 'x' }, { severity: 'low', kind: 'heavyweight', package: 'moment', message: 'y' }] } }).items.find((i) => i.kind === 'deps')
    if (!lowItem || lowItem.severity !== 'low') throw new Error('a low-only dep report → a low deps item: ' + JSON.stringify(lowItem))
    const medItem = buildActionPlan({ dependency: { ok: false, verdict: '', depCount: 3, hasLockfile: false, findings: [{ severity: 'medium', kind: 'no-lockfile', package: '(project)', message: 'x' }] } }).items.find((i) => i.kind === 'deps')
    if (!medItem || medItem.severity !== 'medium') throw new Error('a no-lockfile report → a medium deps item: ' + JSON.stringify(medItem))
    if (buildActionPlan({ dependency: null }).items.some((i) => i.kind === 'deps')) throw new Error('null dependency must add NO deps item')
    if (buildActionPlan({ dependency: { ok: true, verdict: '', depCount: 3, hasLockfile: true, findings: [] } }).items.some((i) => i.kind === 'deps')) throw new Error('a clean dep report must add NO deps item')
    const depInstr = fixInstruction({ severity: 'high', kind: 'deps', title: 'Fix missing or loose packages', detail: '' })
    if (!/missing/i.test(depInstr) || !/pin/i.test(depInstr)) throw new Error('deps (breaker) instruction must mention missing + pin: ' + depInstr)
    // Review fix: the lockfile + tidy variants get their OWN instruction, not the missing-packages text.
    const lockInstr = fixInstruction({ severity: 'medium', kind: 'deps', title: 'Add a lockfile', detail: '' })
    if (!/lockfile/i.test(lockInstr) || /missing from package\.json/i.test(lockInstr)) throw new Error('lockfile instruction must be about generating a lockfile: ' + lockInstr)
    const tidyInstr = fixInstruction({ severity: 'low', kind: 'deps', title: 'Tidy the dependencies', detail: '' })
    if (!/unused|heavyweight/i.test(tidyInstr) || /pin any wildcard/i.test(tidyInstr)) throw new Error('tidy instruction must be about removing unused/heavy deps: ' + tidyInstr)
    if (verifyFix('deps', 2, 0).status !== 'fixed' || !/package problems → 0/.test(verifyFix('deps', 2, 0).headline)) throw new Error('verifyFix(deps) must read fixed with the deps noun: ' + verifyFix('deps', 2, 0).headline)
    // Wave 18: Ship-Readiness — one honest traffic light over the plan.
    const cleanSec = { ok: true, verdict: '', filesScanned: 3, findings: [] }
    // GREEN only when the plan is EMPTY and the key checks HAVE run (security not null).
    const green = buildShipReadiness(buildActionPlan({ security: cleanSec, insight: { fileCount: 5, totalSymbols: 1, languages: {}, topImports: [], entryPoints: [], hasTests: true, debt: [] } }), { security: cleanSec, insight: { fileCount: 5, totalSymbols: 1, languages: {}, topImports: [], entryPoints: [], hasTests: true, debt: [] } })
    if (green.band !== 'green' || green.topBlocker !== null) throw new Error('an empty plan with checks run must be GREEN: ' + JSON.stringify(green))
    // A critical security item → RED, topBlocker is the security item.
    const secSig = { security: { ok: false, verdict: '', filesScanned: 1, findings: [{ severity: 'critical', file: 'a', line: 1, message: 'AKIAXX' }] } }
    const red = buildShipReadiness(buildActionPlan(secSig), secSig)
    if (red.band !== 'red' || red.topBlocker?.kind !== 'security') throw new Error('a critical security item must be RED with a security top blocker: ' + JSON.stringify(red))
    if (/AKIAXX/.test(red.verdict)) throw new Error('ship verdict must be count/kind-only, never a leaked value')
    // A dependency install-breaker (phantom) with clean security → still RED.
    const depSig = { security: cleanSec, dependency: depRep }
    if (buildShipReadiness(buildActionPlan(depSig), depSig).band !== 'red') throw new Error('a dependency install-breaker must be RED')
    // A null security signal (Gate not yet run) → NEVER green (incomplete), even with an empty plan.
    const unchecked = buildShipReadiness(buildActionPlan({}), {})
    if (unchecked.band === 'green' || !unchecked.incomplete) throw new Error('unscanned project must never be GREEN (incomplete): ' + JSON.stringify(unchecked))
    // Only a low design nit (checks run) → AMBER, not red/green.
    const designSig = { security: cleanSec, design: { ok: false, verdict: '', palette: [], hardcodedColors: 3, tokensUsed: 0, nearDuplicates: [], spacingScale: [], fontSizeScale: [], filesScanned: 1 } }
    if (buildShipReadiness(buildActionPlan(designSig), designSig).band !== 'amber') throw new Error('a low tidy-up with checks run must be AMBER')
    // Fix-Verify: verifyFix truth-table + COUNT-only headlines (never a finding value).
    if (verifyFix('security', 3, 0).status !== 'fixed' || !/3 security issues → 0/.test(verifyFix('security', 3, 0).headline)) throw new Error('3→0 must be fixed')
    if (verifyFix('security', 3, 1).status !== 'improved') throw new Error('3→1 must be improved')
    if (verifyFix('security', 3, 4).status !== 'worse' || !/Undo/.test(verifyFix('security', 3, 4).headline)) throw new Error('3→4 must be worse + Undo')
    if (verifyFix('security', 2, 2).status !== 'unchanged') throw new Error('2→2 must be unchanged')
    if (/AKIA|secret value|password:/i.test(verifyFix('security', 1, 0).headline)) throw new Error('verify headline must be count-only, no leaked value')
    if (!/partial view/i.test(verifyFix('security', 2, 0, true).headline)) throw new Error('partial project should soften the fixed verdict')
    // kindProblemCount mirrors the plan's per-kind counting.
    const sig = {
      security: { ok: false, verdict: '', filesScanned: 1, findings: [{ severity: 'critical', file: 'a', line: 1, message: 'x' }, { severity: 'high', file: 'b', line: 2, message: 'y' }] },
      design: { ok: false, verdict: '', palette: [], hardcodedColors: 3, tokensUsed: 0, nearDuplicates: [{ a: '#1', b: '#2', distance: 1 }], spacingScale: [], fontSizeScale: [], filesScanned: 1 },
      insight: { fileCount: 5, totalSymbols: 1, languages: {}, topImports: [], entryPoints: [], hasTests: false, debt: [{ kind: 'oversized', path: 'a', detail: '' }, { kind: 'untested', path: '(project)', detail: '' }] }
    }
    if (kindProblemCount('security', sig) !== 2) throw new Error('security count = findings.length')
    if (kindProblemCount('design', sig) !== 4) throw new Error('design count = hardcoded + near-dups (3+1)')
    if (kindProblemCount('debt', sig) !== 1) throw new Error('debt count excludes the untested pseudo-row')
    if (kindProblemCount('tests', sig) !== 1) throw new Error('tests count = 1 when hasTests false')
    return 'critical security ranks first; untested folds to one tests item; medium>low; drift only with baseline+removal; empty→All clear'
  })

  await step('Blast Radius: entry=high; importers counted from the graph; new file → low+partial (no throw)', async () => {
    const impact = require(path.join(WORKDIR, 'main', 'impact.js'))
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const bpr = path.join(WORKDIR, 'blastproj')
    fs.mkdirSync(path.join(bpr, 'src'), { recursive: true })
    fs.writeFileSync(path.join(bpr, 'package.json'), JSON.stringify({ name: 'blast' }))
    fs.writeFileSync(path.join(bpr, 'src/util.js'), 'function u() { return 1 }\nmodule.exports = { u }\n') // a symbol → indexed as a node
    fs.writeFileSync(path.join(bpr, 'src/config.js'), "const { u } = require('./util')\nfunction cfg() { return u() }\nmodule.exports = { cfg }\n")
    fs.writeFileSync(path.join(bpr, 'src/server.js'), "const { cfg } = require('./config')\nfunction start() { return cfg() }\nmodule.exports = { start }\n")
    indexMod.buildProjectIndex(bpr)
    const map = indexMod.architectureMap(bpr)
    const entryPath = (map.nodes.find((n) => n.isEntry) || {}).path
    if (!entryPath) throw new Error('test project has no entry node: ' + JSON.stringify(map.nodes.map((n) => n.path)))

    const br = impact.blastRadius(bpr, [entryPath, 'src/util.js', 'src/brand-new.js'])
    if (Object.keys(br).length !== 3) throw new Error('blastRadius must key every requested path from ONE map build: ' + JSON.stringify(Object.keys(br)))
    // An entry point = high band + an entry-flavored plain-English summary.
    if (!br[entryPath].isEntry || br[entryPath].band !== 'high' || !/entry point/i.test(br[entryPath].summary)) throw new Error('entry not high: ' + JSON.stringify(br[entryPath]))
    // util.js is imported (config→util) → ≥1 dependent, 2-hop reach includes config's importer, not an entry.
    if (br['src/util.js'].dependents < 1 || br['src/util.js'].isEntry) throw new Error('util dependents wrong: ' + JSON.stringify(br['src/util.js']))
    if (br['src/util.js'].reach < 2) throw new Error('2-hop reach should climb config→server: ' + JSON.stringify(br['src/util.js']))
    // A brand-new / unindexed path → low + partial, and NEVER throws (node===undefined guard).
    const nw = br['src/brand-new.js']
    if (nw.dependents !== 0 || nw.band !== 'low' || !nw.partial) throw new Error('a new/unindexed file must be low+partial: ' + JSON.stringify(nw))
    // Dedup: a file importing the same target TWICE must count as ONE dependent, not two.
    fs.writeFileSync(path.join(bpr, 'src/dbl.js'), "const a = require('./util')\nconst b = require('./util')\nfunction d() { return a.u() + b.u() }\nmodule.exports = { d }\n")
    indexMod.buildProjectIndex(bpr)
    const br2 = impact.blastRadius(bpr, ['src/util.js'])
    if (br2['src/util.js'].dependents !== 2) throw new Error('util should have exactly 2 distinct dependents (config + dbl), double-import deduped: ' + JSON.stringify(br2['src/util.js']))
    // Wave 16: Wiring/Config Guard — a PURE curated matcher (no graph/IO). Well-known plumbing files
    // are flagged sensitive with a plain label; ordinary code files (and .env.example) are never flagged.
    const ca = impact.configAdvisory(['.env', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'Dockerfile', 'src/db/migrations/001_init.sql', 'src/util.js', '.env.example', 'README.md'])
    for (const p of ['.env', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'Dockerfile', 'src/db/migrations/001_init.sql'])
      if (!ca[p].sensitive || !ca[p].label || !ca[p].why) throw new Error('a plumbing file must be flagged sensitive with a label+why: ' + p + ' ' + JSON.stringify(ca[p]))
    for (const p of ['src/util.js', '.env.example', 'README.md'])
      if (ca[p].sensitive) throw new Error('an ordinary/example file must NOT be flagged as plumbing: ' + p)
    // Wave 16 review fix 1: DB-migration flag ONLY on real ORM/DB layouts — NOT any folder named "migrations".
    const cm = impact.configAdvisory(['prisma/migrations/20240101_init/migration.sql', 'db/migrate/001_create_users.rb', 'schema.prisma', 'src/features/migrations/MigrationWizard.tsx', 'src/migrations/reshapeData.ts'])
    for (const p of ['prisma/migrations/20240101_init/migration.sql', 'db/migrate/001_create_users.rb', 'schema.prisma'])
      if (!cm[p].sensitive || cm[p].label !== 'database migration') throw new Error('a real DB migration must be flagged: ' + p)
    for (const p of ['src/features/migrations/MigrationWizard.tsx', 'src/migrations/reshapeData.ts'])
      if (cm[p].sensitive) throw new Error('an app-domain "migrations" folder (not a DB schema change) must NOT get the data-loss warning: ' + p)
    // Wave 16 review fix 2: build-config matcher tolerates prefix + modern extensions; spares plain code.
    const cb = impact.configAdvisory(['electron.vite.config.ts', 'vite.config.mts', 'next.config.mjs', 'webpack.config.ts', 'tailwind.config.js', 'src/config.ts', 'src/vite-helper.ts'])
    for (const p of ['electron.vite.config.ts', 'vite.config.mts', 'next.config.mjs', 'webpack.config.ts', 'tailwind.config.js'])
      if (!cb[p].sensitive || cb[p].label !== 'build config') throw new Error('a build config (incl. electron.vite/modern ext) must be flagged: ' + p)
    for (const p of ['src/config.ts', 'src/vite-helper.ts'])
      if (cb[p].sensitive) throw new Error('ordinary code must NOT be flagged as build config: ' + p)
    return 'entry=high; importers deduped; 2-hop reach; new file low+partial; config-guard flags plumbing (env/manifest/lock/CI/Docker); DB-migration only on real ORM layouts; build-config tolerates electron.vite/modern ext; spares code + .env.example'
  })

  await step('Dependency Health: unpinned/duplicate/unused/phantom/no-lockfile; honest wording; malformed ok', async () => {
    const dep = require(path.join(WORKDIR, 'main', 'dependency.js'))
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    // Pure analyzeManifest — no fs/index needed.
    const pkg = JSON.stringify({
      dependencies: { react: '^18.0.0', lodash: '*', 'left-pad': '1.0.0', 'unused-lib': '2.0.0', 'my-pkg': 'workspace:*', '@types/node': '^20' },
      devDependencies: { react: '^18.0.0', vite: '^5' }
    })
    const imported = new Set(['react', 'left-pad', 'phantom-lib'])
    const f = dep.analyzeManifest(pkg, null, imported) // null = NO lockfile
    const has = (kind, p) => f.some((x) => x.kind === kind && (p === undefined || x.package === p))
    if (!has('no-lockfile')) throw new Error('missing no-lockfile finding: ' + JSON.stringify(f))
    if (!f.some((x) => x.kind === 'unpinned' && x.package === 'lodash' && x.severity === 'high')) throw new Error("wildcard '*' must be a high unpinned finding")
    if (!has('duplicate', 'react')) throw new Error('react in deps+devDeps must be a duplicate')
    if (!has('unused', 'unused-lib')) throw new Error('declared-but-unused dep must be flagged')
    if (!has('phantom', 'phantom-lib')) throw new Error('imported-but-undeclared must be a phantom')
    if (f.some((x) => x.package === 'my-pkg')) throw new Error('workspace: spec must NOT be flagged (intentional non-semver)')
    if (f.some((x) => x.kind === 'unused' && x.package === '@types/node')) throw new Error('@types/* must be excluded from the unused check')
    // An implicit-runtime shim (tslib) in dependencies but not statically imported must NOT be "unused".
    const withShim = dep.analyzeManifest(JSON.stringify({ dependencies: { tslib: '2.0.0', 'genuinely-unused': '1.0.0' } }), '{}', new Set())
    if (withShim.some((x) => x.kind === 'unused' && x.package === 'tslib')) throw new Error('implicit-runtime tslib must not be flagged unused')
    if (!withShim.some((x) => x.kind === 'unused' && x.package === 'genuinely-unused')) throw new Error('a real unused dep should still be flagged')
    // Honesty guardrail: never a CVE / vulnerable / out-of-date / malware claim.
    if (f.some((x) => /\bCVE\b|vulnerab|out of date|malware/i.test(x.message))) throw new Error('dependency wording over-claims a security threat')

    // WITH a lockfile, a ^ range is locked → NOT unpinned; a wildcard still is.
    const f2 = dep.analyzeManifest(JSON.stringify({ dependencies: { react: '^18', lodash: '*' } }), '{"lockfileVersion":3}', new Set(['react', 'lodash']))
    if (f2.some((x) => x.kind === 'unpinned' && x.package === 'react')) throw new Error('a ^ range with a lockfile must NOT be flagged unpinned')
    if (!f2.some((x) => x.kind === 'unpinned' && x.package === 'lodash')) throw new Error('a wildcard is unpinned even with a lockfile')
    if (f2.some((x) => x.kind === 'no-lockfile')) throw new Error('no-lockfile must not fire when a lockfile is present')

    // False-positive guards (review-confirmed): peerDeps count as declared; node builtins + config
    // plugins aren't phantom/unused.
    if (dep.analyzeManifest(JSON.stringify({ peerDependencies: { react: '>=17' } }), '{}', new Set(['react'])).some((x) => x.kind === 'phantom')) throw new Error('a peerDependency import must not be a phantom')
    if (dep.analyzeManifest('{}', '{}', new Set(['constants'])).some((x) => x.kind === 'phantom')) throw new Error("node builtin 'constants' must not be a phantom")
    if (dep.analyzeManifest(JSON.stringify({ dependencies: { 'eslint-plugin-react': '1.0.0' } }), '{}', new Set()).some((x) => x.kind === 'unused')) throw new Error('a config-loaded plugin must not be flagged unused')
    // Malformed package.json → calm, no throw.
    if (dep.analyzeManifest('{ not json at all', null, new Set()).length !== 0) throw new Error('malformed manifest should yield no findings, not throw')

    // End-to-end dependencyAudit over a real project (index gives the imported set).
    const dpj = path.join(WORKDIR, 'depproj')
    fs.mkdirSync(path.join(dpj, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dpj, 'package.json'), JSON.stringify({ dependencies: { 'used-lib': '1.2.3', 'ghost-lib': '1.0.0' } }))
    fs.writeFileSync(path.join(dpj, 'src/app.js'), "const u = require('used-lib')\nconst n = require('not-declared')\nfunction go() { return u(n) }\nmodule.exports = { go }\n")
    indexMod.buildProjectIndex(dpj)
    const rep = dep.dependencyAudit(dpj)
    if (typeof rep.verdict !== 'string' || rep.hasLockfile !== false) throw new Error('audit report shape wrong: ' + JSON.stringify(rep))
    if (!rep.findings.some((x) => x.kind === 'unused' && x.package === 'ghost-lib')) throw new Error('ghost-lib should be unused: ' + JSON.stringify(rep.findings))
    if (!rep.findings.some((x) => x.kind === 'phantom' && x.package === 'not-declared')) throw new Error('not-declared should be a phantom: ' + JSON.stringify(rep.findings))
    if (rep.findings.some((x) => x.kind === 'unused' && x.package === 'used-lib')) throw new Error('used-lib IS imported — must not be unused')
    // A Bun binary lockfile (bun.lockb) counts as a lockfile → no false "No lockfile".
    fs.writeFileSync(path.join(dpj, 'bun.lockb'), Buffer.from([0, 1, 2, 3]))
    const repBun = dep.dependencyAudit(dpj)
    if (!repBun.hasLockfile || repBun.findings.some((x) => x.kind === 'no-lockfile')) throw new Error('bun.lockb must be detected as a lockfile: ' + JSON.stringify(repBun.findings.map((f) => f.kind)))
    // Wave 15: typosquat is a CURATED blocklist of real supply-chain typos — a gentle question, and
    // NEVER fired for a legitimate package that merely resembles a popular one.
    const ft = dep.analyzeManifest(JSON.stringify({ dependencies: { expres: '1.0.0', loadash: '1.0.0', preact: '10', react: '18', nuxt: '^3', vuex: '^4', vike: '^0.4', vest: '^5' } }), '{}', new Set())
    if (!ft.some((x) => x.kind === 'typosquat' && x.package === 'expres' && /express/.test(x.message))) throw new Error('expres should be a typosquat of express')
    if (!ft.some((x) => x.kind === 'typosquat' && x.package === 'loadash')) throw new Error('loadash should be a typosquat of lodash')
    // Real, mainstream packages that are ONE EDIT from a popular name must NEVER be accused (nuxt≈next,
    // vuex≈vue, vike≈vite, vest≈jest, preact≈react) — the whole reason we use a curated list, not edit-distance.
    for (const legit of ['preact', 'react', 'nuxt', 'vuex', 'vike', 'vest'])
      if (ft.some((x) => x.kind === 'typosquat' && x.package === legit)) throw new Error('a legitimate package (' + legit + ') must NOT be typosquat-flagged')
    // Heavyweight (deps only) + overlap (once per group when 2+ present).
    const fh = dep.analyzeManifest(JSON.stringify({ dependencies: { moment: '2', dayjs: '1' } }), '{}', new Set(['moment', 'dayjs']))
    if (!fh.some((x) => x.kind === 'heavyweight' && x.package === 'moment')) throw new Error('moment should be heavyweight')
    if (fh.filter((x) => x.kind === 'overlap').length !== 1) throw new Error('moment+dayjs should be exactly ONE overlap: ' + JSON.stringify(fh.filter((x) => x.kind === 'overlap')))
    // moment in devDeps → NOT heavyweight (deps-only); a single date lib → no overlap.
    const fd = dep.analyzeManifest(JSON.stringify({ devDependencies: { moment: '2' } }), '{}', new Set(['moment']))
    if (fd.some((x) => x.kind === 'heavyweight')) throw new Error('moment in devDeps must not be heavyweight')
    if (fd.some((x) => x.kind === 'overlap')) throw new Error('a single date lib must not be an overlap')
    // Honesty guardrail extends to the new wording (no CVE/vulnerable/out-of-date/malware).
    for (const f of [...ft, ...fh]) if (/\bCVE\b|vulnerab|out of date|malware/i.test(f.message)) throw new Error('new dependency wording over-claims a threat: ' + f.message)
    return 'unpinned/duplicate/unused/phantom/lockfile + typosquat(safe)/heavyweight(deps)/overlap(once); honest; malformed ok'
  })

  await step('Generate tests: deterministic *.test skeleton (right runner/import/TODO; never overwrites)', async () => {
    const tg = require(path.join(WORKDIR, 'main', 'testgen.js'))
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    // exportedNames: only actually-exported names (never a non-exported top-level → broken import).
    if (JSON.stringify(tg.exportedNames('function priv() {}\nexport function add() {}\nconst x = 1\nexport const y = 2\n').sort()) !== JSON.stringify(['add', 'y'])) throw new Error('exportedNames must return ONLY exported symbols')
    // Pure buildTestSkeleton — plain inputs, no fs, no model.
    const vs = tg.buildTestSkeleton('src/math.js', ['add', 'sub'], { runner: 'vitest', quote: "'", semi: ';' })
    if (vs.path !== 'src/math.test.js') throw new Error('test path wrong: ' + vs.path)
    if (!/import \{ describe, it, expect \} from 'vitest';/.test(vs.content)) throw new Error('vitest import missing: ' + vs.content)
    if (!/import \{ add, sub \} from '\.\/math';/.test(vs.content)) throw new Error('named sibling import wrong: ' + vs.content)
    if (!/expect\(add\)\.toBeDefined\(\);/.test(vs.content) || !/TODO/.test(vs.content)) throw new Error('skeleton missing real smoke assert + TODO: ' + vs.content)
    // node:test runner + NO named exports → namespace smoke import + TS ext.
    const ns = tg.buildTestSkeleton('lib/foo.ts', [], { runner: 'node', quote: '"', semi: '' })
    if (!/import \{ describe, it \} from "node:test"/.test(ns.content) || !/import assert from "node:assert"/.test(ns.content)) throw new Error('node runner header wrong: ' + ns.content)
    if (!/import \* as foo from "\.\/foo"/.test(ns.content) || !/assert\.notStrictEqual\(foo, undefined\)/.test(ns.content)) throw new Error('namespace import / node assert wrong: ' + ns.content)
    if (ns.path !== 'lib/foo.test.ts') throw new Error('ts test path wrong: ' + ns.path)
    // A filename starting with a digit must still yield a VALID JS identifier for the namespace import.
    const dig = tg.buildTestSkeleton('src/3d.js', [], { runner: 'vitest', quote: "'", semi: ';' })
    if (!/import \* as [A-Za-z_$]/.test(dig.content)) throw new Error('namespace identifier must be a valid JS identifier (no leading digit): ' + dig.content)

    // End-to-end scaffoldTest: real project, vitest devDep, real source → correct skeleton.
    const tgp = path.join(WORKDIR, 'testgenproj')
    fs.mkdirSync(path.join(tgp, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tgp, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1' } }))
    fs.writeFileSync(path.join(tgp, 'src/math.js'), 'export function add(a, b) { return a + b }\nexport function sub(a, b) { return a - b }\n')
    indexMod.buildProjectIndex(tgp)
    const sc = tg.scaffoldTest(tgp, 'src/math.js')
    if ('error' in sc) throw new Error('scaffold failed: ' + sc.error)
    if (sc.path !== 'src/math.test.js' || !/from 'vitest'/.test(sc.content) || !/add/.test(sc.content)) throw new Error('e2e skeleton wrong: ' + JSON.stringify(sc))
    // Refuses to overwrite an existing test, and refuses a test file as input.
    fs.writeFileSync(path.join(tgp, 'src/exists.js'), 'export const x = 1\n')
    fs.writeFileSync(path.join(tgp, 'src/exists.test.js'), '// already here\n')
    if (!('error' in tg.scaffoldTest(tgp, 'src/exists.js'))) throw new Error('must refuse to overwrite an existing test')
    if (!('error' in tg.scaffoldTest(tgp, 'src/math.test.js'))) throw new Error('must refuse a test file as the source')
    // Traversal read is blocked (fsService.readFile → safeResolve).
    if (!('error' in tg.scaffoldTest(tgp, '../../../../etc/hosts.js'))) throw new Error('must refuse a traversal source path')
    // A node smoke check uses !== undefined (assert.notStrictEqual), not truthiness — so `export const n = 0` passes.
    const zeroTest = tg.buildTestSkeleton('src/z.js', ['n'], { runner: 'node', quote: "'", semi: '' })
    if (/assert\.ok\(/.test(zeroTest.content) || !/assert\.notStrictEqual\(n, undefined\)/.test(zeroTest.content)) throw new Error('node smoke check must be !== undefined, not truthy: ' + zeroTest.content)
    return 'pure skeleton (vitest/node · named/default import · TODO+real-smoke-assert); e2e picks vitest; refuses overwrite + test-input'
  })

  await step('Run Doctor: install/env/db/start checklist; phantom=blocker; .env downgrades env; static ok; e2e', async () => {
    const { buildRunbook } = require(path.join(WORKDIR, 'shared', 'runbook.js'))
    // Full case: phantom (imported-undeclared) dep blocks; missing env (no .env) → setup; db; dev script.
    const rb = buildRunbook({ packageManager: 'pnpm', hasPackageJson: true, hasLockfile: true, scripts: { dev: 'vite' }, phantomPackages: ['left-pad'], missingEnv: ['DATABASE_URL', 'API_KEY'], hasEnvFile: false, hasEnvExample: true, dbModels: 2, isStaticHtml: false, partial: false })
    if (rb.ready !== 'blocked') throw new Error('a phantom (missing) package must block: ' + rb.ready)
    if (!rb.steps.some((s) => s.kind === 'install' && s.severity === 'blocker' && /left-pad/.test(s.detail))) throw new Error('phantom install blocker missing')
    if (!rb.steps.some((s) => s.kind === 'install' && s.command === 'pnpm install')) throw new Error('install command missing')
    const env = rb.steps.find((s) => s.kind === 'env')
    if (!env || !/DATABASE_URL/.test(env.detail) || env.severity !== 'setup') throw new Error('env setup step wrong: ' + JSON.stringify(env))
    if (!rb.steps.some((s) => s.kind === 'db')) throw new Error('db step missing')
    if (!rb.steps.some((s) => s.kind === 'start' && s.command === 'pnpm run dev')) throw new Error('start command missing')
    // A present .env DOWNGRADES the env item from a blocker to a calm "double-check".
    const rb2 = buildRunbook({ hasPackageJson: true, hasLockfile: true, scripts: {}, phantomPackages: [], missingEnv: ['API_KEY'], hasEnvFile: true, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false })
    const env2 = rb2.steps.find((s) => s.kind === 'env')
    if (!env2 || env2.severity !== 'info' || !/double-check/i.test(env2.detail)) throw new Error('.env present should downgrade env to info: ' + JSON.stringify(env2))
    if (rb2.ready === 'blocked') throw new Error('no phantom → not blocked')
    // Static site → just open index.html.
    const rb3 = buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: true, partial: false })
    if (rb3.ready !== 'ready' || !rb3.steps.some((s) => /index\.html/.test(s.detail))) throw new Error('static site runbook wrong: ' + JSON.stringify(rb3))
    // partial passes through; empty inputs never throw.
    if (buildRunbook({ hasPackageJson: true, hasLockfile: true, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: true }).partial !== true) throw new Error('partial must pass through')

    // End-to-end runbook(root): a real project folds to a non-throwing runbook with a start step.
    const rp = path.join(WORKDIR, 'runproj')
    fs.mkdirSync(rp, { recursive: true })
    fs.writeFileSync(path.join(rp, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, dependencies: {} }))
    fs.writeFileSync(path.join(rp, 'package-lock.json'), '{}')
    const rbMod = require(path.join(WORKDIR, 'main', 'runbook.js'))
    const indexMod = require(path.join(WORKDIR, 'main', 'index-service.js'))
    indexMod.buildProjectIndex(rp)
    const live = await rbMod.runbook(rp)
    if (typeof live.verdict !== 'string' || !live.steps.some((s) => s.kind === 'start')) throw new Error('e2e runbook wrong: ' + JSON.stringify(live))
    // An unknown project (no package.json, not static) must NOT report a green "ready".
    const unknown = buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false })
    if (unknown.ready === 'ready' || !/README|Couldn't work out/i.test(unknown.verdict)) throw new Error('unknown project must not be "ready": ' + JSON.stringify(unknown))
    // A broken package.json is still a JS app (install step present), not misread as static.
    const bp = path.join(WORKDIR, 'runbroken')
    fs.mkdirSync(bp, { recursive: true })
    fs.writeFileSync(path.join(bp, 'package.json'), '{ not valid json')
    indexMod.buildProjectIndex(bp)
    const brokenRb = await rbMod.runbook(bp)
    if (!brokenRb.steps.some((s) => s.kind === 'install')) throw new Error('a broken package.json must still yield an install step (not misdiagnosed as static): ' + JSON.stringify(brokenRb))

    // Wave 15: Python stack. requirements + main.py → pip install + a GUESSED start (never THE command).
    const py = buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false, hasRequirementsTxt: true, pythonEntry: 'main.py', pythonPackageManager: 'pip' })
    if (!py.steps.some((s) => s.kind === 'install' && s.command === 'pip install -r requirements.txt')) throw new Error('python install command missing: ' + JSON.stringify(py.steps))
    const pyStart = py.steps.find((s) => s.kind === 'start')
    if (!pyStart || pyStart.command !== 'python main.py' || pyStart.guess !== true) throw new Error('python start must be a guessed command: ' + JSON.stringify(pyStart))
    if (py.ready !== 'setup-needed' || /python main\.py/.test(py.verdict)) throw new Error('a GUESS must NOT be presented as THE command in the verdict: ' + JSON.stringify({ ready: py.ready, verdict: py.verdict }))
    // Regression (Wave 15 review): a BARE script (main.py, NO requirements/pyproject) has ONLY a guessed
    // start and no setup steps — it must NOT read as a confident green "ready"/"Looks ready to run.".
    const bare = buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false, pythonEntry: 'main.py', pythonPackageManager: 'pip' })
    if (bare.ready === 'ready' || /Looks ready/.test(bare.verdict)) throw new Error('a bare guessed-only Python script must NOT be a green "ready": ' + JSON.stringify({ ready: bare.ready, verdict: bare.verdict }))
    if (!/best guess/i.test(bare.verdict) || !/README/i.test(bare.verdict)) throw new Error('a guess-only verdict must hedge (best guess + README): ' + bare.verdict)
    // Django manage.py → runserver; poetry pyproject → poetry install; no entry → README, not ready.
    if (!buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false, hasRequirementsTxt: true, pythonEntry: 'manage.py', pythonFrameworks: ['Django'] }).steps.some((s) => s.command === 'python manage.py runserver')) throw new Error('Django should get manage.py runserver')
    if (!buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false, hasPyproject: true, pythonPackageManager: 'poetry' }).steps.some((s) => s.command === 'poetry install')) throw new Error('poetry project should get poetry install')
    const noEntry = buildRunbook({ hasPackageJson: false, hasLockfile: false, scripts: {}, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false, hasRequirementsTxt: true, pythonPackageManager: 'pip' })
    if (noEntry.ready === 'ready' || noEntry.steps.some((s) => s.kind === 'start' && s.command)) throw new Error('python with no entry: start has no command + not ready: ' + JSON.stringify(noEntry))
    // A JS+Python repo stays Node-primary: npm install, NO pip step.
    const mixed = buildRunbook({ hasPackageJson: true, hasLockfile: true, scripts: { dev: 'vite' }, phantomPackages: [], missingEnv: [], hasEnvFile: false, hasEnvExample: false, dbModels: 0, isStaticHtml: false, partial: false, hasRequirementsTxt: true, pythonEntry: 'main.py' })
    if (mixed.steps.some((s) => /pip install/.test(s.command || ''))) throw new Error('a package.json repo must stay Node-primary (no pip step)')
    // e2e: a real Python project folds to pip install + a python start.
    const pyp = path.join(WORKDIR, 'pyproj')
    fs.mkdirSync(pyp, { recursive: true })
    fs.writeFileSync(path.join(pyp, 'requirements.txt'), 'flask==3.0\n')
    fs.writeFileSync(path.join(pyp, 'main.py'), 'print("hi")\n')
    indexMod.buildProjectIndex(pyp)
    const pyLive = await rbMod.runbook(pyp)
    if (!pyLive.steps.some((s) => /pip install/.test(s.command || '')) || !pyLive.steps.some((s) => s.kind === 'start' && /python/.test(s.command || ''))) throw new Error('e2e python runbook wrong: ' + JSON.stringify(pyLive))
    return 'phantom=blocker; env; db; node start; static; unknown≠ready; broken=JS; PYTHON pip+guessed-start(never THE cmd)/django/poetry/no-entry; node-primary mixed; e2e'
  })

  await step('App Passport: built-with/starts-at/stores + handoff (names-only) + settings checkup + typo hint', async () => {
    const pp = require(path.join(WORKDIR, 'shared', 'passport.js'))
    const ap = require(path.join(WORKDIR, 'shared', 'actionplan.js'))
    const indexService = require(path.join(WORKDIR, 'main', 'index-service.js'))
    // --- PURE folds (hand-built brain) ---
    const brain = {
      stack: { frameworks: ['React', 'Vite'], languages: { ts: 30, tsx: 10, css: 5 }, packageManagers: ['npm'] },
      entryPoints: ['src/main.tsx'],
      graph: { nodes: [], edges: [], externalDeps: [] },
      dbSchema: [{ source: 'prisma/schema.prisma', models: ['Customer', 'Order'] }],
      envVars: [
        { name: 'DATABASE_URL', referenced: true, declared: false },
        { name: 'PORT', referenced: true, declared: true },
        { name: 'SMTP_SERVER', referenced: false, declared: true },
        { name: 'SMTP_HOST', referenced: true, declared: false }
      ],
      hotspots: [], generatedAt: 0, partial: false
    }
    const passport = pp.buildPassport(brain)
    if (!passport.builtWith.includes('React') || !passport.builtWith.includes('TypeScript') || !passport.builtWith.includes('npm')) throw new Error('builtWith missing framework/language/pm: ' + JSON.stringify(passport.builtWith))
    // Friendly language names, deduped — ts+tsx fold to ONE "TypeScript", never the techy "ts"/"tsx".
    if (passport.builtWith.includes('ts') || passport.builtWith.includes('tsx')) throw new Error('builtWith must show a friendly language name, not a file extension: ' + JSON.stringify(passport.builtWith))
    if (passport.builtWith.filter((x) => x === 'TypeScript').length !== 1) throw new Error('ts and tsx must fold to exactly one TypeScript')
    if (!passport.startsAt.includes('src/main.tsx')) throw new Error('startsAt missing entry point')
    if (!(passport.stores.includes('Customer') && passport.stores.includes('Order'))) throw new Error('stores missing db models')
    // Review fix (high): stores must DEDUP across dbSchema sources — a Prisma project's migration .sql
    // re-declares the same models, so a naive flatMap would list every record type twice.
    const dupStores = pp.buildPassport({ ...brain, dbSchema: [{ source: 'prisma/schema.prisma', models: ['Customer', 'Order'] }, { source: '*.sql', models: ['Customer', 'Order', 'Invoice'] }] }).stores
    if (dupStores.length !== 3 || new Set(dupStores.map((s) => s.toLowerCase())).size !== 3) throw new Error('stores must dedup across prisma+sql sources: ' + JSON.stringify(dupStores))
    if (!(dupStores.includes('Customer') && dupStores.includes('Order') && dupStores.includes('Invoice'))) throw new Error('dedup must keep every distinct model')
    // A pure-frontend project (no frameworks/db) → empty rows, never the word "unknown"; null-safe.
    const empty = pp.buildPassport({ stack: { frameworks: [], languages: {}, packageManagers: [] }, entryPoints: [], graph: { nodes: [], edges: [], externalDeps: [] }, dbSchema: [], envVars: [], hotspots: [], generatedAt: 0, partial: false })
    if (empty.builtWith.length || empty.startsAt.length || empty.stores.length) throw new Error('an empty project must yield empty rows, not "unknown"')
    if (pp.buildPassport(null).builtWith.length) throw new Error('null brain must not throw')
    // --- Handoff: passport facts + the action plan, NAMES ONLY ---
    const plan = ap.buildActionPlan({ security: { ok: false, verdict: '', filesScanned: 1, findings: [{ severity: 'critical', file: 'a', line: 1, message: 'x' }] } })
    const handoff = pp.buildHandoff(passport, plan)
    if (!/Built with:/.test(handoff) || !/React/.test(handoff)) throw new Error('handoff missing passport facts')
    if (!handoff.includes(plan.summary)) throw new Error('handoff missing action-plan summary')
    if (!plan.items.every((it) => handoff.includes(it.title))) throw new Error('handoff missing an action-item title')
    if (/AKIA|=\s*["'][^"']{8,}/.test(handoff)) throw new Error('handoff must be names-only, never a secret value')
    // --- Settings checkup + advisory typo hint ---
    const c = pp.settingsCheckup(brain.envVars)
    if (!c.needed.includes('DATABASE_URL') || !c.needed.includes('SMTP_HOST')) throw new Error('needed must include referenced-but-undeclared vars')
    if (!c.ok.includes('PORT')) throw new Error('ok must include referenced+declared')
    const smtp = c.unused.find((u) => u.name === 'SMTP_SERVER')
    if (!smtp) throw new Error('SMTP_SERVER must be classified unused (declared, not referenced)')
    if (smtp.hint !== 'SMTP_HOST') throw new Error('unused SMTP_SERVER should hint at the needed SMTP_HOST (server≈host synonym): ' + JSON.stringify(smtp))
    if (pp.nearMatch('FOO', ['BARBAZ']) !== null) throw new Error('nearMatch must return null when nothing is close (no false hint)')
    if (pp.nearMatch('DATABASE_UR', ['DATABASE_URL']) !== 'DATABASE_URL') throw new Error('nearMatch should catch a single-char typo (missing L)')
    // Review fix (medium/low): the family hint fires ONLY for synonym tails — distinct same-prefix
    // SIBLINGS (host vs port, url vs pool) must NOT get a misleading "possible match".
    if (pp.nearMatch('SMTP_PORT', ['SMTP_HOST']) !== null) throw new Error('SMTP_PORT vs SMTP_HOST are distinct settings — no false hint')
    if (pp.nearMatch('DATABASE_POOL', ['DATABASE_URL']) !== null) throw new Error('DATABASE_POOL vs DATABASE_URL are distinct settings — no false hint')
    if (pp.nearMatch('SMTP_USER', ['SMTP_HOST']) !== null) throw new Error('SMTP_USER vs SMTP_HOST are distinct settings — no false hint')
    // ...but a genuine synonym wrong-name IS caught (server/host, url/dsn).
    if (pp.nearMatch('DATABASE_DSN', ['DATABASE_URL']) !== 'DATABASE_URL') throw new Error('DATABASE_DSN should hint at DATABASE_URL (dsn≈url synonym)')
    // --- e2e: the ALREADY-WIRED projectBrain feeds buildPassport, fully offline ---
    const fx = path.join(WORKDIR, 'passportfx')
    fs.mkdirSync(path.join(fx, 'src'), { recursive: true })
    fs.mkdirSync(path.join(fx, 'prisma'), { recursive: true })
    fs.writeFileSync(path.join(fx, 'package.json'), JSON.stringify({ dependencies: { react: '^18' } }))
    fs.writeFileSync(path.join(fx, 'src', 'main.tsx'), 'const u = process.env.DATABASE_URL\nexport default u\n')
    fs.writeFileSync(path.join(fx, 'prisma', 'schema.prisma'), 'model Customer {\n  id Int @id\n}\nmodel Order {\n  id Int @id\n}\n')
    indexService.buildProjectIndex(fx)
    const liveBrain = await indexService.projectBrain(fx)
    const livePassport = pp.buildPassport(liveBrain)
    if (!livePassport.stores.includes('Customer') || !livePassport.stores.includes('Order')) throw new Error('e2e: projectBrain→buildPassport must surface prisma models: ' + JSON.stringify(livePassport))
    if (!livePassport.builtWith.includes('TypeScript') || livePassport.builtWith.includes('tsx')) throw new Error('e2e: the real brain (.tsx entry) must fold to friendly TypeScript: ' + JSON.stringify(livePassport.builtWith))
    return 'passport folds brain (built-with/starts-at/stores, empty≠unknown); handoff bundles facts+plan names-only; checkup needed/ok/unused + family typo hint; e2e projectBrain→passport'
  })

  await step('Wave 21 Put-It-Back (real I/O): previewPath counts + caps, trashPath snapshots for Undo', async () => {
    const fsSvc = require(path.join(WORKDIR, 'main', 'fs-service.js'))
    const undo = require(path.join(WORKDIR, 'main', 'undo.js'))
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-del-'))
    try {
      // A small tree: 3 files at the top, 2 more one level down, plus a node_modules we must NOT walk.
      fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
      fs.writeFileSync(path.join(root, 'b.txt'), 'world!')
      fs.mkdirSync(path.join(root, 'sub'))
      fs.writeFileSync(path.join(root, 'sub', 'c.txt'), 'x')
      fs.writeFileSync(path.join(root, 'sub', 'd.txt'), 'y')
      fs.mkdirSync(path.join(root, 'sub', 'node_modules'))
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(root, 'sub', 'node_modules', `n${i}.js`), '//')
      const one = fsSvc.previewPath(root, 'a.txt')
      if (one.isDir || one.files !== 1 || one.bytes !== 5) throw new Error('single file preview wrong: ' + JSON.stringify(one))
      const dir = fsSvc.previewPath(root, 'sub')
      if (!dir.isDir || dir.files !== 2) throw new Error('a folder must count its own files but NOT walk node_modules: ' + JSON.stringify(dir))
      // node_modules is counted but never walked, so the totals are LOWER BOUNDS — the preview must say
      // so rather than print a confident count that is orders of magnitude short.
      if (!dir.capped) throw new Error('a folder holding an unwalked node_modules must report capped')
      const plain = path.join(root, 'plain')
      fs.mkdirSync(plain)
      fs.writeFileSync(path.join(plain, 'only.txt'), 'x')
      const plainP = fsSvc.previewPath(root, 'plain')
      if (plainP.capped || plainP.files !== 1) throw new Error('an ordinary small folder must report an EXACT count: ' + JSON.stringify(plainP))
      // An unreadable folder must never collapse into the confident "this folder is empty".
      if (process.platform !== 'win32') {
        // chmod does not restrict reads on Windows, so this case can only be exercised on POSIX.
        const locked = path.join(root, 'locked')
        fs.mkdirSync(locked)
        fs.writeFileSync(path.join(locked, 'secret.txt'), 'x')
        fs.chmodSync(locked, 0o000)
        try {
          const lockedP = fsSvc.previewPath(root, 'locked')
          if (!lockedP.capped) throw new Error('an unreadable folder must report capped, never "empty"')
        } finally {
          fs.chmodSync(locked, 0o755)
        }
      }
      // Escaping the project root is refused by safeResolve, and a missing path is calm.
      const escaped = fsSvc.previewPath(root, '../../etc')
      if (escaped.files !== 0 || escaped.isDir) throw new Error('a path outside the project must yield nothing: ' + JSON.stringify(escaped))
      const missing = fsSvc.previewPath(root, 'nope.txt')
      if (missing.files !== 0) throw new Error('a missing path must be calm, not a throw')
      // The cap must trip on a genuinely big folder and REPORT itself.
      const big = path.join(root, 'big')
      fs.mkdirSync(big)
      for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'z')
      const bigP = fsSvc.previewPath(root, 'big')
      if (!bigP.capped) throw new Error('600 files must trip the cap and say so')
      if (bigP.files > 501) throw new Error('the walk must STOP at the cap, not count everything: ' + bigP.files)
      // trashPath snapshots a single text file first, so the app's OWN Undo can bring it back.
      // Use a UNIQUE name so we can remove our own entry from the real Trash afterwards and leave the
      // user's machine exactly as we found it (this suite must not accumulate junk on every run).
      const uniq = `atomic-trash-test-${process.pid}-${cleanupCounter++}.txt`
      fs.writeFileSync(path.join(root, uniq), 'hello')
      const before = undo.history().length
      const res = await fsSvc.trashPath(root, uniq)
      if (!res.ok || !res.trashed) throw new Error('trashPath should succeed on a normal file: ' + JSON.stringify(res))
      if (fs.existsSync(path.join(root, uniq))) throw new Error('the file should be gone from the project')
      if (undo.history().length !== before + 1) throw new Error('a trashed text file must be snapshotted for Undo')
      const restored = undo.undo()
      if (!restored || !fs.existsSync(path.join(root, uniq))) throw new Error('↩ Undo must bring a trashed file back, got: ' + JSON.stringify(restored))
      if (fs.readFileSync(path.join(root, uniq), 'utf8') !== 'hello') throw new Error('Undo must restore the ORIGINAL content')
      purgeFromTrash(uniq)
      // The project root itself is never deletable.
      const rootRes = await fsSvc.trashPath(root, '.')
      if (rootRes.ok || rootRes.trashed) throw new Error('the project root must never be trashable: ' + JSON.stringify(rootRes))
      // A vanished path is a calm no-op that reports it did NOT trash anything.
      const gone = await fsSvc.trashPath(root, 'never-existed.txt')
      if (!gone.ok || gone.trashed) throw new Error('a missing path: ok but trashed:false — never a phantom success')
      // previewPath.restorable must be EXACTLY what trashPath will snapshot. If they drift, the confirm
      // message promises "↩ Undo brings it straight back" for a file that was never snapshotted.
      const picName = `atomic-trash-test-${process.pid}-${cleanupCounter++}.png`
      fs.writeFileSync(path.join(root, picName), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const picPrev = fsSvc.previewPath(root, picName)
      if (picPrev.restorable) throw new Error('a BINARY file is never snapshotted → restorable must be false: ' + JSON.stringify(picPrev))
      const beforePic = undo.history().length
      await fsSvc.trashPath(root, picName)
      if (undo.history().length !== beforePic) throw new Error('trashPath must NOT snapshot a binary — preview and trash must agree')
      purgeFromTrash(picName)
      fs.writeFileSync(path.join(root, 'text.md'), '# hi')
      if (!fsSvc.previewPath(root, 'text.md').restorable) throw new Error('a small TEXT file must be restorable')
      // A FOLDER is now restorable in-app too (its text files are snapshotted under one checkpoint).
      if (!fsSvc.previewPath(root, 'sub').restorable) throw new Error('a small folder must be restorable by the in-app Undo')

      // Deleting a FOLDER must come back with ONE click — not "go dig in the Trash". Every text file
      // inside is snapshotted under a single checkpoint, and restoring recreates the folders too.
      const treeRoot = path.join(root, 'proj-tree')
      fs.mkdirSync(path.join(treeRoot, 'deep', 'deeper'), { recursive: true })
      fs.writeFileSync(path.join(treeRoot, 'a.txt'), 'AAA')
      fs.writeFileSync(path.join(treeRoot, 'deep', 'b.txt'), 'BBB')
      fs.writeFileSync(path.join(treeRoot, 'deep', 'deeper', 'c.txt'), 'CCC')
      if (!fsSvc.previewPath(root, 'proj-tree').restorable) throw new Error('a small folder must promise an in-app restore')
      const beforeTree = undo.history().length
      const tRes = await fsSvc.trashPath(root, 'proj-tree')
      if (!tRes.ok || !tRes.trashed) throw new Error('folder trash failed: ' + JSON.stringify(tRes))
      if (fs.existsSync(treeRoot)) throw new Error('the folder should be gone')
      if (tRes.restoredFiles !== 3) throw new Error('all 3 text files must be snapshotted: ' + JSON.stringify(tRes))
      if (!tRes.checkpointId) throw new Error('a folder delete must record a checkpoint for one-click restore')
      if (undo.history().length !== beforeTree + 3) throw new Error('3 snapshots expected')
      const back = undo.restoreToCheckpoint(tRes.checkpointId)
      if (!back || back.length !== 3) throw new Error('restoring the checkpoint must bring back all 3 files: ' + JSON.stringify(back))
      for (const [rel, want] of [['a.txt', 'AAA'], ['deep/b.txt', 'BBB'], ['deep/deeper/c.txt', 'CCC']]) {
        const abs = path.join(treeRoot, ...rel.split('/'))
        if (!fs.existsSync(abs)) throw new Error(`${rel} was not restored — nested folders must be recreated`)
        if (fs.readFileSync(abs, 'utf8') !== want) throw new Error(`${rel} restored with the wrong content`)
      }
      fs.rmSync(treeRoot, { recursive: true, force: true })
      // A folder too big for the undo stack must NOT promise an in-app restore (Trash only).
      const huge = path.join(root, 'huge-tree')
      fs.mkdirSync(huge)
      for (let i = 0; i < 320; i++) fs.writeFileSync(path.join(huge, `f${i}.txt`), 'x')
      if (fsSvc.previewPath(root, 'huge-tree').restorable) throw new Error('past the cap we must NOT promise an in-app restore')

      // A git-IGNORED folder inside a repo reports zero changes FOREVER. gitInfo must flag it, or the
      // delete preview reads "all of it is already backed up" about work git has never seen — the exact
      // lie this wave exists to kill. (Caught by the GUI test: its fixture lives under ignored .ui-test/.)
      const gitMod = require(path.join(WORKDIR, 'main', 'git.js'))
      execSync(`git -C "${root}" init -q && git -C "${root}" config user.email t@t && git -C "${root}" config user.name T`, { shell: '/bin/bash' })
      fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-app/\n')
      execSync(`git -C "${root}" add -A && git -C "${root}" commit -qm init`, { shell: '/bin/bash' })
      const ignoredApp = path.join(root, 'ignored-app')
      fs.mkdirSync(ignoredApp)
      fs.writeFileSync(path.join(ignoredApp, 'work.txt'), 'precious unbacked-up work')
      const ignoredInfo = await gitMod.gitInfo(ignoredApp)
      if (!ignoredInfo.isRepo) throw new Error('an ignored folder is still INSIDE the work tree — isRepo must stay true')
      if (ignoredInfo.isIgnored !== true) throw new Error('a git-ignored project folder must be flagged isIgnored: ' + JSON.stringify(ignoredInfo))
      if ((await gitMod.gitWorkingStat(ignoredApp)).files.length !== 0) throw new Error('precondition: git reports nothing inside an ignored folder')
      const trackedInfo = await gitMod.gitInfo(root)
      if (trackedInfo.isIgnored === true) throw new Error('a NORMAL project must not be flagged ignored: ' + JSON.stringify(trackedInfo))
      // And the fold, fed the honest signal, must refuse to claim the work is safe.
      const { describeDeletion: dd } = require(path.join(WORKDIR, 'shared', 'deletesafety.js'))
      const blindText = dd({ relPath: 'ignored-app', isDir: true, files: 1, dirs: 0, bytes: 25, countCapped: false, gitKnown: false, neverBackedUp: 0, changedNotBackedUp: 0, canRestoreWithUndo: false, trashAvailable: true }).lines.join(' ')
      if (/already backed up/.test(blindText)) throw new Error('an ignored folder must never read as backed up: ' + blindText)

      // deletePath is UNCHANGED and still the permanent primitive the harness uses for cleanup.
      fs.writeFileSync(path.join(root, 'perm.txt'), 'x')
      if (!fsSvc.deletePath(root, 'perm.txt').ok || fs.existsSync(path.join(root, 'perm.txt'))) throw new Error('deletePath must still permanently delete')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
    return 'previewPath: file/folder counts, skips node_modules, escape+missing calm, 600 files → capped; trashPath: snapshot → Undo restores content, root refused, missing = no phantom success; deletePath unchanged'
  })

  await step('Wave 21 Put-It-Back: describeDeletion says what would go, and never fakes certainty', async () => {
    const { describeDeletion } = require(path.join(WORKDIR, 'shared', 'deletesafety.js'))
    const base = { relPath: 'src/a.ts', isDir: false, files: 1, dirs: 0, bytes: 900, countCapped: false, gitKnown: true, neverBackedUp: 0, changedNotBackedUp: 0, canRestoreWithUndo: true, trashAvailable: true }
    // A backed-up single file is the calm case: amber, Trash, and it names the app's own Undo.
    const one = describeDeletion(base)
    if (one.band !== 'amber' || one.confirmLabel !== 'Move to Trash') throw new Error('a backed-up single file → amber + Move to Trash: ' + JSON.stringify(one))
    if (!/Undo/.test(one.lines.join(' '))) throw new Error('a snapshotted file must tell the user Undo brings it back')
    // A folder holding unbacked-up work must say BOTH numbers and go red.
    const dir = describeDeletion({ ...base, relPath: 'src/old', isDir: true, files: 14, dirs: 3, bytes: 40000, neverBackedUp: 3, canRestoreWithUndo: false })
    if (dir.band !== 'red') throw new Error('unbacked-up work at stake must be RED: ' + JSON.stringify(dir))
    if (!/14 files/.test(dir.lines.join(' ')) || !/3 files never backed up/.test(dir.lines.join(' '))) throw new Error('the folder case must name BOTH the total and the never-backed-up count: ' + JSON.stringify(dir.lines))
    if (!/not backed up/.test(dir.headline)) throw new Error('the headline must lead with the risk: ' + dir.headline)
    // HONESTY A — a capped count must never be printed as an exact total.
    const capped = describeDeletion({ ...base, relPath: 'huge', isDir: true, files: 500, dirs: 20, countCapped: true })
    const cappedText = capped.lines.join(' ')
    if (!/at least 500 files/.test(cappedText) || !/stopped counting/.test(cappedText)) throw new Error('a capped walk must say "at least N … stopped counting": ' + cappedText)
    if (/holds 500 files/.test(cappedText)) throw new Error('a capped count must NOT be stated as the exact total')
    // HONESTY B — with no git we know NOTHING; never render a reassuring zero.
    const noGit = describeDeletion({ ...base, isDir: true, files: 4, gitKnown: false })
    const noGitText = noGit.lines.join(' ')
    if (!/can't tell whether/.test(noGitText)) throw new Error('unknown backup state must be stated plainly: ' + noGitText)
    if (/already backed up/.test(noGitText) || /0 file/.test(noGitText)) throw new Error('unknown backup state must NEVER read as "backed up" or "0": ' + noGitText)
    if (noGit.band !== 'red') throw new Error('deleting a folder blind (no backup info) must be RED')
    // HONESTY C — no Trash ⇒ the button must say the deletion is permanent.
    const noTrash = describeDeletion({ ...base, trashAvailable: false })
    if (noTrash.confirmLabel !== 'Delete permanently' || noTrash.band !== 'red') throw new Error('no Trash → red + "Delete permanently": ' + JSON.stringify(noTrash))
    if (!/permanent/i.test(noTrash.lines.join(' ')) || !/Permanently delete/.test(noTrash.headline)) throw new Error('the permanent case must say so in words')
    if (/Trash/.test(noTrash.confirmLabel)) throw new Error('the button must not promise the Trash when the delete is permanent')
    return 'describeDeletion: file/folder counts, red on unbacked-up work; capped→"at least N", no-git→"can\'t tell" (never 0), no-trash→"Delete permanently"'
  })

  await step('Wave 21 seatbelt: unsavedGuard blocks only when typing would actually be lost', async () => {
    const { unsavedGuard } = require(path.join(WORKDIR, 'shared', 'worksafety.js'))
    // THE anti-intrusion regression test: a clean tab must still close in ONE click, forever.
    const clean = unsavedGuard({ reason: 'close-tab', dirtyPaths: [], targetPath: 'src/a.ts' })
    if (clean.block || clean.choices.length) throw new Error('a CLEAN tab must never be interrupted: ' + JSON.stringify(clean))
    // A dirty tab that is NOT the one being closed must also not interrupt.
    const other = unsavedGuard({ reason: 'close-tab', dirtyPaths: ['src/b.ts'], targetPath: 'src/a.ts' })
    if (other.block) throw new Error('closing a clean tab while ANOTHER tab is dirty must not block')
    const dirty = unsavedGuard({ reason: 'close-tab', dirtyPaths: ['src/a.ts'], targetPath: 'src/a.ts' })
    if (!dirty.block || !/a\.ts/.test(dirty.headline)) throw new Error('closing a dirty tab must block and name the file: ' + JSON.stringify(dirty))
    if (JSON.stringify(dirty.choices) !== JSON.stringify(['save', 'discard', 'cancel'])) throw new Error('close-tab choices must be save/discard/cancel: ' + JSON.stringify(dirty.choices))
    // Remote tabs: this app's Undo cannot reach a company server — say so instead of implying safety.
    const remote = unsavedGuard({ reason: 'close-tab', dirtyPaths: ['ssh:/srv/app.js'], targetPath: 'ssh:/srv/app.js', isRemote: true })
    if (!/company server/.test(remote.lines.join(' ')) || !/cannot take it back/.test(remote.lines.join(' '))) throw new Error('a remote tab must warn that Undo cannot reach it: ' + JSON.stringify(remote.lines))
    // switch-project names the files and keeps the count honest when there are many.
    const many = unsavedGuard({ reason: 'switch-project', dirtyPaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] })
    if (!many.block || !/5 files/.test(many.headline)) throw new Error('switching with 5 dirty tabs must block and count them: ' + JSON.stringify(many))
    if (!/2 more/.test(many.headline)) throw new Error('a truncated list must say how many more: ' + many.headline)
    if (!unsavedGuard({ reason: 'switch-project', dirtyPaths: [] }).block === false) { /* checked below */ }
    if (unsavedGuard({ reason: 'switch-project', dirtyPaths: [] }).block) throw new Error('switching with NO unsaved work must not interrupt')
    // ai-changed-file offers keep/take — never a bare "discard", which would read as discarding the AI's work.
    const ai = unsavedGuard({ reason: 'ai-changed-file', dirtyPaths: ['src/a.ts'], targetPath: 'src/a.ts' })
    if (JSON.stringify(ai.choices) !== JSON.stringify(['keep-mine', 'take-theirs'])) throw new Error('ai-changed-file choices must be keep-mine/take-theirs: ' + JSON.stringify(ai.choices))
    if (unsavedGuard({ reason: 'ai-changed-file', dirtyPaths: [], targetPath: 'src/a.ts' }).block) throw new Error('an AI edit to a CLEAN tab must reload silently, as before')
    return 'unsavedGuard: clean tab/other-tab/no-dirty never block; dirty close names file + save/discard/cancel; remote warns Undo cannot reach; 5-file switch counts honestly; ai-edit = keep/take'
  })

  await step('Wave 21 review fixes: fail-closed chains, uncommitted-work destroyers, ignored paths', async () => {
    const { classifyScript, classifyFileBody } = require(path.join(WORKDIR, 'shared', 'scriptrisk.js'))
    const { workSafety } = require(path.join(WORKDIR, 'shared', 'worksafety.js'))
    // R1: `yarn run X` indirection was skipped entirely — one hop hid any risky script.
    const yr = classifyScript('ship', { ship: 'yarn run deploy', deploy: 'wrangler pages deploy' })
    if (yr.risk !== 'risky') throw new Error('`yarn run <script>` indirection must be followed: ' + JSON.stringify(yr))
    // R1: run-s / npm-run-all aggregators fan out to several scripts.
    const rs = classifyScript('all', { all: 'run-s lint build publishit', publishit: 'npm publish' })
    if (rs.risk !== 'risky') throw new Error('run-s must be followed into each named script: ' + JSON.stringify(rs))
    // R1: FAIL CLOSED — a chain we could not finish is "unknown", never "safe".
    const deep = classifyScript('a', { a: 'npm run b', b: 'npm run c', c: 'npm run d', d: 'npm run e', e: 'wrangler deploy' }, { maxDepth: 2 })
    if (deep.risk !== 'unknown') throw new Error('a chain cut short by the depth cap must be UNKNOWN, not safe: ' + JSON.stringify(deep))
    const opaque = classifyScript('build', { build: 'node scripts/build.js' })
    if (opaque.risk !== 'unknown') throw new Error('a script that hands off to a FILE we cannot read must be unknown: ' + JSON.stringify(opaque))
    // R1: the commands that destroy UNCOMMITTED work were missing from the table entirely.
    for (const body of ['git clean -fdx', 'git reset --hard origin/main', 'rm -rf /', 'rm -rf $HOME/x', 'fly deploy', 'pulumi destroy', 'supabase db reset', 'aws s3 sync dist s3://bucket']) {
      const v = classifyScript('x', { x: body })
      if (v.risk !== 'risky') throw new Error(`"${body}" destroys or publishes something and must be refused: ` + JSON.stringify(v))
    }
    // R1: "now" is an ordinary English word — it must not trigger a deploy refusal on its own.
    if (classifyScript('x', { x: 'echo building now' }).risk !== 'safe') throw new Error('the word "now" must not be treated as a deploy tool')
    if (classifyScript('x', { x: 'rm -rf ./dist' }).risk !== 'safe') throw new Error('deleting a local build folder is ordinary and must stay allowed')
    // R1: scanning a whole SOURCE file over-refuses — only real execution sites count.
    const mentions = classifyFileBody('test.js', 'const doc = "run git push to publish"\nconsole.log(doc)\n')
    if (mentions.risk !== 'safe') throw new Error('a file that merely MENTIONS a command in a string must not be refused: ' + JSON.stringify(mentions))
    const executes = classifyFileBody('deploy.js', 'const { execSync } = require("child_process")\nexecSync("wrangler pages deploy dist")\n')
    if (executes.risk !== 'risky') throw new Error('a file that actually EXECUTES a deploy must be refused: ' + JSON.stringify(executes))
    const shell = classifyFileBody('deploy.sh', '#!/bin/sh\nvercel --prod\n')
    if (shell.risk !== 'risky') throw new Error('a shell script has no wrapper — scan it whole: ' + JSON.stringify(shell))
    // R1: a git-IGNORED project folder must never show the green "All your work is backed up".
    const base = { isRepo: true, isRepoRoot: true, changedFiles: 0, lastCommitTs: Date.now() - 1000, sessionEdits: 0, restorePoints: 0, now: Date.now() }
    const green = workSafety(base)
    if (green.band !== 'green') throw new Error('precondition: a clean tracked repo is green')
    const ign = workSafety({ ...base, isIgnored: true })
    if (ign.band === 'green') throw new Error('a git-IGNORED folder must NEVER read green — nothing there is backed up: ' + JSON.stringify(ign))
    if (ign.canBackup) throw new Error('an ignored folder cannot be backed up by committing')
    if (!/excluded from backups/.test(ign.verdict)) throw new Error('it must say WHY: ' + ign.verdict)
    return 'chains fail CLOSED (depth cap + file hand-off = unknown); yarn run/run-s followed; git clean/reset --hard/fly/pulumi/supabase/aws caught; "now" + local rm -rf allowed; file scan = execution sites only; ignored folder never green'
  })

  await step('Wave 22: the security gate never says "safe to ship" about a project it only partly read', async () => {
    const sec = require(path.join(WORKDIR, 'main', 'security.js'))
    const { coverageNote, qualifyClean, moreLine, fullCoverage } = require(path.join(WORKDIR, 'shared', 'coverage.js'))
    const { buildShipReadiness, buildActionPlan } = require(path.join(WORKDIR, 'shared', 'actionplan.js'))
    const { buildComplianceReport } = require(path.join(WORKDIR, 'main', 'compliance.js'))
    // THE ANTI-NAGWARE PIN: nothing hidden ⇒ absolute silence, and the verdict is byte-identical.
    if (coverageNote(fullCoverage(4)) !== '') throw new Error('an uncapped read must add NO caveat at all')
    const clean = 'Looks safe to ship — no hardcoded secrets or private keys found.'
    if (qualifyClean(clean, fullCoverage(4)) !== clean) throw new Error('a fully-read project keeps today\'s exact sentence')
    if (moreLine(3, 3) !== '' || moreLine(40, 210) !== '…and 170 more') throw new Error('moreLine wrong')
    // Count-only: these strings reach a compliance report a client may read.
    const note = coverageNote({ read: 600, capped: true, reasons: ['file-cap'] })
    // Count-only means no PATHS and no quoted values; an ordinary apostrophe in English is fine.
    if (!/600/.test(note) || /\//.test(note) || /["`]/.test(note)) throw new Error('the caveat must be count-only, never a path or value: ' + note)
    // A REAL capped scan: 620 scannable files trips the 600-file cap.
    const big = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-cap-'))
    try {
      for (let i = 0; i < 620; i++) fs.writeFileSync(path.join(big, `f${i}.ts`), 'export const a = 1\n')
      const rep = sec.scanProject(big)
      if (!rep.coverage.capped || !rep.coverage.reasons.includes('file-cap')) throw new Error('620 files must trip the file cap: ' + JSON.stringify(rep.coverage))
      if (/^Looks safe to ship — no hardcoded secrets or private keys found\.$/.test(rep.verdict)) throw new Error('a PARTIAL read must never give the unqualified all-clear: ' + rep.verdict)
      if (!/part of this project/.test(rep.verdict)) throw new Error('it must say it only read part: ' + rep.verdict)
      // ...and that must block the GREEN ship light, which is what the CEO actually acts on.
      const ship = buildShipReadiness(buildActionPlan({ security: rep }), { security: rep })
      if (ship.band === 'green') throw new Error('a capped scan must never license a GREEN "safe to ship"')
      if (!ship.incomplete) throw new Error('incomplete must be true so the amber wording explains itself')
      // The auditor-facing export must carry the same caveat, not a clean bill of health.
      const md = buildComplianceReport('capped-proj', Date.now(), rep, [], [])
      if (/_No hardcoded secrets or private keys found\._/.test(md)) throw new Error('the compliance export must not state an unqualified all-clear on a partial scan')
      if (!/\*\*Coverage:\*\*/.test(md)) throw new Error('the compliance export must state how much was scanned')
    } finally {
      fs.rmSync(big, { recursive: true, force: true })
    }
    // A SMALL clean project must be byte-identical to before this wave (the regression pin).
    const small = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-small-'))
    try {
      fs.writeFileSync(path.join(small, 'a.ts'), 'export const hello = 1\n')
      const rep = sec.scanProject(small)
      if (rep.coverage.capped) throw new Error('a 1-file project must not be capped: ' + JSON.stringify(rep.coverage))
      if (rep.verdict !== clean) throw new Error('a small clean project must keep the exact old sentence: ' + rep.verdict)
      if (coverageNote(rep.coverage) !== '') throw new Error('no caveat may render on a fully-read project')
      const ship = buildShipReadiness(buildActionPlan({ security: rep }), { security: rep })
      if (ship.band !== 'green') throw new Error('a fully-read clean project must still go GREEN: ' + JSON.stringify(ship))
    } finally {
      fs.rmSync(small, { recursive: true, force: true })
    }
    return 'capped scan → qualified verdict + no GREEN + compliance caveat; fully-read scan → byte-identical verdict, zero caveats, still GREEN; caveats are count-only'
  })

  await step('Wave 22: "no tests" becomes "not sure" when it came from a partial sample', async () => {
    const { testsClaim, buildActionPlan, kindProblemCount } = require(path.join(WORKDIR, 'shared', 'actionplan.js'))
    const full = { hasTests: false, coverage: { read: 12, capped: false, reasons: [] }, debt: [], fileCount: 12 }
    const capped = { hasTests: false, coverage: { read: 300, capped: true, reasons: ['file-cap'] }, debt: [], fileCount: 300 }
    const has = { hasTests: true, coverage: { read: 300, capped: true, reasons: ['file-cap'] }, debt: [], fileCount: 300 }
    if (testsClaim(full) !== 'no') throw new Error('a fully-read project with no tests is honestly "no"')
    if (testsClaim(capped) !== 'unknown') throw new Error('a PARTIAL read that saw no tests must be "unknown", never "no"')
    if (testsClaim(has) !== 'yes') throw new Error('seeing a test file is proof, capped or not')
    if (testsClaim(null) !== 'unknown' || testsClaim({}) !== 'unknown') throw new Error('missing data must fail to unknown, never to a confident answer')
    // The action plan must ASK, not accuse — and must not be a high-severity blocker.
    const askItem = buildActionPlan({ insight: capped }).items.find((i) => i.kind === 'tests')
    if (!askItem || askItem.severity !== 'medium') throw new Error('an unknown must be a medium question, not a HIGH accusation: ' + JSON.stringify(askItem))
    if (/no tests yet/.test(askItem.detail)) throw new Error('it must not state as fact something it never checked: ' + askItem.detail)
    const accuseItem = buildActionPlan({ insight: full }).items.find((i) => i.kind === 'tests')
    if (!accuseItem || accuseItem.severity !== 'high' || !/no tests yet/.test(accuseItem.detail)) throw new Error('a fully-read project with no tests keeps the old HIGH item (regression pin): ' + JSON.stringify(accuseItem))
    // Fix-Verify must not count a problem we never established (it would report a phantom "fix").
    if (kindProblemCount('tests', { insight: capped }) !== 0) throw new Error('an unknown contributes 0 problems — otherwise Fix-Verify posts a fake "Fixed"')
    if (kindProblemCount('tests', { insight: full }) !== 1) throw new Error('a real missing-tests problem still counts 1')
    return 'testsClaim yes/no/unknown; capped sample → medium QUESTION not high accusation; fully-read keeps the old HIGH item; unknown counts 0 so Fix-Verify cannot fake a fix'
  })

  await step('Wave 22: the unbacked-up count is exact when it can be, and a floor when it cannot', async () => {
    const { workSafety } = require(path.join(WORKDIR, 'shared', 'worksafety.js'))
    const { describeDeletion } = require(path.join(WORKDIR, 'shared', 'deletesafety.js'))
    const { moreLine } = require(path.join(WORKDIR, 'shared', 'coverage.js'))
    const base = { isRepo: true, isRepoRoot: true, changedFiles: 900, lastCommitTs: Date.now() - 1000, sessionEdits: 0, restorePoints: 0, now: Date.now() }
    const exact = workSafety({ ...base, changedFilesExact: true })
    if (!/^900 changed files not backed up yet\./.test(exact.verdict)) throw new Error('an exact count keeps the plain sentence (regression pin): ' + exact.verdict)
    const floor = workSafety({ ...base, changedFilesExact: false })
    if (!/^At least 900 changed files/.test(floor.verdict)) throw new Error('a floor must say "At least": ' + floor.verdict)
    if (floor.band !== exact.band) throw new Error('a floor is not a new emergency — the band must not change')
    if (workSafety({ ...base }).verdict !== exact.verdict) throw new Error('omitting the flag must behave exactly as before (no silent change)')
    // The delete preview must inherit the same honesty.
    const dbase = { relPath: 'src', isDir: true, files: 3, dirs: 0, bytes: 100, countCapped: false, gitKnown: true, neverBackedUp: 5, changedNotBackedUp: 2, canRestoreWithUndo: false, trashAvailable: true, trashName: 'Trash' }
    if (!/at least 5 files never backed up/.test(describeDeletion({ ...dbase, backupCountsCapped: true }).lines.join(' '))) throw new Error('a capped backup count must say "at least"')
    const plain = describeDeletion(dbase).lines.join(' ')
    if (/at least/.test(plain)) throw new Error('an exact count must NOT hedge (regression pin): ' + plain)
    if (moreLine(40, 210) !== '…and 170 more') throw new Error('the hidden-rows line must name the real remainder')
    return 'exact count keeps the old sentence; a truncated one says "At least" without changing the band; delete preview inherits it; 40-of-210 says "…and 170 more"'
  })

  await step('Wave 21 follow-up: uncurated deploy tools are caught, and the bin is named per platform', async () => {
    const { classifyScript } = require(path.join(WORKDIR, 'shared', 'scriptrisk.js'))
    const { describeDeletion } = require(path.join(WORKDIR, 'shared', 'deletesafety.js'))
    // The curated table can only name tools we thought of. The second tier catches the SHAPE of a
    // publish/destroy by a tool we have never heard of — as "I can't be sure", not a false certainty.
    for (const body of ['acme-cli deploy --env production', 'mycorp-tool publish', './infra destroy', 'ourhost release --prod']) {
      const v = classifyScript('x', { x: body })
      if (v.risk !== 'unknown') throw new Error(`an UNKNOWN tool doing "${body}" must be flagged, not silently run: ` + JSON.stringify(v))
      // Either honest route is fine — an unreadable hand-off or an unrecognised tool — so long as it
      // admits uncertainty instead of claiming to know.
      if (!/can't be sure|recognise|can't tell/.test(v.why || '')) throw new Error('it must admit uncertainty rather than claim knowledge: ' + v.why)
    }
    // ...without touching ordinary local build work, which is the whole cost of a net like this.
    for (const body of ['vite build', 'next build && next export', 'tsc -p tsconfig.json', 'jest --coverage',
                        'eslint . --fix', 'rimraf dist', 'electron-builder --publish never', 'expo start',
                        'concurrently "npm:dev:*"', 'cross-env NODE_ENV=production vite build']) {
      const v = classifyScript('x', { x: body })
      if (v.risk !== 'safe') throw new Error(`ordinary local build work must stay allowed: "${body}" → ` + JSON.stringify(v))
    }
    // A curated tool still wins with its SPECIFIC reason (never downgraded to the vague net).
    const known = classifyScript('x', { x: 'wrangler pages deploy dist' })
    if (known.risk !== 'risky' || !/live website/.test(known.why || '')) throw new Error('a curated tool keeps its precise reason: ' + JSON.stringify(known))
    // The delete message must use the OS's own word — "Finder → Trash" is meaningless on Windows.
    const base = { relPath: 'a.txt', isDir: false, files: 1, dirs: 0, bytes: 10, countCapped: false, gitKnown: true, neverBackedUp: 0, changedNotBackedUp: 0, canRestoreWithUndo: true, trashAvailable: true }
    const win = describeDeletion({ ...base, trashName: 'Recycle Bin' })
    if (win.confirmLabel !== 'Move to Recycle Bin') throw new Error('the button must use the platform name: ' + win.confirmLabel)
    if (/Trash|Finder/.test(win.lines.join(' '))) throw new Error('no macOS-only words on Windows: ' + JSON.stringify(win.lines))
    const mac = describeDeletion({ ...base, trashName: 'Trash' })
    if (mac.confirmLabel !== 'Move to Trash') throw new Error('macOS wording regressed: ' + mac.confirmLabel)
    // A FOLDER that can be restored says so — the old text sent the user to Finder for everything.
    const dir = describeDeletion({ ...base, relPath: 'src', isDir: true, files: 4, dirs: 1, bytes: 900, canRestoreWithUndo: true, trashName: 'Trash' })
    if (!/whole folder back/.test(dir.lines.join(' '))) throw new Error('a restorable folder must promise the folder, not one file: ' + JSON.stringify(dir.lines))
    const bigDir = describeDeletion({ ...base, relPath: 'src', isDir: true, files: 900, dirs: 9, bytes: 99999, canRestoreWithUndo: false, trashName: 'Trash' })
    if (/↩ Undo/.test(bigDir.lines.join(' '))) throw new Error('past the cap we must NOT promise Undo: ' + JSON.stringify(bigDir.lines))
    return 'uncurated deploy/destroy tools flagged as "not sure" (10 ordinary build scripts untouched); curated reasons preserved; bin named per platform; folder restore promised only within the cap'
  })

  await step('Wave 21 round-2: hand-offs are READ not guessed, and every sentence matches its verdict', async () => {
    const { classifyScript, classifyFileBody, scriptRefusal } = require(path.join(WORKDIR, 'shared', 'scriptrisk.js'))
    const { describeDeletion } = require(path.join(WORKDIR, 'shared', 'deletesafety.js'))
    const { unsavedGuard, workSafety } = require(path.join(WORKDIR, 'shared', 'worksafety.js'))
    // R2: a script that hands off to a file must be RESOLVED, not blanket-refused. Refusing every
    // `node scripts/build.js` would have broken the agent's ordinary work.
    const files = { 'scripts/build.js': 'console.log("building")\n', 'scripts/ship.js': 'require("child_process").execSync("vercel --prod")\n' }
    const reader = (rel) => (rel in files ? files[rel] : null)
    const okBuild = classifyScript('build', { build: 'node scripts/build.js' }, { readFile: reader })
    if (okBuild.risk !== 'safe') throw new Error('a readable, harmless build script must be ALLOWED, not refused: ' + JSON.stringify(okBuild))
    const badShip = classifyScript('ship', { ship: 'node scripts/ship.js' }, { readFile: reader })
    if (badShip.risk !== 'risky') throw new Error('a hand-off to a file that DOES deploy must be caught: ' + JSON.stringify(badShip))
    const missing = classifyScript('x', { x: 'node scripts/gone.js' }, { readFile: reader })
    if (missing.risk !== 'unknown' || !/gone\.js/.test(missing.why || '')) throw new Error('an unreadable hand-off is unknown AND names the file: ' + JSON.stringify(missing))
    // R2: wrapper/env prefixes must not hide the hand-off.
    const wrapped = classifyScript('x', { x: 'cross-env NODE_ENV=production node scripts/ship.js' }, { readFile: reader })
    if (wrapped.risk !== 'risky') throw new Error('a wrapper prefix must not hide the real command: ' + JSON.stringify(wrapped))
    // R2: `node --test` hands off to nothing — a flag is not a file.
    if (classifyScript('x', { x: 'node --test' }, { readFile: reader }).risk !== 'safe') throw new Error('`node --test` must stay allowed — a flag is not a hand-off')
    // R2: an exec call written INSIDE a string is a fixture, not a command (this repo's own test suite).
    const fixture = classifyFileBody('t.cjs', 'fs.writeFileSync(p, "require(\'child_process\').execSync(\'wrangler pages deploy\')")\n')
    if (fixture.risk !== 'safe') throw new Error('a command inside a STRING is a fixture and must not be refused: ' + JSON.stringify(fixture))
    const real = classifyFileBody('t.cjs', 'require("child_process").execSync("wrangler pages deploy")\n')
    if (real.risk !== 'risky') throw new Error('a real execSync call must still be caught: ' + JSON.stringify(real))
    // R2: the refusal sentence must match the verdict — an "unknown" must not invent a live-change reason.
    const unk = scriptRefusal(missing)
    if (/looks like it changes something live/.test(unk)) throw new Error('an UNKNOWN verdict must not claim to know what it does: ' + unk)
    if (!/Terminal panel/.test(unk)) throw new Error('every refusal must offer the manual route: ' + unk)
    // R2: the delete seatbelt must not tell someone deleting a file that they are opening a project.
    const dg = unsavedGuard({ reason: 'delete-path', dirtyPaths: ['src/a.ts'], targetPath: 'src/a.ts' })
    if (/another project/.test(dg.lines.join(' '))) throw new Error('a DELETE must not talk about opening a project: ' + JSON.stringify(dg.lines))
    if (!/Deleting/.test(dg.lines.join(' '))) throw new Error('it must say what is actually happening: ' + JSON.stringify(dg.lines))
    // R2: "at least 0 files - too big to count" was printed for a 3-file folder holding node_modules.
    const noise = describeDeletion({ relPath: 'pkg', isDir: true, files: 3, dirs: 1, bytes: 4096, countCapped: true, capReason: 'skipped-noise', gitKnown: true, neverBackedUp: 0, changedNotBackedUp: 0, canRestoreWithUndo: false, trashAvailable: true })
    if (/stopped counting/.test(noise.lines.join(' '))) throw new Error('a small folder with node_modules is not "too big to count": ' + JSON.stringify(noise.lines))
    if (!/didn.t count/.test(noise.lines.join(' '))) throw new Error('it must say what was skipped: ' + JSON.stringify(noise.lines))
    const unreadable = describeDeletion({ relPath: 'x', isDir: true, files: 0, dirs: 0, bytes: 0, countCapped: true, capReason: 'unreadable', gitKnown: true, neverBackedUp: 0, changedNotBackedUp: 0, canRestoreWithUndo: false, trashAvailable: true })
    if (/empty/.test(unreadable.lines.join(' '))) throw new Error('an unreadable folder must never be called empty: ' + JSON.stringify(unreadable.lines))
    // R2: a git-IGNORED path was told "this project isn't set up for backups" — it IS, this is excluded.
    const ignoredPath = describeDeletion({ relPath: '.env', isDir: false, files: 1, dirs: 0, bytes: 40, countCapped: false, gitKnown: false, pathIgnored: true, noRepo: false, neverBackedUp: 0, changedNotBackedUp: 0, canRestoreWithUndo: true, trashAvailable: true })
    const ipText = ignoredPath.lines.join(' ')
    if (/isn.t set up for backups/.test(ipText)) throw new Error('a tracked project with an ignored FILE is set up for backups: ' + ipText)
    if (!/ignore list/.test(ipText) || ignoredPath.band !== 'red') throw new Error('an ignored path has never been backed up — say so, in red: ' + JSON.stringify(ignoredPath))
    // R2: an ignored folder must not be told to "back up" — there is no button and it cannot work.
    const ignWS = workSafety({ isRepo: true, isRepoRoot: true, isIgnored: true, changedFiles: 0, lastCommitTs: Date.now() - 1000, sessionEdits: 2, restorePoints: 1, now: Date.now() })
    if (/back up to keep a permanent record/.test(ignWS.lines.join(' '))) throw new Error('an ignored folder cannot be backed up — do not instruct it: ' + JSON.stringify(ignWS.lines))
    if (!/somewhere outside it/.test(ignWS.lines.join(' '))) throw new Error('give the honest alternative instead: ' + JSON.stringify(ignWS.lines))
    return 'hand-offs read (build allowed, ship caught, missing=unknown+named, wrappers, --test); string fixtures ignored; refusal matches verdict; delete-path wording; capReason truth; ignored path/folder honesty'
  })

  await step('Wave 21 script guard: the AI cannot run a shortcut that deploys or wipes a database', async () => {
    const { classifyScript, scriptRefusal } = require(path.join(WORKDIR, 'shared', 'scriptrisk.js'))
    // THE headline catch: a safe-SOUNDING name whose body is destructive.
    const sneaky = classifyScript('test', { test: 'prisma migrate reset --force' })
    if (sneaky.risk !== 'risky' || !/prisma migrate reset/.test(sneaky.matched || '')) throw new Error('a script named "test" that resets the DB must be caught by its BODY: ' + JSON.stringify(sneaky))
    if (!/database/i.test(sneaky.why || '')) throw new Error('the reason must be in plain English: ' + sneaky.why)
    // THE headline false positive: a scary NAME with a harmless body must be allowed.
    const benign = classifyScript('deploy', { deploy: 'cp -r dist /tmp/staging' })
    if (benign.risk !== 'safe') throw new Error('a "deploy" that only copies files locally must be allowed — body beats name: ' + JSON.stringify(benign))
    // Real deploys are caught.
    for (const [name, body] of [['deploy', 'wrangler pages deploy dist'], ['ship', 'vercel --prod'], ['release', 'npm publish'], ['push', 'git push origin main']]) {
      const v = classifyScript(name, { [name]: body })
      if (v.risk !== 'risky') throw new Error(`"${body}" must be refused: ` + JSON.stringify(v))
    }
    // npm ALSO runs pre/post hooks — a postbuild deploy must not sneak through `npm run build`.
    const hook = classifyScript('build', { build: 'vite build', postbuild: 'wrangler pages deploy dist' })
    if (hook.risk !== 'risky') throw new Error('a postbuild hook that deploys must be caught via `npm run build`: ' + JSON.stringify(hook))
    // Indirection is followed, and a cycle must terminate instead of hanging.
    const chained = classifyScript('ship', { ship: 'npm run deploy', deploy: 'wrangler deploy' })
    if (chained.risk !== 'risky' || !chained.chain.includes('deploy')) throw new Error('an indirect `npm run deploy` must be followed: ' + JSON.stringify(chained))
    const cyclic = classifyScript('a', { a: 'npm run b', b: 'npm run a' })
    if (cyclic.risk !== 'safe') throw new Error('a cycle must terminate as safe, not hang or throw: ' + JSON.stringify(cyclic))
    // An undeclared script is harmless — npm just errors "Missing script".
    if (classifyScript('build', {}).risk !== 'safe') throw new Error('an undeclared script must stay allowed (npm errors on its own)')
    if (classifyScript('build', { build: 'vite build' }).risk !== 'safe') throw new Error('an ordinary build must NOT be refused — this is the intrusion regression')
    // HONEST DEGRADATION — unreadable package.json ⇒ judge by name and SAY it was a guess.
    const blind = classifyScript('deploy', null)
    if (blind.risk !== 'risky' || !blind.byNameOnly) throw new Error('unreadable scripts ⇒ name-only refusal flagged as a guess: ' + JSON.stringify(blind))
    const unknown = classifyScript('build', null)
    if (unknown.risk !== 'unknown' || !unknown.byNameOnly) throw new Error('an unremarkable name with unreadable scripts is "unknown", not a false "safe": ' + JSON.stringify(unknown))
    if (!/judged it by name/.test(scriptRefusal(blind))) throw new Error('the refusal must admit when it guessed: ' + scriptRefusal(blind))
    if (!/Terminal panel/.test(scriptRefusal(sneaky))) throw new Error('the refusal must offer the user a way to run it themselves')
    return 'classifyScript: body beats name both ways (test→reset caught, deploy→cp allowed); pre/post hooks, indirection + cycle-safe; undeclared/ordinary allowed; unreadable→byNameOnly guess'
  })

  await step('Project X-ray: unused files + fragile watchlist + circular-import tangles (pure folds)', async () => {
    const orphans = require(path.join(WORKDIR, 'shared', 'orphans.js'))
    const fragile = require(path.join(WORKDIR, 'shared', 'fragile.js'))
    const tangles = require(path.join(WORKDIR, 'shared', 'tangles.js'))
    // --- F1: Unused-File Finder — nobody imports it, not an entry, not a test, has symbols ---
    const arch = {
      nodes: [
        { path: 'src/a.js', symbols: 3, language: 'js', isEntry: false }, // imported by b → NOT unused
        { path: 'src/b.js', symbols: 2, language: 'js', isEntry: false }, // imports a; nobody imports b → unused
        { path: 'src/c.js', symbols: 5, language: 'js', isEntry: false }, // nobody imports → unused
        { path: 'src/main.js', symbols: 4, language: 'js', isEntry: true }, // entry → excluded
        { path: 'src/x.test.js', symbols: 2, language: 'js', isEntry: false }, // test → excluded
        { path: 'src/empty.js', symbols: 0, language: 'js', isEntry: false } // zero symbols → excluded
      ],
      edges: [{ from: 'src/b.js', to: 'src/a.js' }],
      externalDeps: []
    }
    const unPaths = orphans.findUnusedFiles(arch).files.map((f) => f.path).sort()
    if (JSON.stringify(unPaths) !== JSON.stringify(['src/b.js', 'src/c.js'])) throw new Error('unused must be exactly b.js + c.js (a=imported, main=entry, test/empty excluded): ' + JSON.stringify(unPaths))
    if (orphans.findUnusedFiles(null).files.length || orphans.findUnusedFiles({ nodes: [], edges: [], externalDeps: [] }).files.length) throw new Error('null/empty arch → [] (no throw)')
    // --- F2: Fragile watchlist — hotspot ∩ debt ---
    const fr = fragile.rankFragile([{ file: 'a.ts', commits: 9, churn: 200 }, { file: 'b.ts', commits: 1, churn: 5 }], [{ kind: 'oversized', path: 'a.ts', detail: '' }, { kind: 'todo', path: 'a.ts', detail: '' }])
    if (fr.needsGit || fr.files[0]?.path !== 'a.ts' || !fr.files[0].fragile) throw new Error('a.ts (hotspot+debt) must rank first + fragile: ' + JSON.stringify(fr))
    if (fr.files.some((f) => f.path === 'b.ts')) throw new Error('b.ts is busy but CLEAN → NOT on the fragile watchlist')
    const noGit = fragile.rankFragile([], [{ kind: 'oversized', path: 'z.ts', detail: '' }])
    if (!noGit.needsGit || !noGit.files.some((f) => f.path === 'z.ts')) throw new Error('no hotspots → debt-only list with needsGit true')
    if (fragile.rankFragile([{ file: 'a.ts', commits: 5, churn: 5 }], []).files.length !== 0) throw new Error('hotspots but no debt → zero fragile rows')
    if (fragile.rankFragile([{ file: '(project)', commits: 5, churn: 5 }], [{ kind: 'untested', path: '(project)', detail: '' }]).files.length !== 0) throw new Error('the synthetic (project) untested row must be skipped')
    // --- F3: Tangle Finder — circular imports ---
    const c2 = tangles.findCycles([{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }])
    if (c2.cycles.length !== 1 || c2.cycles[0].files.join('') !== 'AB') throw new Error('A<->B must be exactly one [A,B] cycle: ' + JSON.stringify(c2.cycles))
    const c3 = tangles.findCycles([{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }, { from: 'C', to: 'A' }])
    if (c3.cycles.length !== 1 || c3.cycles[0].files.length !== 3) throw new Error('A->B->C->A must be one 3-cycle: ' + JSON.stringify(c3.cycles))
    if (tangles.findCycles([{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }]).cycles.length !== 0) throw new Error('a pure DAG must have zero cycles')
    if (tangles.findCycles([{ from: 'B', to: 'C' }, { from: 'C', to: 'B' }, { from: 'C', to: 'B' }]).cycles.length !== 1) throw new Error('a rotated/duplicate loop must dedupe to one entry')
    const dense = []
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) if (i !== j) dense.push({ from: 'n' + i, to: 'n' + j })
    const dc = tangles.findCycles(dense)
    if (dc.cycles.length > 20) throw new Error('cycle count must be capped at 20: ' + dc.cycles.length)
    if (!dc.partial) throw new Error('a capped run must report partial:true')
    // --- Review round 1 regressions: every "clean" state must be TRUE, never an artefact of a dropped signal ---
    // (a) A real loop longer than the render cap must degrade to partial, NOT to a false "no tangles".
    const long = []
    for (let i = 0; i < 12; i++) long.push({ from: 'L' + i, to: 'L' + ((i + 1) % 12) })
    const lc = tangles.findCycles(long)
    if (lc.cycles.length !== 0 || !lc.partial) throw new Error('a 12-file loop is too long to show → zero cycles but partial TRUE (never a false clean): ' + JSON.stringify(lc))
    // (b) Cross-edge into a finished subtree (A→B, A→C, B→D, C→D, D→A) hides the [A,C,D] loop from a
    //     one-pass DFS — the report must still admit incompleteness rather than imply an exhaustive list.
    const cross = tangles.findCycles([{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'B', to: 'D' }, { from: 'C', to: 'D' }, { from: 'D', to: 'A' }])
    if (!cross.cycles.length) throw new Error('the cross-edge graph does contain loops — at least one must surface')
    if (!cross.partial) throw new Error('an unenumerated cross-edge loop must set partial TRUE (no false completeness)')
    // Round 2: a DUPLICATE edge is not a second path — it must not fake incompleteness on a complete list.
    const dup = tangles.findCycles([{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }, { from: 'A', to: 'B' }])
    if (dup.cycles.length !== 1 || dup.partial) throw new Error('a duplicate edge must not make a COMPLETE cycle list report partial: ' + JSON.stringify(dup))
    // Round 2: a plain DAG (no loop anywhere) must stay honestly clean — cross-edges alone are not tangles.
    const dagCross = tangles.findCycles([{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'B', to: 'D' }, { from: 'C', to: 'D' }])
    if (dagCross.cycles.length || dagCross.partial) throw new Error('a DAG with cross-edges but NO loop must report clean + complete (no false alarm): ' + JSON.stringify(dagCross))
    // (c) Fragile: hotspot paths in a DIFFERENT namespace than debt (the monorepo-subfolder bug) must fall
    //     back to the messiest-files list, never render as "your busiest files look clean".
    const mism = fragile.rankFragile([{ file: 'apps/desktop/a.ts', commits: 9, churn: 200 }], [{ kind: 'oversized', path: 'a.ts', detail: '' }])
    if (!mism.files.length || !mism.noOverlap) throw new Error('disjoint hotspot/debt namespaces → debt-only fallback with noOverlap TRUE, never an empty "all clean" card: ' + JSON.stringify(mism))
    if (fragile.rankFragile([{ file: 'a.ts', commits: 5, churn: 5 }], []).noOverlap) throw new Error('no debt at all is genuinely clean → noOverlap must stay false')
    if (fr.noOverlap || noGit.noOverlap) throw new Error('a real hotspot∩debt hit (and the no-git path) must not claim noOverlap')
    // (d) Orphans: a lazily-imported and a barrel-re-exported file must NOT be called "safe to remove".
    const idx = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const imps = idx.extractImports("import a from './static'\nconst m = await import('./lazy')\nexport * from './barrel'\nexport { y } from './named'\nconst r = require('./req')\nimport './bare'\nimport {\n  z\n} from './multi'\nawait import(/* webpackChunkName: \"c\" */ './magic')\n")
    for (const want of ['./static', './lazy', './barrel', './named', './req', './bare', './multi', './magic']) {
      if (!imps.includes(want)) throw new Error(`extractImports must see ${want} — a missed edge makes a USED file look deletable: ` + JSON.stringify(imps))
    }
    // Round 2: the WIDER regex must not invent module paths. Each of these has NO import at all — a
    // phantom spec pollutes externalDeps/drift and (via a phantom edge) hides a genuinely dead file.
    const phantoms = [
      ['python', 'import os\nimport sys\n\nAPP_NAME = "my-service"\n'],
      ['python-from', 'import os\nfrom pathlib import Path\nNAME = "svc"\n'],
      ['import.meta', "import.meta.hot?.dispose\nexport const MODE = 'production'\n"],
      ['line-comment', "// const m = await import('./legacy/old')\n"],
      ['block-comment', "/*\n * require('./deleted')\n */\n"],
      ['jsdoc', "/** use import('./types') for typing */\n"],
      ['vite-ignore var', "const u = await import(/* @vite-ignore */ url)\nconst n = /* c */ 'lodash-es'\n"],
      ['word-boundary', "const noimport = myimport('./nope')\n"]
    ]
    for (const [name, src] of phantoms) {
      const got = idx.extractImports(src)
      if (got.length) throw new Error(`extractImports invented a module path from ${name}: ` + JSON.stringify(got))
    }
    // Round 2 (honesty): a project whose imports we can't parse must claim NOTHING, and framework-loaded
    // files must never be offered for deletion.
    const pyArch = { nodes: [{ path: 'a.py', symbols: 3, language: 'py', isEntry: false }, { path: 'b.py', symbols: 2, language: 'py', isEntry: false }], edges: [], externalDeps: [] }
    const pyRep = orphans.findUnusedFiles(pyArch)
    if (pyRep.files.length || !pyRep.partial) throw new Error('a project with zero readable imports must list nothing and report partial: ' + JSON.stringify(pyRep))
    const convArch = {
      nodes: [
        { path: 'pages/about.tsx', symbols: 2, language: 'tsx', isEntry: false },
        { path: 'functions/api/hook.ts', symbols: 2, language: 'ts', isEntry: false },
        { path: 'migrations/001_init.ts', symbols: 2, language: 'ts', isEntry: false },
        { path: 'vite.config.ts', symbols: 2, language: 'ts', isEntry: false },
        { path: 'src/types.d.ts', symbols: 2, language: 'ts', isEntry: false },
        { path: 'src/really-dead.ts', symbols: 4, language: 'ts', isEntry: false },
        { path: 'src/used.ts', symbols: 1, language: 'ts', isEntry: false }
      ],
      edges: [{ from: 'src/really-dead.ts', to: 'src/used.ts' }],
      externalDeps: []
    }
    const convPaths = orphans.findUnusedFiles(convArch).files.map((f) => f.path)
    if (JSON.stringify(convPaths) !== JSON.stringify(['src/really-dead.ts'])) throw new Error('framework-loaded files (pages/functions/migrations/config/.d.ts) must NEVER be offered for deletion: ' + JSON.stringify(convPaths))
    // A graph flagged partial by the indexer must propagate — the card softens "nobody imports it".
    if (!orphans.findUnusedFiles({ ...convArch, partial: true }).partial) throw new Error('arch.partial must propagate to the unused report')
    return 'unused=b+c (entry/test/empty/imported excluded, null-safe) + lazy/barrel/re-export edges seen; fragile=a.ts(hotspot∩debt)>b.ts-clean, no-git=debt-only, (project) skipped, namespace-mismatch→noOverlap fallback; tangles A<->B/3-cycle/DAG-0/dedupe/capped + long-loop & cross-edge stay honest'
  })

  await step('Graph honesty: a package sub-path stays a package; a builtin is not "unresolved"; a real alias still resolves', async () => {
    // Round 2 regressions in the fix that made the graph report `partial`. The suffix-matching fallback
    // (added so alias imports stop looking like dead files) must never eat a REAL dependency, and the
    // "we could not resolve this" flag must not fire on `import 'fs'` — that would caveat every card,
    // on every ordinary Node project, forever.
    const idx = require(path.join(WORKDIR, 'main', 'index-service.js'))
    const mk = (name, files) => {
      const root = path.join(WORKDIR, name)
      for (const [rel, src] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
        fs.writeFileSync(path.join(root, rel), src)
      }
      return root
    }
    // (a) 'react-dom/client' must NOT be suffix-matched onto a local src/client.ts: that would invent an
    //     edge AND drop react-dom from externalDeps, so Dependency Health would call an actively-used
    //     package "installed but never imported". `fs` must not make the graph partial.
    const rootA = mk('gh-a', {
      'package.json': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { 'react-dom': '^18.0.0' } }),
      'src/client.ts': 'export const apiClient = () => 1\n',
      'src/main.tsx': "import { createRoot } from 'react-dom/client'\nimport { readFileSync } from 'fs'\nexport const boot = () => createRoot\n"
    })
    const a = idx.architectureMap(rootA, { full: true })
    if (!a.externalDeps.some((d) => d.name === 'react-dom')) throw new Error('a declared package sub-path must stay a DEPENDENCY, never an invented edge: ' + JSON.stringify(a.externalDeps))
    if (a.edges.some((e) => e.to === 'src/client.ts')) throw new Error("'react-dom/client' must not become an edge to the local src/client.ts: " + JSON.stringify(a.edges))
    if (a.partial) throw new Error('a small project whose only unknown spec is the node builtin `fs` must NOT be partial: ' + JSON.stringify(a))
    // (b) A genuine custom alias still resolves to an in-project edge (that is why the fallback exists),
    //     and an alias we CANNOT resolve marks the graph partial instead of silently losing the edge.
    const rootB = mk('gh-b', {
      'package.json': JSON.stringify({ name: 'b', version: '1.0.0', dependencies: { react: '^18.0.0' } }),
      'src/renderer/src/App.tsx': 'export const App = () => null\n',
      'src/main.tsx': "import { App } from '@renderer/src/App'\nimport { useState } from 'react'\nexport const boot = () => App\n"
    })
    const b = idx.architectureMap(rootB, { full: true })
    if (!b.edges.some((e) => e.from === 'src/main.tsx' && e.to === 'src/renderer/src/App.tsx')) throw new Error('a unique alias suffix match must still create the edge: ' + JSON.stringify(b.edges))
    if (b.partial) throw new Error('every import resolved or declared → NOT partial: ' + JSON.stringify(b))
    const rootC = mk('gh-c', {
      'package.json': JSON.stringify({ name: 'c', version: '1.0.0' }),
      'src/main.tsx': "import log from 'utils/log'\nexport const boot = () => log\n"
    })
    if (!idx.architectureMap(rootC, { full: true }).partial) throw new Error('an unresolvable alias-shaped import must mark the graph partial (a lost in-project edge)')
    return 'react-dom/client stays a dep (no phantom edge, no false "unused package"); builtin fs ≠ partial; @renderer alias still resolves; unresolvable alias → partial'
  })

  await step('git log capture keeps the NEWEST commits (head), not the oldest 20 KB', async () => {
    // gitHotspots ranks "your busiest files" from `git log`, which prints NEWEST FIRST. The shared
    // capture buffer kept the LAST 20 KB, so on any repo with real history the ranking was computed
    // from the OLDEST commits and every recent change was thrown away.
    const term = require(path.join(WORKDIR, 'main', 'terminal.js'))
    const script = path.join(WORKDIR, 'many-lines.sh')
    fs.writeFileSync(script, '#!/bin/sh\ni=0\nwhile [ $i -lt 3000 ]; do echo "line-$i-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done\n')
    fs.chmodSync(script, 0o755)
    const tailRun = await term.execStream(`sh ${JSON.stringify(script)}`, WORKDIR, () => {}, 60_000).done
    if (!/line-2999-/.test(tailRun.output) || /line-0-/.test(tailRun.output)) throw new Error('default capture must keep the TAIL (a build error is at the bottom)')
    const headRun = await term.execStream(`sh ${JSON.stringify(script)}`, WORKDIR, () => {}, 60_000, { keep: 'head' }).done
    if (!/line-0-/.test(headRun.output)) throw new Error('keep:head must retain the FIRST output — the newest commits of a git log')
    if (headRun.output.length > 20_000) throw new Error('keep:head must still respect the cap')
    const big = await term.execStream(`sh ${JSON.stringify(script)}`, WORKDIR, () => {}, 60_000, { keep: 'head', max: 4_000_000 }).done
    if (!/line-0-/.test(big.output) || !/line-2999-/.test(big.output)) throw new Error('a raised cap must hold the whole log (400 commits of numstat)')
    return 'default=tail (build errors); keep:head retains the newest git-log commits; raised max holds a full history'
  })

  await step('Air-gapped model catalog: installed-vs-available via fake ollama; missing binary degrades', async () => {
    const mods = require(path.join(WORKDIR, 'main', 'models.js'))
    const fake = path.join(WORKDIR, 'fake-ollama.sh')
    // The list holds one CURATED model (qwen) and one the user pulled themselves (codellama),
    // so both halves of the catalog are covered.
    fs.writeFileSync(fake, '#!/bin/sh\ncase "$1" in\n  --version) echo "ollama version 0.1.0"; exit 0 ;;\n  list) printf "NAME\\tID\\tSIZE\\tMODIFIED\\nqwen2.5-coder:latest\\tabc\\t4.7 GB\\t1 day\\ncodellama:13b\\tdef\\t7.4 GB\\t2 days\\n"; exit 0 ;;\n  *) exit 1 ;;\nesac\n')
    fs.chmodSync(fake, 0o755)
    const prev = process.env.STUDIO_OLLAMA_BIN
    process.env.STUDIO_OLLAMA_BIN = fake
    try {
      const cat = await mods.modelCatalog()
      if (!cat.available || cat.state !== 'ready') throw new Error('fake ollama should report ready: ' + JSON.stringify(cat.state))
      if (typeof cat.totalMemoryGb !== 'number' || cat.totalMemoryGb <= 0) throw new Error('catalog must report this machine\'s RAM')
      if (!cat.models.every((m) => typeof m.fitsMemory === 'boolean')) throw new Error('every model needs a fitsMemory verdict')
      // A model the user pulled themselves must be listed, not hidden behind the curated six.
      const mine = cat.others.find((m) => m.name === 'codellama:13b')
      if (!mine || !mine.installed) throw new Error('an uncurated installed model must appear in others: ' + JSON.stringify(cat.others))
      const qwen = cat.models.find((m) => m.name === 'qwen2.5-coder')
      if (!qwen || !qwen.installed) throw new Error('installed model (qwen, via list) not detected: ' + JSON.stringify(qwen))
      if (qwen.pullCommand !== 'ollama pull qwen2.5-coder') throw new Error('pull command wrong: ' + qwen.pullCommand)
      const other = cat.models.find((m) => m.name !== 'qwen2.5-coder')
      if (!other || other.installed) throw new Error('a non-installed model was wrongly marked installed: ' + JSON.stringify(other))
      // Daemon down: `--version` exits 0 but `list` fails → available:true, nothing installed, no throw.
      const down = path.join(WORKDIR, 'fake-ollama-down.sh')
      fs.writeFileSync(down, '#!/bin/sh\ncase "$1" in\n  --version) echo "ollama version 0.1.0"; exit 0 ;;\n  *) echo "could not connect to ollama app" 1>&2; exit 1 ;;\nesac\n')
      fs.chmodSync(down, 0o755)
      process.env.STUDIO_OLLAMA_BIN = down
      const dn = await mods.modelCatalog()
      // Changed deliberately: this used to assert `available: true` for a daemon that is DOWN,
      // which is what made the panel say "detected" while every local request failed. A stopped
      // daemon is its own state, and it is not available.
      if (dn.available || dn.state !== 'stopped') throw new Error('daemon-down must report state=stopped, available=false: ' + JSON.stringify(dn.state))
      if (dn.models.some((m) => m.installed)) throw new Error('daemon-down cannot know what is installed')
      // A missing ollama binary must degrade to not-installed + nothing installed, NEVER throw,
      // and must carry the install command the UI offers to copy.
      process.env.STUDIO_OLLAMA_BIN = path.join(WORKDIR, 'no-such-ollama-xyz')
      const off = await mods.modelCatalog()
      if (off.available || off.state !== 'not-installed') throw new Error('missing ollama should degrade: ' + JSON.stringify(off.state))
      if (off.models.some((m) => m.installed)) throw new Error('missing ollama cannot report installed models')
      if (!off.install || !off.install.command || !/^https?:\/\//.test(off.install.url)) throw new Error('missing ollama must offer a real install command + URL: ' + JSON.stringify(off.install))
      if (!off.models.length) throw new Error('recommended list should still show when ollama is missing')
      // startOllama must not pretend: with no binary there is nothing to start.
      if ((await mods.startOllama()) !== 'not-installed') throw new Error('startOllama must report not-installed when the binary is absent')
    } finally {
      if (prev === undefined) delete process.env.STUDIO_OLLAMA_BIN
      else process.env.STUDIO_OLLAMA_BIN = prev
    }
    return 'ready/stopped/not-installed are distinct states; uncurated installed models listed; RAM fit reported; missing binary degrades with an install command'
  })

  await step('A plain website is detected as one even when it has a package.json', async () => {
    const { ProcessManager } = require(path.join(WORKDIR, 'main', 'process-manager.js'))
    const pm = new ProcessManager()
    const site = path.join(WORKDIR, 'plain-site')
    fs.rmSync(site, { recursive: true, force: true })
    fs.mkdirSync(site, { recursive: true })
    fs.writeFileSync(path.join(site, 'index.html'), '<h1>hello</h1>')

    // No package.json at all — the case that always worked.
    if (pm.inspectProject(site).framework !== 'static-html') throw new Error('a bare index.html folder must be static-html')

    /* WITH a package.json — the case a real user hits the moment they run `npm init`. This used to
       report framework "unknown" with no dev script, so Run preview failed with "No dev/start
       script" on a folder whose index.html the built-in static server can serve perfectly well. */
    fs.writeFileSync(path.join(site, 'package.json'), JSON.stringify({ name: 'plain-site', version: '1.0.0' }))
    const withPkg = pm.inspectProject(site)
    if (withPkg.framework !== 'static-html') throw new Error(`a package.json must not hide a plain website: got ${withPkg.framework}`)
    if (withPkg.devScript !== null) throw new Error('a static site has no dev script to run')

    // A real node project must NOT be mistaken for a static site just because it has an index.html.
    fs.writeFileSync(
      path.join(site, 'package.json'),
      JSON.stringify({ name: 'real-app', version: '1.0.0', scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } })
    )
    const real = pm.inspectProject(site)
    if (real.framework !== 'vite' || real.devScript !== 'dev') throw new Error(`a real vite app must still be detected: ${JSON.stringify(real)}`)
    return 'bare folder + folder with a bare package.json → static-html; a real vite app is untouched'
  })

  await step('Project Memory: retrieval is budgeted, deterministic, and never drops a forbidden rule', async () => {
    const mem = require(path.join(WORKDIR, 'main', 'memory.js'))
    const proj = path.join(WORKDIR, 'mem-project')
    fs.rmSync(proj, { recursive: true, force: true })
    fs.mkdirSync(proj, { recursive: true })

    mem.remember(proj, { kind: 'forbidden', text: 'Never touch the production database.' })
    mem.remember(proj, { kind: 'business-rule', text: 'Prices are records, never charges.' })
    mem.remember(proj, { kind: 'goal', text: 'Ship a checkout flow for Egyptian pharmacies.' })
    mem.remember(proj, { kind: 'convention', text: 'Components live in src/components and are PascalCase.' })
    // Enough noise that the budget has to actually choose.
    for (let i = 0; i < 200; i++) mem.remember(proj, { kind: 'idea', text: `Unrelated passing thought number ${i}` })

    const r = mem.retrieve(proj, 'add a discount field to the checkout page')
    if (r.entries.length > 12) throw new Error(`retrieval must stay within its budget, got ${r.entries.length}`)
    if (r.entries.reduce((n, e) => n + e.text.length, 0) > 2000) throw new Error('retrieval blew the character budget')
    if (r.omitted <= 0) throw new Error('with 200 spare entries, the count of what did not fit must be reported, not hidden')

    // The two kinds that must never be missed, whatever the task happens to mention.
    const kinds = r.entries.map((e) => e.kind)
    if (!kinds.includes('forbidden')) throw new Error('a forbidden rule was dropped from retrieval')
    if (!kinds.includes('business-rule')) throw new Error('a business rule was dropped from retrieval')
    // Task-relevant beats generic: "checkout" should pull the goal in ahead of 200 stray ideas.
    if (!r.entries.some((e) => /checkout/i.test(e.text))) throw new Error('retrieval ignored the task text')

    // Same store + same task ⇒ same result. Agent behaviour has to be reproducible.
    const again = mem.retrieve(proj, 'add a discount field to the checkout page')
    if (JSON.stringify(again.entries.map((e) => e.id)) !== JSON.stringify(r.entries.map((e) => e.id))) {
      throw new Error('retrieval is not deterministic')
    }

    // The prompt block is bounded, labelled, and empty when there is nothing to say.
    const prompt = mem.memoryPrompt(proj, 'add a discount field to the checkout page')
    if (!/NEVER DO THIS/.test(prompt)) throw new Error('the forbidden rule must be labelled unmissably in the prompt')
    if (prompt.length > 3000) throw new Error(`the memory prompt must stay small, got ${prompt.length} chars`)
    if (mem.memoryPrompt(path.join(WORKDIR, 'no-such-project'), 'anything') !== '') {
      throw new Error('a project with no memory must contribute nothing to the prompt')
    }
    return `budget held (${r.entries.length} of ${r.entries.length + r.omitted}); forbidden + business rules always present; deterministic`
  })

  await step('Project Memory: user beats AI on the same key, stale entries drop out, tombstones work', async () => {
    const mem = require(path.join(WORKDIR, 'main', 'memory.js'))
    const proj = path.join(WORKDIR, 'mem-project2')
    fs.rmSync(proj, { recursive: true, force: true })
    fs.mkdirSync(proj, { recursive: true })

    // Conflicting facts under one key: the agent's inference must not overwrite the user's statement.
    mem.remember(proj, { kind: 'convention', text: 'Indent with two spaces.', key: 'convention:indent', source: 'user' })
    mem.remember(proj, { kind: 'convention', text: 'Indent with tabs.', key: 'convention:indent', source: 'agent' })
    let live = mem.active(proj).filter((e) => e.key === 'convention:indent')
    if (live.length !== 1) throw new Error(`one key must resolve to one live entry, got ${live.length}`)
    if (!/two spaces/.test(live[0].text)) throw new Error('a user statement must outrank an AI inference on the same key')

    // A later USER correction does supersede the earlier user entry.
    mem.remember(proj, { kind: 'convention', text: 'Indent with four spaces.', key: 'convention:indent', source: 'user' })
    live = mem.active(proj).filter((e) => e.key === 'convention:indent')
    if (live.length !== 1 || !/four spaces/.test(live[0].text)) throw new Error('a newer user entry must supersede the older one')
    // History is kept, not destroyed.
    if (!mem.list(proj).some((e) => /two spaces/.test(e.text) && e.supersededBy)) {
      throw new Error('the superseded entry must be kept with a pointer to what replaced it')
    }

    // An entry about a file that no longer exists is marked stale and stops being injected.
    fs.writeFileSync(path.join(proj, 'temp.ts'), 'export const x = 1\n')
    mem.remember(proj, { kind: 'file', text: 'temp.ts holds the pricing table.', files: ['temp.ts'] })
    if (mem.retrieve(proj, 'pricing table').entries.some((e) => /temp\.ts/.test(e.text)) === false) {
      throw new Error('a live file entry should be retrievable')
    }
    fs.rmSync(path.join(proj, 'temp.ts'))
    if (mem.active(proj).find((e) => /temp\.ts/.test(e.text))?.stale !== true) throw new Error('an entry naming a deleted file must be marked stale')
    if (mem.retrieve(proj, 'pricing table').entries.some((e) => /temp\.ts/.test(e.text))) {
      throw new Error('a stale entry must not be injected')
    }

    // Forgetting is a tombstone, not a deletion — the log is append-only and recoverable.
    const goal = mem.remember(proj, { kind: 'goal', text: 'Launch in Cairo first.' })
    mem.forget(proj, goal.id)
    if (mem.active(proj).some((e) => e.id === goal.id)) throw new Error('a forgotten entry must leave the active set')
    if (!mem.list(proj).some((e) => e.id === goal.id)) throw new Error('a forgotten entry must still exist in the log')

    // A corrupt line must never take the store down.
    const store = path.join(app.getPath('userData'), 'memory', require('node:crypto').createHash('sha1').update(proj).digest('hex') + '.jsonl')
    fs.appendFileSync(store, '{ not json at all\n')
    if (mem.active(proj).length === 0) throw new Error('a corrupt line must not discard the rest of the store')
    return 'user > AI on a shared key; newer user supersedes; stale files drop out; tombstones keep history; corrupt line survived'
  })

  await step('Project Memory: the shared ATOMIC-MEMORY.md round-trips and imports what it alone knows', async () => {
    const mem = require(path.join(WORKDIR, 'main', 'memory.js'))
    const memfile = require(path.join(WORKDIR, 'main', 'memory-file.js'))
    const proj = path.join(WORKDIR, 'mem-project3')
    fs.rmSync(proj, { recursive: true, force: true })
    fs.mkdirSync(proj, { recursive: true })

    // Off by default: the app never writes into someone's repo without being told to.
    mem.remember(proj, { kind: 'goal', text: 'Be the calmest IDE.' })
    if (fs.existsSync(path.join(proj, 'ATOMIC-MEMORY.md'))) throw new Error('memory must NOT write into the project until asked')

    mem.setSync(proj, true)
    const file = path.join(proj, 'ATOMIC-MEMORY.md')
    if (!fs.existsSync(file)) throw new Error('turning sync on must write the file')

    // Round-trip: render → parse → the same entries, so a committed file can rebuild a store.
    const parsed = memfile.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed.some((e) => /calmest IDE/.test(e.text))) throw new Error('the projection lost an entry')
    if (memfile.render(parsed) !== memfile.render(parsed)) throw new Error('rendering must be deterministic')

    // A teammate's entry, present only in the committed file, is adopted on the next read.
    fs.appendFileSync(file, '\n## Business rules\n\n### Refunds are always manual.\n- id: teammate-1\n- ts: 1\n- source: user\n')
    if (!mem.active(proj).some((e) => /Refunds are always manual/.test(e.text))) {
      throw new Error('an entry that exists only in the shared file must be imported')
    }
    // …and it is only imported once, however many times memory is read.
    mem.active(proj)
    if (mem.active(proj).filter((e) => /Refunds are always manual/.test(e.text)).length !== 1) {
      throw new Error('importing from the shared file must be idempotent')
    }

    // A half-merged or hand-mangled file contributes what it can and never throws.
    fs.writeFileSync(file, '# Project Memory\n\n## Goals\n\n### orphan with no id\n- ts: not-a-number\n\n<<<<<<< HEAD\ngarbage\n')
    if (!Array.isArray(mem.active(proj))) throw new Error('a mangled file must degrade, not throw')

    mem.setSync(proj, false)
    return 'off by default; render↔parse round-trips; a file-only entry imports once; a mangled file degrades'
  })

  await step('Connectors (MCP): handshake + tools/list + tools/call; unapproved tools are REFUSED', async () => {
    const mcp = require(path.join(WORKDIR, 'main', 'mcp.js'))
    // A real MCP server over stdio, written here so the test exercises the actual protocol
    // (JSON-RPC framed by Content-Length) rather than a stub of our own client.
    const server = path.join(WORKDIR, 'fake-mcp-server.cjs')
    fs.writeFileSync(
      server,
      `
// MCP's stdio transport is newline-delimited JSON (NOT the LSP Content-Length framing).
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
        { name: 'ping', description: 'returns pong', inputSchema: { type: 'object' } },
        { name: 'danger', description: 'must never run unapproved', inputSchema: { type: 'object' } }
      ] } })
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: msg.params.name + ':' + JSON.stringify(msg.params.arguments || {}) }] } })
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
  }
})
`
    )
    mcp.writeConfig([
      { id: 'fake', name: 'Fake', command: process.execPath, args: [server], enabled: true, approvedTools: [], source: 'manual' }
    ])

    const started = await mcp.start('fake')
    if (!started.ok) throw new Error('connector failed to start: ' + started.error)
    const names = (started.tools || []).map((t) => t.name).sort().join(',')
    if (names !== 'danger,ping') throw new Error('tools/list wrong: ' + names)

    // The whole safety story: an un-approved tool is refused, and the model being confident about
    // it is not consent. This must fail even though the server would happily run it.
    const refused = await mcp.callTool('fake', 'danger', {})
    if (refused.ok || !/not been approved/i.test(refused.error || '')) {
      throw new Error('an unapproved tool must be refused: ' + JSON.stringify(refused))
    }
    // Approve one tool only — approval is per tool, never "trust this server".
    mcp.setToolApproved('fake', 'ping', true)
    const ok = await mcp.callTool('fake', 'ping', { a: 1 })
    if (!ok.ok || !/ping:\{"a":1\}/.test(ok.text || '')) throw new Error('approved call failed: ' + JSON.stringify(ok))
    const stillRefused = await mcp.callTool('fake', 'danger', {})
    if (stillRefused.ok) throw new Error('approving one tool must not approve the others')

    // Only approved tools reach the agent's prompt — every listed tool costs tokens every turn.
    const exposed = await mcp.agentTools()
    if (exposed.length !== 1 || exposed[0].tool.name !== 'ping') {
      throw new Error('only approved tools may be exposed to the agent: ' + JSON.stringify(exposed.map((e) => e.tool.name)))
    }
    await mcp.stopAll()
    mcp.writeConfig([]) // leave no enabled connector behind for the steps that follow
    return 'stdio handshake + tools/list + approved call; unapproved refused; only approved tools exposed'
  })

  await step('Connectors: Air-Gapped Mode disables them, and a corrupt config degrades', async () => {
    const mcp = require(path.join(WORKDIR, 'main', 'mcp.js'))
    const policy = require(path.join(WORKDIR, 'main', 'policy.js'))
    // This step owns its fixture rather than inheriting one from the step before it.
    mcp.writeConfig([
      { id: 'fake', name: 'Fake', command: process.execPath, args: ['-e', '0'], enabled: true, approvedTools: ['ping'], source: 'manual' }
    ])
    policy.setAirGap(true)
    try {
      const start = await mcp.start('fake')
      if (start.ok) throw new Error('air-gapped must not start a connector')
      const call = await mcp.callTool('fake', 'ping', {})
      if (call.ok || !/air-gapped/i.test(call.error || '')) throw new Error('air-gapped must block tool calls')
      if ((await mcp.agentTools()).length !== 0) throw new Error('air-gapped must expose no tools to the agent')
      const listed = await mcp.list()
      if (!listed.some((c) => c.blockedByAirGap)) throw new Error('the panel must be told WHY it is off, not just that it is')
    } finally {
      policy.setAirGap(false)
    }
    // A hand-edited or truncated config must degrade to "no connectors", never throw (policy.js precedent).
    const cfg = path.join(app.getPath('userData'), 'connectors.json')
    fs.writeFileSync(cfg, '{ this is not json')
    if (mcp.readConfig().length !== 0) throw new Error('a corrupt connectors.json must read as empty')
    fs.writeFileSync(cfg, '{"not":"an array"}')
    if (mcp.readConfig().length !== 0) throw new Error('a non-array connectors.json must read as empty')
    mcp.writeConfig([])
    return 'air-gap blocks start/call/exposure and says why; corrupt config degrades without throwing'
  })

  await step('Extensions: a manifest is required, and installing registers a DISABLED connector', async () => {
    const ext = require(path.join(WORKDIR, 'main', 'extensions.js'))
    const mcp = require(path.join(WORKDIR, 'main', 'mcp.js'))
    mcp.writeConfig([])
    const src = path.join(WORKDIR, 'ext-src')
    fs.rmSync(src, { recursive: true, force: true })
    fs.mkdirSync(src, { recursive: true })

    // No manifest → refused, with a reason.
    const none = ext.installFromFolder(src)
    if (none.ok || !/atomic-extension\.json/.test(none.error || '')) throw new Error('a folder with no manifest must be refused')

    // Malformed manifest → refused (not silently installed as something half-formed).
    fs.writeFileSync(path.join(src, 'atomic-extension.json'), '{"id":"bad"}')
    if (ext.installFromFolder(src).ok) throw new Error('a manifest with no kind must be refused')

    fs.writeFileSync(
      path.join(src, 'atomic-extension.json'),
      JSON.stringify({ id: 'demo', name: 'Demo', version: '1.2.3', description: 'a demo', kind: 'mcp', command: 'echo', args: ['hi'] })
    )
    const res = ext.installFromFolder(src)
    if (!res.ok) throw new Error('valid install failed: ' + res.error)
    if (!ext.listInstalled().some((e) => e.id === 'demo')) throw new Error('installed extension not listed')

    // Installed, but INERT: nothing a user just downloaded starts running by itself.
    const cfg = mcp.readConfig().find((c) => c.id === 'demo')
    if (!cfg) throw new Error('an mcp extension must register itself as a connector')
    if (cfg.enabled || cfg.approvedTools.length) throw new Error('a freshly installed connector must be disabled with nothing approved')

    // Only https repos may be installed — no file:// or git@ smuggled through.
    const bad = await ext.installFromGit('file:///tmp/evil')
    if (bad.ok || !/https/i.test(bad.error || '')) throw new Error('non-https install sources must be refused')

    await ext.uninstall('demo')
    if (ext.listInstalled().some((e) => e.id === 'demo')) throw new Error('uninstall left the extension behind')
    if (mcp.readConfig().some((c) => c.id === 'demo')) throw new Error('uninstall left the connector registered')
    return 'manifest required + validated; install registers a DISABLED connector; non-https refused; uninstall is clean'
  })

  await step('modelPull streams progress lines; whitelist blocks unknown models (no spawn)', async () => {
    const mods = require(path.join(WORKDIR, 'main', 'models.js'))
    const puller = path.join(WORKDIR, 'fake-ollama-pull.sh')
    // `pull` echoes a couple of progress lines then ollama's own final "success".
    fs.writeFileSync(puller, '#!/bin/sh\ncase "$1" in\n  pull) echo "pulling manifest"; echo "downloading 45%"; echo "success"; exit 0 ;;\n  *) exit 1 ;;\nesac\n')
    fs.chmodSync(puller, 0o755)
    const prev = process.env.STUDIO_OLLAMA_BIN
    process.env.STUDIO_OLLAMA_BIN = puller
    try {
      const lines = []
      const handle = mods.pullModel('qwen2.5-coder', (l) => lines.push(l))
      const res = await handle.done
      if (res.code !== 0) throw new Error('pull should exit 0: ' + JSON.stringify(res))
      const texts = lines.map((l) => l.text)
      if (!texts.some((t) => t.includes('downloading 45%'))) throw new Error('progress line not streamed: ' + JSON.stringify(texts))
      if (!texts.some((t) => t.includes('success'))) throw new Error("ollama's success line not streamed")
      if (!lines.some((l) => l.stream === 'system' && /^exit 0/.test(l.text))) throw new Error('missing terminal exit-0 system line: ' + JSON.stringify(texts))
      // A name outside RECOMMENDED must be refused WITHOUT spawning a shell (injection guard).
      const badLines = []
      const bad = mods.pullModel('evil; rm -rf ~', (l) => badLines.push(l))
      const bres = await bad.done
      if (!bres.error || bres.error !== 'unknown model') throw new Error('unknown model should resolve error, not run: ' + JSON.stringify(bres))
      if (!badLines.some((l) => /refusing to pull/i.test(l.text))) throw new Error('no refusal line for unknown model')
    } finally {
      if (prev === undefined) delete process.env.STUDIO_OLLAMA_BIN
      else process.env.STUDIO_OLLAMA_BIN = prev
    }
    return 'pull streams progress + success + exit-0; unknown name refused (no shell spawn)'
  })

  await step('Compliance export: Markdown report bundles security + ledger + audit; empty sections degrade', async () => {
    const comp = require(path.join(WORKDIR, 'main', 'compliance.js'))
    const security = { ok: false, verdict: 'Do NOT ship yet — 1 critical secret.', filesScanned: 12, findings: [{ severity: 'critical', file: 'src/config.js', line: 3, message: 'An AWS access key is hardcoded.' }] }
    const ledger = [{ ts: 1_700_000_000_000, file: 'src/app.js', why: 'add a banner | comment', model: 'scripted' }]
    const auditRows = [{ ts: 1_700_000_100_000, event: 'compliance-export', detail: '/tmp/x.md' }]
    const md = comp.buildComplianceReport('demo', 1_700_000_200_000, security, ledger, auditRows)
    if (!md.includes('# Compliance Report — demo')) throw new Error('title missing')
    if (!md.includes('## 1. Pre-Ship Security Gate') || !md.includes('Do NOT ship yet')) throw new Error('security section missing')
    if (!md.includes('## 2. What the AI Changed & Why') || !md.includes('add a banner') || !md.includes('scripted')) throw new Error('ledger section missing')
    if (!md.includes('## 3. Audit Trail') || !md.includes('compliance-export')) throw new Error('audit section missing')
    if (!md.includes(new Date(1_700_000_000_000).toISOString())) throw new Error('ledger ts not ISO-formatted')
    if (md.includes('add a banner |')) throw new Error('pipe not escaped in a table cell')
    // Empty inputs must produce graceful "none" sections, not a crash.
    const empty = comp.buildComplianceReport('', 0, { ok: true, verdict: 'Looks safe to ship', filesScanned: 0, findings: [] }, [], [])
    if (!empty.includes('No hardcoded secrets') || !empty.includes('No AI edits recorded') || !empty.includes('No audited events')) throw new Error('empty sections not graceful')
    // A pasted Windows/CRLF instruction with a backslash-pipe must NOT split the table row.
    const tricky = [{ ts: 1_700_000_000_000, file: 'src/x.js', why: 'line one\r\nline two \\| end', model: 'm' }]
    const md2 = comp.buildComplianceReport('p', 1_700_000_000_000, { ok: true, verdict: 'ok', filesScanned: 0, findings: [] }, tricky, [])
    if (/\r/.test(md2)) throw new Error('CR survived into the report (would break the GFM table)')
    const whyLine = md2.split('\n').find((l) => l.includes('line one'))
    if (!whyLine || !whyLine.includes('line two')) throw new Error('multi-line why split the table row')
    if (!whyLine.includes('\\\\')) throw new Error('backslash not escaped before the pipe')
    return `report: sections, ISO dates, pipes escaped; empty degrades; CRLF+backslash-pipe safe`
  })

  await step('ACTION run_preview starts the dev server via ProcessManager (not the blocking run tool)', async () => {
    // Real bug report: "run the app" could never work through `run` — a dev server never exits, so
    // execStream would just hang/timeout, and the agent would tell a non-coder to open the Terminal
    // and type npm start themselves. run_preview must go through a non-blocking start/poll instead.
    const calls = []
    const fakePm = {
      inspectProject: (p) => { calls.push(['inspectProject', p]); return { path: p, name: 'x', framework: 'vite', devScript: 'dev' } },
      start: (info) => { calls.push(['start', info.devScript]); fakePm._state = { status: 'running', url: 'http://localhost:5555', error: null } },
      getState: () => fakePm._state ?? { status: 'idle', url: null, error: null },
      stop: () => { calls.push(['stop']); fakePm._state = { status: 'stopped', url: null, error: null } }
    }
    writeScript(['ACTION run_preview', 'ACTION done\nstarted it'])
    events.length = 0
    const res = await agent.startAgent({ projectPath: PROJ, instruction: 'run the app', mode: 'build', provider: 'mock', newChat: true }, emit, fakePm)
    if (!res.ok) throw new Error(res.error)
    const tool = byType('tool').find((e) => e.tool === 'run_preview')
    if (!tool || !tool.ok || !/localhost:5555/.test(tool.detail)) throw new Error('run_preview did not report the running URL: ' + JSON.stringify(tool))
    if (!calls.some((c) => c[0] === 'start')) throw new Error('run_preview never called pm.start')
    // A missing dev script must be a clear ERROR, not a silent hang or a crash.
    fakePm._state = { status: 'idle', url: null, error: null }
    fakePm.inspectProject = (p) => ({ path: p, name: 'x', framework: 'unknown', devScript: null })
    writeScript(['ACTION run_preview', 'ACTION done\ntried'])
    events.length = 0
    await agent.startAgent({ projectPath: PROJ, instruction: 'run the app again', mode: 'build', provider: 'mock', newChat: true }, emit, fakePm)
    const noScript = byType('tool').find((e) => e.tool === 'run_preview')
    if (!noScript || noScript.ok || !/no.*script/i.test(noScript.detail)) throw new Error('missing dev script must be a clear refusal: ' + JSON.stringify(noScript))
    // Omitting pm entirely (e.g. a headless/test context) must degrade to an honest error, never throw.
    writeScript(['ACTION run_preview', 'ACTION done\nno pm'])
    events.length = 0
    const noPmRes = await agent.startAgent({ projectPath: PROJ, instruction: 'run without pm', mode: 'build', provider: 'mock', newChat: true }, emit)
    if (!noPmRes.ok) throw new Error('missing pm must degrade gracefully, not fail the run: ' + JSON.stringify(noPmRes))
    return 'run_preview: real URL reported, missing script refused honestly, missing pm degrades gracefully'
  })

  // ---------- Builder Mode / Developer Mode ----------

  await step('Mode: the surface table is a real subset — Builder hides, Developer shows everything', async () => {
    const { modeSurface, normalizeMode, DEFAULT_MODE, describeMode, unsavedCarryOverNote } = require(path.join(WORKDIR, 'shared', 'mode.js'))
    // A stored value from a future version, a truncated file, or nothing at all must land on the FULL
    // IDE. Defaulting the other way would hide a developer's editor because a JSON file went bad.
    for (const bad of [null, undefined, '', 'Builder', 'x', 0, {}, []]) {
      if (normalizeMode(bad) !== DEFAULT_MODE) throw new Error(`normalizeMode(${JSON.stringify(bad)}) must fall back to ${DEFAULT_MODE}`)
    }
    if (normalizeMode('builder') !== 'builder' || normalizeMode('developer') !== 'developer') throw new Error('valid modes must round-trip')

    const dev = modeSurface('developer')
    const b = modeSurface('builder')
    const flags = ['code', 'terminal', 'search', 'extensions', 'git', 'workspaces', 'problems', 'activityLog', 'advancedInsight']
    for (const f of flags) {
      if (dev[f] !== true) throw new Error(`developer must show ${f}`)
      if (b[f] !== false) throw new Error(`builder must hide ${f}`)
    }
    if (dev.dockAlwaysOn !== false || b.dockAlwaysOn !== true) throw new Error('the dock is a toggle in developer, permanent in builder')
    // Builder's panel tabs must be a strict SUBSET of the developer set: a tab only Builder Mode has
    // would be a surface with no home in the full IDE.
    for (const t of b.panelTabs) if (!dev.panelTabs.includes(t)) throw new Error(`builder tab ${t} is not a real panel tab`)
    if (b.panelTabs.length >= dev.panelTabs.length) throw new Error('builder must show fewer panel tabs')
    if (!b.panelTabs.length) throw new Error('builder must keep at least one panel tab or the Tools button opens nothing')
    // Every label a mode renders must be non-empty, or a button ships blank.
    for (const m of ['builder', 'developer']) {
      const L = modeSurface(m).labels
      for (const k of ['files', 'tools', 'runPreview', 'stopPreview', 'undo']) if (!L[k]) throw new Error(`${m}.labels.${k} is empty`)
      const d = describeMode(m)
      if (!d.title || !d.tagline || !d.bullets.length) throw new Error(`describeMode(${m}) is incomplete`)
    }
    if (unsavedCarryOverNote(0) !== '') throw new Error('no unsaved files → nothing to say')
    if (!/1 file\b/.test(unsavedCarryOverNote(1)) || !/2 files/.test(unsavedCarryOverNote(2))) throw new Error('carry-over note must count correctly')
    return 'builder ⊂ developer across 9 surfaces + panel tabs; bad stored values fall back to the full IDE'
  })

  await step('Mode: every hidden command is a REAL menu command (no typo that protects nothing)', async () => {
    const { BUILDER_HIDDEN_COMMANDS, commandAllowed } = require(path.join(WORKDIR, 'shared', 'mode.js'))
    const menuSrc = fs.readFileSync(path.join(SRC, 'main', 'menu.ts'), 'utf8')
    // A blocklist is only as good as its ids: `'term.nwe'` would silently allow the terminal through
    // while looking like protection. Each id must appear in the menu that sends it.
    const orphans = BUILDER_HIDDEN_COMMANDS.filter((id) => !menuSrc.includes(`'${id}'`))
    if (orphans.length) throw new Error('hidden ids that no menu item sends: ' + orphans.join(', '))
    for (const id of BUILDER_HIDDEN_COMMANDS) {
      if (commandAllowed('builder', id)) throw new Error(`builder must hide ${id}`)
      if (!commandAllowed('developer', id)) throw new Error(`developer must keep ${id}`)
    }
    // Commands nobody listed stay available in both — the list hides, it does not whitelist.
    for (const id of ['file.open', 'run.togglePreview', 'view.palette', 'help.about']) {
      if (!commandAllowed('builder', id) || !commandAllowed('developer', id)) throw new Error(`${id} must stay in both modes`)
    }
    return `${BUILDER_HIDDEN_COMMANDS.length} hidden ids all resolve to real menu commands`
  })

  await step('Mode: the real application menu drops the hidden surfaces (and their stranded separators)', async () => {
    const { Menu } = require('electron')
    const menuMod = require(path.join(WORKDIR, 'main', 'menu.js'))
    const topLabels = () => (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label)
    const itemsOf = (label) => {
      const top = (Menu.getApplicationMenu()?.items ?? []).find((i) => i.label === label)
      return (top?.submenu?.items ?? []).map((i) => ({ label: i.label, type: i.type }))
    }

    menuMod.setMenuState({ mode: 'developer', hasProject: true })
    const devTop = topLabels()
    for (const m of ['Terminal', 'Selection', 'Go']) if (!devTop.includes(m)) throw new Error(`developer menu lost ${m}`)
    if (!itemsOf('File').some((i) => i.label === 'Save')) throw new Error('developer File menu lost Save')

    menuMod.setMenuState({ mode: 'builder' })
    const bTop = topLabels()
    for (const m of ['Terminal', 'Selection']) if (bTop.includes(m)) throw new Error(`builder menu still shows ${m}`)
    const file = itemsOf('File')
    for (const gone of ['Save', 'Save All', 'New File…', 'Close Editor']) {
      if (file.some((i) => i.label === gone)) throw new Error(`builder File menu still shows ${gone}`)
    }
    if (!file.some((i) => i.label === 'Open Project…')) throw new Error('builder must still be able to open a project')
    // Removing items must not leave the separators they sat between: a menu opening with a divider,
    // or two in a row, is visible damage from the filtering.
    for (const label of ['File', 'Edit', 'View', 'Go', 'Run']) {
      const items = itemsOf(label)
      if (!items.length) continue
      if (items[0].type === 'separator' || items[items.length - 1].type === 'separator') throw new Error(`${label} menu has a stranded separator`)
      for (let i = 1; i < items.length; i++) {
        if (items[i].type === 'separator' && items[i - 1].type === 'separator') throw new Error(`${label} menu has doubled separators`)
      }
    }
    // And switching back restores the full menu — the hiding is reversible, not destructive.
    menuMod.setMenuState({ mode: 'developer' })
    for (const m of ['Terminal', 'Selection']) if (!topLabels().includes(m)) throw new Error(`${m} did not come back in developer mode`)
    return 'builder menu drops Terminal/Selection + every code command, keeps Open Project, no stranded separators, fully reversible'
  })

  await step('Mode: the choice persists, survives a corrupt file, and STUDIO_MODE overrides for a run', async () => {
    const modeMod = require(path.join(WORKDIR, 'main', 'mode.js'))
    const file = path.join(app.getPath('userData'), 'mode.json')
    fs.rmSync(file, { force: true })
    modeMod.resetModeCache()
    delete process.env.STUDIO_MODE
    if (modeMod.modeChosen()) throw new Error('a fresh install must report "never chosen"')
    if (modeMod.getMode() !== 'developer') throw new Error('a fresh install must default to the full IDE')

    if (modeMod.setMode('builder') !== 'builder') throw new Error('setMode must return the effective mode')
    modeMod.resetModeCache()
    if (modeMod.getMode() !== 'builder') throw new Error('the choice must survive a cache drop (i.e. a restart)')
    if (!modeMod.modeChosen()) throw new Error('after choosing, the one-time invitation must not return')

    // "Keep the mode I already have" is still a choice, and it must be recorded.
    fs.rmSync(file, { force: true })
    modeMod.resetModeCache()
    modeMod.setMode('developer')
    if (!modeMod.modeChosen()) throw new Error('choosing the current mode must still be recorded')

    fs.writeFileSync(file, '{ this is not json', 'utf8')
    modeMod.resetModeCache()
    if (modeMod.getMode() !== 'developer') throw new Error('a corrupt mode file must fall back to the full IDE, not a half-hidden window')

    process.env.STUDIO_MODE = 'builder'
    modeMod.resetModeCache()
    if (modeMod.getMode() !== 'builder') throw new Error('STUDIO_MODE must override for the run')
    delete process.env.STUDIO_MODE
    modeMod.resetModeCache()
    if (modeMod.getMode() !== 'developer') throw new Error('clearing STUDIO_MODE must return to the stored value')
    return 'persisted, restart-safe, corrupt-file-safe, env-overridable'
  })


  // ---------------------------------------------------------------- media generation
  // Images + video on the CLIENT'S OWN provider account. The mock provider (STUDIO_MOCK_MEDIA=1)
  // writes real bytes, so saving, sizing, the sidecar and the gallery are all exercised for real —
  // no network, no key, no credits.

  await step('Media registry: every provider is usable and every model is fully described', async () => {
    const reg = require(path.join(WORKDIR, 'shared', 'media.js'))
    const providersMod = require(path.join(WORKDIR, 'main', 'providers.js'))
    const seen = new Set()
    let modelCount = 0
    for (const p of reg.MEDIA_PROVIDERS) {
      if (seen.has(p.id)) throw new Error(`duplicate media provider id: ${p.id}`)
      seen.add(p.id)
      if (!p.models.length) throw new Error(`${p.id} offers no models at all`)
      if (p.id !== 'mock-media') {
        if (!p.keyUrl.startsWith('https://')) throw new Error(`${p.id} has no https link for getting a key`)
        if (p.planNote.length < 20) throw new Error(`${p.id} does not say which plan it needs`)
      }
      // A provider that claims to reuse the chat key must name a REAL chat provider, or a client
      // who already pasted that key would be told to add it a second time.
      if (p.sharesChatKey && !providersMod.PROVIDERS.some((c) => c.id === p.id)) {
        throw new Error(`${p.id} claims to share a chat key but no chat provider has that id`)
      }
      for (const m of p.models) {
        modelCount++
        if (m.kind !== 'image' && m.kind !== 'video') throw new Error(`${p.id}/${m.id} has no valid kind`)
        if (!(m.approxUsd > 0)) throw new Error(`${p.id}/${m.id} has no price for the meter`)
        if (m.sizes && !m.sizes.length) throw new Error(`${p.id}/${m.id} has an empty sizes list`)
        if (m.kind === 'video' && m.durations && !m.durations.length) throw new Error(`${p.id}/${m.id} has an empty durations list`)
      }
    }
    if (!reg.providersFor('image').length) throw new Error('no provider can make an image')
    if (!reg.providersFor('video').length) throw new Error('no provider can make a video')
    // A model typed by hand has no price — the meter must say "unknown", never invent a comfortable 0.
    if (reg.estimateUsd('openai', 'some-model-we-never-heard-of') !== null) throw new Error('an unknown model must not get a made-up price')
    return `${seen.size} providers / ${modelCount} models, all priced, linked and plan-documented`
  })

  await step('Media naming + errors: filenames are readable and failures say what to DO', async () => {
    const reg = require(path.join(WORKDIR, 'shared', 'media.js'))
    const at = Date.UTC(2026, 7, 10, 9, 30, 0)
    const n = reg.assetFileName('A calm BLUE clinic reception!! ', 'png', at)
    if (!/^a-calm-blue-clinic-reception-2026-08-10T09-30-00\.png$/.test(n)) throw new Error(`filename: ${n}`)
    if (reg.assetFileName('', 'png', at) === reg.assetFileName('', 'png', at, 1)) throw new Error('the collision suffix must change the name')
    if (!reg.assetFileName('!!!', 'png', at).startsWith('generated-')) throw new Error('an unslugabble prompt still needs a name')
    // Prompt guard
    if (reg.validatePrompt('  ') === null) throw new Error('an empty prompt must be refused')
    if (reg.validatePrompt('a cat') !== null) throw new Error('a normal prompt must be accepted')
    if (reg.validatePrompt('x'.repeat(5000)) === null) throw new Error('an over-long prompt must be refused')
    // Every failure a user actually hits names the next action, not the status code.
    const cases = [[401, 'Settings'], [402, 'credit'], [404, 'Model names change'], [429, 'rate-limit'], [500, 'their end']]
    for (const [code, must] of cases) {
      const msg = reg.describeMediaError('OpenAI', code, '{"error":"nope"}')
      if (!msg.includes(must)) throw new Error(`${code} message does not mention "${must}": ${msg}`)
    }
    return 'readable slug+timestamp names, collision suffix, and 5 HTTP failures translated into next actions'
  })

  await step('Media guards: no key / air-gap / over-budget all refuse BEFORE anything is written', async () => {
    const mediaMod = require(path.join(WORKDIR, 'main', 'media.js'))
    const policy = require(path.join(WORKDIR, 'main', 'policy.js'))
    const outDir = path.join(PROJ, 'assets', 'generated')
    const count = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0)
    const before = count()

    // A provider with no key in the vault: the refusal must name the service AND its plan note,
    // because "no API key" alone sends people to the wrong dashboard.
    const noKey = await mediaMod.generate({ projectPath: PROJ, kind: 'image', providerId: 'replicate', model: 'x/y', prompt: 'a cat' })
    if (noKey.ok) throw new Error('a provider with no key must refuse')
    if (!noKey.error.includes('Replicate') || !noKey.error.includes('account')) throw new Error(`unhelpful no-key error: ${noKey.error}`)

    // Air-gapped: there is NO local image model, so the message must say that rather than fail
    // with a network error the user cannot act on.
    policy.setAirGap(true)
    const gapped = await mediaMod.generate({ projectPath: PROJ, kind: 'image', providerId: 'openai', model: 'gpt-image-1', prompt: 'a cat' })
    policy.setAirGap(false)
    if (gapped.ok) throw new Error('air-gapped mode must block outbound generation')
    if (!/no offline option/i.test(gapped.error)) throw new Error(`air-gap error must explain there is no local option: ${gapped.error}`)

    // Budget cap: refused using THIS generation's own estimate, so one expensive video cannot sail
    // past the ceiling and only get caught on the next click.
    mediaMod.resetMediaUsage()
    mediaMod.setMediaCap(0.005)
    const capped = await mediaMod.generate({ projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-image', prompt: 'a cat' })
    mediaMod.setMediaCap(0)
    if (capped.ok) throw new Error('the media budget cap must refuse')
    if (!/budget/i.test(capped.error)) throw new Error(`cap error should mention the budget: ${capped.error}`)

    // Empty prompt + no project are refused too.
    const blank = await mediaMod.generate({ projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-image', prompt: '   ' })
    if (blank.ok) throw new Error('an empty prompt must be refused')

    if (count() !== before) throw new Error('a refused generation must not leave a file behind')
    return 'no-key names the service, air-gap explains there is no local option, cap refuses pre-flight, nothing written'
  })

  await step('Media round-trip: bytes land on disk with a receipt, the gallery reads them back, delete is fenced', async () => {
    const mediaMod = require(path.join(WORKDIR, 'main', 'media.js'))
    mediaMod.resetMediaUsage()
    mediaMod.setMediaCap(0)

    const res = await mediaMod.generate({
      projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-image', prompt: 'a blue clinic reception', size: '1024x1024'
    })
    if (!res.ok) throw new Error(`generation failed: ${res.error}`)
    const abs = path.join(PROJ, res.receipt.file)
    if (!res.receipt.file.startsWith('assets/generated/')) throw new Error(`saved outside the generated folder: ${res.receipt.file}`)
    if (!fs.existsSync(abs)) throw new Error('the file the receipt names does not exist')
    // REAL bytes, not a string pretending to be a picture.
    const head = fs.readFileSync(abs).subarray(0, 8)
    if (head[0] !== 0x89 || head[1] !== 0x50) throw new Error('the saved file is not a real PNG')
    if (res.receipt.bytes !== fs.statSync(abs).size) throw new Error('the receipt byte count does not match the file')

    // The sidecar is what makes the asset self-explaining months later.
    const side = JSON.parse(fs.readFileSync(abs + '.json', 'utf8'))
    if (side.prompt !== 'a blue clinic reception') throw new Error('the sidecar lost the prompt')
    if (side.model !== 'mock-image' || side.providerId !== 'mock-media') throw new Error('the sidecar lost which model made it')

    // The meter moved by this generation's own estimate.
    const usage = mediaMod.getMediaUsage()
    if (usage.generations !== 1) throw new Error(`meter counted ${usage.generations}`)
    if (!(usage.estUsd > 0)) throw new Error('the meter recorded no spend')

    // Two generations from the SAME prompt must not overwrite each other.
    const again = await mediaMod.generate({ projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-image', prompt: 'a blue clinic reception' })
    if (!again.ok) throw new Error(again.error)
    if (again.receipt.file === res.receipt.file) throw new Error('a second generation overwrote the first')

    // The gallery reads from DISK, so it survives a restart.
    const listed = mediaMod.listMedia(PROJ)
    if (listed.length < 2) throw new Error(`gallery listed ${listed.length}`)
    if (listed[0].createdAt < listed[listed.length - 1].createdAt) throw new Error('the gallery must be newest-first')
    if (!listed.some((m) => m.file === res.receipt.file && m.prompt === 'a blue clinic reception')) throw new Error('the gallery lost the prompt')

    // A file whose sidecar is gone still appears — the asset existing is the fact that matters.
    fs.rmSync(abs + '.json', { force: true })
    const orphan = mediaMod.listMedia(PROJ).find((m) => m.file === res.receipt.file)
    if (!orphan) throw new Error('an asset with no sidecar vanished from the gallery')
    if (orphan.bytes !== fs.statSync(abs).size) throw new Error('an orphan asset must still report its real size')

    // Data URL for the thumbnail, and the path guard on delete.
    const durl = mediaMod.readMediaDataUrl(PROJ, res.receipt.file)
    if (!durl.ok || !durl.dataUrl.startsWith('data:image/png;base64,')) throw new Error('thumbnail data URL is wrong')
    const escape = mediaMod.deleteMedia(PROJ, '../../../etc/hosts')
    if (escape.ok) throw new Error('delete must refuse a path outside the generated folder')
    const gone = mediaMod.deleteMedia(PROJ, res.receipt.file)
    if (!gone.ok) throw new Error(`delete failed: ${gone.error}`)
    if (fs.existsSync(abs)) throw new Error('delete left the file behind')
    return 'real PNG on disk, sidecar carries the prompt, no overwrite, gallery is disk-backed + orphan-safe, delete is path-fenced'
  })

  await step('generate_image: the agent can make an artwork, but never in plan mode', async () => {
    const spec = agent.parseImageSpec('a calm blue clinic reception --size 16:9 --provider openai --model gpt-image-1')
    if (spec.prompt !== 'a calm blue clinic reception') throw new Error(`flags leaked into the prompt: "${spec.prompt}"`)
    if (spec.size !== '16:9' || spec.providerId !== 'openai' || spec.model !== 'gpt-image-1') throw new Error('flags were not read')
    const plain = agent.parseImageSpec('just a hero image of a pharmacy')
    if (plain.prompt !== 'just a hero image of a pharmacy') throw new Error('a plain sentence must survive intact')
    if (!plain.providerId) throw new Error('a plain sentence must still get a default service')

    const mediaMod = require(path.join(WORKDIR, 'main', 'media.js'))
    mediaMod.resetMediaUsage()
    const outDir = path.join(PROJ, 'assets', 'generated')
    const before = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0

    // PLAN mode: describing is allowed, spending is not.
    events.length = 0
    writeScript(['I would add a hero image.\nACTION generate_image a hero image of a pharmacy', 'ACTION done Described it.'])
    await agent.startAgent({ projectPath: PROJ, instruction: 'add a hero image', mode: 'plan', provider: 'mock', newChat: true }, emit)
    const refused = byType('tool').find((e) => e.tool === 'generate_image')
    if (!refused || refused.ok !== false) throw new Error('plan mode must refuse to spend money on an image')
    if ((fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0) !== before) throw new Error('plan mode wrote a file anyway')

    // BUILD mode: it really generates, and the file is counted in the Build Receipt.
    events.length = 0
    writeScript(['Making the hero image now.\nACTION generate_image a hero image of a pharmacy', 'ACTION done Added the hero image.'])
    await agent.startAgent({ projectPath: PROJ, instruction: 'add a hero image', mode: 'build', provider: 'mock', newChat: true }, emit)
    const made = byType('tool').filter((e) => e.tool === 'generate_image')
    if (!made.length || !made[made.length - 1].ok) throw new Error(`generate_image failed: ${JSON.stringify(byType('error'))}`)
    const file = made[made.length - 1].detail
    if (!fs.existsSync(path.join(PROJ, file))) throw new Error(`the agent reported ${file} but nothing is there`)
    const receipt = byType('done')[0] && byType('done')[0].receipt
    if (!receipt) throw new Error('the run produced no receipt')
    if (!receipt.files.some((f) => f.path === file && f.bytesDelta > 0)) throw new Error('the generated image is missing from the Build Receipt')
    return `flags parsed cleanly, plan mode refused, build mode created ${file} and counted it on the receipt`
  })


  await step('Start from a photo: the registry is coherent and every capable model declares HOW', async () => {
    const reg = require(path.join(WORKDIR, 'shared', 'media.js'))
    let capable = 0
    for (const p of reg.MEDIA_PROVIDERS) {
      for (const m of p.models) {
        if (!m.acceptsSourceImage) {
          // The reverse must hold too, or a sourceKey sits there implying a capability we never offer.
          if (m.sourceKey) throw new Error(`${p.id}/${m.id} declares a sourceKey but not acceptsSourceImage`)
          continue
        }
        capable++
        // Replicate and fal go through the GENERIC pass-through, which posts whatever field it is
        // told to — those two MUST name the field, because a guess would 422 rather than degrade.
        if ((p.id === 'replicate' || p.id === 'fal') && !m.sourceKey) {
          throw new Error(`${p.id}/${m.id} accepts a photo but never says which input field it goes in`)
        }
        if (!reg.acceptsSource(p.id, m.id)) throw new Error(`acceptsSource() disagrees with the table for ${p.id}/${m.id}`)
      }
    }
    if (capable < 4) throw new Error(`only ${capable} models can start from a photo`)
    // A model with no declaration must never be treated as capable — that is what keeps the picker honest.
    if (reg.acceptsSource('replicate', 'black-forest-labs/flux-1.1-pro')) throw new Error('a non-editing model was reported as editing-capable')
    if (reg.acceptsSource('openai', 'a-model-nobody-has-heard-of')) throw new Error('an unknown model must not be reported as capable')
    // Both kinds are reachable: editing a photo AND animating one.
    if (!reg.sourceCapableProviders('image').length) throw new Error('no service can edit a photo')
    if (!reg.sourceCapableProviders('video').length) throw new Error('no service can animate a photo')
    // File-type gate
    for (const good of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp']) if (!reg.isUsableSourceImage(good)) throw new Error(`${good} should be usable`)
    for (const bad of ['a.mp4', 'b.svg', 'c.txt', 'noextension']) if (reg.isUsableSourceImage(bad)) throw new Error(`${bad} must not be usable as a source`)
    return `${capable} models can start from a photo, all with a declared input path; non-capable models stay non-capable`
  })

  await step('Start from a photo: the bytes really reach the wire, and every bad pairing is refused free', async () => {
    const mediaMod = require(path.join(WORKDIR, 'main', 'media.js'))
    mediaMod.resetMediaUsage()
    mediaMod.setMediaCap(0)
    const outDir = path.join(PROJ, 'assets', 'generated')
    const count = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => !f.endsWith('.json')).length : 0)

    // Make a real source picture first.
    const base = await mediaMod.generate({ projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-image', prompt: 'a plain wall' })
    if (!base.ok) throw new Error(`could not create the source image: ${base.error}`)
    const srcRel = base.receipt.file
    const srcBytes = fs.statSync(path.join(PROJ, srcRel)).size

    // ---- refusals, all of which must cost nothing ----
    const before = count()
    const wrongModel = await mediaMod.generate({
      projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-image', prompt: 'make it blue', sourceFile: srcRel
    })
    if (wrongModel.ok) throw new Error('a model that cannot take a photo must refuse one')
    if (!/cannot start from a photo/i.test(wrongModel.error)) throw new Error(`unclear refusal: ${wrongModel.error}`)

    const notAnImage = await mediaMod.generate({
      projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-edit', prompt: 'x', sourceFile: 'assets/generated/clip.mp4'
    })
    if (notAnImage.ok || !/PNG, JPG or WebP/i.test(notAnImage.error)) throw new Error(`a video is not a starting picture: ${notAnImage.error}`)

    const missing = await mediaMod.generate({
      projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-edit', prompt: 'x', sourceFile: 'assets/generated/does-not-exist.png'
    })
    if (missing.ok || !/could not read/i.test(missing.error)) throw new Error(`a missing source must say so: ${missing.error}`)

    // The path guard applies to the SOURCE too — reading an arbitrary file off the disk and posting
    // it to a third party would be the worst possible bug in this feature.
    const escape = await mediaMod.generate({
      projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-edit', prompt: 'x', sourceFile: '../../../../etc/hosts'
    })
    if (escape.ok) throw new Error('a source image outside the project must be refused')

    if (count() !== before) throw new Error('a refused edit must not leave a file behind')

    // ---- the real thing: bytes arrive at the adapter ----
    const logFile = path.join(WORKDIR, 'media-wire.json')
    process.env.STUDIO_MOCK_MEDIA_LOG = logFile
    const edited = await mediaMod.generate({
      projectPath: PROJ, kind: 'image', providerId: 'mock-media', model: 'mock-edit', prompt: 'make the wall blue', sourceFile: srcRel
    })
    if (!edited.ok) throw new Error(`edit failed: ${edited.error}`)
    const wire = JSON.parse(fs.readFileSync(logFile, 'utf8'))
    if (wire.sourceBytes !== srcBytes) throw new Error(`the adapter got ${wire.sourceBytes} bytes, the file is ${srcBytes}`)
    if (wire.sourceMime !== 'image/png') throw new Error(`wrong mime on the wire: ${wire.sourceMime}`)
    // The result records what it was made FROM — otherwise an edit is indistinguishable from a
    // fresh generation the moment it lands in the folder.
    if (edited.receipt.sourceFile !== srcRel) throw new Error('the receipt does not record the source photo')
    const side = JSON.parse(fs.readFileSync(path.join(PROJ, edited.receipt.file) + '.json', 'utf8'))
    if (side.sourceFile !== srcRel) throw new Error('the sidecar does not record the source photo')

    // ---- animating the same photo into a video ----
    const animated = await mediaMod.generate({
      projectPath: PROJ, kind: 'video', providerId: 'mock-media', model: 'mock-animate', prompt: 'slow pan', sourceFile: srcRel, seconds: 4
    })
    if (!animated.ok) throw new Error(`animate failed: ${animated.error}`)
    if (animated.receipt.kind !== 'video') throw new Error('animating a photo must produce a video')
    const wire2 = JSON.parse(fs.readFileSync(logFile, 'utf8'))
    if (wire2.sourceBytes !== srcBytes) throw new Error('the photo did not reach the video adapter')
    delete process.env.STUDIO_MOCK_MEDIA_LOG

    // Cleanup so the gallery test's expectations stay stable.
    for (const f of [srcRel, edited.receipt.file, animated.receipt.file]) mediaMod.deleteMedia(PROJ, f)
    return `${srcBytes} B of real PNG reached both the edit and the animate adapters; 4 bad pairings refused before any spend`
  })


  await step('Key vault: an unreadable vault is never mistaken for an empty one (and never overwritten)', async () => {
    /* Found by live testing on 2026-08-12, not by reading the code. A helper read the vault under a
       different app name, macOS handed it a different Keychain entry, decryptString threw — and the
       swallowed error presented as "no API key set" for keys that were sitting right there. The
       destructive half is worse: setApiKey merges into whatever readAll() returned, so merging into
       {} rewrites the file with ONLY the newest key and silently destroys the rest. */
    const vault = require(path.join(WORKDIR, 'main', 'keyvault.js'))
    const { app: electronApp } = require('electron')
    const file = path.join(electronApp.getPath('userData'), 'atomic-studio-keys.bin')

    // A fresh install: empty, not broken.
    fs.rmSync(file, { force: true })
    if (vault.vaultStatus() !== 'empty') throw new Error('a fresh install must report "empty"')

    // Normal round-trip, and a second key must not evict the first.
    let res = vault.setApiKey('replicate', 'r8_test_value_one')
    if (!res.ok) throw new Error(`saving into an empty vault must work: ${res.error}`)
    res = vault.setApiKey('fal', 'fal_test_value_two')
    if (!res.ok) throw new Error(`saving a second key must work: ${res.error}`)
    if (vault.getApiKey('replicate') !== 'r8_test_value_one') throw new Error('the second save evicted the first key')
    if (vault.vaultStatus() !== 'ok') throw new Error('a readable vault must report "ok"')

    // Now make it undecryptable, exactly as a wrong Keychain identity would.
    fs.writeFileSync(file, Buffer.from('v10this-is-not-decryptable-by-this-process', 'utf8'))
    if (vault.vaultStatus() !== 'unreadable') throw new Error('a vault that will not open must report "unreadable", not "empty"')
    if (vault.hasApiKey('replicate')) throw new Error('an unreadable vault cannot report a usable key')

    // THE important assertion: saving must REFUSE rather than clobber the credentials it cannot read.
    const before = fs.readFileSync(file)
    const refused = vault.setApiKey('openai', 'sk-would-destroy-the-others')
    if (refused.ok) throw new Error('saving into an unreadable vault must refuse — it would erase the other keys')
    if (!/erase|unlock/i.test(refused.error)) throw new Error(`the refusal must explain the risk: ${refused.error}`)
    if (!fs.readFileSync(file).equals(before)) throw new Error('a refused save must leave the existing vault byte-for-byte untouched')

    // Recovering by deleting the file works, and does not carry the broken state forward.
    fs.rmSync(file, { force: true })
    if (vault.vaultStatus() !== 'empty') throw new Error('deleting the vault must return it to "empty"')
    if (!vault.setApiKey('openai', 'sk-fresh-start').ok) throw new Error('a fresh vault must accept a key again')
    fs.rmSync(file, { force: true })
    return 'empty ≠ unreadable; two keys coexist; an unreadable vault refuses the write and is left byte-identical'
  })

  await step('Media errors: 429 tells credit-exhausted apart from rate-limited', async () => {
    /* Live testing again: Google answers "your prepayment credits are depleted" with 429, and the
       first version of this mapping told that user to "wait a moment and try again" — advice that can
       never succeed. The two halves of 429 need opposite actions, so the body decides. */
    const reg = require(path.join(WORKDIR, 'shared', 'media.js'))
    const googleBody = JSON.stringify({
      error: { code: 429, message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.', status: 'RESOURCE_EXHAUSTED' }
    })
    const outOfCredit = reg.describeMediaError('Google (Gemini)', 429, googleBody)
    if (!/out of credit/i.test(outOfCredit)) throw new Error(`a depleted account must be named as such: ${outOfCredit}`)
    if (/wait a moment/i.test(outOfCredit)) throw new Error('a depleted account must NOT be told to wait — waiting can never fix it')
    if (!/will not clear this/i.test(outOfCredit)) throw new Error('the message should say waiting will not help')

    // A genuine rate limit still gets the "wait" advice, which for that case is correct.
    const throttled = reg.describeMediaError('OpenAI', 429, JSON.stringify({ error: { message: 'Rate limit reached for requests' } }))
    if (!/rate-limiting/i.test(throttled) || !/try again/i.test(throttled)) throw new Error(`a real rate limit should still say wait: ${throttled}`)
    return 'a depleted account is told to top up, a throttled one is told to wait — from the body, not the status code'
  })


  await step('No terminal: the message says WHY and what still works (never a raw module error)', async () => {
    /* The Windows build ships without node-pty on purpose — it is a native module with no Windows
       prebuilt that cannot be compiled from the Mac these builds are made on. The raw failure is
       "Cannot find module 'node-pty'", which tells a non-coder nothing: not whether their install is
       broken, not whether it is fixable, not what still works. */
    const pty = require(path.join(WORKDIR, 'main', 'pty.js'))

    const win = pty.describeNoTerminal(true, 'win32', "Cannot find module 'node-pty'")
    if (/node-pty|MODULE_NOT_FOUND|Cannot find module/i.test(win)) throw new Error(`the module name leaked into the user's message: ${win}`)
    if (!/not included in this Windows build/i.test(win)) throw new Error('a Windows build must say the terminal was never included')
    if (!/agent still runs commands/i.test(win)) throw new Error('it must say what still works, or the app reads as broken')
    // It must NOT offer a fix that cannot work — there is nothing this user can do about it.
    if (/rebuild:native/i.test(win)) throw new Error('a missing-by-design terminal must not suggest a rebuild that cannot help')

    // Same situation on a Mac is still "not included", but without blaming Windows.
    const mac = pty.describeNoTerminal(true, 'darwin', "Cannot find module 'node-pty'")
    if (/Windows/i.test(mac)) throw new Error(`a mac build must not blame Windows: ${mac}`)

    // Present-but-broken is a DIFFERENT situation with an actionable fix, so it keeps the detail.
    const broken = pty.describeNoTerminal(false, 'darwin', 'NODE_MODULE_VERSION 127 vs 125')
    if (!/rebuild:native/i.test(broken)) throw new Error('a fixable failure must name the fix')
    if (!/NODE_MODULE_VERSION/.test(broken)) throw new Error('a fixable failure should keep the technical detail for whoever fixes it')
    if (/not included in this build/i.test(broken)) throw new Error('a broken module must not be described as absent by design')
    return 'missing-by-design vs broken are told apart; no raw module error, no fix that cannot work, and it says what still works'
  })

  // ---------- self-hosted git provisioning ----------
  const prov = require(path.join(WORKDIR, 'main', 'git-provision.js'))
  const PROV_DIR = path.join(WORKDIR, 'gitserver')
  const PROV_SSH = path.join(WORKDIR, 'fake-ssh-prov.sh')

  /** Write a fake ssh that fails the way real ssh fails: exit 255 with a message on stderr. */
  function fakeSshFailing(message) {
    fs.writeFileSync(PROV_SSH, `#!/bin/sh\necho ${JSON.stringify(message)} >&2\nexit 255\n`)
    fs.chmodSync(PROV_SSH, 0o755)
    process.env.STUDIO_SSH_BIN = PROV_SSH
    process.env.GIT_SSH_COMMAND = PROV_SSH
  }
  /**
   * Write a fake ssh that connects: run the final argument locally, like the company-server fake.
   *
   * Sets BOTH env vars, not just STUDIO_SSH_BIN: `preflight`/`createBareRepo` go through
   * `remote.ts`'s `sshRun`, which honours STUDIO_SSH_BIN — but `gitPush`/`gitRemoteAdd` run
   * a real `git` process (`git-exec.ts`), which only ever looks at `ssh`/GIT_SSH_COMMAND, has
   * never heard of STUDIO_SSH_BIN, and would otherwise try to really dial `git.example`. git's
   * own `env` is `{ ...process.env, … }` (`execStream` in terminal.ts), so setting
   * GIT_SSH_COMMAND here is enough — no code changes needed in git-core.ts for `git push` to
   * land on the SAME local fake bare repo that `createBareRepo` created via `sshRun`.
   */
  function fakeSshWorking() {
    fs.writeFileSync(PROV_SSH, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n')
    fs.chmodSync(PROV_SSH, 0o755)
    process.env.STUDIO_SSH_BIN = PROV_SSH
    process.env.GIT_SSH_COMMAND = PROV_SSH
  }

  await step('preflight: ssh exit 255 is told apart from a command that actually ran', async () => {
    fs.mkdirSync(PROV_DIR, { recursive: true })
    const server = { host: 'git.example', sshUser: 'git', root: PROV_DIR }

    fakeSshFailing('ssh: connect to host git.example port 22: Connection refused')
    const unreachable = await prov.preflight(server)
    if (unreachable.ok) throw new Error('a refused connection must not pass preflight')
    if (unreachable.remedy?.kind !== 'unreachable') throw new Error(`expected unreachable, got ${unreachable.remedy?.kind}`)
    if (unreachable.steps[0].id !== 'reach' || unreachable.steps[0].ok) throw new Error('reach must be the failing step')

    fakeSshFailing('git@git.example: Permission denied (publickey).')
    const denied = await prov.preflight(server)
    if (denied.ok) throw new Error('a refused key must not pass preflight')
    if (denied.remedy?.kind !== 'no-key' && denied.remedy?.kind !== 'key-refused')
      throw new Error(`expected a key remedy, got ${denied.remedy?.kind}`)
    // Reaching the host SUCCEEDED here — that is the whole point of splitting the two.
    if (!denied.steps.find((s) => s.id === 'reach')?.ok) throw new Error('a key refusal proves the host was reached')

    fakeSshFailing('@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@')
    const changed = await prov.preflight(server)
    if (changed.remedy?.kind !== 'host-key-changed') throw new Error(`expected host-key-changed, got ${changed.remedy?.kind}`)

    fakeSshWorking()
    const good = await prov.preflight(server)
    if (!good.ok) throw new Error(`a reachable, writable server with git should pass: ${JSON.stringify(good.steps)}`)
    if (good.steps.length !== 4) throw new Error(`expected 4 steps, got ${good.steps.length}`)

    const notWritable = await prov.preflight({ ...server, root: '/no/such/dir/xyz' })
    if (notWritable.ok) throw new Error('a missing root must fail')
    if (notWritable.remedy?.kind !== 'not-writable') throw new Error(`expected not-writable, got ${notWritable.remedy?.kind}`)
    return 'unreachable / key-refused / host-key-changed / not-writable are four distinct answers'
  })

  await step('repo names: validated AND quoted, and planRepo touches nothing', async () => {
    const server = { host: 'git.example', sshUser: 'git', root: '/srv/atomic/git' }

    for (const bad of ['../escape', 'has space', 'a;rm -rf /', '', '.', '..', 'x'.repeat(65), 'repo.lock', 'a/b']) {
      if (prov.validRepoName(bad)) throw new Error(`accepted a bad name: ${JSON.stringify(bad)}`)
    }
    for (const good of ['my-app', 'studio', 'a.b_c-1', 'X']) {
      if (!prov.validRepoName(good)) throw new Error(`rejected a good name: ${good}`)
    }

    const plan = prov.planRepo(server, 'my-app')
    if (plan.url !== 'ssh://git@git.example/srv/atomic/git/my-app.git') throw new Error(plan.url)
    if (!/git init --bare '\/srv\/atomic\/git\/my-app\.git'/.test(plan.command)) throw new Error(plan.command)

    // A non-default port must appear in the URL or the clone silently goes to 22.
    const alt = prov.planRepo({ ...server, port: 2222 }, 'my-app')
    if (alt.url !== 'ssh://git@git.example:2222/srv/atomic/git/my-app.git') throw new Error(alt.url)

    // planRepo must not run ssh. Point STUDIO_SSH_BIN at a script that leaves a trace if called.
    const TRIP = path.join(WORKDIR, 'ssh-tripwire.sh')
    const TRIPPED = path.join(WORKDIR, 'tripped')
    fs.writeFileSync(TRIP, `#!/bin/sh\ntouch ${JSON.stringify(TRIPPED)}\nexit 0\n`)
    fs.chmodSync(TRIP, 0o755)
    const prevBin = process.env.STUDIO_SSH_BIN
    process.env.STUDIO_SSH_BIN = TRIP
    prov.planRepo(server, 'another')
    await sleep(150)
    process.env.STUDIO_SSH_BIN = prevBin
    if (fs.existsSync(TRIPPED)) throw new Error('planRepo invoked ssh — the confirmation screen would be a lie')

    let threw = false
    try { prov.planRepo(server, '../escape') } catch { threw = true }
    if (!threw) throw new Error('planRepo must refuse an invalid name rather than build a path from it')
    return 'bad names rejected, port carried into the URL, path single-quoted, zero ssh calls'
  })

  await step('createBareRepo: refuses a name already taken, and audits the one it creates', async () => {
    fs.mkdirSync(PROV_DIR, { recursive: true })
    fakeSshWorking()
    const server = { host: 'git.example', sshUser: 'git', root: PROV_DIR }

    const made = await prov.createBareRepo(server, 'fresh-app')
    if (!made.ok) throw new Error(made.error)
    if (!fs.existsSync(path.join(PROV_DIR, 'fresh-app.git', 'HEAD'))) throw new Error('no bare repo on disk')
    if (made.url !== `ssh://git@git.example${PROV_DIR}/fresh-app.git`) throw new Error(made.url)

    // The dangerous case: the directory is already there. git init --bare would SUCCEED.
    const again = await prov.createBareRepo(server, 'fresh-app')
    if (again.ok) throw new Error('a second create on the same name must be refused, not silently reused')
    if (!/already exists/i.test(again.error || '')) throw new Error(`unhelpful error: ${again.error}`)

    const bad = await prov.createBareRepo(server, 'a;rm -rf /')
    if (bad.ok) throw new Error('an invalid name must be refused')

    const entries = auditMod.auditTail(50)
    if (!entries.some((e) => e.event === 'git-provision-create' && /fresh-app\.git/.test(e.detail)))
      throw new Error("creating a repository on someone else's server must leave an audit entry")
    return 'creates once, refuses the retake, refuses a shell-injecting name, audits the write'
  })

  await step('ensureKey: creates one dedicated key, reuses it, never touches the default identities', async () => {
    const FAKE_HOME = path.join(WORKDIR, 'home')
    fs.mkdirSync(path.join(FAKE_HOME, '.ssh'), { recursive: true })
    // A pre-existing default identity that must survive untouched.
    fs.writeFileSync(path.join(FAKE_HOME, '.ssh', 'id_ed25519'), 'DO NOT TOUCH\n')
    const prevHome = process.env.HOME
    process.env.HOME = FAKE_HOME
    try {
      const first = await prov.ensureKey()
      if (!first.created) throw new Error('the first call should create the key')
      if (!first.path.startsWith(FAKE_HOME)) throw new Error(`key escaped the fake home: ${first.path}`)
      if (first.path.includes('~')) throw new Error('the stored path must be absolute, never a tilde')
      if (!/^ssh-ed25519 AAAA/.test(first.publicKey)) throw new Error(`not an ed25519 public key: ${first.publicKey}`)
      if (!fs.existsSync(first.path)) throw new Error('private key missing')

      const before = fs.readFileSync(first.path, 'utf8')
      const second = await prov.ensureKey()
      if (second.created) throw new Error('the second call must reuse, not regenerate')
      if (fs.readFileSync(first.path, 'utf8') !== before) throw new Error('the private key was rewritten')
      if (second.publicKey !== first.publicKey) throw new Error('public key changed between calls')

      if (fs.readFileSync(path.join(FAKE_HOME, '.ssh', 'id_ed25519'), 'utf8') !== 'DO NOT TOUCH\n')
        throw new Error("the user's default identity was modified")
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
    return 'one dedicated key, idempotent, absolute path, default identities untouched'
  })

  await step('publish: plan then run; an empty folder wires origin without pushing', async () => {
    fakeSshWorking()
    const server = { host: 'git.example', sshUser: 'git', root: PROV_DIR }
    const gitCore = require(path.join(WORKDIR, 'main', 'git-core.js'))

    // Real folders, NOT under WORKDIR: WORKDIR (apps/desktop/.agent-test) sits INSIDE this very
    // repo, so a subfolder with no .git of its own is still "isRepo: true" — git walks up and
    // finds ATOMICStudio's own .git. Every other "plain, non-repo folder" in this suite uses
    // os.tmpdir() for exactly this reason (see the `truly outside any repo` folders elsewhere in
    // this file); a folder under WORKDIR would make willInit false and fail the assertion below
    // for a reason that has nothing to do with publishPlan.
    const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-publish-'))

    // --- a folder with files ---
    const withFiles = path.join(scratch, 'proj-files')
    fs.mkdirSync(withFiles, { recursive: true })
    fs.writeFileSync(path.join(withFiles, 'index.html'), '<h1>hi</h1>\n')

    const plan = await prov.publishPlan(server, withFiles, 'has-files')
    if (!plan.preflight.ok) throw new Error(JSON.stringify(plan.preflight.steps))
    if (!plan.willInit) throw new Error('a plain folder needs git init')
    if (!plan.willCommit) throw new Error('a folder with files needs an initial commit')
    if (!/git init --bare/.test(plan.command)) throw new Error(plan.command)
    if (fs.existsSync(path.join(PROV_DIR, 'has-files.git'))) throw new Error('publishPlan created the repo — it must only plan')

    const ran = await prov.publishRun(server, withFiles, 'has-files')
    if (!ran.ok) throw new Error(ran.error)
    if (!ran.pushed) throw new Error('a folder with files should have pushed')
    const remotes = await gitCore.gitRemotes(withFiles)
    // GitRemote has fetchUrl/pushUrl, not `.url` — `gitRemotes` reports a name and its two URLs
    // separately (see git-core.ts:836) since `set-url` can in principle diverge them.
    if (!remotes.some((r) => r.name === 'origin' && r.fetchUrl === ran.url)) throw new Error(JSON.stringify(remotes))

    // --- an empty folder ---
    const empty = path.join(scratch, 'proj-empty')
    fs.mkdirSync(empty, { recursive: true })
    const emptyRan = await prov.publishRun(server, empty, 'is-empty')
    if (!emptyRan.ok) throw new Error(emptyRan.error)
    if (emptyRan.pushed) throw new Error('an empty folder has no commits and must not claim to have pushed')
    const emptyRemotes = await gitCore.gitRemotes(empty)
    if (!emptyRemotes.some((r) => r.name === 'origin')) throw new Error('origin should still be wired')
    return 'plan writes nothing; files → init+commit+push; empty → origin wired, nothing pushed'
  })

  await step('publish: a folder containing only an empty subdirectory has nothing to commit — not an error', async () => {
    fakeSshWorking()
    const server = { host: 'git.example', sshUser: 'git', root: PROV_DIR }
    const gitCore = require(path.join(WORKDIR, 'main', 'git-core.js'))
    const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'atomic-publish-'))

    // The exact defect this proves: the old `hasAnyFile` counted ANY directory entry other than
    // `.git` as "a file", and an empty subdirectory IS a directory entry — but `git add -A` never
    // stages an empty directory, so git genuinely has nothing to commit here. Before this fix,
    // `publishRun` sailed past its "anything to commit?" check, `gitCommit` correctly found
    // nothing, and `gitPush` then failed outright because the brand-new repo had no commits at
    // all: the caller got `{ ok: false, pushed: false, error: <raw git error> }` even though
    // `createBareRepo`/`gitInit`/`gitRemoteAdd` had all already succeeded. This asserts the
    // graceful outcome a truly-empty folder already got — `{ ok: true, pushed: false }` with
    // `origin` wired — which the OLD code would have failed on both counts (ok:false, no error
    // asserted here) and the plan's `willCommit` would have wrongly said true.
    const onlyEmptyDir = path.join(scratch, 'proj-empty-subdir')
    fs.mkdirSync(path.join(onlyEmptyDir, 'empty-subfolder'), { recursive: true })

    const plan = await prov.publishPlan(server, onlyEmptyDir, 'is-empty-subdir')
    if (plan.willCommit) throw new Error('an empty subdirectory has nothing for git to stage — the plan must say willCommit:false')

    const ran = await prov.publishRun(server, onlyEmptyDir, 'is-empty-subdir')
    if (!ran.ok) throw new Error(`an empty-subdirectory-only folder must publish gracefully, not error: ${ran.error}`)
    if (ran.pushed) throw new Error('nothing was committed, so nothing should have been pushed')
    const remotes = await gitCore.gitRemotes(onlyEmptyDir)
    if (!remotes.some((r) => r.name === 'origin')) throw new Error('origin should still be wired even though nothing was pushed')
    return 'a folder containing only an empty subdirectory publishes as ok:true, pushed:false — origin wired, no raw git error'
  })

  await step('git server config: written where the forge already reads it, and merged not clobbered', async () => {
    const forgeAtomic = require(path.join(WORKDIR, 'main', 'forge-atomic.js'))
    const CFG = path.join(WORKDIR, 'atomic-forge.json')
    process.env.STUDIO_ATOMIC_FORGE = CFG
    fs.rmSync(CFG, { force: true })

    const saved = forgeAtomic.saveServerConfig({ host: 'git.example', sshUser: 'git', root: '/srv/atomic/git', port: 2222, keyPath: '/abs/key' })
    if (!saved.ok) throw new Error(saved.error)

    // It must land in the SAME file the forge reads, so the dropdown and repo list light up.
    const back = forgeAtomic.serverConfig()
    if (!back || back.host !== 'git.example' || back.port !== 2222) throw new Error(JSON.stringify(back))
    if (String(back.keyPath).includes('~')) throw new Error('keyPath must be stored absolute')

    // Saving must not destroy a repo list the control plane or a previous session wrote.
    fs.writeFileSync(CFG, JSON.stringify({ ...JSON.parse(fs.readFileSync(CFG, 'utf8')), repos: [{ name: 'keepme' }] }))
    forgeAtomic.saveServerConfig({ host: 'git2.example', sshUser: 'git', root: '/srv/atomic/git' })
    const merged = JSON.parse(fs.readFileSync(CFG, 'utf8'))
    if (!merged.repos || merged.repos[0].name !== 'keepme') throw new Error('saving the server wiped the repo list')
    if (merged.host !== 'git2.example') throw new Error('the new host did not land')
    return 'one file, merged not clobbered, absolute keyPath'
  })

  await step('git server config: managed seat refuses at the source, not just at IPC', async () => {
    const forgeAtomic = require(path.join(WORKDIR, 'main', 'forge-atomic.js'))
    const policyMod = require(path.join(WORKDIR, 'main', 'policy.js'))
    const CFG = path.join(WORKDIR, 'atomic-forge-managed.json')
    process.env.STUDIO_ATOMIC_FORGE = CFG
    fs.rmSync(CFG, { force: true })

    // A managed seat: identityRequired() is driven off the enterprise-policy file's idp block,
    // and this suite already points STUDIO_ENTERPRISE_POLICY at a fixture for other steps — set
    // and restore it here so no later step inherits a managed seat.
    const policyFile = path.join(WORKDIR, 'managed-seat-policy.json')
    fs.writeFileSync(policyFile, JSON.stringify({ idp: { issuer: 'https://idp.example', clientId: 'studio', controlPlane: 'https://cp.example' } }))
    const prevEnv = process.env.STUDIO_ENTERPRISE_POLICY
    process.env.STUDIO_ENTERPRISE_POLICY = policyFile
    try {
      policyMod.resetPolicyCache()
      if (!policyMod.identityRequired()) throw new Error('fixture did not produce a managed seat')

      // Refusal alone is not enough to prove the guard: a caller that ignored the return value
      // and read the file back would see whether it was actually written. Assert both.
      const result = forgeAtomic.saveServerConfig({ host: 'sneaky.example', sshUser: 'git', root: '/srv/atomic/git' })
      if (result.ok) throw new Error('saveServerConfig must refuse on a managed seat')
      if (!/organisation manages/i.test(result.error || '')) throw new Error(`unexpected refusal message: ${result.error}`)
      if (fs.existsSync(CFG)) throw new Error('a refused save must not create the config file')
    } finally {
      if (prevEnv === undefined) delete process.env.STUDIO_ENTERPRISE_POLICY
      else process.env.STUDIO_ENTERPRISE_POLICY = prevEnv
      policyMod.resetPolicyCache()
    }
    return 'managed seat: saveServerConfig refuses before writing, unmanaged env restored'
  })

  await step('clone URLs: a non-default SSH port survives, and the server’s own URL always wins', async () => {
    /**
     * TWO WAYS THE PORT USED TO GO MISSING, and both produced the same unreadable failure — a clone
     * that dialled 22, hit whatever was (or was not) there, and reported something about the
     * transport rather than the port.
     *
     *  1. `atomicCloneUrl` rebuilt the URL from host + root and never emitted `:port`, so
     *     PUBLISHING a repo (which got it right) and CLONING the same repo disagreed about its
     *     address.
     *  2. The control-plane catalogue returns `url` per repository — built by the server, which is
     *     the only party that knows its own SSH port and repository root — and that field was
     *     parsed and thrown away.
     */
    const forgeAtomic = require(path.join(WORKDIR, 'main', 'forge-atomic.js'))
    const CFG = path.join(WORKDIR, 'atomic-forge-port.json')
    process.env.STUDIO_ATOMIC_FORGE = CFG
    fs.writeFileSync(CFG, JSON.stringify({
      name: 'ATOMIC Team', host: 'git.example', sshUser: 'git', root: '/srv/atomic/git', port: 2222,
      repos: [{ name: 'studio' }]
    }))

    const built = forgeAtomic.atomicCloneUrl({ fullName: 'studio', private: true, cloneUrl: '', description: '' })
    if (built !== 'ssh://git@git.example:2222/srv/atomic/git/studio.git') throw new Error(`port lost: ${built}`)

    // Port 22 stays IMPLICIT, so the URL matches what a person would type by hand.
    fs.writeFileSync(CFG, JSON.stringify({ host: 'git.example', sshUser: 'git', root: '/srv/atomic/git', port: 22, repos: [{ name: 'studio' }] }))
    const plain = forgeAtomic.atomicCloneUrl({ fullName: 'studio', private: true, cloneUrl: '', description: '' })
    if (plain !== 'ssh://git@git.example/srv/atomic/git/studio.git') throw new Error(`default port should be implicit: ${plain}`)

    // A URL the SERVER supplied is used verbatim — never rebuilt from local config that may be
    // stale, and never stripped of a field this side does not model.
    const fromServer = forgeAtomic.atomicCloneUrl({
      fullName: 'studio', private: true, description: '',
      cloneUrl: 'ssh://git@real.internal:2223/data/repos/studio.git'
    })
    if (fromServer !== 'ssh://git@real.internal:2223/data/repos/studio.git') throw new Error(`the server's URL was overwritten: ${fromServer}`)

    // …and publishing predicts the same address the catalogue will later hand back.
    const prov = require(path.join(WORKDIR, 'main', 'git-provision.js'))
    const planned = prov.planRepo({ host: 'git.example', sshUser: 'git', root: '/srv/atomic/git', port: 2222 }, 'studio')
    if (planned.url !== 'ssh://git@git.example:2222/srv/atomic/git/studio.git') throw new Error(`publish and clone disagree: ${planned.url}`)
    return 'catalog, publish and a server-supplied URL all carry :2222; port 22 stays implicit'
  })

  await step('managed seat: repositories are created through the control plane, never over ssh', async () => {
    /**
     * THE INVARIANT. A managed ATOMIC server's shared `git` account has no interactive shell — sshd
     * runs a forced command that speaks three git verbs and refuses everything else. So
     * `ssh <host> git init --bare <dir>` cannot work there, and must not be MADE to work there:
     * relaxing the allow-list to accept it would hand every seat arbitrary remote execution to save
     * one REST call. This asserts the desktop takes the other route, with an ssh tripwire proving
     * it never even tried.
     */
    const prov = require(path.join(WORKDIR, 'main', 'git-provision.js'))
    const policyMod = require(path.join(WORKDIR, 'main', 'policy.js'))
    const identityMod = require(path.join(WORKDIR, 'main', 'identity.js'))
    const http = require('node:http')

    let seen = null
    const cp = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen = { url: req.url, method: req.method, auth: req.headers.authorization, body: body ? JSON.parse(body) : null }
        if (req.url === '/v1/me') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ name: 'alice', role: 'lead' }))
        if (req.url === '/v1/repos' && req.method === 'POST') {
          return res.writeHead(201, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ name: seen.body.name, url: `ssh://git@managed.internal:2222/srv/atomic/git/${seen.body.name}.git` }))
        }
        res.writeHead(404).end('{}')
      })
    })
    await new Promise((r) => cp.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${cp.address().port}`

    // An ssh binary that FAILS LOUDLY and leaves a trace. If provisioning touches ssh at all on a
    // managed seat, this test must not be able to pass.
    const TRIP = path.join(WORKDIR, 'managed-ssh-tripwire')
    const TRIPBIN = path.join(WORKDIR, 'managed-ssh.sh')
    fs.rmSync(TRIP, { force: true })
    fs.writeFileSync(TRIPBIN, `#!/bin/sh\ntouch ${JSON.stringify(TRIP)}\nexit 0\n`)
    fs.chmodSync(TRIPBIN, 0o755)

    const policyFile = path.join(WORKDIR, 'managed-provision-policy.json')
    fs.writeFileSync(policyFile, JSON.stringify({ idp: { issuer: 'https://idp.example', clientId: 'studio', controlPlane: base } }))
    const prevPolicy = process.env.STUDIO_ENTERPRISE_POLICY
    const prevSsh = process.env.STUDIO_SSH_BIN
    process.env.STUDIO_ENTERPRISE_POLICY = policyFile
    process.env.STUDIO_SSH_BIN = TRIPBIN
    try {
      policyMod.resetPolicyCache()
      if (!prov.isManaged()) throw new Error('fixture did not produce a managed seat')

      // The plan must SHOW the REST call, because the confirm screen shows `command` verbatim and
      // showing `git init --bare` on a server where that is refused would be a lie.
      const plan = prov.planRepo({ host: 'managed.internal', sshUser: 'git', root: '/srv/atomic/git', port: 2222 }, 'newthing')
      if (!plan.managed) throw new Error('planRepo did not mark a managed seat')
      if (/git init --bare/.test(plan.command)) throw new Error(`the confirm screen would promise an ssh command: ${plan.command}`)
      if (!/\/v1\/repos/.test(plan.command)) throw new Error(`the confirm screen does not name the real action: ${plan.command}`)

      // Not signed in: refused with something actionable, and still no ssh.
      const anon = await prov.createBareRepo({ host: 'managed.internal', sshUser: 'git', root: '/srv/atomic/git' }, 'newthing')
      if (anon.ok) throw new Error('a repository was created without a company sign-in')
      if (!/[Ss]ign in/.test(anon.error || '')) throw new Error(`unhelpful refusal: ${anon.error}`)

      // Now with a token. `ensureAccessToken` is module state; the suite has no IdP, so the token
      // is injected through the same seam sign-in uses.
      identityMod._setAccessTokenForTests('test-access-token')
      const made = await prov.createBareRepo({ host: 'managed.internal', sshUser: 'git', root: '/srv/atomic/git' }, 'newthing')
      if (!made.ok) throw new Error(`managed create failed: ${made.error}`)
      if (made.url !== 'ssh://git@managed.internal:2222/srv/atomic/git/newthing.git') {
        throw new Error(`the server's URL was not used verbatim: ${made.url}`)
      }
      if (seen.method !== 'POST' || seen.url !== '/v1/repos') throw new Error(`wrong call: ${seen.method} ${seen.url}`)
      if (seen.auth !== 'Bearer test-access-token') throw new Error('the create was not authenticated')

      if (fs.existsSync(TRIP)) throw new Error('a managed seat invoked ssh to create a repository')
    } finally {
      cp.close()
      identityMod._resetIdentityForTests()
      if (prevPolicy === undefined) delete process.env.STUDIO_ENTERPRISE_POLICY
      else process.env.STUDIO_ENTERPRISE_POLICY = prevPolicy
      if (prevSsh === undefined) delete process.env.STUDIO_SSH_BIN
      else process.env.STUDIO_SSH_BIN = prevSsh
      policyMod.resetPolicyCache()
    }
    return 'managed create goes to POST /v1/repos with a bearer token, uses the server’s URL verbatim, and never touches ssh'
  })

  // ---------- report ----------
  console.log(`\n\x1b[1m${results.length - failed}/${results.length} agent checks passed\x1b[0m\n`)
  if (failed) for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}\n    ${r.detail}`)
  fs.rmSync(WORKDIR, { recursive: true, force: true })
  app.exit(failed ? 1 : 0)
})
