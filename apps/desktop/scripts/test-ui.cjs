/* eslint-disable */
/**
 * ATOMIC Studio — automated GUI pass (the GUI_CHECKLIST.md steps, driven for real).
 *
 * Runs as Electron's MAIN entry, stubs only the native "open folder" dialog, then
 * loads the REAL built main process (out/main/index.js) and drives the REAL window:
 * real DOM clicks, real keystrokes (Monaco typing + Cmd/Ctrl+S), real dev server.
 *
 *   cd apps/desktop && npm run build && npx electron scripts/test-ui.cjs
 *
 * Screenshots land in $STUDIO_UI_SHOTS (default: ./.ui-test/shots).
 * Exit code 0 = all steps passed.
 */
const { app, BrowserWindow, dialog, webContents, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

// Enable the deterministic mock AI provider (registered at module load) so the
// agent steps run with zero API keys and zero cost.
process.env.STUDIO_MOCK_AI = '1'
// Deterministic media provider: real PNG bytes, no key, no credits, no network.
process.env.STUDIO_MOCK_MEDIA = '1'

// Fake docker CLI for the compose-buttons step.
const FAKE_DOCKER = path.join(__dirname, '..', '.ui-test', 'fake-docker.sh')
fs.mkdirSync(path.dirname(FAKE_DOCKER), { recursive: true })
fs.writeFileSync(FAKE_DOCKER, '#!/bin/sh\necho FAKE_DOCKER "$@"\n')
fs.chmodSync(FAKE_DOCKER, 0o755)
process.env.STUDIO_DOCKER_BIN = FAKE_DOCKER

// Fake ssh for the Company Server steps: ignores every flag and runs the final
// argument (the remote command) locally — the full chain minus the network.
const SSH_FIXTURE = path.join(__dirname, '..', '.ui-test', 'company-server')
const FAKE_SSH = path.join(__dirname, '..', '.ui-test', 'fake-ssh.sh')
fs.mkdirSync(path.join(SSH_FIXTURE, 'src'), { recursive: true })
fs.writeFileSync(path.join(SSH_FIXTURE, 'src', 'server.py'), 'print("company code")\n')
fs.writeFileSync(FAKE_SSH, '#!/bin/sh\n# -N = tunnel mode: just stay alive (tests kill us)\ncase " $* " in *" -N "*) exec sleep 30;; esac\nfor last; do :; done\nexec sh -c "$last"\n')
fs.chmodSync(FAKE_SSH, 0o755)
process.env.STUDIO_SSH_BIN = FAKE_SSH

// Self-hosted git server target for the Settings → Git server step: the fake ssh above runs
// its command locally, so `test -w` and `command -v git` answer truthfully about this real folder.
const SERVER_GIT_DIR = path.join(__dirname, '..', '.ui-test', 'gitserver')
fs.mkdirSync(SERVER_GIT_DIR, { recursive: true })

// Fake ollama for the air-gapped model catalog (installed: qwen2.5-coder).
// `pull` echoes one progress line then `exec sleep`s: the download STAYS running (so the
// Cancel button is observable) and the sleep is a LEAF process, so execStream's SIGKILL
// reaches it directly and `close` fires immediately on Cancel (no orphaned-pipe delay).
const FAKE_OLLAMA = path.join(__dirname, '..', '.ui-test', 'fake-ollama.sh')
fs.writeFileSync(FAKE_OLLAMA, '#!/bin/sh\ncase "$1" in\n  --version) echo "ollama version 0.1.0"; exit 0 ;;\n  list) printf "NAME\\tID\\tSIZE\\tMODIFIED\\nqwen2.5-coder:latest\\tabc\\t4.7 GB\\t1 day\\ncodellama:13b\\tdef\\t7.4 GB\\t2 days\\n"; exit 0 ;;\n  pull) echo "pulling manifest"; exec sleep 30 ;;\n  *) exit 1 ;;\nesac\n')
fs.chmodSync(FAKE_OLLAMA, 0o755)
process.env.STUDIO_OLLAMA_BIN = FAKE_OLLAMA

const REPO = path.resolve(__dirname, '../../..')
const PROJECT = path.join(REPO, 'examples/hello-vite')
const TARGET_REL = 'src/main.tsx'
const TARGET_ABS = path.join(PROJECT, TARGET_REL)
const VITE_CFG = path.join(PROJECT, 'vite.config.ts')
const SHOTS = process.env.STUDIO_UI_SHOTS || path.join(__dirname, '..', '.ui-test', 'shots')

// Scripted replies for the mock provider's agent run (see step 13).
const AGENT_SCRIPT = path.join(__dirname, '..', '.ui-test', 'agent-script.json')
process.env.STUDIO_MOCK_SCRIPT = AGENT_SCRIPT
function writeAgentScript(replies) {
  fs.mkdirSync(path.dirname(AGENT_SCRIPT), { recursive: true })
  fs.writeFileSync(AGENT_SCRIPT, JSON.stringify(replies))
  fs.rmSync(AGENT_SCRIPT + '.idx', { force: true })
}

// Isolate saved API keys / prefs so the test never touches the real app's data.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ui-test-')))

// The ONLY stub: the native folder picker (a modal OS dialog can't be automated).
// Successive "Open project…" clicks return successive fixtures (last one repeats).
const FIBER_PROJ = path.join(__dirname, '..', '.ui-test', 'fiber-fixture')
const PROJECT_QUEUE = [PROJECT, FIBER_PROJ, path.join(REPO, 'examples/hello-static')]
// pickFolder-style dialogs (New project location, clone destination) take from
// nextFolder first; project-open dialogs consume PROJECT_QUEUE.
const nextFolder = []
dialog.showOpenDialog = async () => ({
  canceled: false,
  filePaths: [
    nextFolder.length
      ? nextFolder.shift()
      : PROJECT_QUEUE.length > 1
        ? PROJECT_QUEUE.shift()
        : PROJECT_QUEUE[0]
  ]
})
// Save dialog (compliance export) → a temp file the test can read back.
const SAVE_TARGET = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-save-')), 'compliance.md')
dialog.showSaveDialog = async () => ({ canceled: false, filePath: SAVE_TARGET })

// ---------------------------------------------------------------- diagnostics
const consoleErrors = []
const crashes = []

// ---------------------------------------------------------------- test plumbing
const results = []
let failed = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failed++
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
  console.log(`  ${tag}  ${name}${detail ? `\n          ↳ ${detail}` : ''}`)
}

/** Assert helper: runs fn, records pass/fail, never throws. */
async function step(name, fn) {
  try {
    const detail = await fn()
    record(name, true, detail || '')
    return true
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err))
    return false
  }
}

let win
const js = (code) => win.webContents.executeJavaScript(code, true)

/** Poll until truthy. `expr` is a JS string evaluated in the window, or a Node-side function. */
async function waitFor(expr, { timeout = 20000, every = 150, what = String(expr) } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    try {
      last = typeof expr === 'function' ? await expr() : await js(expr)
      if (last) return last
    } catch (e) {
      last = `eval error: ${e.message}`
    }
    await sleep(every)
  }
  throw new Error(`timed out after ${timeout}ms waiting for: ${what} (last=${JSON.stringify(last)})`)
}

/**
 * The Explorer is one sidebar VIEW among several since 2026-09-02 (Source Control took the slot
 * VS Code gives it). A stray keystroke or click that switches the view mid-suite used to be
 * harmless — the Git drawer lived in the bottom panel — and now hides the file tree. A person
 * would click the Explorer icon and carry on; so does every tree click here.
 */
async function ensureExplorer() {
  if (await js(`!!document.querySelector('.ex-tree')`)) return
  await js(`(() => { const b = document.querySelector('.activity-bar .ab-btn'); if (b && !b.classList.contains('active')) b.click(); return true })()`)
  await waitFor(`!!document.querySelector('.ex-tree')`, { timeout: 8000, what: 'the Explorer view' })
}

/** Click the first element matching `sel` whose trimmed text contains `text`. */
const clickByText = async (sel, text) => {
  if (sel.includes('.ex-row')) await ensureExplorer()
  return clickByTextNow(sel, text)
}
const clickByTextNow = (sel, text) =>
  js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (!el) return 'NOT_FOUND';
    if (el.disabled) return 'DISABLED';
    el.click();
    return 'OK';
  })()`).then((r) => {
    if (r !== 'OK') throw new Error(`click "${text}" (${sel}) → ${r}`)
    return r
  })

/**
 * Click the first element matching `sel` whose ACCESSIBLE NAME contains `name` (aria-label, else
 * title, else text). Icon-only controls are drawn SVG now, so they carry no text to match on —
 * and their accessible name is a stronger contract than the codepoint they used to render.
 */
const clickByLabel = (sel, name) =>
  js(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})]
      .find(e => ((e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '')).includes(${JSON.stringify(name)}));
    if (!el) return 'NOT_FOUND';
    if (el.disabled) return 'DISABLED';
    el.click();
    return 'OK';
  })()`).then((r) => {
    if (r !== 'OK') throw new Error(`click [${name}] (${sel}) → ${r}`)
    return r
  })

const clickSel = (sel) =>
  js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'NOT_FOUND'; el.click(); return 'OK' })()`).then((r) => {
    if (r !== 'OK') throw new Error(`click ${sel} → ${r}`)
  })

const textOf = (sel) =>
  js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
    return el ? (el.textContent || '').trim() : null })()`)

const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`)

/** Real keystrokes into the focused element (Monaco's hidden textarea). */
function typeText(str) {
  for (const ch of str) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }
}

/** The real Cmd+S / Ctrl+S the user presses. */
async function saveShortcut() {
  const mod = process.platform === 'darwin' ? 'meta' : 'control'
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: [mod] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: [mod] })
  await sleep(500)
}

/** Open a tab of the unified bottom panel (opens the panel via Tools first if needed). */
async function openPanelTab(label) {
  const open = await js(`!!document.querySelector('.panel')`)
  if (!open) await clickByLabel('.topbar-actions .btn', 'Tools')
  await waitFor(`!!document.querySelector('.panel-tabs')`, { what: 'bottom panel' })
  await clickByText('.panel-tabs .seg-btn', label)
}

/** Open the Source Control view in the LEFT sidebar (an activity-bar view since 2026-09-02, not a panel tab). */
async function openScm() {
  const open = await js(`!!document.querySelector('.left .scm')`)
  if (!open) await clickByLabel('.activity-bar .ab-btn', 'Source Control')
  await waitFor(`!!document.querySelector('.left .scm')`, { what: 'the Source Control sidebar view', timeout: 15000 })
}

/** Real keystrokes with verify-and-retry: focus can be lost under machine load,
 * silently dropping typed characters. Types, verifies the buffer, retries. */
async function typeVerified(text) {
  const probe = text.trim()
  for (let attempt = 1; attempt <= 3; attempt++) {
    win.webContents.focus()
    await js(`window.__studioEditor?.focus(), 'ok'`)
    await sleep(250)
    typeText(text)
    try {
      await waitFor(
        `window.__studioEditor?.getModel()?.getValue()?.includes(${JSON.stringify(probe)})`,
        { timeout: 2500, what: `typed text in buffer (attempt ${attempt})` }
      )
      return
    } catch {
      /* focus lost mid-type — refocus and retry */
    }
  }
  throw new Error(`typed text never reached the editor buffer: ${JSON.stringify(text)}`)
}

/** Real keystrokes with a modifier, for the steps that drive the app by keyboard. */
const key = async (code, modifiers = []) => {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers })
  await sleep(120)
}
const MOD = process.platform === 'darwin' ? 'meta' : 'control'

/**
 * Open a project, answering the Wave 21 unsaved-work seatbelt if it appears.
 *
 * Switching projects closes every open tab, so a buffer with unsaved typing stops the switch and
 * asks first — correct product behaviour, and these steps are the first in the suite to switch
 * projects at all. Any stray typing here belongs to an EARLIER step that failed and left it
 * behind, so it is discarded (the suite restores the fixture files at the end regardless); a
 * "Save first" would write a failed step's half-typed marker into the developer's real file.
 * The guard queues one prompt per dirty tab, hence the loop.
 */
const openProjectAt = async (dir) => {
  // Close every open tab FIRST, discarding unsaved typing. Depending on the seatbelt dialog to
  // appear during the switch is fragile: when an earlier step fails mid-edit the editor can be
  // left dirty in ways that stop the switch before the dialog is even rendered. Closing tabs is
  // deterministic, uses the suite's existing helper, and is what a careful person does anyway.
  await closeTabsDiscarding()
  nextFolder.push(dir)
  const name = path.basename(dir)
  await clickByText('.topbar-actions .btn', 'Open project')
  // The dialog is rendered a tick AFTER the click, so a single "is it there yet" check races it.
  // Poll for either outcome instead: answer the guard whenever it appears (it queues one prompt
  // per dirty tab), and finish when the new project's name reaches the command centre.
  await waitFor(
    async () => {
      if (await js(`!!document.querySelector('.unsaved-guard')`)) {
        await js(`(() => { const b = [...document.querySelectorAll('.unsaved-guard .btn')].find(b => /Discard/.test(b.textContent)); if (b) b.click(); return 'OK' })()`)
        return false
      }
      return js(`(document.querySelector('.command-center, .topbar')?.textContent || '').includes(${JSON.stringify(name)})`)
    },
    { timeout: 25000, what: `project ${name} to open (discarding any unsaved typing an earlier step left behind)` }
  )
}

/** Remove OUR uniquely-named test file from the real Trash so the suite leaves no residue.
 *  Exact-name match against a pid-stamped name, so it can never touch one of the user's own files. */
function purgeFromTrash(uniqueName) {
  if (process.platform !== 'darwin') return // only macOS exposes the bin as a plain folder
  try {
    const t = path.join(require('node:os').homedir(), '.Trash', uniqueName)
    if (fs.existsSync(t) && /^w21-[\w-]+-\d+\.txt$/.test(uniqueName)) fs.rmSync(t, { force: true })
  } catch { /* best effort — never fail a test over cleanup */ }
}

/**
 * Insight is a WORKSPACE view now, not a bottom-panel tab (2026-09-03) — so it is opened through
 * its real command-palette entry and then navigated by destination, exactly as a user does. The
 * old `openPanelTab('Insight')` had no equivalent: there is no Insight tab in the panel any more.
 */
async function openInsight(dest = 'Overview') {
  if (!(await js(`!!document.querySelector('.iv')`))) {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true })), 'ok'`)
    await waitFor(`!!document.querySelector('.palette .palette-input')`, { what: 'the command palette' })
    await js(`(() => { const el = document.querySelector('.palette .palette-input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'Insight');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
    await waitFor(`!!document.querySelector('.palette .palette-item')`, { what: 'the Insight palette entry' })
    await js(`document.querySelector('.palette .palette-item').click(), 'ok'`)
    await waitFor(`!!document.querySelector('.iv')`, { timeout: 20000, what: 'the Insight workspace view' })
  }
  const id = { Overview: 'overview', Review: 'review', 'Code Map': 'codemap', Memory: 'memory' }[dest]
  await js(`(() => { const b = document.getElementById('iv-tab-${id}'); if (b) b.click(); return 'OK' })()`)
  await waitFor(`document.querySelector('.iv-tab.active')?.textContent === ${JSON.stringify(dest)}`, { what: `the ${dest} destination` })
  await sleep(250)
}

/** Run ONE of the five project-review checks by name and wait for it to leave "Checking…". */
async function runInsightCheck(name) {
  await openInsight('Review')
  await js(`(() => { const row = [...document.querySelectorAll('.iv-check')]
      .find(c => c.querySelector('.iv-check-name')?.textContent === ${JSON.stringify(name)});
    if (!row) return 'NO_ROW'; row.querySelector('.iv-check-head .btn').click(); return 'OK' })()`)
  await waitFor(`(() => { const row = [...document.querySelectorAll('.iv-check')]
      .find(c => c.querySelector('.iv-check-name')?.textContent === ${JSON.stringify(name)});
    const st = row?.querySelector('.iv-check-status')?.textContent || '';
    return st !== '' && st !== 'Checking…' && st !== 'Not checked' })()`, { timeout: 30000, what: `the ${name} check to finish` })
}

/** Open one of Code Map's / Memory's collapsed advanced sections by its heading. */
async function openInsightSection(title) {
  await js(`(() => { const b = [...document.querySelectorAll('.iv-section-btn')]
      .find(x => x.querySelector('.iv-section-title')?.textContent === ${JSON.stringify(title)});
    if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return 'OK' })()`)
  await waitFor(`[...document.querySelectorAll('.iv-section-btn')].some(x => x.querySelector('.iv-section-title')?.textContent === ${JSON.stringify(title)} && x.getAttribute('aria-expanded') === 'true')`, { what: `the "${title}" section to open` })
  await sleep(300)
}

/** Wave 21: closing a DIRTY tab now asks first (unsavedGuard). Steps that deliberately throw away an
 *  unsaved buffer must answer that question — this closes, then discards if the seatbelt appears. */
async function closeTabsDiscarding(selector = '.tab .tab-close') {
  const sel = JSON.stringify(selector)
  for (let i = 0; i < 12; i++) {
    const clicked = await js(`(() => { const x = document.querySelector(${sel}); if (!x) return 'NONE'; x.click(); return 'OK' })()`)
    if (clicked === 'NONE') break
    await sleep(150)
    if (await js(`!!document.querySelector('.unsaved-guard')`)) {
      await js(`(() => { const b = [...document.querySelectorAll('.unsaved-guard .btn')].find(b => /Discard/.test(b.textContent)); if (b) b.click(); return 'OK' })()`)
      await sleep(150)
    }
  }
}

let shotN = 0
async function shot(label) {
  try {
    const img = await win.webContents.capturePage()
    const file = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${label}.png`)
    fs.writeFileSync(file, img.toPNG())
    return file
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- the run
async function run() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const originalSource = fs.readFileSync(TARGET_ABS, 'utf8')
  const originalCfg = fs.readFileSync(VITE_CFG, 'utf8')

  console.log('\n\x1b[1mATOMIC Studio — automated GUI pass\x1b[0m')
  console.log(`  project: ${PROJECT}`)
  console.log(`  shots:   ${SHOTS}\n`)

  // --- 0. boot -------------------------------------------------------------
  await step('0. App window opens and renders the shell, panel already open', async () => {
    await waitFor(`!!document.querySelector('.topbar .brand')`, { what: 'topbar' })
    const brand = await textOf('.topbar .brand')
    if (!brand.includes('ATOMIC Studio')) throw new Error(`brand text = ${brand}`)
    // Checked HERE, at first boot, because it is only true before anything has closed it: the
    // bottom panel starts open (VS Code does) and stays open until the user closes it with ×.
    // Later steps close it deliberately, and that choice is remembered — so this is the one
    // moment in the run where "default" means anything.
    await waitFor(`!!document.querySelector('.panel')`, { timeout: 8000, what: 'panel open on first launch' })
    if (!(await js(`!!document.querySelector('.pane-resizer')`))) throw new Error('the panel must have a drag handle to resize it')
    await shot('boot')
    return `${brand} · panel open by default, with a drag handle`
  })

  await step('0b. Boots with no renderer console errors', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 3).join(' | '))
    return 'clean console'
  })

  await step('0c. Providers loaded from main process', async () => {
    // The panel auto-opens when the selected provider has no saved key, so toggle
    // only if it is currently closed.
    const open = () => js(`!!document.querySelector('.modal .settings')`)
    if (!(await open())) await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.modal .settings')`, { what: 'settings panel' })
    const n = await js(`document.querySelectorAll('.modal .settings select option').length`)
    await shot('settings')
    if (await open()) await clickByLabel('.topbar-actions .btn', 'Settings') // leave it closed
    if (!n) throw new Error('no providers in settings dropdown')
    return `${n} providers`
  })

  await step('0d. Settings: tabbed control center with an API Keys page', async () => {
    if (!(await js(`!!document.querySelector('.modal .settings')`))) await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.settings-tabs')`, { what: 'settings tabs' })
    await clickByText('.settings-tabs .seg-btn', 'API Keys')
    const rows = await waitFor(`document.querySelectorAll('.key-row').length`, { what: 'key rows' })
    if (rows < 7) throw new Error(`only ${rows} key rows`)
    // Save a GitHub token through the page and see the ✓.
    await js(`(() => {
      const row = [...document.querySelectorAll('.key-row')].find(r => r.textContent.includes('GitHub'));
      const inp = row.querySelector('input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, 'ghp_test_token');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK' })()`)
    await js(`(() => {
      const row = [...document.querySelectorAll('.key-row')].find(r => r.textContent.includes('GitHub'));
      row.querySelector('button').click(); return 'OK' })()`)
    await waitFor(`[...document.querySelectorAll('.key-row')].find(r => r.textContent.includes('GitHub'))?.querySelector('.key-ok') != null`, { what: 'saved ✓' })
    await clickByText('.settings-tabs .seg-btn', 'Editor')
    await waitFor(`document.querySelectorAll('.settings-section .settings-toggle').length >= 2`, { what: 'editor prefs' })
    await shot('settings-keys')
    await clickByLabel('.topbar-actions .btn', 'Settings') // close
    return `${rows} key rows · GitHub token saved ✓ · Editor prefs tab`
  })

  const NP_PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-npnew-'))
  await step('0e. "New project…" scaffolds a template, opens it, and the Agent tab opens the dock', async () => {
    // The launcher lives in the center WelcomeScreen now (the sidebar's no-project state keeps
    // ONE button on purpose — see the comment beside .projects-home in App.tsx), so drive the
    // real control a user sees. Reshaped 2026-09-03: Start is three intent cards, so "New Project"
    // is now the "Start something new" card rather than a list row.
    await clickByText('.welcome-card', 'Start something new')
    await waitFor(`!!document.querySelector('.np-modal')`, { what: 'new-project modal' })
    await js(`(() => {
      const el = document.querySelector('.np-modal input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'demo-site');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
    nextFolder.push(NP_PARENT)
    await clickByText('.np-modal .btn', 'Choose location & create')
    await waitFor(`(document.querySelector('.left')?.textContent || '').includes('demo-site')`, {
      timeout: 15000,
      what: 'new project opened'
    })
    if (!fs.existsSync(path.join(NP_PARENT, 'demo-site', 'index.html'))) throw new Error('template not scaffolded')
    await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === 'index.html')`, { what: 'tree shows the file' })
    /* The dock starts CLOSED on a fresh profile (changed 2026-09-03) and the Agent tab on the
       right edge is the way in — so assert both halves: nothing is docked, the tab is there and
       says what it opens, and clicking it opens the panel. A default that cannot be reversed by
       one visible control would just be a hidden feature. */
    if (await js(`!!document.querySelector('.agent-panel')`)) throw new Error('agent dock should start CLOSED on a fresh profile')
    const tabLabel = await js(`document.querySelector('.right-reopen-tab')?.textContent?.trim() || ''`)
    if (!/Agent/.test(tabLabel)) throw new Error(`the Agent tab is missing or unlabelled (text = "${tabLabel}")`)
    await clickSel('.right-reopen-tab')
    await waitFor(`!!document.querySelector('.agent-panel')`, { what: 'the Agent tab to open the dock' })
    const recents = await js(`localStorage.getItem('studio.recent') || ''`)
    if (!recents.includes('demo-site')) throw new Error('recents not updated')
    await shot('new-project')
    return 'scaffolded + opened + in recents + dock starts closed, Agent tab opens it'
  })

  // --- 1. open project -----------------------------------------------------
  await step('1. "Open project…" loads the project and shows the file tree', async () => {
    await clickByText('.topbar-actions .btn', 'Open project')
    // Wait for THIS project, not merely for "some rows": opening is now pick → (unsaved-work guard) →
    // commit, so the previous project's tree is still on screen for a moment.
    await waitFor(`(document.querySelector('.left')?.textContent || '').includes('hello-vite')`, { what: 'hello-vite opened' })
    await waitFor(`document.querySelectorAll('.ex-row').length > 0`, { what: 'file tree rows' })
    const header = await textOf('.left')
    const rows = await count('.ex-row')
    await shot('project-open')
    if (!header.includes('hello-vite')) throw new Error(`left header = ${header}`)
    return `${rows} root entries, header "${header}"`
  })

  await step('1b. Framework detected and shown', async () => {
    const fw = await textOf('.left-fw')
    if (fw !== 'vite') throw new Error(`framework badge = ${fw}`)
    return fw
  })

  await step('1c. The Explorer hides what VS Code hides — and nothing else', async () => {
    // This assertion was INVERTED on 2026-09-02. It used to demand that `node_modules` and `dist`
    // be hidden, which is a SCANNER's exclusion list applied to a file explorer: a folder you
    // cannot see is a folder you cannot open, and every other IDE shows them. The Explorer now
    // hides exactly VS Code's defaults — version-control metadata and OS droppings — while the
    // stricter list still governs indexing, security scans and delete previews.
    const names = await js(`[...document.querySelectorAll('.ex-name')].map(e=>e.textContent)`)
    const leaked = names.filter((n) => ['.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db'].includes(n))
    if (leaked.length) throw new Error(`the Explorer must hide ${leaked.join(', ')}`)
    if (!names.includes('node_modules')) throw new Error('node_modules must be listed, like every other IDE')
    return `${names.length} entries · node_modules listed · .git and OS droppings hidden`
  })

  // --- 2. expand + open a file --------------------------------------------
  await step('1d. Explorer: VS Code geometry, real file-type icons, and header actions', async () => {
    // The 2026-09-02 rebuild. Geometry first: 22px rows, a 16px icon slot, and the uppercase
    // view title — the measurements a developer's hands already know.
    await ensureExplorer()
    await waitFor(`document.querySelectorAll('.ex-row').length > 2`, { what: 'explorer rows' })
    const geom = await js(`(() => {
      const rows = [...document.querySelectorAll('.ex-row')].slice(0, 6);
      const icon = document.querySelector('.ex-row .file-icon');
      const cs = icon ? getComputedStyle(icon) : null;
      return JSON.stringify({
        heights: [...new Set(rows.map(r => Math.round(r.getBoundingClientRect().height)))],
        title: (document.querySelector('.left-title')?.textContent || ''),
        titleTransform: getComputedStyle(document.querySelector('.left-title')).textTransform,
        iconW: cs ? Math.round(parseFloat(cs.width)) : 0,
        iconFont: cs ? cs.fontFamily : '',
        radius: getComputedStyle(rows[0]).borderRadius,
        transform: cs ? cs.transform : ''
      }) })()`)
    const g = JSON.parse(geom)
    if (g.heights.length !== 1 || g.heights[0] !== 22) throw new Error(`rows must all be 22px, got ${g.heights}`)
    if (g.iconW !== 16) throw new Error(`the file-icon slot must be a fixed 16px, got ${g.iconW}`)
    if (!/seti/i.test(g.iconFont)) throw new Error(`file icons must come from the bundled theme font, got "${g.iconFont}"`)
    // Sharpness: the glyph is drawn at its own size, never scaled by a transform.
    if (g.transform && g.transform !== 'none') throw new Error(`file icons must not be transformed: ${g.transform}`)
    if (g.radius !== '0px') throw new Error(`tree rows are square chrome, got radius ${g.radius}`)
    if (!/explorer/i.test(g.title)) throw new Error(`view title is "${g.title}"`)

    // The four header actions, by accessible name, present and quiet until hover.
    const actions = await js(`[...document.querySelectorAll('.sb-action')].map(b => b.getAttribute('aria-label')).join('|')`)
    for (const want of ['New File', 'New Folder', 'Refresh Explorer', 'Collapse Folders in Explorer']) {
      if (!actions.includes(want)) throw new Error(`no "${want}" header action: ${actions}`)
    }
    const resting = await js(`getComputedStyle(document.querySelector('.sb-section-actions .sb-action')).opacity`)
    if (resting !== '0') throw new Error(`header actions must be quiet at rest, opacity=${resting}`)
    await shot('explorer')
    return `rows 22px · icon slot 16px from the ${g.iconFont} theme font, untransformed · square · title "${g.title.trim()}" · 4 header actions, hidden at rest`
  })

  await step('1e. Explorer: every everyday file type gets its OWN themed icon, not one generic glyph', async () => {
    // The old tree mapped thirty types onto nine product glyphs, so Go, Rust and Java were the
    // same outline. This asserts the theme actually distinguishes them, by codepoint AND colour.
    const { execSync: x } = require('node:child_process')
    const FX = path.join(__dirname, '..', '.ui-test', 'icon-fixture')
    fs.rmSync(FX, { recursive: true, force: true })
    fs.mkdirSync(FX, { recursive: true })
    const names = ['app.js', 'main.ts', 'App.tsx', 'package.json', 'style.css', 'notes.md', 'main.py', 'App.vue', 'App.svelte', 'Dockerfile', '.gitignore', 'logo.png']
    for (const n of names) fs.writeFileSync(path.join(FX, n), n === 'package.json' ? '{}' : `// ${n}\n`)
    try {
      await openProjectAt(FX)
      await ensureExplorer()
      await waitFor(`document.querySelectorAll('.ex-row').length >= ${names.length}`, { timeout: 15000, what: 'the icon fixture rows' })
      const seen = JSON.parse(await js(`(() => {
        const out = {};
        for (const r of document.querySelectorAll('.ex-row')) {
          const name = r.querySelector('.ex-name')?.textContent;
          const i = r.querySelector('.file-icon');
          if (!name || !i) continue;
          out[name] = { id: i.getAttribute('data-icon-id'), color: getComputedStyle(i).color, char: i.textContent.codePointAt(0) || 0 };
        }
        return JSON.stringify(out) })()`))
      for (const n of names) {
        if (!seen[n]) throw new Error(`no row for ${n}`)
        if (!seen[n].id || !seen[n].char) throw new Error(`${n} has no themed glyph: ${JSON.stringify(seen[n])}`)
      }
      // JavaScript must be the theme's javascript icon, not a shared code page — the specific
      // failure the rebuild was asked to fix.
      if (seen['app.js'].id !== '_javascript') throw new Error(`app.js resolved to ${seen['app.js'].id}`)
      if (seen['main.ts'].id !== '_typescript') throw new Error(`main.ts resolved to ${seen['main.ts'].id}`)
      if (seen['App.tsx'].id !== '_react') throw new Error(`App.tsx resolved to ${seen['App.tsx'].id}`)
      if (seen['package.json'].id !== '_json') throw new Error(`package.json resolved to ${seen['package.json'].id}`)
      if (seen['app.js'].id === seen['main.ts'].id) throw new Error('JS and TS must not share one glyph')
      // Distinct codepoints AND distinct colours across the set — the proof it is a real theme.
      const chars = new Set(names.map((n) => seen[n].char))
      const colors = new Set(names.map((n) => seen[n].color))
      if (chars.size < 8) throw new Error(`only ${chars.size} distinct glyphs across ${names.length} types`)
      if (colors.size < 4) throw new Error(`only ${colors.size} distinct colours across ${names.length} types`)
      await shot('explorer-icons')
      return `${names.length} types → ${chars.size} distinct glyphs in ${colors.size} colours; js=_javascript, ts=_typescript, tsx=_react, json=_json`
    } finally {
      await openProjectAt(PROJECT)
      fs.rmSync(FX, { recursive: true, force: true })
    }
  })

  await step('1f. Explorer: keyboard navigation, inline create and F2 rename, and Refresh keeps folders open', async () => {
    await ensureExplorer()
    await waitFor(`document.querySelectorAll('.ex-row').length > 2`, { what: 'rows' })
    const NAME = `ex-kbd-${process.pid}.txt`
    const RENAMED = `ex-kbd-renamed-${process.pid}.txt`
    // New File creates at the SELECTED location, as in VS Code — this step selects `src` first,
    // so that is where the file must land.
    const abs = path.join(PROJECT, 'src', NAME)
    const renamedAbs = path.join(PROJECT, 'src', RENAMED)
    fs.rmSync(abs, { force: true })
    fs.rmSync(renamedAbs, { force: true })
    const setValue = (sel, value) =>
      js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'NO_INPUT';
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 'OK' })()`)
    try {
      // Keyboard: focus the list, Home, then type-to-jump — VS Code's list type-navigation.
      await js(`document.querySelector('.ex-scroll').focus(); true`)
      await key('Home')
      await key('Down')
      if (!(await js(`document.activeElement?.getAttribute('data-key') || ''`))) throw new Error('ArrowDown focused nothing')
      typeText('src')
      await sleep(400)
      const typed = await js(`document.activeElement?.getAttribute('data-key') || ''`)
      if (typed !== 'src') throw new Error(`type-ahead landed on "${typed}", expected src`)

      // → expands, ← collapses, → again re-opens.
      await key('Right')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === 'main.tsx')`, { what: '→ to expand src' })
      const openRows = await js(`document.querySelectorAll('.ex-row').length`)
      await key('Left')
      await waitFor(`![...document.querySelectorAll('.ex-name')].some(e => e.textContent === 'main.tsx')`, { what: '← to collapse src' })
      await key('Right')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === 'main.tsx')`, { what: 'src open again' })

      // Refresh must KEEP the open folder and not blank the tree.
      await clickByLabel('.sb-action', 'Refresh Explorer')
      await sleep(800)
      if (!(await js(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === 'main.tsx')`))) {
        throw new Error('Refresh collapsed the tree — expansion must survive it')
      }

      // Inline create, at the selected folder.
      await clickByLabel('.sb-action', 'New File')
      await waitFor(`!!document.querySelector('.ex-creating input')`, { what: 'the inline create row' })
      if ((await setValue('.ex-creating input', NAME)) !== 'OK') throw new Error('no create input')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === ${JSON.stringify(NAME)})`, { timeout: 12000, what: 'the created file in the tree' })
      if (!fs.existsSync(abs)) throw new Error(`inline create did not reach disk at ${abs}`)

      // F2 renames the focused row in place.
      await js(`(() => { const r = [...document.querySelectorAll('.ex-row')].find(x => x.querySelector('.ex-name')?.textContent === ${JSON.stringify(NAME)});
        if (!r) return 'NO_ROW'; r.click(); return 'OK' })()`)
      await sleep(300)
      // Clicking a file row OPENS it, and Monaco takes DOM focus as it mounts — sometimes AFTER
      // this line, which used to steal the F2 away from the tree and fail the step at random.
      // Re-assert list focus until it sticks, then press. (F2 inside the editor is the editor's
      // own rename, so the key genuinely must not reach the Explorer unless the Explorer has focus.)
      await waitFor(
        async () => {
          await js(`(() => { const s = document.querySelector('.ex-scroll'); if (s && !s.contains(document.activeElement)) s.focus(); return 'OK' })()`)
          return js(`!!document.querySelector('.ex-scroll')?.contains(document.activeElement)`)
        },
        { timeout: 10000, what: 'keyboard focus back in the Explorer list' }
      )
      await key('F2')
      await waitFor(`!!document.querySelector('.ex-rename')`, { timeout: 10000, what: 'the inline rename input (F2)' })
      if ((await setValue('.ex-rename', RENAMED)) !== 'OK') throw new Error('no rename input')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === ${JSON.stringify(RENAMED)})`, { timeout: 12000, what: 'the renamed row' })
      if (!fs.existsSync(renamedAbs)) throw new Error('rename did not reach disk')
      return `↑↓ move · type-ahead jumped to src · →/← expand and collapse (${openRows} rows open) · Refresh kept it open · inline create + F2 rename landed in src/`
    } finally {
      fs.rmSync(abs, { force: true })
      fs.rmSync(renamedAbs, { force: true })
      // Leave the workspace as this step found it: close the tab the create opened, and fold `src`
      // back shut — later steps expand it themselves and would toggle it SHUT instead.
      await closeTabsDiscarding()
      await js(`(() => { const r = [...document.querySelectorAll('.ex-row')].find(x => x.querySelector('.ex-name')?.textContent === 'src');
        if (r && r.getAttribute('aria-expanded') === 'true') r.click(); return true })()`)
      await sleep(400)
    }
  })

  await step('1g. Explorer: node_modules is listed and never pre-walked; a 2,000-file folder stays windowed', async () => {
    // The exclusion policy first, on the real fixture: `node_modules` must be LISTED (the old tree
    // hid it, and a folder you cannot see is a folder you cannot open) and must contribute no rows
    // until it is opened.
    await ensureExplorer()
    await waitFor(`document.querySelectorAll('.ex-row').length > 2`, { what: 'rows' })
    const nm = await js(`(() => { const r = [...document.querySelectorAll('.ex-row')].find(x => x.querySelector('.ex-name')?.textContent === 'node_modules');
      return r ? JSON.stringify({ expanded: r.getAttribute('aria-expanded'), depth: r.getAttribute('aria-level') }) : '' })()`)
    if (!nm) throw new Error('node_modules must be listed in the Explorer')
    if (JSON.parse(nm).expanded !== 'false') throw new Error('node_modules must start COLLAPSED — never pre-walked')

    // Windowing, on a folder that actually has enough entries to need it.
    const BIG = path.join(__dirname, '..', '.ui-test', 'big-tree')
    fs.rmSync(BIG, { recursive: true, force: true })
    fs.mkdirSync(path.join(BIG, 'many'), { recursive: true })
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(BIG, 'many', `f${String(i).padStart(4, '0')}.ts`), `export const x = ${i}\n`)
    try {
      await openProjectAt(BIG)
      await ensureExplorer()
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === 'many')`, { timeout: 20000, what: 'the big fixture root' })
      const rootMs = JSON.parse(await js(`JSON.stringify(window.__explorerStats || {})`)).rootMs
      const t0 = Date.now()
      await js(`(() => { const r = [...document.querySelectorAll('.ex-row')].find(x => x.querySelector('.ex-name')?.textContent === 'many'); r.click(); return true })()`)
      await waitFor(`document.querySelectorAll('.ex-row').length > 5`, { timeout: 25000, what: '2,000 files to project' })
      const openMs = Date.now() - t0
      const st = JSON.parse(await js(`JSON.stringify(window.__explorerStats || {})`))
      const mounted = await js(`document.querySelectorAll('.ex-row').length`)
      const firstName = await js(`document.querySelector('.ex-name')?.textContent || ''`)
      if (st.rows < 2000) throw new Error(`expected 2,000+ rows projected, got ${st.rows}`)
      if (mounted > 80) throw new Error(`${mounted} rows mounted for ${st.rows} projected — the tree is not windowed`)
      // Scroll to the very end: the last row is reachable and the DOM is still a window.
      await js(`(() => { const l = document.querySelector('.ex-scroll'); l.scrollTop = l.scrollHeight; return true })()`)
      await sleep(500)
      const atEnd = await js(`document.querySelectorAll('.ex-row').length`)
      if (atEnd > 80) throw new Error(`${atEnd} rows mounted after scrolling to the end`)
      // The scroll EXTENT must account for every projected row, not just the mounted ones — that
      // is the property that makes a windowed list navigable rather than silently truncated.
      const scroll = JSON.parse(await js(`(() => { const l = document.querySelector('.ex-scroll');
        return JSON.stringify({ top: Math.round(l.scrollTop), h: Math.round(l.scrollHeight), view: Math.round(l.clientHeight) }) })()`))
      if (scroll.h < st.rows * 20) throw new Error(`scroll height ${scroll.h} cannot hold ${st.rows} rows`)
      if (scroll.top <= scroll.view) throw new Error(`the list did not scroll (top ${scroll.top}, viewport ${scroll.view})`)
      await shot('explorer-big-tree')
      return `node_modules listed + collapsed · 2,000 files projected in ${openMs}ms (root ${rootMs}ms) → ${st.rows} rows, ${mounted} mounted (${atEnd} at the end)`
    } finally {
      await openProjectAt(PROJECT)
      fs.rmSync(BIG, { recursive: true, force: true })
    }
  })

  await step('2. Expanding "src" lazily loads its children', async () => {
    await clickByText('.ex-row', 'src')
    await waitFor(
      `[...document.querySelectorAll('.ex-name')].some(e=>e.textContent==='main.tsx')`,
      { what: 'main.tsx in tree' }
    )
    await shot('tree-expanded')
    return 'src → main.tsx visible'
  })

  await step('3. Clicking main.tsx opens a tab with the Monaco editor', async () => {
    await clickByText('.ex-row', 'main.tsx')
    await waitFor(`!!document.querySelector('.monaco-editor')`, { timeout: 30000, what: 'monaco mounted' })
    await waitFor(`!!document.querySelector('.tab .tab-name')`, { what: 'editor tab' })
    const tab = await textOf('.tab .tab-name')
    // Monaco must render the real file text, not an empty buffer.
    await waitFor(
      `(document.querySelector('.monaco-editor .view-lines')?.textContent || '').includes('React')`,
      { timeout: 15000, what: 'file contents rendered in editor' }
    )
    await shot('editor-open')
    if (tab !== 'main.tsx') throw new Error(`tab name = ${tab}`)
    return 'tab "main.tsx" + Monaco showing source'
  })

  await step('3b. Monaco is offline (no CDN request, worker started)', async () => {
    if (consoleErrors.some((e) => /monaco|worker|cdn|jsdelivr|unpkg/i.test(e)))
      throw new Error(consoleErrors.find((e) => /monaco|worker|cdn/i.test(e)))
    return 'no monaco/worker/CDN errors'
  })

  // --- 4. type + save ------------------------------------------------------
  const MARKER = `UI_TEST_${Date.now()}`
  await step('4. Typing in the editor marks the tab dirty (● dot)', async () => {
    win.focus()
    // Real keystrokes, self-healing against focus loss under load.
    await typeVerified(`// ${MARKER}\n`)
    await waitFor(`!!document.querySelector('.tab .tab-dot')`, { timeout: 8000, what: 'dirty dot' })
    const shown = await waitFor(
      `(document.querySelector('.monaco-editor .view-lines')?.textContent || '').includes(${JSON.stringify(MARKER)})`,
      { timeout: 8000, what: 'typed text visible in editor' }
    )
    await shot('typed-dirty')
    return `typed "// ${MARKER}", dirty dot shown (${shown})`
  })

  await step('5. Cmd/Ctrl+S saves to disk, clears the dot, confirms in the UI', async () => {
    await saveShortcut()
    await waitFor(`!document.querySelector('.tab .tab-dot')`, { timeout: 8000, what: 'dirty dot cleared' })
    const msg = await waitFor(`document.querySelector('.ok-box')?.textContent || ''`, {
      timeout: 8000,
      what: 'save confirmation'
    })
    const onDisk = fs.readFileSync(TARGET_ABS, 'utf8')
    await shot('saved')
    if (!onDisk.includes(MARKER)) throw new Error('file on disk does NOT contain the typed text')
    if (!/saved/i.test(msg)) throw new Error(`confirmation text = "${msg}"`)
    return `disk updated · "${msg.trim()}"`
  })

  await step('5b. Manual save is undoable (Undo button became enabled)', async () => {
    const state = await js(`(() => {
      const b = [...document.querySelectorAll('.topbar-actions .btn')].find(e=>e.textContent.includes('Undo'));
      return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing' })()`)
    if (state !== 'enabled') throw new Error(`Undo button is ${state}`)
    return 'enabled'
  })

  // Regression: the ⌘S Monaco command must call the CURRENT onSave, not the one
  // captured when the editor first mounted.
  const MARKER2 = `UI_TEST_REMOUNT_${Date.now()}`
  await step('5c. ⌘S still saves after the editor is remounted (tab switch away and back)', async () => {
    await clickSel('.tab-preview')
    await waitFor(`!document.querySelector('.monaco-editor')`, { what: 'editor unmounted' })
    await clickByText('.tab:not(.tab-preview)', 'main.tsx')
    await waitFor(`!!document.querySelector('.monaco-editor .view-lines')`, { what: 'editor remounted' })
    await sleep(400)

    await typeVerified(`// ${MARKER2}\n`)
    await waitFor(`!!document.querySelector('.tab .tab-dot')`, { timeout: 8000, what: 'dirty dot' })
    await saveShortcut()
    await waitFor(`!document.querySelector('.tab .tab-dot')`, { timeout: 8000, what: 'dot cleared' })
    await sleep(400)
    const onDisk = fs.readFileSync(TARGET_ABS, 'utf8')
    if (!onDisk.includes(MARKER2)) throw new Error('remounted editor also failed to persist the typed text')
    return 'typed text persisted after remount'
  })

  // Regression: with two files open, ⌘S must write the ACTIVE file, not the first one.
  const MARKER3 = `UI_TEST_ACTIVE_${Date.now()}`
  await step('5d. ⌘S writes the ACTIVE tab when several files are open', async () => {
    await clickByText('.ex-row', 'vite.config.ts')
    await waitFor(
      `[...document.querySelectorAll('.tab .tab-name')].some(e=>e.textContent==='vite.config.ts')`,
      { what: 'vite.config.ts tab' }
    )
    await waitFor(
      `(document.querySelector('.monaco-editor .view-lines')?.textContent || '').includes('defineConfig')`,
      { timeout: 10000, what: 'vite.config.ts contents in editor' }
    )
    await sleep(300)

    await typeVerified(`// ${MARKER3}\n`)
    await sleep(300)
    await saveShortcut()
    await sleep(1200)

    const cfg = fs.readFileSync(VITE_CFG, 'utf8')
    const main = fs.readFileSync(TARGET_ABS, 'utf8')
    if (main.includes(MARKER3)) throw new Error('⌘S wrote the typed text into main.tsx — the WRONG file')
    if (!cfg.includes(MARKER3)) {
      const diag = await js(`JSON.stringify({
        inBuffer: !!window.__studioEditor?.getModel()?.getValue()?.includes(${JSON.stringify(MARKER3)}),
        activeEl: document.activeElement?.className?.slice(0, 40),
        dirty: !!document.querySelector('.tab .tab-dot'),
        toast: document.querySelector('.toast')?.textContent?.slice(0, 40) || null
      })`)
      throw new Error('⌘S did not write the active file (vite.config.ts) — diag=' + diag)
    }
    await shot('two-tabs-saved')
    return 'active tab written, other tab untouched'
  })

  await step('5e. Closing the extra tab leaves main.tsx active', async () => {
    await js(`(() => {
      const t = [...document.querySelectorAll('.tab')].find(e => (e.textContent||'').includes('vite.config.ts'));
      t.querySelector('.tab-close').click(); return 'OK' })()`)
    await waitFor(
      `![...document.querySelectorAll('.tab .tab-name')].some(e=>e.textContent==='vite.config.ts')`,
      { what: 'extra tab closed' }
    )
    return 'closed'
  })

  // --- 6. dev server + preview --------------------------------------------
  await step('5f. Real bug fix: the idle preview pane has an actual clickable button, not just text', async () => {
    // Reported live: clicking the Preview tab while idle showed a message telling the user to press a
    // DIFFERENT button elsewhere — read as "no event listener" (nothing to click right there). The
    // empty state must now contain a real <button>, wired to actually start the server.
    await clickSel('.tab-preview')
    await waitFor(`!!document.querySelector('.canvas-empty')`, { what: 'idle preview empty state' })
    const btn = await js(`(() => { const b = [...document.querySelectorAll('.canvas-empty button')].find(x => /run preview/i.test(x.textContent)); return b ? b.tagName : 'NONE' })()`)
    if (btn !== 'BUTTON') throw new Error('the empty preview state must contain a real, clickable "Run preview" button: ' + btn)
    return 'idle preview pane has a real Run preview button, not just inert text'
  })

  let previewUrl = null
  await step('6. "Run preview" starts the dev server and the Preview tab goes green', async () => {
    await clickByText('.topbar-actions .btn', 'Run preview')
    await waitFor(`!!document.querySelector('.tab-preview .badge-running')`, {
      timeout: 90000,
      what: 'dev server running badge'
    })
    await clickSel('.tab-preview')
    previewUrl = await waitFor(`(document.querySelector('.preview-url')?.textContent || '').startsWith('http')`, {
      timeout: 15000,
      what: 'preview url'
    })
    const url = await textOf('.preview-url')
    // The always-visible status bar must reflect the running state.
    const statusChip = await waitFor(`(document.querySelector('.statusbar .status-chip')?.textContent || '')`, {
      timeout: 8000,
      what: 'status bar preview chip'
    })
    if (!statusChip.includes('Running')) throw new Error(`status chip = "${statusChip}"`)
    await sleep(2500) // let the webview paint
    await shot('preview-running')
    return `${url} · statusbar: "${statusChip.trim()}"`
  })

  await step('6b. The live app renders inside the preview <webview>', async () => {
    const n = await count('webview')
    if (n < 1) throw new Error('no <webview> in the preview pane')
    // Reach into the guest page and read its DOM — proves the app really loaded.
    const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    if (!guests.length) throw new Error('no webview webContents attached')
    const inner = await guests[0]
      .executeJavaScript(`document.getElementById('root')?.innerText || document.body.innerText`)
      .catch(() => null)
    if (!inner || !inner.trim()) throw new Error('webview loaded but its page is blank')
    return `webview body: "${inner.trim().slice(0, 60)}"`
  })

  await step('6c. Device switcher resizes the preview (Desktop → iPhone → All)', async () => {
    await clickByText('.seg-btn', 'iPhone')
    await sleep(600)
    const iphone = await count('webview')
    await shot('preview-iphone')
    await clickByText('.seg-btn', 'All')
    await sleep(800)
    const all = await count('webview')
    await shot('preview-all')
    await clickByText('.seg-btn', 'Desktop')
    await sleep(500)
    if (!(all > iphone)) throw new Error(`"All" showed ${all} device(s), "iPhone" showed ${iphone}`)
    return `iPhone=${iphone} webview, All=${all} webviews`
  })

  await step('6d. "Select element" becomes enabled once the server is running', async () => {
    const state = await js(`(() => {
      const b = [...document.querySelectorAll('.preview-toolbar .btn')].find(e=>e.textContent.includes('Select element'));
      return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing' })()`)
    if (state !== 'enabled') throw new Error(`Select element is ${state}`)
    return 'enabled'
  })

  await step('6e. Clicking a stamped element in the preview selects its source (file:line)', async () => {
    // Regression guard: the preview preload must run sandboxed in the guest —
    // any non-electron require in it fails silently and kills click-to-edit.
    await clickByText('.preview-toolbar .btn', 'Select element')
    const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    if (!guests.length) throw new Error('no webview guest')
    const stamped = await guests[0].executeJavaScript(
      `(() => { const el = document.querySelector('[data-canvas-file]');
         if (!el) return null;
         el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
         return el.dataset.canvasFile })()`
    )
    if (!stamped) throw new Error('no data-canvas-file stamped elements in the vite preview')
    const chip = await waitFor(`document.querySelector('.sel-chip')?.textContent || ''`, {
      timeout: 10000,
      what: 'stamped selection chip'
    })
    if (!chip.includes('main.tsx')) throw new Error(`sel-chip = "${chip}"`)
    await clickByText('.edit-panel .btn', 'Cancel')
    return chip
  })

  // --- 7. iOS simulator menu ----------------------------------------------
  await step('7. iOS Simulator menu lists real simulators from this Mac', async () => {
    await clickByText('.sim-menu .btn', 'iOS Simulator')
    await waitFor(`!!document.querySelector('.sim-dropdown')`, { what: 'simulator dropdown' })
    const items = await count('.sim-item')
    const names = await js(`[...document.querySelectorAll('.sim-item')].slice(0,3).map(e=>e.textContent.trim())`)
    await shot('simulator-menu')
    await clickByText('.sim-menu .btn', 'iOS Simulator') // close (do NOT boot a sim)
    if (process.platform === 'darwin' && items === 0) throw new Error('no simulators listed on macOS')
    return `${items} simulators (${names.join(', ')})`
  })

  // --- 8. logs drawer ------------------------------------------------------
  await step('8. Logs drawer opens and shows real dev-server output', async () => {
    await openPanelTab('Activity')
    await waitFor(`!!document.querySelector('.panel .activity-body')`, { what: 'activity tab' })
    const lines = await waitFor(`document.querySelectorAll('.logs-body .log').length`, {
      timeout: 8000,
      what: 'log lines'
    })
    await shot('logs')
    await clickSel('.panel-close')
    return `${lines} log lines`
  })

  // --- 9. undo -------------------------------------------------------------
  await step('9. "↩ Undo" unwinds every save (LIFO, across both files) and refreshes the tab', async () => {
    const undoEnabled = () => js(`(() => {
      const b = [...document.querySelectorAll('.topbar-actions .btn')].find(e=>e.textContent.includes('Undo'));
      return !!b && !b.disabled })()`)

    let clicks = 0
    while ((await undoEnabled()) && clicks < 8) {
      await clickByText('.topbar-actions .btn', 'Undo')
      clicks++
      await sleep(700)
    }
    if (await undoEnabled()) throw new Error('Undo never became disabled — stack did not drain')

    const main = fs.readFileSync(TARGET_ABS, 'utf8')
    const cfg = fs.readFileSync(VITE_CFG, 'utf8')
    if (main !== originalSource) throw new Error(`main.tsx not restored (still ${main.length} chars vs ${originalSource.length})`)
    if (cfg !== originalCfg) throw new Error('vite.config.ts not restored by undo')

    const inEditor = await waitFor(
      `!(document.querySelector('.monaco-editor .view-lines')?.textContent || '').includes('UI_TEST_')`,
      { timeout: 8000, what: 'editor re-read from disk' }
    )
    await shot('undone')
    return `${clicks} undos → both files byte-identical to original; editor refreshed (${inEditor})`
  })

  // --- 10. tabs + stop -----------------------------------------------------
  await step('10. Closing the editor tab falls back to the Preview tab', async () => {
    await closeTabsDiscarding()
    await waitFor(`document.querySelectorAll('.tab:not(.tab-preview)').length === 0`, { what: 'tab closed' })
    const active = await js(`!!document.querySelector('.tab-preview.active')`)
    if (!active) throw new Error('Preview tab is not active after closing the last file tab')
    return 'preview re-activated'
  })

  await step('11. "Stop" stops the dev server', async () => {
    await clickByText('.topbar-actions .btn', 'Stop')
    await waitFor(`!document.querySelector('.tab-preview .badge-running')`, {
      timeout: 20000,
      what: 'server stopped'
    })
    await shot('stopped')
    return 'dev server stopped'
  })

  // --- Phase 10: agent + terminal ------------------------------------------
  const setNativeValue = (sel, value, proto) =>
    js(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'NOT_FOUND';
      Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(${JSON.stringify(proto === 'HTMLSelectElement' ? 'change' : 'input')}, { bubbles: true }));
      return 'OK' })()`).then((r) => {
      if (r !== 'OK') throw new Error(`set ${sel} → ${r}`)
    })

  await step('12. Switch provider to the test mock in Settings', async () => {
    if (!(await js(`!!document.querySelector('.modal .settings')`))) await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.modal .settings select')`, { what: 'settings select' })
    const has = await js(`[...document.querySelectorAll('.modal .settings select option')].some(o => o.value === 'mock')`)
    if (!has) throw new Error('mock provider not in the dropdown (STUDIO_MOCK_AI not seen by main?)')
    await setNativeValue('.modal .settings select', 'mock', 'HTMLSelectElement')
    await clickByLabel('.topbar-actions .btn', 'Settings')
    return 'provider = Mock (tests)'
  })

  const AGENT_MARKER = 'AGENT_UI_TEST'
  await step('13. Agent dock opens and takes a goal', async () => {
    // Script the "model": read the file, then stage a one-line banner edit, then done.
    const banner = `// ${AGENT_MARKER}\n` + originalSource
    writeAgentScript([
      'Let me read that file first.\nACTION read_file src/main.tsx',
      'Adding the banner comment now.\nACTION write src/main.tsx\n```tsx\n' + banner + '\n```',
      'ACTION done\nAdded a banner comment at the top of src/main.tsx.'
    ])
    if (!(await js(`!!document.querySelector('.agent-panel')`)))
      await clickByLabel('.topbar-actions .btn', 'Agent')
    await waitFor(`!!document.querySelector('.agent-panel')`, { what: 'agent dock' })
    await setNativeValue('.agent-input textarea', 'Add a banner comment to main.tsx', 'HTMLTextAreaElement')
    await clickByText('.agent-input .btn', 'Start')
    await waitFor(`document.querySelectorAll('.tool-chip').length >= 2`, { timeout: 20000, what: 'tool chips' })
    return 'run started, steps streaming'
  })

  await step('13b/c. Build mode auto-applies with no approval step — verified/unchecked badge, logged on the board', async () => {
    // Real bug this design fixes: the agent used to stage a write, then immediately try to run/verify
    // it, and fail because nothing was on disk yet. Build mode now writes the instant it stages, so
    // there is no separate "click Apply" step — the file lands on disk as the agent works.
    await waitFor(
      () => fs.readFileSync(TARGET_ABS, 'utf8').includes(AGENT_MARKER),
      { timeout: 20000, what: 'agent edit on disk (auto-applied, no click needed)' }
    )
    await waitFor(`!!document.querySelector('.msg-done')`, { timeout: 20000, what: 'agent done' })
    // Nothing stays in "Proposed changes" for a plain (non-secret) edit — it moves straight to Applied.
    await waitFor(`document.querySelectorAll('.staged:not(.applied) .diff-card').length === 0`, { what: 'nothing left pending approval' })
    await waitFor(`!!document.querySelector('.staged.applied .diff-card .conf-meter')`, { timeout: 6000, what: 'applied confidence badge' })
    const appliedConf = await js(`(() => { const m = document.querySelector('.staged.applied .conf-meter'); return m ? m.textContent.replace(/\\s+/g,' ').trim() : 'NONE' })()`)
    // main.tsx is a .tsx file → not syntax-checked → the label must be exactly
    // "unchecked" and the % must be the UNCHANGED pre-apply confidence (90, this edit read first).
    if (!/\bunchecked\b/.test(appliedConf)) throw new Error('unchecked .tsx not labeled unchecked: ' + appliedConf)
    if (!/\b90%/.test(appliedConf)) throw new Error('unchecked file confidence changed from its base (expected 90%): ' + appliedConf)
    // Wave 16: Blind-Edit badge — this edit READ the file first, so it must NOT carry the "didn't read first" chip.
    if (await js(`!!document.querySelector('.staged.applied .diff-card .blindedit-chip')`)) throw new Error('a read-first edit must NOT show the blind-edit chip')
    // Wave 13: Blast Radius chip — additive, async-enriched from the import graph, beside Confidence — now on the Applied card.
    await waitFor(`!!document.querySelector('.staged.applied .diff-card .blast-chip')`, { timeout: 8000, what: 'blast radius chip' })
    const blastTxt = await js(`(() => { const c = document.querySelector('.staged.applied .diff-card .blast-chip'); return c ? c.textContent.trim() : 'NONE' })()`)
    if (!/entry|rely|depend|impact/i.test(blastTxt)) throw new Error('blast chip text unexpected: ' + blastTxt)
    await shot('agent-diff')
    // Multi-Agent Board: the finished run is recorded.
    await clickSel('.agent-board-head')
    await waitFor(`!!document.querySelector('.agent-board-list .agent-task.task-done')`, { timeout: 6000, what: 'finished task on the board' })
    await shot('agent-applied')
    return `auto-applied to disk; badge "${appliedConf}"; task on board`
  })

  await step('13d. Undo reverts the agent edit too (same safety spine)', async () => {
    await clickByText('.topbar-actions .btn', 'Undo')
    await waitFor(() => !fs.readFileSync(TARGET_ABS, 'utf8').includes(AGENT_MARKER), {
      timeout: 8000,
      what: 'agent edit reverted'
    })
    return 'reverted'
  })

  await step('13e. A follow-up while busy QUEUES behind the run and shows on the board', async () => {
    // A brief run keeps the agent busy while we submit a second instruction.
    const qfile = path.join(PROJECT, '_qtest.js')
    fs.writeFileSync(qfile, 'setTimeout(() => {}, 1400)\n')
    try {
      if (!(await js(`!!document.querySelector('.agent-panel')`))) await clickByLabel('.topbar-actions .btn', 'Agent')
      writeAgentScript(['ACTION run node _qtest.js', 'ACTION done\nfirst'])
      // Start the first run directly (running=true synchronously in main).
      const P = JSON.stringify(PROJECT)
      const r1 = await js(`window.studio.agentStart({ projectPath: ${P}, instruction: 'first busy task', mode: 'build', provider: 'mock' })`)
      if (!r1.ok || r1.queued) throw new Error('first start should run, not queue: ' + JSON.stringify(r1))
      await waitFor(`window.studio.agentState().then(s => s.running)`, { timeout: 6000, what: 'first run busy' })
      // Submit a follow-up THROUGH THE DOCK — the button now offers "Queue".
      await setNativeValue('.agent-input textarea', 'queued follow-up task', 'HTMLTextAreaElement')
      await waitFor(`(document.querySelector('.agent-input .btn-block')?.textContent || '').includes('Queue')`, { timeout: 4000, what: 'Queue button while busy' })
      await clickByText('.agent-input .btn', 'Queue')
      // The dock acknowledges the queue and the snapshot carries the instruction.
      await waitFor(`[...document.querySelectorAll('.msg-done')].some(e => /Queued/i.test(e.textContent))`, { timeout: 5000, what: 'queued acknowledgement' })
      const inSnap = await js(`window.studio.agentState().then(s => (s.queuedTasks || []).some(t => t.instruction === 'queued follow-up task'))`)
      if (!inSnap) throw new Error('queued task not in agentState snapshot')
      // The Multi-Agent Board shows the queued row (expand if collapsed).
      if (!(await js(`!!document.querySelector('.agent-board-list')`))) await clickSel('.agent-board-head')
      await waitFor(`[...document.querySelectorAll('.agent-task.task-queued .task-instruction')].some(e => e.textContent.includes('queued follow-up'))`, { timeout: 4000, what: 'queued task on the board' })
      await shot('agent-queued')
    } finally {
      await waitFor(`window.studio.agentState().then(s => !s.running)`, { timeout: 20000, what: 'agent idle after drain' })
      fs.rmSync(qfile, { force: true })
    }
    return 'follow-up queued via the dock, shown on the board, drained'
  })

  await step('13f. Wave 16/23: Blind-Edit + Wiring/Config chips on auto-applied cards; Secret Leak Guard still holds a key back', async () => {
    const blindFile = path.join(PROJECT, 'src', 'w16blind.tsx')
    fs.writeFileSync(blindFile, 'export const w16 = 1\n') // must EXIST → overwriting it without a read is "blind"
    const newFile = path.join(PROJECT, 'src', 'w16new.tsx')
    const secretFile = path.join(PROJECT, 'src', 'w16secret.ts')
    const cfgDir = path.join(PROJECT, 'w16cfg')
    try {
      if (!(await js(`!!document.querySelector('.agent-panel')`))) await clickByLabel('.topbar-actions .btn', 'Agent')
      // Four writes, NONE preceded by a read: an EXISTING code file (blind), a brand-NEW code file
      // (not blind), a plumbing file (package.json → Wiring/Config chip), and a file that ADDS a
      // fake AWS key (→ Secret chip). Build mode auto-applies the first three instantly; the
      // Secret Leak Guard is the one carve-out that still holds a write back instead of applying it.
      writeAgentScript([
        'ACTION write src/w16blind.tsx\n```tsx\nexport const w16 = 2\n```',
        'ACTION write src/w16new.tsx\n```tsx\nexport const fresh = 1\n```',
        'ACTION write w16cfg/package.json\n```json\n{"name":"x"}\n```',
        'ACTION write src/w16secret.ts\n```ts\nexport const AWS = "AKIA1234567890ABCDEF"\n```',
        'ACTION done\nfour writes, no reads'
      ])
      const P = JSON.stringify(PROJECT)
      await js(`window.studio.agentStart({ projectPath: ${P}, instruction: 'guardrail writes', mode: 'build', provider: 'mock' })`)
      await waitFor(`!!document.querySelector('.msg-done')`, { timeout: 20000, what: 'agent done' })
      // The three clean writes land on disk unattended; the key-bearing one does NOT.
      await waitFor(() => fs.existsSync(blindFile) && fs.readFileSync(blindFile, 'utf8').includes('w16 = 2'), { what: 'blind edit applied' })
      await waitFor(() => fs.existsSync(newFile), { what: 'new file applied' })
      await waitFor(() => fs.existsSync(path.join(cfgDir, 'package.json')), { what: 'config file applied' })
      if (fs.existsSync(secretFile)) throw new Error('a likely secret must NOT be auto-applied to disk')
      const hasApplied = (fname, chip) =>
        js(`(() => { const c=[...document.querySelectorAll('.staged.applied .diff-card')].find(d => (d.querySelector('.diff-file')?.textContent||'').includes('${fname}')); return c ? !!c.querySelector('${chip}') : 'NOCARD' })()`)
      // Blind-Edit: only the unread overwrite of an EXISTING file — never the new files.
      if ((await hasApplied('w16blind.tsx', '.blindedit-chip')) !== true) throw new Error('an unread overwrite of an existing file MUST show the blind-edit chip')
      if ((await hasApplied('w16new.tsx', '.blindedit-chip')) !== false) throw new Error('a brand-new file must NEVER show the blind-edit chip')
      if ((await hasApplied('package.json', '.blindedit-chip')) !== false) throw new Error('a brand-new config file must NEVER show the blind-edit chip')
      // Wiring/Config: only the plumbing file — never ordinary code. Now shown on the Applied card.
      await waitFor(`(() => { const c=[...document.querySelectorAll('.staged.applied .diff-card')].find(d => (d.querySelector('.diff-file')?.textContent||'').includes('package.json')); return c ? !!c.querySelector('.wiring-chip') : false })()`, { timeout: 8000, what: 'wiring chip on package.json' })
      if ((await hasApplied('w16blind.tsx', '.wiring-chip')) !== false) throw new Error('a normal code file must NOT show the wiring chip')
      if ((await hasApplied('w16new.tsx', '.wiring-chip')) !== false) throw new Error('a normal code file must NOT show the wiring chip')
      // Secret Leak Guard: the key-bearing file is STILL a pending diff card (not applied). (Chip text carries NO value.)
      await waitFor(`(() => { const c=[...document.querySelectorAll('.staged:not(.applied) .diff-card')].find(d => (d.querySelector('.diff-file')?.textContent||'').includes('w16secret.ts')); return c ? !!c.querySelector('.secret-chip') : false })()`, { timeout: 8000, what: 'secret chip on the still-pending key-bearing edit' })
      if (await js(`/AKIA/.test((document.querySelector('.staged:not(.applied) .diff-card .secret-chip')?.textContent||'') + (document.querySelector('.staged:not(.applied) .diff-card .secret-chip')?.title||''))`)) throw new Error('secret chip must never render the matched value')
      await shot('wave16-guardrails')
      await clickByText('.staged-head .btn', 'Reject all') // the held-back secret write — never touches disk
      await waitFor(`document.querySelectorAll('.staged:not(.applied) .diff-card').length === 0`, { timeout: 6000, what: 'staged cleared (rejected)' })
      if (fs.existsSync(secretFile)) throw new Error('rejected secret-bearing write must never reach disk')
    } finally {
      fs.rmSync(blindFile, { force: true })
      fs.rmSync(newFile, { force: true })
      fs.rmSync(secretFile, { force: true })
      fs.rmSync(cfgDir, { recursive: true, force: true })
    }
    return 'blind-edit/wiring chips on auto-applied cards; secret-bearing write held back, rejected, never on disk ✓'
  })

  await step('14. Terminal: a REAL shell (pty) — interactive, coloured, tabs isolated, docker streams', async () => {
    // Give the project a compose file so the Docker buttons appear (removed after).
    fs.writeFileSync(path.join(PROJECT, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n')
    await openPanelTab('Terminal')
    await waitFor(`!!document.querySelector('.term-drawer')`, { what: 'terminal drawer' })
    // A pseudo-terminal running the user's own shell — so there is a PROMPT before anything is typed.
    // The old runner had no shell at all until a command was submitted.
    await waitFor(`!!window.__studioTerm && !!document.querySelector('.term-view.active .xterm-rows') && document.querySelector('.term-view.active .xterm-rows').textContent.trim().length > 0`, {
      timeout: 20000,
      what: 'a live shell with a prompt'
    })
    // `input()` is xterm's public "the user typed this" API: keystrokes go through the real path,
    // into the pty, and the shell answers.
    const type = (text) => js(`(window.__studioTerm.input(${JSON.stringify(text)}), 'OK')`)
    const screen = () => js(`document.querySelector('.term-view.active .xterm-rows').textContent`)

    await type('ls\r')
    await waitFor(`document.querySelector('.term-view.active .xterm-rows').textContent.includes('package.json')`, {
      timeout: 15000,
      what: 'ls output'
    })

    // Colour must render as colour, never as raw escape-code text.
    await type("printf '\\033[32mGREEN_OK\\033[0m plain'\r")
    await waitFor(`document.querySelector('.term-view.active .xterm-rows').textContent.includes('GREEN_OK')`, { timeout: 10000, what: 'coloured output' })
    const colored = await js(`(() => {
      const spans = [...document.querySelectorAll('.term-view.active .xterm-rows span')];
      const span = spans.find(s => s.textContent.includes('GREEN_OK'));
      return span ? getComputedStyle(span).color : 'NO_SPAN';
    })()`)
    if (colored === 'NO_SPAN') throw new Error('coloured ANSI output must render as a styled span')
    if (colored === 'rgb(0, 0, 0)' || colored === '') throw new Error(`the coloured span must actually be coloured, got: ${colored}`)
    if (/\x1b|\u001b/.test(await screen())) throw new Error('raw escape-code garbage must never be visible')

    // THE thing the old terminal could not do: answer a program that is waiting for input.
    // `read` blocks until a line arrives, which only works over a real tty.
    await type('read -r WHO && echo "HELLO_$WHO"\r')
    await new Promise((r) => setTimeout(r, 700))
    await type('WORLD\r')
    await waitFor(`document.querySelector('.term-view.active .xterm-rows').textContent.includes('HELLO_WORLD')`, {
      timeout: 12000,
      what: 'an interactive prompt answered mid-command'
    })
    await shot('wave23-terminal-color')

    // Second tab: its own shell, and none of tab 1's scrollback.
    await clickByLabel('.term-side-actions .term-side-btn', 'New Terminal')
    await waitFor(`document.querySelectorAll('.term-tab').length === 2`, { what: 'two terminal tabs' })
    await waitFor(`!document.querySelector('.term-view.active .xterm-rows').textContent.includes('package.json')`, { what: 'second tab is a fresh session' })
    await type('echo TAB2_OK\r')
    await waitFor(`document.querySelector('.term-view.active .xterm-rows').textContent.includes('TAB2_OK')`, { timeout: 12000, what: 'tab 2 output' })

    // Docker buttons (fake CLI): Up streams into the active tab.
    await waitFor(`!!document.querySelector('.docker-actions')`, { what: 'docker actions visible' })
    await clickByText('.docker-actions .btn', 'Up')
    await waitFor(`document.querySelector('.term-view.active .xterm-rows').textContent.includes('FAKE_DOCKER compose up -d')`, {
      timeout: 15000,
      what: 'compose up streamed'
    })
    await shot('terminal-tabs-docker')

    // Back to tab 1 — its own shell and scrollback survived the switch.
    await clickByText('.term-tab', 'Terminal 1')
    await waitFor(`document.querySelector('.term-view.active .xterm-rows').textContent.includes('package.json')`, { what: 'tab 1 scrollback intact' })

    /* Smart Terminal "Explain" reads THIS terminal's transcript. It lives here rather than with the
       other Wave-1 features because it needs a shell that has actually printed something, and this
       step has just proven one — several commands deep, in a tab whose output is on screen. */
    writeAgentScript(['The command printed package.json and succeeded.'])
    await clickByText('.term-toolbar .btn', 'Explain')
    await waitFor(`(document.querySelector('.term-explain')?.textContent || '').includes('succeeded')`, {
      timeout: 20000,
      what: 'terminal explanation'
    })
    await shot('smart-terminal')

    fs.rmSync(path.join(PROJECT, 'docker-compose.yml'))
    await clickSel('.panel-close')
    return 'real pty: prompt + ls + colour + INTERACTIVE read answered + tabs isolated + docker streamed + Explain summarised it'
  })

  await step('14b. History drawer lists changes and reverts to a chosen point', async () => {
    // Two manual saves → two timeline entries → revert to before the FIRST.
    await clickByText('.ex-row', 'main.tsx')
    await waitFor(`!!document.querySelector('.monaco-editor .view-lines')`, { timeout: 30000, what: 'editor' })
    await sleep(300)
    for (const mark of ['HIST_A', 'HIST_B']) {
      await typeVerified(`// ${mark}\n`)
      await saveShortcut()
      await waitFor(`!document.querySelector('.tab .tab-dot')`, { timeout: 8000, what: `${mark} saved` })
    }
    if (!fs.readFileSync(TARGET_ABS, 'utf8').includes('HIST_B')) throw new Error('second save not on disk')

    await openPanelTab('Changes')
    await waitFor(`document.querySelectorAll('.hist-row:not(.hist-mark)').length >= 2`, { what: 'history rows' })
    const rows = await count('.hist-row')
    await shot('history')
    // Rows are newest-first; the LAST row is the oldest change → revert to before it.
    await js(`(() => { const r = [...document.querySelectorAll('.hist-row:not(.hist-mark)')]; r[r.length-1].querySelector('button').click(); return 'OK' })()`)
    await waitFor(() => {
      const now = fs.readFileSync(TARGET_ABS, 'utf8')
      return !now.includes('HIST_A') && !now.includes('HIST_B') && now === originalSource
    }, { timeout: 10000, what: 'both saves rolled back' })
    await waitFor(`document.querySelectorAll('.hist-row:not(.hist-mark)').length === 0`, { what: 'timeline emptied' })
    await waitFor(
      `(document.querySelector('.monaco-editor .view-lines')?.textContent || '').indexOf('HIST_') === -1`,
      { timeout: 8000, what: 'editor refreshed' }
    )
    await clickSel('.panel-close')
    await closeTabsDiscarding() // leave the workspace as the next steps expect (Wave 21: answers the seatbelt)
    return `${rows} entries shown → revert-to-point → file byte-identical, editor refreshed`
  })

  await step('14c. ⌘K inline edit: selection → AI rewrite lands as an UNSAVED buffer change', async () => {
    writeAgentScript([`        <h1 style={{ color: '#16a34a' }}>INLINE_K_OK</h1>`])
    await clickByText('.ex-row', 'main.tsx')
    await waitFor(`!!window.__studioEditor`, { timeout: 30000, what: 'editor + test hook' })
    await sleep(300)
    // Select line 7 (the <h1>) like a user would, then press ⌘K.
    await js(`(() => {
      const ed = window.__studioEditor;
      ed.focus();
      ed.setSelection({ startLineNumber: 7, startColumn: 1, endLineNumber: 7, endColumn: ed.getModel().getLineMaxColumn(7) });
      return 'OK' })()`)
    await sleep(200)
    const mod = process.platform === 'darwin' ? 'meta' : 'control'
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: [mod] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: [mod] })
    await waitFor(`!!document.querySelector('.inline-edit-bar')`, { timeout: 8000, what: '⌘K bar' })
    const range = await textOf('.inline-edit-range')
    if (!range.includes('7–7')) throw new Error(`range = ${range}`)

    await js(`(() => {
      const el = document.querySelector('.inline-edit-input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'make the heading green');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK' })()`)
    await clickByText('.inline-edit-bar .btn', 'Rewrite')
    await waitFor(
      `(document.querySelector('.monaco-editor .view-lines')?.textContent || '').includes('INLINE_K_OK')`,
      { timeout: 15000, what: 'rewritten selection in editor' }
    )
    if (!(await js(`!!document.querySelector('.tab .tab-dot')`))) throw new Error('buffer not marked unsaved')
    if (fs.readFileSync(TARGET_ABS, 'utf8').includes('INLINE_K_OK'))
      throw new Error('⌘K wrote to disk without ⌘S')
    await shot('inline-k')
    await closeTabsDiscarding() // drop the unsaved change (Wave 21: the seatbelt asks first)
    await waitFor(`document.querySelectorAll('.tab:not(.tab-preview)').length === 0`, { what: 'tab closed' })
    if (fs.readFileSync(TARGET_ABS, 'utf8') !== originalSource) throw new Error('disk changed after dropping')
    return `${range} → rewrite in buffer only; ⌘S gate held; dropped cleanly`
  })

  await step('14d. Tab autocomplete shows ghost text from the model while typing', async () => {
    writeAgentScript(['const GHOST_TEXT_OK = true'])
    await clickByText('.ex-row', 'main.tsx')
    await waitFor(`!!window.__studioEditor`, { timeout: 30000, what: 'editor' })
    await sleep(300)
    // Put the caret on the empty last line and type — the inline provider should
    // debounce, call the (mock) model, and render its reply as ghost text.
    await js(`(() => {
      const ed = window.__studioEditor;
      const last = ed.getModel().getLineCount();
      ed.focus();
      ed.setPosition({ lineNumber: last, column: ed.getModel().getLineMaxColumn(last) });
      return 'OK' })()`)
    await sleep(200)
    typeText('con')
    await sleep(600)
    // Monaco hides ghost text while the IntelliSense dropdown is open — close it
    // (users see suggestions whenever the widget isn't up), reset the scripted
    // reply consumed by the first debounced call, and ask for the inline hint.
    await js(`window.__studioEditor.trigger('t','hideSuggestWidget',{}), 'ok'`)
    fs.rmSync(AGENT_SCRIPT + '.idx', { force: true })
    await js(`window.__studioEditor.trigger('t','editor.action.inlineSuggest.trigger',{}), 'ok'`)
    const ghost = await waitFor(
      `(document.querySelector('.monaco-editor')?.textContent || '').includes('GHOST_TEXT_OK')`,
      { timeout: 15000, what: 'ghost text rendered' }
    )
    await shot('autocomplete')
    // The suggestion is DISPLAY only until accepted — the buffer must not contain it.
    const inBuffer = await js(`window.__studioEditor.getModel().getValue().includes('GHOST_TEXT_OK')`)
    if (inBuffer) throw new Error('ghost text was inserted into the buffer without accepting')
    // Reject it and drop the typed chars: close the tab without saving.
    await closeTabsDiscarding()
    await waitFor(`document.querySelectorAll('.tab:not(.tab-preview)').length === 0`, { what: 'tab closed' })
    if (fs.readFileSync(TARGET_ABS, 'utf8') !== originalSource) throw new Error('disk changed')
    return `ghost text shown (${ghost}), buffer + disk untouched`
  })

  // ---- Source Control (2026-09-02): the VS Code-grade Git view ----------------------------------
  const scmPerf = () => js(`JSON.stringify(window.__scmPerf || {})`).then((v) => JSON.parse(v))
  /** Click a section header by title. With a thousand rows the History header is not mounted until the list is scrolled to it. */
  const clickSection = async (title) => {
    // Re-assert the scroll on every poll rather than once: the list keeps its FOCUSED row in view,
    // so a refresh landing between the scroll and the check (a commit, a watcher event) can pull
    // the viewport back before the header mounts. Scrolling each time races nothing.
    //
    // SWEEP rather than jump to the bottom. History is the LAST section, so its header sits ABOVE
    // every commit row: scrolling straight to scrollHeight only finds it while the whole section
    // fits inside one mounted window. That held at a 30-commit history and stopped holding when
    // history became paged at 50 plus a "Load more" row — the header was then ~51 rows above the
    // bottom and never mounted, while the same call in a test that opened History from COLLAPSED
    // still passed, because the list was short. Stepping a viewport at a time (and wrapping, so a
    // list that grows under us is swept again) finds the header at any page size.
    const sweep = title === 'History'
    let pass = 0
    await waitFor(
      async () => {
        if (sweep) {
          await js(`(() => {
            const l = document.querySelector('.scm-list'); if (!l) return true
            const step = Math.max(66, l.clientHeight - 44)
            const max = Math.max(0, l.scrollHeight - l.clientHeight)
            l.scrollTop = max === 0 ? 0 : (${pass} * step) % (max + step)
            return true
          })()`)
          pass++
        } else {
          await js(`(() => { const l = document.querySelector('.scm-list'); if (l) l.scrollTop = 0; return true })()`)
        }
        // Find AND click in ONE evaluation. Checking "is the header mounted?" in one round trip
        // and clicking in the next is a race the windowed list wins often enough to matter: a
        // refresh landing between them unmounts the header again, `.find` returns undefined, and
        // the click throws `reading 'click' of undefined` — which surfaces as "Script failed to
        // execute" and tells you nothing. Failing the poll and sweeping again is the correct
        // response to a header that went away; throwing is not. (`?.` on the title for the same
        // reason: a section without one must fail the match, not the script.)
        return js(`(() => {
          const s = [...document.querySelectorAll('.scm-section')]
            .find(x => x.querySelector('.scm-section-title')?.textContent === ${JSON.stringify(title)})
          if (!s) return false
          s.click()
          return true
        })()`)
      },
      { timeout: 20000, what: `the ${title} header to be mounted and clicked` }
    )
  }

  await step('14e0. "Clone repository…" lives in the overflow menu and opens a real URL field — not a prompt()', async () => {
    // Regression: this used window.prompt(), which Electron REFUSES — "prompt() is and will not
    // be supported" — and the click handler was `void cloneFromUrl()`, so the rejection was
    // swallowed and the button did nothing at all. The field is now a real input in a sheet that
    // opens from the ⋯ menu, so it does not occupy the top of every repository view.
    await openScm()
    await waitFor(`!!document.querySelector('.scm .scm-head')`, { what: 'the Source Control header', timeout: 15000 })
    await clickByLabel('.scm-head .scm-icon-btn', 'More actions')
    const labels = await waitFor(`[...document.querySelectorAll('.scm-menu-item')].map(b => b.textContent.trim()).join('|')`, { what: 'overflow menu' })
    if (!/Clone repository/.test(labels)) throw new Error(`no "Clone repository…" in the overflow menu: ${labels}`)
    if (!/Commit all/.test(labels)) throw new Error('"Commit all" must be an explicit menu entry, never the default')
    await clickByText('.scm-menu-item', 'Clone repository')
    await waitFor(`!!document.querySelector('.scm-clone input[placeholder^="ssh://"]')`, { what: 'the clone-URL field', timeout: 8000 })
    // The self-hosted server must be OFFERED, and listed before any cloud forge: "your code need
    // not leave the building" is the product claim.
    const forges = await js(`(() => { const s = document.querySelector('.scm-clone select'); return s ? [...s.options].map(o => o.textContent).join('|') : ''; })()`)
    if (!/self-hosted/i.test(forges) || !/self-hosted/i.test(forges.split('|')[0])) throw new Error(`self-hosted forge not first: ${forges}`)
    await clickByLabel('.scm-clone .scm-icon-btn', 'Close clone')
    await waitFor(`!document.querySelector('.scm-clone')`, { what: 'the sheet to close', timeout: 8000 })
    return `overflow: ${labels.split('|').length} entries; clone sheet opens with ssh:// field, forges "${forges}", closes again`
  })

  await step('14e1. The Git view follows a change made OUTSIDE the app, with no manual refresh', async () => {
    // Reported 2026-09-01: run Claude CLI in the built-in terminal, it edits files, the FILE TREE
    // updates and the git view does not. Now the watcher feeds a debounced refresh coordinator.
    await openScm()
    await waitFor(`!!document.querySelector('.scm .scm-list')`, { what: 'git list' })
    const total = () => js(`[...document.querySelectorAll('.scm-section .scm-count')].map(e => parseInt(e.textContent, 10) || 0).reduce((a, b) => a + b, 0)`)
    const before = await total()
    const name = `outside-edit-${process.pid}.txt`
    const file = path.join(PROJECT, name)
    fs.writeFileSync(file, 'written by something that is not Studio\n')
    try {
      await waitFor(async () => (await total()) > before, { timeout: 15000, what: `the changed-file count to rise above ${before} with no user action` })
    } finally {
      fs.rmSync(file, { force: true })
    }
    return `count rose above ${before} with no click — the view tracks disk, not the moment the project opened`
  })

  await step('14e. Source Control: sticky header, pinned composer, gated Commit, history on demand', async () => {
    await openScm()
    await waitFor(`!!document.querySelector('.scm .scm-head')`, { what: 'header' })
    // hello-vite lives inside the ATOMICStudio repo, so a real branch is shown.
    const branch = await waitFor(`document.querySelector('.scm-branch-name')?.textContent || ''`, { timeout: 10000, what: 'current branch' })
    if (!/^[\w./-]+$/.test(branch)) throw new Error(`branch looks wrong: "${branch.slice(0, 80)}"`)
    // Every icon-only control in the header carries an accessible name.
    const unnamed = await js(`[...document.querySelectorAll('.scm-head button')].filter(b => !b.getAttribute('aria-label') && !b.textContent.trim()).length`)
    if (unnamed) throw new Error(`${unnamed} icon-only header button(s) without an accessible name`)
    // The composer sits ABOVE the list — pinned, inside the panel, before any row.
    const order = await js(`(() => { const c = document.querySelector('.scm-composer'); const l = document.querySelector('.scm-list'); const p = document.querySelector('.left');
      if (!c || !l || !p) return 'missing'; const cr = c.getBoundingClientRect(), lr = l.getBoundingClientRect(), pr = p.getBoundingClientRect();
      return JSON.stringify({ composerAboveList: cr.bottom <= lr.top + 1, inPanel: cr.top >= pr.top && cr.bottom <= pr.bottom }) })()`)
    const o = JSON.parse(order)
    if (!o.composerAboveList || !o.inPanel) throw new Error(`composer not pinned above the list inside the sidebar: ${order}`)
    // Read-only assertions ONLY against the developer's real tree. Commit is gated on the INDEX
    // and says WHY it is disabled.
    const staged = await js(`(() => { const s = [...document.querySelectorAll('.scm-section')].find(x => /Staged/i.test(x.textContent)); return s ? parseInt(s.querySelector('.scm-count').textContent, 10) : 0 })()`)
    const commit = await js(`(() => { const b = document.querySelector('.scm-commit-btn'); return JSON.stringify({ disabled: b.disabled, title: b.title }) })()`)
    const c = JSON.parse(commit)
    if (staged === 0 && !c.disabled) throw new Error('Commit enabled with an empty index')
    if (c.disabled && !c.title) throw new Error('a disabled Commit must explain itself in its tooltip')
    const hint = await js(`document.querySelector('.scm-composer-hint')?.textContent || ''`)
    if (c.disabled && !hint) throw new Error('a disabled Commit must explain itself beside the button')
    // History is COLD: no log read until the section is opened. The channel is `gitLog` since
    // history became paged — `gitTimeline`'s fixed `log -n 30` was a ceiling, not a page, and the
    // panel no longer calls it. Asserting the OLD name here would pass forever by measuring a
    // counter nothing increments, which is worse than failing.
    const p0 = await scmPerf()
    if ((p0.ipc && p0.ipc.gitLog) || 0) throw new Error(`history was read before History was opened: ${JSON.stringify(p0.ipc)}`)
    if (await js(`document.querySelectorAll('.scm-commit').length`)) throw new Error('commit rows rendered while History is collapsed')
    await clickSection('History')
    const commits = await waitFor(`document.querySelectorAll('.scm-commit').length`, { timeout: 10000, what: 'commit rows after opening History' })
    const p1 = await scmPerf()
    if (!(p1.ipc && p1.ipc.gitLog >= 1)) throw new Error('opening History did not read the log')
    await clickSection('History')
    await waitFor(`document.querySelectorAll('.scm-commit').length === 0`, { what: 'History to fold' })
    await shot('git-drawer')
    return `branch "${branch}" · composer pinned · Commit ${c.disabled ? `disabled: "${hint}"` : 'enabled'} · History cold then ${commits} commits · last refresh ${p1.lastProcesses} git process(es) in ${p1.lastRefreshMs}ms`
  })

  await step('14e2. Clicking a changed file shows its diff with the comparison named; clicking again closes it', async () => {
    await openScm()
    // 14e1 deleted its file a moment ago; let the watcher-driven refresh catch up before clicking.
    await waitFor(`![...document.querySelectorAll('.scm-file')].some(r => /outside-edit-/.test(r.title))`, { timeout: 15000, what: 'the deleted 14e1 row to leave the list' })
    const rows = await waitFor(`document.querySelectorAll('.scm-file').length`, { timeout: 10000, what: 'at least one changed file' })
    const shape = await js(`(() => { const r = document.querySelector('.scm-file');
      return JSON.stringify({ leaf: r.querySelector('.scm-leaf')?.textContent || '', svg: !!r.querySelector('svg'), title: r.title || '', h: r.getBoundingClientRect().height }) })()`)
    const { leaf, svg, title, h } = JSON.parse(shape)
    if (!leaf || !svg) throw new Error('row lacks leaf name or icon')
    if (!title.includes(leaf)) throw new Error(`full path not on the title: "${title}"`)
    if (Math.round(h) !== 22) throw new Error(`rows must be 22px workbench rows, got ${h}`)
    await js(`document.querySelector('.scm-file').click()`)
    const mode = await waitFor(`document.querySelector('.scm-detail-mode')?.textContent || ''`, { timeout: 15000, what: 'the diff pane with its mode label' })
    if (!/HEAD|Index|New file|Conflict/.test(mode)) throw new Error(`diff pane does not name the comparison: "${mode}"`)
    await waitFor(`!!document.querySelector('.scm-detail .dl') || /empty|matches|Binary|large|Could not|No diff|conflict/i.test(document.querySelector('.scm-detail-body')?.textContent || '')`, { timeout: 15000, what: 'diff lines or an explanation' })
    await shot('git-diff-pane')
    await js(`document.querySelector('.scm-file').click()`)
    await waitFor(`!document.querySelector('.scm-detail')`, { what: 'the diff to close again' })
    return `${rows} rows of 22px with icon+leaf+path; diff pane labelled "${mode}"; toggles closed`
  })

  await step('14e3. A project with no upstream says so, and Push/Publish never lie', async () => {
    await openScm()
    await waitFor(`!!document.querySelector('.scm-head')`, { what: 'header' })
    const state = await js(`(() => { const strip = [...document.querySelectorAll('.scm-strip')].map(s => s.textContent.trim()).join(' || ');
      const push = document.querySelector('.scm-head [aria-label="Push"], .scm-head [aria-label="Publish branch"]');
      return JSON.stringify({ strip, push: push ? push.getAttribute('aria-label') + ': ' + push.title + (push.disabled ? ' [disabled]' : '') : 'NONE' }) })()`)
    const st = JSON.parse(state)
    if (st.push === 'NONE') throw new Error('no Push/Publish control in the header')
    const explained = /never been sent|Not connected|no remote|Publish|to /.test(st.strip + st.push)
    if (!explained) throw new Error(`neither the strip nor the push control explains where code goes: ${state}`)
    return `push control "${st.push.slice(0, 80)}" · strips "${st.strip.slice(0, 80) || '(none — connected)'}"`
  })

  // A THROWAWAY repository for the mutating steps: never the developer's real tree.
  const SCM_FIXTURE = path.join(__dirname, '..', '.ui-test', 'scm-fixture')
  const NON_REPO = path.join(os.tmpdir(), `studio-scm-not-a-repo-${process.pid}`)
  await step('14e4. 1,000 changes: exact counts, the composer stays put, and only a window of rows is mounted', async () => {
    const { execSync: x } = require('node:child_process')
    fs.rmSync(SCM_FIXTURE, { recursive: true, force: true })
    fs.mkdirSync(path.join(SCM_FIXTURE, 'src'), { recursive: true })
    const q = { shell: '/bin/bash', stdio: 'pipe' }
    x(`git init -q -b main "${SCM_FIXTURE}" && git -C "${SCM_FIXTURE}" config user.email ui@test && git -C "${SCM_FIXTURE}" config user.name UI`, q)
    fs.writeFileSync(path.join(SCM_FIXTURE, 'README.md'), '# fixture\n')
    fs.writeFileSync(path.join(SCM_FIXTURE, 'both.txt'), 'base\nline2\n')
    fs.writeFileSync(path.join(SCM_FIXTURE, 'src', 'app.js'), 'console.log(1)\n')
    x(`git -C "${SCM_FIXTURE}" add -A && git -C "${SCM_FIXTURE}" commit -qm init`, q)
    // MM: one staged edit, then a second working-tree edit on the same file.
    fs.writeFileSync(path.join(SCM_FIXTURE, 'both.txt'), 'base\nFIRST_EDIT_LINE\nline2\n')
    x(`git -C "${SCM_FIXTURE}" add both.txt`, q)
    fs.writeFileSync(path.join(SCM_FIXTURE, 'both.txt'), 'base\nFIRST_EDIT_LINE\nline2\nSECOND_EDIT_LINE\n')
    fs.writeFileSync(path.join(SCM_FIXTURE, 'src', 'app.js'), 'console.log(2)\n')
    fs.mkdirSync(path.join(SCM_FIXTURE, 'many'))
    for (let i = 1; i <= 1000; i++) fs.writeFileSync(path.join(SCM_FIXTURE, 'many', `f${String(i).padStart(4, '0')}.txt`), `${i}\n`)
    await openProjectAt(SCM_FIXTURE)
    await openScm()
    const counts = await waitFor(`(() => { const m = {}; for (const s of document.querySelectorAll('.scm-section')) m[s.querySelector('.scm-section-title').textContent] = s.querySelector('.scm-count').textContent; return m['Changes'] && parseInt(m['Changes'], 10) >= 1000 ? JSON.stringify(m) : '' })()`, { timeout: 30000, what: 'a Changes count of at least 1000' })
    const m = JSON.parse(counts)
    if (m['Changes'] !== '1002') throw new Error(`Changes count must be exactly 1002 (both.txt + app.js + 1000), got ${m['Changes']}`)
    if (m['Staged Changes'] !== '1') throw new Error(`Staged must be 1, got ${m['Staged Changes']}`)
    // `budget` is what windowing MAY legitimately mount: the rows the viewport actually shows,
    // plus the overscan on each side, plus slack. Hardcoding a number would fail on a taller
    // display for a list that is behaving perfectly.
    const geometry = () => js(`(() => { const c = document.querySelector('.scm-composer').getBoundingClientRect(); const p = document.querySelector('.left').getBoundingClientRect();
      const l = document.querySelector('.scm-list');
      return JSON.stringify({ visible: c.top >= p.top && c.bottom <= p.bottom && c.height > 30, mounted: l.querySelectorAll('.scm-row').length, scrollH: l.scrollHeight, budget: Math.ceil(l.clientHeight / 22) + 2 * 6 + 6 }) })()`).then(JSON.parse)
    const g0 = await geometry()
    if (!g0.visible) throw new Error('the commit composer is not visible with 1,002 changes')
    if (g0.mounted > g0.budget) throw new Error(`${g0.mounted} rows mounted for a viewport that shows ~${g0.budget - 18} — the list is not windowed`)
    if (g0.scrollH < 1000 * 22) throw new Error(`scroll height ${g0.scrollH} does not account for every row`)
    // Scroll to the very end: the last file is reachable, and the DOM is still a window.
    await js(`(() => { const l = document.querySelector('.scm-list'); l.scrollTop = l.scrollHeight; return true })()`)
    await waitFor(`[...document.querySelectorAll('.scm-file')].some(r => r.title.includes('src/app.js'))`, { what: 'the last row (src/app.js) to be mounted after scrolling to the end' })
    const g1 = await geometry()
    if (g1.mounted > g1.budget || !g1.visible) throw new Error(`after scrolling: ${g1.mounted} rows mounted (budget ${g1.budget}), composer visible=${g1.visible}`)
    await js(`(() => { document.querySelector('.scm-list').scrollTop = 0; return true })()`)
    // The refresh budget: at most three git processes, and no history/forge read.
    const pBefore = await scmPerf()
    await clickByLabel('.scm-head .scm-icon-btn', 'Refresh')
    await sleep(600)
    const perf = await scmPerf()
    if (perf.lastProcesses > 3) throw new Error(`a refresh cost ${perf.lastProcesses} git processes`)
    // `gitLog` is the channel history actually uses now; `gitTimeline` stays because the IPC still
    // exists, but on its own it would make this assertion vacuous — a counter nothing increments.
    const cold = ['gitLog', 'gitTimeline', 'forgeRepos', 'gitRemotes', 'gitBranches', 'gitCommitFiles'].map((k) => (perf.ipc[k] || 0) - (pBefore.ipc[k] || 0)).reduce((a, b) => a + b, 0)
    if (cold) throw new Error(`cold data was read by a plain refresh: before ${JSON.stringify(pBefore.ipc)} after ${JSON.stringify(perf.ipc)}`)
    await shot('git-1000-changes')
    return `Changes 1002 exact · Staged 1 · ${g0.mounted} rows mounted (→ ${g1.mounted} at the end, budget ${g0.budget}) of ${g0.scrollH / 22} · composer visible · refresh = ${perf.lastProcesses} process(es), ${perf.lastRefreshMs}ms · ${perf.refreshes} refreshes, ${perf.coalesced} coalesced, ${perf.dropped} dropped`
  })

  await step('14e5. An MM file is in BOTH lists, and each row shows only its own half of the change', async () => {
    await openScm()
    await waitFor(`!!document.querySelector('[data-key="staged:both.txt"]') && !!document.querySelector('[data-key="unstaged:both.txt"]')`, { timeout: 10000, what: 'both.txt in Staged AND Changes' })
    const adds = () => js(`[...document.querySelectorAll('.scm-detail .dl-add')].map(e => e.textContent).join('|')`)
    await js(`document.querySelector('[data-key="staged:both.txt"]').click()`)
    await waitFor(`/Index ↔ HEAD/.test(document.querySelector('.scm-detail-mode')?.textContent || '') && document.querySelectorAll('.scm-detail .dl').length > 0`, { timeout: 15000, what: 'the staged diff' })
    const s = await adds()
    if (!/FIRST_EDIT_LINE/.test(s) || /SECOND_EDIT_LINE/.test(s)) throw new Error(`staged row must show index↔HEAD only: "${s}"`)
    await js(`document.querySelector('[data-key="unstaged:both.txt"]').click()`)
    await waitFor(`/Working tree ↔ Index/.test(document.querySelector('.scm-detail-mode')?.textContent || '') && /SECOND_EDIT_LINE/.test(document.querySelector('.scm-detail')?.textContent || '')`, { timeout: 15000, what: 'the unstaged diff' })
    const u = await adds()
    if (!/SECOND_EDIT_LINE/.test(u) || /FIRST_EDIT_LINE/.test(u)) throw new Error(`unstaged row must show worktree↔index only: "${u}"`)
    await shot('git-mm-diff')
    await key('Escape')
    return `staged adds "${s}" · unstaged adds "${u}"`
  })

  await step('14e6. Keyboard-first: arrows, Enter opens the diff, Space stages/unstages, Shift-range and ⌘-click multi-select', async () => {
    await openScm()
    await waitFor(`!!document.querySelector('[data-key="staged:both.txt"]')`, { what: 'the staged row' })
    await js(`document.querySelector('.scm-list').focus(); true`)
    await key('Home') // the Staged header, whatever the previous step left focused
    await key('Down') // header → first staged row
    const focused = await waitFor(`document.activeElement?.getAttribute('data-key') || ''`, { what: 'a focused row' })
    if (focused !== 'staged:both.txt') throw new Error(`ArrowDown focused "${focused}", expected staged:both.txt`)
    await key('Return')
    await waitFor(`/Index ↔ HEAD/.test(document.querySelector('.scm-detail-mode')?.textContent || '')`, { timeout: 15000, what: 'Enter to open the staged diff' })
    // Space on a staged row unstages it: the Staged section empties and the row is gone.
    await key('Space')
    await waitFor(`!document.querySelector('[data-key="staged:both.txt"]') && ![...document.querySelectorAll('.scm-section-title')].some(t => /Staged/.test(t.textContent))`, { timeout: 15000, what: 'Space to unstage the focused row' })
    if (await js(`!!document.querySelector('.scm-detail')`)) throw new Error('the staged diff stayed open for a row that left the Staged list')
    // Down into Changes, Shift+Down to grow a range of two rows, Space stages both.
    await key('Down'); await key('Down')
    const first = await js(`document.activeElement?.getAttribute('data-key') || ''`)
    if (first !== 'unstaged:both.txt') throw new Error(`expected focus on unstaged:both.txt, got "${first}"`)
    await key('Down', ['shift'])
    const selCount = await js(`document.querySelectorAll('.scm-row.scm-sel').length`)
    if (selCount !== 2) throw new Error(`Shift+Down should select 2 rows, got ${selCount}`)
    await key('Space')
    // git lists tracked changes before untracked ones, so the row after both.txt is src/app.js.
    await waitFor(`!!document.querySelector('[data-key="staged:both.txt"]') && !!document.querySelector('[data-key="staged:src/app.js"]')`, { timeout: 15000, what: 'both selected rows to be staged' })
    // ⌘-click adds a second row to the selection without dropping the first.
    await js(`document.querySelector('[data-key="staged:both.txt"]').click(); true`)
    await js(`(() => { const r = document.querySelector('[data-key="staged:src/app.js"]'); r.dispatchEvent(new MouseEvent('click', { bubbles: true, ${process.platform === 'darwin' ? 'metaKey' : 'ctrlKey'}: true })); return true })()`)
    const multi = await js(`[...document.querySelectorAll('.scm-row.scm-sel')].map(r => r.getAttribute('data-key')).join('|')`)
    if (multi !== 'staged:both.txt|staged:src/app.js') throw new Error(`⌘-click selection: "${multi}"`)
    // Unstage all from the section toolbar, so the fixture is back to one staged file for the commit step.
    await clickByLabel('.scm-section .scm-act', 'Unstage all')
    await waitFor(`![...document.querySelectorAll('.scm-section-title')].some(t => /Staged/.test(t.textContent))`, { timeout: 15000, what: 'Unstage all to empty the section' })
    // The list is WINDOWED: a row the viewport has scrolled past is genuinely not in the DOM, so
    // scroll back to the top and wait for the row to mount before reaching for its hover action.
    await js(`(() => { document.querySelector('.scm-list').scrollTop = 0; return true })()`)
    await waitFor(`!!document.querySelector('[data-key="unstaged:both.txt"] .scm-act')`, { timeout: 8000, what: 'both.txt mounted at the top of Changes' })
    await clickByLabel('[data-key="unstaged:both.txt"] .scm-act', 'Stage both.txt')
    await waitFor(`!!document.querySelector('[data-key="staged:both.txt"]')`, { timeout: 15000, what: 'both.txt staged again via the hover action' })
    await key('Escape')
    return 'Down → Enter opened the diff · Space unstaged · Shift+Down range → Space staged 2 · ⌘-click multi-select · section Unstage all · row hover Stage'
  })

  await step('14e7. ⌘Enter in the composer commits STAGED content only, and History shows it', async () => {
    await openScm()
    await waitFor(`!!document.querySelector('[data-key="staged:both.txt"]')`, { what: 'one staged file' })
    // Re-create the MM split this step exists to test. 14e6 legitimately consumed the fixture's
    // original one (it unstaged and re-staged both.txt), so the state is built here rather than
    // inherited: a third edit lands in the working tree while the first two sit in the index.
    fs.appendFileSync(path.join(SCM_FIXTURE, 'both.txt'), 'THIRD_EDIT_LINE\n')
    await waitFor(`!!document.querySelector('[data-key="staged:both.txt"]') && !!document.querySelector('[data-key="unstaged:both.txt"]')`, { timeout: 15000, what: 'both.txt in Staged AND Changes again' })
    const before = await js(`parseInt([...document.querySelectorAll('.scm-section')].find(s => /^Changes/.test(s.textContent)).querySelector('.scm-count').textContent, 10)`)
    await js(`document.querySelector('.scm-composer-input').focus(); true`)
    typeText('Keyboard commit from the UI suite')
    await waitFor(`document.querySelector('.scm-composer-input').value.includes('Keyboard commit')`, { what: 'the typed message' })
    await waitFor(`!document.querySelector('.scm-commit-btn').disabled`, { what: 'Commit to enable once staged + message' })
    await key('Return', [MOD])
    /* On timeout, say what the view actually shows. This step has failed in full runs while every
       targeted reproduction of it passed (2026-09-03), so the useful thing is the state at the
       moment it gives up — sections, composer, what has focus, and any message the view is
       showing — rather than one more "timed out". */
    try {
      await waitFor(`![...document.querySelectorAll('.scm-section-title')].some(t => /Staged/.test(t.textContent)) && document.querySelector('.scm-composer-input').value === ''`, { timeout: 20000, what: 'the commit to land and the composer to clear' })
    } catch (err) {
      const state = await js(`JSON.stringify({
        sections: [...document.querySelectorAll('.scm-section-title')].map(t => t.textContent),
        composer: document.querySelector('.scm-composer-input')?.value ?? '(no composer)',
        commitDisabled: document.querySelector('.scm-commit-btn')?.disabled ?? null,
        active: document.activeElement?.className || '(body)',
        strips: [...document.querySelectorAll('.scm-strip')].map(e => e.textContent.trim()).slice(0, 3),
        toast: document.querySelector('.toast')?.textContent?.trim() || '' })`)
      const head = require('node:child_process').execSync(`git -C "${SCM_FIXTURE}" log --oneline -2`, { shell: '/bin/bash' }).toString().trim().replace(/\n/g, ' | ')
      throw new Error(`${err.message} — view: ${state} — git: ${head}`)
    }
    const after = await js(`parseInt([...document.querySelectorAll('.scm-section')].find(s => /^Changes/.test(s.textContent)).querySelector('.scm-count').textContent, 10)`)
    // both.txt's UNSTAGED half must still be there: only the index was committed.
    if (!(await js(`!!document.querySelector('[data-key="unstaged:both.txt"]')`))) throw new Error('the unstaged half of both.txt vanished — did the commit stage everything?')
    if (after !== before) throw new Error(`Changes count moved from ${before} to ${after}; a staged-only commit must not touch it`)
    await clickSection('History')
    const subject = await waitFor(`document.querySelector('.scm-commit .scm-subject')?.textContent || ''`, { timeout: 15000, what: 'the new commit at the top of History' })
    if (!/Keyboard commit/.test(subject)) throw new Error(`History top is "${subject}"`)
    const { execSync: x } = require('node:child_process')
    const disk = x(`git -C "${SCM_FIXTURE}" show --stat --format=%s HEAD`, { shell: '/bin/bash' }).toString()
    if (!/Keyboard commit/.test(disk) || !/both\.txt/.test(disk) || /many\//.test(disk)) throw new Error(`commit on disk is wrong: ${disk.slice(0, 200)}`)
    await clickSection('History')
    return `committed both.txt only (Changes stayed ${after}); History shows "${subject}"; git log agrees`
  })

  await step('14e8. Sections fold and unfold; the minimum window still shows header, composer and list', async () => {
    await openScm()
    const rowsBefore = await waitFor(`document.querySelectorAll('.scm-file').length`, { what: 'file rows' })
    await clickSection('Changes')
    await waitFor(`document.querySelectorAll('.scm-file').length === 0`, { what: 'Changes to fold' })
    await clickSection('Changes')
    await waitFor(`document.querySelectorAll('.scm-file').length > 0`, { what: 'Changes to unfold' })
    // Keyboard fold: focus the header, ArrowLeft folds, ArrowRight unfolds.
    await js(`document.querySelector('.scm-list').focus(); true`)
    await key('Home')
    await key('Left')
    await waitFor(`document.querySelectorAll('.scm-file').length === 0`, { what: 'ArrowLeft to fold the focused section' })
    await key('Right')
    await waitFor(`document.querySelectorAll('.scm-file').length > 0`, { what: 'ArrowRight to unfold' })
    // Minimum window size: everything essential stays on screen and nothing scrolls sideways.
    const bounds = win.getBounds()
    win.setSize(1024, 680)
    await sleep(600)
    const fit = await js(`(() => { const p = document.querySelector('.left').getBoundingClientRect(); const c = document.querySelector('.scm-composer').getBoundingClientRect(); const h = document.querySelector('.scm-head').getBoundingClientRect(); const l = document.querySelector('.scm-list').getBoundingClientRect(); const s = document.querySelector('.scm');
      return JSON.stringify({ w: window.innerWidth, head: h.height, composer: c.bottom <= p.bottom && c.top >= p.top, list: l.height > 40, noXScroll: s.scrollWidth <= s.clientWidth + 1, wide: s.dataset.wide }) })()`)
    const f = JSON.parse(fit)
    await shot('git-min-window')
    win.setSize(bounds.width, bounds.height)
    await sleep(400)
    if (f.w !== 1024) throw new Error(`window did not shrink: ${fit}`)
    if (!f.composer || !f.list || !f.noXScroll || Math.round(f.head) !== 22) throw new Error(`minimum-size layout broke: ${fit}`)
    return `fold/unfold by click and by ←/→ (${rowsBefore} rows) · at 1024×680: header 22px, composer visible, list ${f.list ? 'usable' : 'gone'}, no horizontal scroll, layout=${f.wide === 'true' ? 'side-by-side' : 'stacked'}`
  })

  await step('14e9. Not a repository: an honest empty state with the clone command, and no fake controls', async () => {
    fs.rmSync(NON_REPO, { recursive: true, force: true })
    fs.mkdirSync(NON_REPO, { recursive: true })
    fs.writeFileSync(path.join(NON_REPO, 'index.html'), '<h1>no git here</h1>\n')
    let text = ''
    try {
      await openProjectAt(NON_REPO)
      await openScm()
      text = await waitFor(`/not a git repository/i.test(document.querySelector('.scm-empty')?.textContent || '') ? document.querySelector('.scm-empty').textContent : ''`, { timeout: 15000, what: 'the not-a-repository empty state' })
      if (await js(`!!document.querySelector('.scm-head') || !!document.querySelector('.scm-composer')`)) throw new Error('header/composer rendered for a non-repository')
      await clickByText('.scm-empty .btn', 'Clone repository')
      await waitFor(`!!document.querySelector('.scm-clone input[placeholder^="ssh://"]')`, { what: 'the clone sheet from the empty state' })
      await shot('git-empty-state')
    } finally {
      // Back to the real fixture for everything that follows — whatever happened above, the rest
      // of the suite must not run against a throwaway folder.
      await openProjectAt(PROJECT)
      fs.rmSync(SCM_FIXTURE, { recursive: true, force: true })
      fs.rmSync(NON_REPO, { recursive: true, force: true })
    }
    return `empty state: "${text.trim().slice(0, 70)}" → clone sheet opens; back on hello-vite`
  })

  const REMOTE_FILE = path.join(SSH_FIXTURE, 'src', 'server.py')
  await step('14f. 🏢 Company Server: connect over SSH and edit code IN PLACE on the server', async () => {
    await openPanelTab('Workspaces')
    await waitFor(`!!document.querySelector('.remote-drawer')`, { what: 'company drawer' })
    const set = (ph, val) =>
      js(`(() => {
        const el = [...document.querySelectorAll('.remote-form input.text-input')].find(i => (i.placeholder||'').startsWith(${JSON.stringify(ph)}));
        if (!el) return 'NOT_FOUND';
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(val)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'OK' })()`).then((r) => {
        if (r !== 'OK') throw new Error(`set "${ph}" → ${r}`)
      })
    await set('Server address', 'aws.fake.company')
    await set('User', 'deploy')
    await set('SSH key path', '')
    await set('Project folder on the server', SSH_FIXTURE)
    await clickByText('.remote-form .btn', 'Connect')
    await waitFor(`!!document.querySelector('.remote-connected')`, { timeout: 15000, what: 'connected view' })

    // Browse into src/ and open the server file — it must arrive as an ssh:// tab.
    await waitFor(`[...document.querySelectorAll('.remote-files .tree-name')].some(e => e.textContent === 'src')`, { what: 'src dir listed' })
    await clickByText('.remote-files .tree-row', 'src')
    await waitFor(`[...document.querySelectorAll('.remote-files .tree-name')].some(e => e.textContent === 'server.py')`, { timeout: 10000, what: 'server.py listed' })
    await clickByText('.remote-files .tree-row', 'server.py')
    const tabOrErr = await waitFor(
      `(() => {
        if ([...document.querySelectorAll('.tab .tab-name')].some(e => e.textContent === 'server.py')) return 'TAB';
        const err = document.querySelector('.error-box')?.textContent;
        return err ? 'ERRBOX: ' + err : false;
      })()`,
      { timeout: 10000, what: 'ssh tab created (or an error surfaced)' }
    )
    if (tabOrErr !== 'TAB') throw new Error(tabOrErr)
    // NOTE: Monaco renders spaces as NBSP in .view-lines — normalize before matching.
    await waitFor(
      `!!window.__studioEditor && (document.querySelector('.monaco-editor .view-lines')?.textContent || '').replace(/\\u00a0/g, ' ').includes('company code')`,
      { timeout: 15000, what: 'server file in editor' }
    )
    // Edit + ⌘S → lands on the "server" (fixture), never on local project disk.
    await typeVerified('# EDITED_ON_SERVER\n')
    await saveShortcut()
    await waitFor(() => fs.readFileSync(REMOTE_FILE, 'utf8').includes('EDITED_ON_SERVER'), {
      timeout: 10000,
      what: 'edit landed on the server'
    })
    // The save must be audited as a remote-save — assert here, at its source,
    // where it is the freshest event. (The persistent audit.log grows across
    // runs, and auditTail() is a bounded 50-line window, so checking it two
    // steps later races the window and flakes; check it now instead.)
    await waitFor(`window.studio.auditTail().then(a => a.some(e => e.event === 'remote-save'))`, {
      timeout: 8000,
      what: 'remote-save audited'
    })
    // The status bar must show the always-visible connection chip.
    const chip = await waitFor(
      `[...document.querySelectorAll('.statusbar .status-chip')].map(c => c.textContent).find(t => t.includes('Company server')) || false`,
      { timeout: 8000, what: 'company status chip' }
    )
    await shot('company-server')
    return `edited in place on the server · statusbar: "${chip.trim()}"`
  })

  await step('14g. Protection policy: copying server code is BLOCKED and audited; 🚩 Report works', async () => {
    // Select all in the protected server tab and copy (the same DOM 'copy'
    // event a real ⌘C produces via the Edit menu / webContents.copy()).
    await js(`(() => { const ed = window.__studioEditor; ed.focus();
      ed.setSelection(ed.getModel().getFullModelRange());
      document.execCommand('copy'); return 'OK' })()`)
    await waitFor(`(document.querySelector('.error-box')?.textContent || '').includes('company policy')`, {
      timeout: 8000,
      what: 'copy-blocked message'
    })
    const audits = await js(`window.studio.auditTail()`)
    if (!audits.some((a) => a.event === 'copy-blocked')) throw new Error('copy-blocked not in audit log')

    await clickByText('.remote-files .btn', 'Report')
    await waitFor(`(document.querySelector('.ok-box, .error-box')?.textContent || '').toLowerCase().includes('logged')`, {
      timeout: 8000,
      what: 'report acknowledged'
    })
    await shot('policy-blocked')
    // Close the server tab + drawer so the next steps start clean.
    await closeTabsDiscarding()
    await clickSel('.panel-close')
    return 'copy blocked + audited (copy-blocked) + report logged'
  })

  const WS_FIXTURE = path.join(__dirname, '..', '.ui-test', 'ws-new')
  await step('14h. ATOMIC Workspaces: two-tier chooser → provision on "your server" → open → delete', async () => {
    fs.rmSync(WS_FIXTURE, { recursive: true, force: true })
    await openPanelTab('Workspaces')
    // 14g left the direct-connect session open — the workspace home shows when disconnected.
    if (await js(`!!document.querySelector('.remote-connected')`)) {
      await clickByText('.remote-files .btn', 'Disconnect')
      await waitFor(`!document.querySelector('.remote-connected')`, { what: 'disconnected' })
    }
    await waitFor(`!!document.querySelector('.ws-home')`, { what: 'workspaces home' })
    // Phase 3: the Private ATOMIC Server tier is offered alongside the two cards.
    if (!(await js(`(document.querySelector('.ws-home')?.textContent || '').includes('Private ATOMIC Server')`)))
      throw new Error('Private Server tier note missing')

    // Two-tier chooser with the commercial copy.
    await clickByText('.ws-home .btn', 'New workspace')
    await waitFor(`document.querySelectorAll('.ws-card').length === 2`, { what: 'two tier cards' })
    const cards = await js(`document.querySelector('.ws-cards')?.textContent || ''`)
    if (!cards.includes('$9/month')) throw new Error('cloud pricing missing')
    if (!cards.includes('Free · unlimited')) throw new Error('free tier copy missing')
    if (!cards.includes('never') && !cards.includes('No meters')) throw new Error('no-metering promise missing')
    await shot('ws-chooser')

    // Create on "your own server" (fake ssh → local fixture).
    await clickByText('.ws-card', 'Your own server')
    await waitFor(`!!document.querySelector('.ws-newform')`, { what: 'company form' })
    const set = (ph, val) =>
      js(`(() => {
        const el = [...document.querySelectorAll('.ws-newform input.text-input')].find(i => (i.placeholder||'').startsWith(${JSON.stringify(ph)}));
        if (!el) return 'NOT_FOUND';
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(val)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'OK' })()`).then((r) => {
        if (r !== 'OK') throw new Error(`set "${ph}" → ${r}`)
      })
    await set('Workspace name', 'demo-pharmacy')
    await set('Server address', 'byo.fake.company')
    await set('User', 'deploy')
    await set('SSH key path', '')
    await set('New workspace folder', WS_FIXTURE)
    await clickByText('.ws-newform .btn', 'Create workspace')
    await waitFor(() => fs.existsSync(path.join(WS_FIXTURE, 'index.html')), {
      timeout: 15000,
      what: 'template provisioned on the "server"'
    })

    // Listed with the tier badge, then open it.
    await waitFor(`[...document.querySelectorAll('.ws-row .ws-name')].some(e => e.textContent === 'demo-pharmacy')`, { what: 'workspace listed' })
    const badge = await textOf('.ws-row .ws-badge')
    if (badge !== 'Your server') throw new Error(`badge = ${badge}`)
    await shot('ws-list')
    await clickByText('.ws-row .btn', 'Open')
    await waitFor(`!!document.querySelector('.remote-connected')`, { timeout: 15000, what: 'workspace opened' })
    await waitFor(`[...document.querySelectorAll('.remote-files .tree-name')].some(e => e.textContent === 'index.html')`, {
      timeout: 10000,
      what: 'provisioned files listed'
    })
    await shot('ws-open')

    // Workspace snapshot via the UI, then restore appears.
    await js(`(() => {
      const el = [...document.querySelectorAll('.ws-tools input')].find(i => (i.placeholder||'').startsWith('Snapshot'));
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'before-experiments');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
    await clickByText('.ws-tools .btn', 'Snapshot')
    await waitFor(`[...document.querySelectorAll('.snap-name')].some(e => e.textContent === 'before-experiments')`, {
      timeout: 15000,
      what: 'snapshot listed with Restore'
    })
    if (!fs.existsSync(path.join(WS_FIXTURE, '.studio-snapshots'))) throw new Error('snapshot not on the server')

    // Port forwarding: fake ssh holds -N tunnels open.
    await js(`(() => {
      const el = [...document.querySelectorAll('.ws-tools input')].find(i => (i.placeholder||'').startsWith('Forward'));
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, '9313');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
    await clickByText('.ws-tools .btn', 'Forward')
    await waitFor(`[...document.querySelectorAll('.snap-name')].some(e => e.textContent.includes('localhost:9313'))`, {
      timeout: 15000,
      what: 'tunnel listed'
    })
    await shot('ws-snapshot-tunnel')
    await clickByText('.snap-row .btn', 'Close')
    await waitFor(`![...document.querySelectorAll('.snap-name')].some(e => e.textContent.includes('localhost:9313'))`, { what: 'tunnel closed' })

    await clickByText('.remote-files .btn', 'Disconnect')
    await waitFor(`!document.querySelector('.remote-connected')`, { what: 'disconnected again' })

    // Two-step delete (arm → confirm); server files must survive.
    await clickByText('.ws-row .btn', 'Delete')
    await clickByText('.ws-row .btn', 'Confirm delete')
    await waitFor(`![...document.querySelectorAll('.ws-row .ws-name')].some(e => e.textContent === 'demo-pharmacy')`, { what: 'row removed' })
    if (!fs.existsSync(path.join(WS_FIXTURE, 'index.html'))) throw new Error('server files were deleted!')
    await clickSel('.panel-close')
    return 'chooser ✓ pricing ✓ provision ✓ badge ✓ open ✓ files ✓ safe delete ✓'
  })

  await step('14i. ⌘⇧P command palette runs commands; ⌘N opens a second window', async () => {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', metaKey: true, shiftKey: true })), 'ok'`)
    await waitFor(`!!document.querySelector('.palette')`, { what: 'palette open' })
    await js(`(() => {
      const el = document.querySelector('.palette-input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'Terminal');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
    await sleep(200)
    await shot('palette')
    await js(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 'ok'`)
    await waitFor(`!!document.querySelector('.term-drawer')`, { what: 'palette opened the Terminal tab' })
    await clickSel('.panel-close')

    // Multi-window: a second, independent Studio window.
    const before = BrowserWindow.getAllWindows().length
    await js(`window.studio.newWindow(), 'ok'`)
    await waitFor(() => BrowserWindow.getAllWindows().length === before + 1, { timeout: 10000, what: 'second window' })
    const extra = BrowserWindow.getAllWindows().find((w) => w !== win)
    extra.close()
    await waitFor(() => BrowserWindow.getAllWindows().length === before, { what: 'second window closed' })
    return 'palette → Terminal ✓ · second window opened + closed ✓'
  })

  await step('14j. Problems panel collects preview errors; ⌘P Search Everywhere jumps to symbols', async () => {
    // Throw a real error inside the running preview → Problems row.
    const guests0 = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    // (preview was stopped in step 11 — trigger via a fresh quick run)
    await clickByText('.topbar-actions .btn', 'Run preview')
    await waitFor(`!!document.querySelector('.tab-preview .badge-running')`, { timeout: 60000, what: 'preview up' })
    await sleep(1500)
    const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    await guests[0].executeJavaScript(`setTimeout(() => { throw new Error('BOOM_PROBLEM_TEST') }, 10), 'ok'`)
    await openPanelTab('Problems')
    await waitFor(`[...document.querySelectorAll('.problem-msg')].some(e => e.textContent.includes('BOOM_PROBLEM_TEST'))`, {
      timeout: 10000,
      what: 'problem row'
    })
    // The count is a separate badge now, not "(3)" glued onto the label — that is what keeps the
    // tab from changing width as problems arrive. So assert the two facts separately: the label is
    // still the plain word, and the badge carries a real number.
    const tabParts = await js(`(() => {
      const b = [...document.querySelectorAll('.panel-tabs [role="tab"]')].find(x => x.textContent.includes('Problems'));
      if (!b) return null;
      const badge = b.querySelector('.panel-count');
      return { label: b.firstChild?.textContent?.trim() || '', count: badge ? badge.textContent.trim() : '' } })()`)
    if (!tabParts) throw new Error('no Problems tab in the panel tablist')
    if (tabParts.label !== 'Problems') throw new Error(`tab label = ${JSON.stringify(tabParts.label)}`)
    if (!/^[1-9]\d*$/.test(tabParts.count)) throw new Error(`count badge = ${JSON.stringify(tabParts.count)}`)
    await shot('problems')
    await clickByText('.problems-toolbar .btn', 'Clear all')
    await waitFor(`document.querySelectorAll('.problem-row').length === 0`, { what: 'cleared' })
    await clickByText('.topbar-actions .btn', 'Stop')
    await waitFor(`!document.querySelector('.tab-preview .badge-running')`, { what: 'stopped' })
    await clickSel('.panel-close')

    // ⌘P quick-open over the AI index: find the App symbol in main.tsx.
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true })), 'ok'`)
    await waitFor(`!!document.querySelector('.quickopen')`, { what: 'quick-open' })
    await js(`(() => {
      const el = document.querySelector('.quickopen .palette-input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'App');
      el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
    await waitFor(`document.querySelectorAll('.quickopen .palette-item').length > 0`, { timeout: 10000, what: 'index hits' })
    await shot('quickopen')
    await js(`document.querySelector('.quickopen .palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), 'ok'`)
    await waitFor(`[...document.querySelectorAll('.tab .tab-name')].some(e => e.textContent === 'main.tsx')`, { timeout: 10000, what: 'file opened from index' })
    await closeTabsDiscarding()

    // Extensions tab in Settings: real toggles present, auto-fix flips + persists.
    await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.settings-tabs')`, { what: 'settings' })
    await clickByText('.settings-tabs .seg-btn', 'Extensions')
    // Studio's own features are rows in the Extensions view now, with an Enable/Disable action —
    // the same shape a connector or a theme gets, rather than a checkbox in a settings tab.
    await waitFor(`!!document.querySelector('.ext-view')`, { what: 'extensions view' })
    const toggles = await waitFor(`document.querySelectorAll('.ext-row').length`, { what: 'extension rows' })
    if (toggles < 4) throw new Error(`only ${toggles} extension entries`)
    const flipAutoFix = `(() => {
      const row = [...document.querySelectorAll('.ext-row')].find(r => r.textContent.includes('Auto-fix'));
      if (!row) return 'NO_ROW';
      const b = row.querySelector('.ext-action');
      if (!b) return 'NO_BUTTON';
      b.click(); return 'OK' })()`
    if ((await js(flipAutoFix)) !== 'OK') throw new Error('no Auto-fix row with an action button')
    const stored = await waitFor(`localStorage.getItem('studio.ext.autofix')`, { what: 'autofix pref written' })
    if (stored !== 'off') throw new Error(`autofix pref = ${stored}`)
    await js(flipAutoFix)
    await clickByLabel('.topbar-actions .btn', 'Settings')
    return 'problem captured+badge+clear ✓ · ⌘P → symbol → file ✓ · extensions toggle persisted ✓'
  })

  await step('14k. Wave 1: Insight/Explainer + Tech-Debt Radar + agent mode control + Smart Terminal explain', async () => {
    // Insight tab: radar populates from the background index; Explain calls the mock model.
    await openInsight()
    // Wave 4: the Project Health scorecard renders at the top with a numeric score.
    await waitFor(`!!document.querySelector('.iv-tile-score')`, { timeout: 12000, what: 'the project snapshot' })
    const healthScore = await js(`parseInt((document.querySelector('.iv-tile-score')?.textContent || 'x').replace(/[^0-9]/g, ' ').trim().split(' ')[0] || 'x', 10)`)
    if (!Number.isFinite(healthScore) || healthScore < 0 || healthScore > 100) throw new Error('health score out of range: ' + healthScore)
    // The score must reflect a real signal: hello-vite has no tests → a "tests: none found"
    // tile and a sub-100 score (catches a hardcoded/constant score).
    const noTests = await js(`[...document.querySelectorAll('.iv-tile')].some(t => /^tests:\\s*none found$/.test(t.textContent))`)
    if (!noTests) throw new Error('health card missing the tests: none found tile')
    if (healthScore >= 100) throw new Error('a no-tests project must not score a perfect 100: ' + healthScore)
    // PRODUCT GAP: the rebuild reads analytics but no renderer calls analyticsRecord anymore.
    // Keep the snapshot assertion: opening Insight must record today's measurement.
    await waitFor(`window.studio.analyticsList(${JSON.stringify(PROJECT)}).then(a => a.length >= 1)`, { timeout: 6000, what: 'analytics snapshot recorded' })
    writeAgentScript(['This project is a small Vite React app. Run it with npm run dev.'])
    await clickByText('.iv .btn', 'Explain this project')
    await waitFor(`(document.querySelector('.insight-explain')?.textContent || '').includes('Vite React app')`, {
      timeout: 15000,
      what: 'project explanation'
    })
    await runInsightCheck('Tests and debt')
    // hello-vite has no tests → radar shows an "untested" signal.
    await waitFor(`[...document.querySelectorAll('.iv-row .ws-badge')].some(b => b.textContent === 'untested')`, {
      timeout: 8000,
      what: 'tech-debt radar'
    })
    // Wave 3: the Live Architecture Map renders in the same Insight tab (no model).
    await openInsight('Code Map')
    await waitFor(`!!document.querySelector('.arch-map .arch-row, .arch-map .iv-empty')`, {
      timeout: 8000,
      what: 'architecture map'
    })
    const archContent = await js(`document.querySelectorAll('.arch-map .arch-row').length + document.querySelectorAll('.arch-map .arch-chip').length`)
    if (!archContent) throw new Error('architecture map rendered no modules/deps/entries')
    // Wave 20: Project X-ray — the three read-only cards render (rows OR a graceful empty state), no throw.
    for (const t of ['Possibly unused', 'Handle with care', 'Tangled files']) await openInsightSection(t)
    await waitFor(`!!document.querySelector('.orphans-card') && !!document.querySelector('.fragile-card') && !!document.querySelector('.tangle-card')`, { timeout: 8000, what: 'Project X-ray sections (unused/fragile/tangle)' })
    // Each card must carry a subhead and either data rows or a plain-English empty state (never blank/undefined).
    for (const card of ['.orphans-card', '.fragile-card', '.tangle-card']) {
      const txt = await js(`(document.querySelector('${card}')?.textContent || '') + '|' + (document.querySelector('${card} .iv-row') ? 'rows' : (document.querySelector('${card} .iv-empty') ? 'empty' : 'NONE'))`)
      if (/\|NONE$/.test(txt) || /undefined/i.test(txt)) throw new Error(`${card} must show rows or a graceful empty state: ${txt}`)
    }
    // hello-vite has no import cycles → the Tangle card shows the clean "no tangles" state.
    if (!(await js(`/No loops — nothing depends on itself in a circle\./i.test(document.querySelector('.tangle-card').textContent)`))) throw new Error('a clean project must show the "no tangles" state')
    // No card may render a bare empty box: an empty state must carry a REASON the CEO can act on
    // (why it's empty), never just disappear. Guards the "silently empty = falsely clean" failure.
    for (const card of ['.orphans-card', '.fragile-card', '.tangle-card']) {
      const empty = await js(`!document.querySelector('${card} .iv-row')`)
      if (empty) {
        const reason = await js(`(document.querySelector('${card} .iv-empty')?.textContent || '').trim()`)
        if (reason.length < 15) throw new Error(`${card} is empty with no plain-English reason: "${reason}"`)
      }
    }
    // The orphans card must never print the definitive "nobody imports it" while its graph is truncated.
    const honest = await js(`(() => { const c = document.querySelector('.orphans-card'); if (!c) return true
      const partial = /partial view/i.test(c.textContent); return !(partial && /nobody imports it/.test(c.textContent)) })()`)
    if (!honest) throw new Error('a partial import graph must NOT claim "nobody imports it"')
    // NON-VACUOUS pass: every assertion above is satisfied by three EMPTY cards on a clean project, so
    // it would still pass if the folds returned nothing at all. Seed a real dead file and a real import
    // loop, prove both cards actually render them, then remove the files and prove the cards go clean.
    const xrayFiles = { orphan: 'src/w20-orphan.ts', a: 'src/w20-loop-a.ts', b: 'src/w20-loop-b.ts' }
    try {
      await js(`window.studio.writeFile(${JSON.stringify(PROJECT)}, ${JSON.stringify(xrayFiles.orphan)}, 'export const w20Unused = () => 42\\n')`)
      await js(`window.studio.writeFile(${JSON.stringify(PROJECT)}, ${JSON.stringify(xrayFiles.a)}, "import { bee } from './w20-loop-b'\\nexport const ay = () => bee()\\n")`)
      await js(`window.studio.writeFile(${JSON.stringify(PROJECT)}, ${JSON.stringify(xrayFiles.b)}, "import { ay } from './w20-loop-a'\\nexport const bee = () => ay\\n")`)
      // Wait until the re-indexed graph carries the loop, then re-enter Insight so the cards re-fold.
      await waitFor(`window.studio.architectureMap(${JSON.stringify(PROJECT)}).then(m => m.edges.some(e => /w20-loop-a/.test(e.from) && /w20-loop-b/.test(e.to)))`, { timeout: 10000, what: 'index picks up the seeded files' })
      await openPanelTab('Activity')
      await openInsight()
      await openInsight('Code Map')
      for (const t of ['Possibly unused', 'Tangled files']) await openInsightSection(t)
      // The dead file must be listed BY NAME under "Probably safe to remove".
      await waitFor(`[...document.querySelectorAll('.orphans-card .debt-detail')].some(d => /w20-orphan/.test(d.textContent))`, { timeout: 8000, what: 'seeded dead file listed as probably-safe-to-remove' })
      // The two files in the loop are imported BY EACH OTHER, so neither may be called deletable.
      if (await js(`[...document.querySelectorAll('.orphans-card .debt-detail')].some(d => /w20-loop-/.test(d.textContent))`))
        throw new Error('a file that IS imported (by the other half of the loop) must never be offered for deletion')
      // The tangle card must name both halves of the real circular import.
      await waitFor(`[...document.querySelectorAll('.tangle-card .debt-detail')].some(d => /w20-loop-a/.test(d.textContent) && /w20-loop-b/.test(d.textContent))`, { timeout: 8000, what: 'seeded circular import reported as a tangle' })
      if (await js(`/No loops — nothing depends on itself in a circle\./i.test(document.querySelector('.tangle-card').textContent)`)) throw new Error('a project WITH a real loop must not still say "no tangles"')
      await shot('wave20-xray')
    } finally {
      for (const rel of Object.values(xrayFiles)) {
        await js(`window.studio.deletePath(${JSON.stringify(PROJECT)}, ${JSON.stringify(rel)}).catch(() => {})`)
        fs.rmSync(path.join(PROJECT, rel), { force: true })
      }
    }
    // Back to a clean project: the loop is gone, so the honest clean state returns (proves the card
    // reflects the CURRENT graph and isn't stuck on a stale fold).
    await waitFor(`window.studio.architectureMap(${JSON.stringify(PROJECT)}).then(m => !m.edges.some(e => /w20-loop/.test(e.from)))`, { timeout: 10000, what: 'index drops the removed files' })
    await openPanelTab('Activity')
    await openInsight()
    await openInsight('Code Map')
    for (const t of ['Possibly unused', 'Tangled files']) await openInsightSection(t)
    await waitFor(`/No loops — nothing depends on itself in a circle\./i.test(document.querySelector('.tangle-card').textContent) && ![...document.querySelectorAll('.orphans-card .debt-detail')].some(d => /w20-orphan/.test(d.textContent))`, { timeout: 8000, what: 'cards go clean again once the seeded files are removed' })
    // Click a module's Open → a tab whose name matches that module must exist
    // (whether newly opened or re-selected). A no-op would leave no such tab.
    const modTitle = await js(`(() => { const d = document.querySelector('.arch-map .arch-row .debt-detail'); return d ? (d.getAttribute('title') || '').trim() : '' })()`)
    if (!modTitle) throw new Error('no module row in the architecture map to open')
    const modBase = modTitle.split('/').pop()
    await js(`(() => { const b = document.querySelector('.arch-map .arch-row .btn'); if (b) b.click(); return 'ok' })()`)
    await waitFor(`[...document.querySelectorAll('.tab .tab-name')].some(t => t.textContent.trim() === ${JSON.stringify(modBase)})`, { timeout: 6000, what: 'clicked module opened as a tab' })
    await shot('insight')

    // The agent dock's mode control: one button that cycles and names the live mode in words.
    // (Replaced the persona picker + Build|Plan toggle — personas were one prompt sentence each and
    //  were removed; the toggle named neither what each mode permits nor which was in force.)
    if (!(await js(`!!document.querySelector('.agent-panel')`))) await clickByLabel('.topbar-actions .btn', 'Agent')
    await waitFor(`!!document.querySelector('.ap-mode-cycle')`, { what: 'agent mode control' })
    const modeBefore = await js(`document.querySelector('.ap-mode-cycle .ap-mode-label').textContent.trim()`)
    await clickSel('.ap-mode-cycle')
    await waitFor(
      `document.querySelector('.ap-mode-cycle .ap-mode-label').textContent.trim() !== ${JSON.stringify(modeBefore)}`,
      { what: 'mode cycled to the other state' }
    )
    const modeAfter = await js(`document.querySelector('.ap-mode-cycle .ap-mode-label').textContent.trim()`)
    const modeStates = [modeBefore, modeAfter].sort().join('|')
    if (modeStates !== 'accept edits on|plan mode on') throw new Error(`mode labels = ${modeStates}`)
    await clickSel('.ap-mode-cycle') // leave it as we found it
    if (await js(`!!document.querySelector('.persona-picker')`)) throw new Error('persona picker still present')

    await shot('smart-terminal')
    await clickSel('[aria-label="Close Insight"]')
    return `explainer ✓ radar(untested) ✓ arch-map(${archContent} items) ✓ mode-cycle(${modeStates})`
  })

  await step('14kb. Wave 19: Work-Safety (subfolder-aware) + project-scoped changed-files + READ-ONLY Compare + confirm-gated Restore', async () => {
    // hello-vite is a SUBFOLDER of the monorepo, so this exercises the subfolder path (project-relative
    // paths, NO one-click backup). STRICTLY READ-ONLY: never confirms a restore, never commits.
    const mainRel = 'src/main.tsx'
    const mainAbs = path.join(PROJECT, mainRel)
    const orig = fs.readFileSync(mainAbs, 'utf8')
    try {
      fs.writeFileSync(mainAbs, orig + '\n// w19 probe\n') // a real modification to a TRACKED file → restorable row
      await openPanelTab('Activity')
      await openInsight()
      await clickSel('[aria-label="Refresh Insight"]')
      // PRODUCT GAP: changeToken clears Overview without triggering its loader; the backend
      // returns the modified file while the view remains "Not read yet". Keep the row assertion.
      // F2 FIRST (it gates on the FRESH async load): the changed-files list shows our modified file with a
      // PROJECT-RELATIVE path (src/main.tsx, not the monorepo path). Waiting here avoids a stale-banner race.
      await waitFor(`[...document.querySelectorAll('.changed-files .changed-row')].some(r => /Modified: src\\/main\\.tsx/.test(r.textContent))`, { timeout: 10000, what: 'project-relative Modified row for src/main.tsx' }).catch(async error => {
        console.log('[work-safety diagnostic]', await js(`(async () => JSON.stringify({ overview: document.querySelector('.iv-overview')?.textContent, stat: await window.studio.gitWorkingStat(${JSON.stringify(PROJECT)}) }))()`))
        throw error
      })
      // F1: the Work-Safety banner renders at the TOP with a band + verdict, ABOVE ship-readiness.
      /* ONE verdict now (2026-09-03). Work Safety, Ship Readiness and Health used to be three
         equally-loud cards that answered different questions and so routinely disagreed; they are
         ordered by what is irreversible, and the two that lose appear as supporting lines under the
         one that wins. So the thing to assert is no longer their order — it is that exactly one
         headline exists, it carries a band, and both other answers are still on screen. */
      if ((await js(`(() => { const v=document.querySelector('.iv-verdict'); return (v?.className.match(/iv-band-(green|amber|red|unknown)/)||[])[1]||'none' })()`)) === 'none') throw new Error('the verdict must carry a band class')
      if ((await js(`(document.querySelector('.iv-verdict-text')?.textContent||'').trim().length`)) < 5) throw new Error('verdict headline missing')
      if ((await js(`document.querySelectorAll('.iv-verdict').length`)) !== 1) throw new Error('there must be exactly ONE headline verdict')
      const support = await js(`[...document.querySelectorAll('.iv-support-label')].map(e => e.textContent).join('|')`)
      if (!/Your work/.test(support) || !/Ready to ship/.test(support)) throw new Error('both other answers must remain as supporting lines: ' + support)
      // Review fix: a SUBFOLDER project must NOT offer a one-click "Back up now" (would commit the parent) —
      // it shows a plain-English "inside a bigger project" note instead.
      if (await js(`[...document.querySelectorAll('.iv-verdict .btn')].some(b => /Back up now/.test(b.textContent))`)) throw new Error('a subfolder project must NOT show Back up now')
      if (!(await js(`/inside a bigger project/i.test(document.querySelector('.iv-verdict').textContent)`))) throw new Error('a subfolder project must explain why backup is not offered — verdict was: ' + (await js(`document.querySelector('.iv-verdict').textContent`)))
      // F3: Compare that row → a READ-ONLY diff; Restore is CONFIRM-gated (arm → Yes/Cancel), never a bare write.
      await js(`(() => { const r=[...document.querySelectorAll('.changed-files .changed-row')].find(x=>/src\\/main\\.tsx/.test(x.textContent)); [...r.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='Compare').click(); return true })()`)
      await waitFor(`!!document.querySelector('.restore-diff .restore-diff-body .dl')`, { timeout: 8000, what: 'read-only compare diff renders real rows' })
      await clickByText('.restore-diff .btn', 'Restore to last backup') // ARM only — reveals the confirm, writes nothing
      await waitFor(`[...document.querySelectorAll('.restore-diff .btn')].some(b => b.textContent.trim() === 'Yes, restore') && [...document.querySelectorAll('.restore-diff .btn')].some(b => b.textContent.trim() === 'Cancel')`, { timeout: 4000, what: 'restore is confirm-gated (Yes/Cancel)' })
      await clickByText('.restore-diff .btn', 'Cancel') // NEVER confirm — no real write to the repo
      await waitFor(`![...document.querySelectorAll('.restore-diff .btn')].some(b => b.textContent.trim() === 'Yes, restore')`, { timeout: 3000, what: 'cancel disarms the restore' })
      await shot('wave19-work-safety')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.writeFileSync(mainAbs, orig) // revert the seeded modification
    }
    return 'Work-Safety: subfolder-aware banner (no Back up now + warning) + project-relative changed-files + read-only Compare + confirm-gated Restore (cancelled) ✓'
  })

  await step('14ka. Wave 17: App Passport (offline facts) + Copy handoff + Settings Checkup', async () => {
    await openInsight()
    await clickSel('[aria-label="Refresh Insight"]')
    // F1: the App Passport card renders at the TOP (above "Explain this project"), offline, no model —
    // hello-vite has a stack, so a "Built with" row must appear with real names.
    await waitFor(`!!document.querySelector('.app-passport')`, { timeout: 8000, what: 'app passport card' })
    const builtWith = await js(`(() => { const dl=document.querySelector('.app-passport'); if(!dl) return 'NONE';
      const dts=[...dl.querySelectorAll('dt')]; const i=dts.findIndex(d=>/Built with/.test(d.textContent));
      return i < 0 ? 'NONE' : 'Built with ' + dl.querySelectorAll('dd')[i].textContent })()`)
    if (builtWith === 'NONE' || builtWith.replace(/Built with/, '').trim().length < 2) throw new Error('passport "Built with" row missing/empty: ' + builtWith)
    // Passport must sit ABOVE the Explain button (instant facts first, model-explanation second).
    const order = await js(`(() => { const b=document.querySelector('.iv'); const p=b.querySelector('.app-passport'); const ex=[...b.querySelectorAll('.btn')].find(x=>/Explain this project/.test(x.textContent)); if(!p||!ex) return 'MISS'; return (p.compareDocumentPosition(ex) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'above' : 'below' })()`)
    if (order !== 'above') throw new Error('passport card must render above the Explain button: ' + order)
    // F2: Copy handoff summary → clipboard gets a plain-text brief (facts + "Do these next"), names only.
    await js(`(() => { window.__copied = null; const stub = (t) => { window.__copied = String(t); return Promise.resolve() }; try { navigator.clipboard.writeText = stub } catch(e){} if (navigator.clipboard.writeText !== stub) { try { Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:stub}}) } catch(e2){} } return true })()`)
    await clickByText('.iv-actions .btn', 'Copy handoff summary')
    await waitFor(`typeof window.__copied === 'string' && window.__copied.length > 0`, { timeout: 4000, what: 'handoff copied to clipboard' })
    const copied = await js(`window.__copied`)
    if (!/Built with:/.test(copied) || !/Do these next/.test(copied)) throw new Error('handoff missing facts or to-do list: ' + copied.slice(0, 120))
    if (/AKIA|=\s*["'][^"']{8,}/.test(copied)) throw new Error('handoff must be names-only, never a secret value')
    // F3: seed a source file that REFERENCES an undeclared setting → the index refreshes (writeFile IPC
    // re-indexes) and the two-sided Settings Checkup card appears with that name under "needs". Names only.
    const envRel = 'src/w17env.ts'
    const envAbs = path.join(PROJECT, envRel)
    try {
      await js(`window.studio.writeFile(${JSON.stringify(PROJECT)}, ${JSON.stringify(envRel)}, 'export const x = process.env.W17_NEEDS_THIS\\n')`)
      // Wait until the recomputed brain sees the new referenced-but-undeclared var (index refresh done).
      await waitFor(`window.studio.projectBrain(${JSON.stringify(PROJECT)}).then(b => (b.envVars||[]).some(v => v.name === 'W17_NEEDS_THIS' && v.referenced && !v.declared))`, { timeout: 8000, what: 'brain re-detects the new setting' })
      // Re-enter the Insight tab so the renderer reloads the fresh brain.
      await openPanelTab('Activity')
      await openInsight()
      await clickSel('[aria-label="Refresh Insight"]')
      await waitFor(`(() => { const c=document.querySelector('.settings-checkup'); return !!c && /W17_NEEDS_THIS/.test(c.textContent) && [...c.querySelectorAll('.iv-sev')].some(b => /needs/.test(b.textContent)) })()`, { timeout: 8000, what: 'settings-checkup shows the needed setting' })
      // Names/badges only — the card must NEVER render an "=value".
      if (await js(`/=\\s*\\S/.test(document.querySelector('.settings-checkup').textContent)`)) throw new Error('settings checkup must show names/badges only, never a value')
      await shot('wave17-passport')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      await js(`window.studio.deletePath(${JSON.stringify(PROJECT)}, ${JSON.stringify(envRel)}).catch(() => {})`)
      fs.rmSync(envAbs, { force: true })
    }
    return `passport(built-with, above Explain) ✓ copy-handoff(facts+to-do, names-only) ✓ settings-checkup(needed setting, names-only) ✓`
  })

  await step('14l. Wave 2: AI Spend chip + Pre-Ship Security Gate + What-Changed ledger', async () => {
    // The agent already ran in step 13 with the mock provider, but mock is not
    // metered — so drive a metered-looking indicator by asserting the Security
    // Gate + ledger, which are the demoable Wave-2 surfaces on hello-vite.
    await openInsight()

    // Security Gate: seed a fake secret in the project, scan, see a finding, then clean up.
    const secretFile = path.join(PROJECT, 'src', 'leak.js')
    fs.writeFileSync(secretFile, 'const key = "AKIA1234567890ABCDEF"\n')
    await runInsightCheck('Security')
    await waitFor(`[...document.querySelectorAll('.iv-row .ws-badge')].some(b => b.textContent === 'critical')`, {
      timeout: 15000,
      what: 'security finding'
    })
    const verdict = await textOf('.iv .error-box')
    if (!verdict || !/Do NOT ship|fix/i.test(verdict)) throw new Error(`verdict = ${verdict}`)
    await shot('security-gate')
    fs.rmSync(secretFile)
    // Re-scan → clean verdict.
    await runInsightCheck('Security')
    await waitFor(`(document.querySelector('.iv .ok-box')?.textContent || '').includes('safe to ship')`, {
      timeout: 15000,
      what: 'clean verdict'
    })
    // Wave 22 ANTI-NAGWARE PIN: hello-vite is small enough to read completely, so the clean verdict must
    // be the plain sentence with NO caveat and NO coverage line anywhere on screen.
    const cleanVerdict = await textOf('.iv .ok-box')
    if (/part of this project|couldn't be opened|too large/i.test(cleanVerdict))
      throw new Error(`a fully-read project must carry no caveat at all: ${cleanVerdict}`)
    if (await js(`!!document.querySelector('.iv-check:nth-child(1 of .iv-check) .iv-caveat')`))
      throw new Error('the coverage line must not render when the whole project was read')

    // Wave 22: a scan that had to STOP EARLY must not read as an all-clear. Seed one file holding more
    // findings than the gate collects, so the finding cap trips on a real scan.
    const capFile = path.join(PROJECT, 'src', 'w22-cap-probe.js')
    fs.writeFileSync(capFile, Array.from({ length: 130 }, (_, i) => `const k${i} = "AKIA${String(i).padStart(16, '0')}"`).join('\n') + '\n')
    try {
      await runInsightCheck('Security')
      await waitFor(`!!document.querySelector('.iv-check:nth-child(1 of .iv-check) .iv-caveat')`, { timeout: 15000, what: 'coverage line on a capped scan' })
      const cov = await js(`document.querySelector('.iv-check:nth-child(1 of .iv-check) .iv-caveat').textContent`)
      if (!/stopped after|part of this project|couldn't be opened|too large/i.test(cov)) throw new Error(`the coverage line must say what was skipped: ${cov}`)
      if (/\//.test(cov)) throw new Error(`the coverage line must be count-only, never a path: ${cov}`)
      const capped = await js(`document.querySelector('.iv .ok-box')?.textContent || document.querySelector('.iv .error-box')?.textContent || ''`)
      if (/^Looks safe to ship — no hardcoded secrets or private keys found\.$/.test(capped))
        throw new Error(`a capped scan must never give the unqualified all-clear: ${capped}`)
      await shot('wave22-coverage')
    } finally {
      // Re-scan INSIDE finally: a failed assertion above must not leave 130 seeded secrets in the
      // project for every later step to trip over.
      fs.rmSync(capFile, { force: true })
      await runInsightCheck('Security')
      await waitFor(`!document.querySelector('.iv-check:nth-child(1 of .iv-check) .iv-caveat')`, { timeout: 15000, what: 'coverage line gone after cleanup' })
    }

    await openInsight('Memory')
    await openInsightSection('What the AI changed')
    // What-Changed ledger: step 13 applied an agent edit to main.tsx → a ledger row.
    await waitFor(`[...document.querySelectorAll('.debt-detail')].some(e => e.textContent.includes('main.tsx'))`, {
      timeout: 8000,
      what: 'ledger entry'
    })
    // Wave 4: Compliance export → a Markdown report saved via the stubbed save dialog.
    await openInsight('Review')
    await clickByText('.iv .btn', 'Compliance report')
    await waitFor(() => fs.existsSync(SAVE_TARGET) && fs.readFileSync(SAVE_TARGET, 'utf8').includes('# Compliance Report'), { timeout: 8000, what: 'compliance report written' })
    const md = fs.readFileSync(SAVE_TARGET, 'utf8')
    if (!md.includes('## 1. Pre-Ship Security Gate') || !md.includes('## 2. What the AI Changed') || !md.includes('## 3. Audit Trail')) throw new Error('compliance report missing sections')
    await clickSel('[aria-label="Close Insight"]')
    return 'security gate (catch + clean) ✓ · ledger row ✓ · compliance report exported ✓'
  })

  await step('14l2. Wave 5: Decision + Context Pack + Analytics trend sparkline', async () => {
    // Pre-seed an older-dated analytics snapshot so opening Insight yields a 2nd
    // (today's) point and the trend sparkline (needs > 1 point) renders.
    const anFile = path.join(app.getPath('userData'), 'analytics', require('node:crypto').createHash('sha1').update(PROJECT).digest('hex') + '.jsonl')
    fs.mkdirSync(path.dirname(anFile), { recursive: true })
    fs.writeFileSync(anFile, JSON.stringify({ ts: Date.parse('2020-01-01'), score: 60, debtCount: 2, secrets: null, fileCount: 8, agentRunsDone: 0 }) + '\n')
    await openInsight()
    await clickSel('[aria-label="Refresh Insight"]')
    // PRODUCT GAP: no current snapshot is recorded by the rebuilt view. Do not seed
    // today in the test: that would hide the missing recording behaviour.
    // Analytics-over-time: with a second (today) point, the sparkline renders.
    await waitFor(`!!document.querySelector('.health-spark .spark-svg polyline')`, { timeout: 8000, what: 'health trend sparkline' })
    // Project Decisions: type a decision, Record, see it in the list.
    // Decisions are a memory KIND now, not a separate product — recorded through Memory's own form.
    await openInsight('Memory')
    await js(`(() => { const sel = document.querySelector('.mem-add .mem-kind');
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, 'decision');
      sel.dispatchEvent(new Event('change', { bubbles: true })); return 'OK' })()`)
    await setNativeValue('.mem-add input.text-input', 'Auth uses JWT not sessions', 'HTMLInputElement')
    await clickByText('.mem-add .btn', 'Remember')
    await waitFor(`[...document.querySelectorAll('.mem-row')].some(e => e.textContent.includes('Auth uses JWT'))`, { timeout: 6000, what: 'decision recorded' })
    // Auto-Context Packs: seed a real file, Find related, see the ranked list.
    await openInsight('Code Map')
    await setNativeValue('.ctx-find .text-input', 'src/main.tsx', 'HTMLInputElement')
    await clickByText('.ctx-find .btn', 'Find related')
    await openInsight('Code Map')
    await waitFor(`document.querySelectorAll('.ctx-row').length >= 1 && [...document.querySelectorAll('.ctx-row .ws-badge')].some(b => b.textContent === 'seed')`, { timeout: 6000, what: 'context pack results' })
    await shot('wave5-insight')
    await clickSel('[aria-label="Close Insight"]')
    return 'decision ✓ · context pack ✓ · analytics trend sparkline ✓'
  })

  await step('14l3. Wave 6: Architecture drift baseline + Knowledge Graph owners + Replay story', async () => {
    await openInsight()
    // Architecture Drift: set a baseline → it reports "No drift" (baseline == current).
    await openInsight('Code Map')
    await openInsightSection('Architecture drift')
    await clickByText('.iv-section-body .btn', 'Set baseline')
    await waitFor(`[...document.querySelectorAll('.iv .ok-box')].some(b => /No drift/.test(b.textContent))`, { timeout: 6000, what: 'no-drift after baseline' })
    await openInsightSection('Who knows this code')
    // Team Knowledge Graph: owners render (hello-vite lives inside a git repo).
    await waitFor(`[...document.querySelectorAll('.iv-section-title')].some(s => /Who knows this code/.test(s.textContent))`, { timeout: 12000, what: 'knowledge graph owners' })
    // Wave 12: cross-repo Knowledge Graph — aggregate over the recents. Seed in the REAL
    // stored shape ({path,name,framework}[], NOT a bare string[]) so the panel's path
    // extraction is genuinely exercised. Additive: the single-repo owners section is unchanged.
    await js(`localStorage.setItem('studio.recent', JSON.stringify([{ path: ${JSON.stringify(PROJECT)}, name: 'hello-vite', framework: 'vite' }]))`)
    await openInsightSection('Across your projects')
    await clickByText('.crossrepo .btn', 'Across your projects')
    await waitFor(`!!document.querySelector('.crossrepo-body') && /Across \\d+ project/.test(document.querySelector('.crossrepo-body').textContent)`, { timeout: 20000, what: 'cross-repo aggregate owners' })
    // Development Replay: the project story shows events from step 13's agent run.
    await openInsight('Memory')
    await openInsightSection('Development replay')
    await waitFor(`!!document.querySelector('.replay-panel')`, { timeout: 8000, what: 'replay story timeline' })
    await shot('wave6-insight')
    // Wave 9: seed a real in-project edit (two writes → a genuine diff), reopen Insight
    // so the Replay remounts, then open that change's per-change diff viewer.
    const P = JSON.stringify(PROJECT)
    await js(`window.studio.writeFile(${P}, '_replaydiff.js', 'const a = 1\\nconst b = 2\\nconst c = 3\\n')`)
    await js(`window.studio.writeFile(${P}, '_replaydiff.js', 'const a = 1\\nconst b = 99\\nconst c = 3\\n')`)
    try {
      await clickSel('[aria-label="Close Insight"]')
      await openInsight()
      await openInsight('Memory')
      await openInsightSection('Development replay')
      await waitFor(`[...document.querySelectorAll('.replay-panel .btn')].some(b => /Diff/.test(b.textContent))`, { timeout: 8000, what: 'per-change Diff button' })
      await clickByText('.replay-panel .btn', 'Diff')
      // The per-change diff viewer renders real diff lines (added lines are guaranteed
      // for these writes; whether a del also shows depends on which same-ts row sorts first).
      await waitFor(`!!document.querySelector('.replay-panel .diff-body .dl-add')`, { timeout: 6000, what: 'per-change diff lines' })
      await shot('wave9-replay-diff')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(path.join(PROJECT, '_replaydiff.js'), { force: true })
    }
    return 'drift baseline (no drift) ✓ · knowledge-graph owners ✓ · replay story + per-change diff ✓'
  })

  await step('14l4. Wave 7: Design review — palette + hardcoded colors + near-duplicate', async () => {
    const cssFile = path.join(PROJECT, 'src', 'wave7.css')
    fs.writeFileSync(cssFile, '.w7{color:#3b82f6;padding:12px;font-size:14px}.w7b{color:#3b82fa;margin:8px}')
    try {
      await openInsight()
      await runInsightCheck('Design consistency')
      // The palette renders as swatches, and the verdict box appears.
      await waitFor(`!!document.querySelector('.design-swatch') && [...document.querySelectorAll('.iv .ok-box, .iv .error-box')].some(b => /Design|Consistent/i.test(b.textContent))`, { timeout: 8000, what: 'design review palette + verdict' })
      // The seeded near-duplicate (#3b82f6 ≈ #3b82fa) is flagged.
      await waitFor(`[...document.querySelectorAll('.ws-badge')].some(b => b.textContent === 'near-dup')`, { timeout: 4000, what: 'near-duplicate flagged' })
      // Wave 9/10: the hardcoded palette yields a suggested :root token block (Wave 10 names
      // by hue family — the seeded #3b82f6 blues fold to one --blue-* token) + Extract button.
      await waitFor(`!!document.querySelector('.design-tokens .token-block') && /:root/.test(document.querySelector('.design-tokens .token-block').textContent) && /--blue-\\d/.test(document.querySelector('.design-tokens .token-block').textContent)`, { timeout: 4000, what: 'suggested design tokens block' })
      await waitFor(`[...document.querySelectorAll('.design-tokens .btn')].some(b => /Extract tokens/.test(b.textContent))`, { timeout: 2000, what: 'Extract tokens button' })
      await openInsight('Overview')
      // Wave 13: the design finding feeds the Fix-First Action Plan card at the TOP of Insight —
      // a "Do these next" list with a design row + a distinct-labelled "Go" button. It uses
      // .plan-summary (NOT ok-box/error-box), so the Security selectors below still resolve.
      await waitFor(`!!document.querySelector('.action-plan .action-row') && [...document.querySelectorAll('.iv-overview .iv-h')].some(s => /Do these next/.test(s.textContent))`, { timeout: 4000, what: 'fix-first action plan renders' })
      // PRODUCT GAP: the rebuild removed the per-item Go action; preserve this gate until resolved.
      await waitFor(`[...document.querySelectorAll('.action-plan .action-row .btn')].some(b => b.textContent.trim() === 'Go')`, { timeout: 2000, what: 'action plan Go button' })
      // Wave 14: "Fix with AI" opens the agent dock and SEEDS a targeted instruction — no auto-run.
      await clickByText('.action-plan .action-row .btn', 'Fix with AI')
      await waitFor(`!!document.querySelector('.agent-input textarea') && document.querySelector('.agent-input textarea').value.trim().length > 20`, { timeout: 4000, what: 'agent input seeded by Fix with AI' })
      if (await js(`window.studio.agentState().then(s => s.running)`)) throw new Error('Fix with AI must NOT auto-start a run')
      await shot('wave7-design')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(cssFile, { force: true })
    }
    return 'design review: palette + verdict + near-duplicate + token extraction ✓'
  })

  await step('14l4b. Wave 11: apply design tokens — preview → rewrite hex→var → one Undo reverts', async () => {
    const cssFile = path.join(PROJECT, 'src', 'wave11.css')
    // .a hex + .rgb rgb() BOTH equal #3b82f6 (Wave 12: rgb() folds too); .c is 8-digit alpha
    // (guard: must survive verbatim). Two replacements, one opaque-safe survivor.
    const original = '.a{color:#3b82f6}\n.rgb{color:rgb(59,130,246)}\n.c{background:#3b82f6aa}\n'
    fs.writeFileSync(cssFile, original)
    try {
      await openInsight()
      await runInsightCheck('Design consistency')
      await waitFor(`!!document.querySelector('.design-tokens .token-block') && /--blue/.test(document.querySelector('.design-tokens .token-block').textContent)`, { timeout: 8000, what: 'token block' })
      // Preview apply → wave11.css shows 2 replacements (the hex AND the rgb() form).
      await clickByText('.design-tokens .btn', 'Preview apply')
      await waitFor(`[...document.querySelectorAll('.apply-preview .apply-file')].some(r => /wave11\\.css/.test(r.textContent) && /2 replacements/.test(r.textContent))`, { timeout: 6000, what: 'apply preview row (2 replacements)' })
      // Apply → both hex and rgb() become var(--blue-*); :root block prepended; 8-digit survives.
      await clickByText('.apply-actions .btn', 'Apply tokens')
      await waitFor(() => {
        const c = fs.readFileSync(cssFile, 'utf8')
        return (c.match(/var\(--blue/g) || []).length === 2 && c.includes('#3b82f6aa') && c.trimStart().startsWith(':root {') && !/color:#3b82f6\b/i.test(c) && !/rgb\(59,130,246\)/.test(c)
      }, { timeout: 8000, what: 'wave11.css: hex+rgb→var, block, 8-digit survived' })
      await shot('wave11-apply-tokens')
      // One top-bar Undo reverts the whole apply (single snapshot) byte-for-byte.
      await clickByText('.topbar-actions .btn', 'Undo')
      await waitFor(() => fs.readFileSync(cssFile, 'utf8') === original, { timeout: 8000, what: 'one Undo restored wave11.css' })
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(cssFile, { force: true })
    }
    return 'apply tokens: preview (2 reps: hex+rgb) → var + :root block → one-Undo revert ✓'
  })

  await step('14l4c. Wave 13: Dependency Health audits package.json offline (distinct button + verdict)', async () => {
    await openInsight()
    // Distinct button label (not 'Check before you ship'/'Review design'); audits hello-vite's real package.json.
    await runInsightCheck('Dependencies')
    // The result renders in a SCOPED .iv-check:nth-child(2 of .iv-check) block (so it never collides with the Security verdict).
    await waitFor(`!!document.querySelector('.iv-check:nth-child(2 of .iv-check) .ok-box, .iv-check:nth-child(2 of .iv-check) .error-box') && (document.querySelector('.iv-check:nth-child(2 of .iv-check) .ok-box, .iv-check:nth-child(2 of .iv-check) .error-box').textContent || '').trim().length > 0`, { timeout: 8000, what: 'dependency audit verdict' })
    await shot('wave13-dep-health')
    await clickSel('[aria-label="Close Insight"]')
    return 'dependency health: offline audit of package.json → scoped verdict ✓'
  })

  await step('14l4cb. Wave 18: a missing package becomes a high "deps" row in the Fix-First plan + Fix with AI', async () => {
    const phantomRel = 'src/w18phantom.ts'
    const phantomAbs = path.join(PROJECT, phantomRel)
    try {
      await openInsight()
      // Seed a source file importing a package that is NOT in package.json (a phantom → install-breaker).
      await js(`window.studio.writeFile(${JSON.stringify(PROJECT)}, ${JSON.stringify(phantomRel)}, "import x from 'totally-missing-pkg-w18'\\nexport default x\\n")`)
      await waitFor(`window.studio.dependencyAudit(${JSON.stringify(PROJECT)}).then(r => (r.findings||[]).some(f => f.kind === 'phantom' && f.package === 'totally-missing-pkg-w18'))`, { timeout: 8000, what: 'audit re-detects the phantom import' })
      // Run the audit so the report flows into the ONE Fix-First plan.
      await runInsightCheck('Dependencies')
      await waitFor(`!!document.querySelector('.iv-check:nth-child(2 of .iv-check)')`, { timeout: 8000, what: 'dep audit ran' })
      await openInsight('Overview')
      // The plan now carries a HIGH 'deps' row (missing package) with a Fix-with-AI button.
      await waitFor(`[...document.querySelectorAll('.action-plan .action-row')].some(r => /missing or loose packages/i.test(r.textContent) && [...r.querySelectorAll('.btn')].some(b => b.textContent.trim() === 'Fix with AI'))`, { timeout: 6000, what: 'deps action-row with Fix with AI' })
      // Clicking Fix with AI on the deps row seeds the agent WITHOUT auto-running (same path as every kind).
      await js(`(() => { const r=[...document.querySelectorAll('.action-plan .action-row')].find(x=>/missing or loose packages/i.test(x.textContent)); const b=[...r.querySelectorAll('.btn')].find(x=>x.textContent.trim()==='Fix with AI'); b.click(); return true })()`)
      await waitFor(`!!document.querySelector('.agent-input textarea') && document.querySelector('.agent-input textarea').value.trim().length > 20`, { timeout: 4000, what: 'deps Fix-with-AI seeded the agent input' })
      if (await js(`window.studio.agentState().then(s => s.running)`)) throw new Error('Fix with AI must NOT auto-run')
      await shot('wave18-deps-plan')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      // Remove the phantom IMPORT (writeFile re-indexes so a later audit is clean), then delete the file.
      await js(`window.studio.writeFile(${JSON.stringify(PROJECT)}, ${JSON.stringify(phantomRel)}, 'export default 1\\n').catch(() => {})`)
      await waitFor(`window.studio.dependencyAudit(${JSON.stringify(PROJECT)}).then(r => !(r.findings||[]).some(f => f.package === 'totally-missing-pkg-w18')).catch(() => true)`, { timeout: 6000, what: 'phantom cleared from the audit' }).catch(() => {})
      await js(`window.studio.deletePath(${JSON.stringify(PROJECT)}, ${JSON.stringify(phantomRel)}).catch(() => {})`)
      fs.rmSync(phantomAbs, { force: true })
    }
    return 'Wave 18: missing package → high "deps" row in the one plan + Fix with AI (no auto-run) ✓'
  })

  await step('14l4cc. Wave 18: Ship-Readiness traffic light — baseline not-red, flips RED on a seeded secret', async () => {
    const secretRel = 'src/w18secret.ts'
    const secretAbs = path.join(PROJECT, secretRel)
    try {
      await openInsight()
      // Refresh the dependency report to the now-clean project (prior step's phantom is gone) so the
      // baseline is deterministic and not carrying a stale install-breaker.
      await runInsightCheck('Dependencies')
      await waitFor(`!!document.querySelector('.iv-check:nth-child(2 of .iv-check)')`, { timeout: 8000, what: 'clean dep audit' })
      await openInsight('Overview')
      // The one honest traffic-light header renders at the TOP, with a band class + a one-line verdict.
      await waitFor(`!!document.querySelector('.iv-verdict')`, { timeout: 8000, what: 'ship-readiness header' })
      if ((await js(`(() => { const s=document.querySelector('.iv-verdict'); return (s.className.match(/iv-band-(green|amber|red)/)||[])[1] || 'none' })()`)) === 'none') throw new Error('ship-readiness must carry a band class')
      // …ABOVE the Fix-First Action Plan.
      const above = await js(`(() => { const b=document.querySelector('.iv'); const s=b.querySelector('.iv-verdict'); const p=b.querySelector('.action-plan'); if(!s||!p) return 'MISS'; return (s.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'above' : 'below' })()`)
      if (above !== 'above') throw new Error('ship-readiness must render above the action plan: ' + above)
      if ((await js(`(document.querySelector('.iv-verdict-text')?.textContent||'').trim().length`)) < 5) throw new Error('ship verdict text missing')
      if (await js(`!!document.querySelector('.iv-verdict.iv-band-red')`)) throw new Error('a clean baseline must not be RED')
      // Seed a hardcoded secret + run the Security Gate → the light flips RED and names the blocker.
      fs.writeFileSync(secretAbs, 'export const AWS = "AKIA1234567890ABCDEF"\n')
      await runInsightCheck('Security')
      await openInsight('Overview')
      await waitFor(`!!document.querySelector('.iv-verdict.iv-band-red')`, { timeout: 8000, what: 'ship light flips RED on a real secret' })
      const verdict = await js(`document.querySelector('.iv-verdict-text').textContent`)
      if (!/not safe to ship/i.test(verdict)) throw new Error('RED verdict must say "not safe to ship": ' + verdict)
      if (/AKIA/.test(verdict)) throw new Error('the verdict must never render the secret value')
      await shot('wave18-ship-readiness')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(secretAbs, { force: true })
    }
    return 'Ship-Readiness: header above the plan; baseline not-red; flips RED on a seeded secret; verdict names the blocker (no value) ✓'
  })

  await step('14l4cd. Wave 18: Upload-Safety — an unignored secret file is flagged as a GitHub leak; .gitignore clears it', async () => {
    const rsaAbs = path.join(PROJECT, 'id_rsa')
    const giAbs = path.join(PROJECT, '.gitignore')
    const hadGi = fs.existsSync(giAbs)
    const origGi = hadGi ? fs.readFileSync(giAbs, 'utf8') : null
    try {
      fs.writeFileSync(rsaAbs, 'PRIVATE KEY CONTENT\n') // a present private key, NOT listed in .gitignore
      await openInsight()
      await runInsightCheck('Security')
      // The scan names id_rsa as a GitHub upload leak (never the file's contents).
      await waitFor(`[...document.querySelectorAll('.debt-detail')].some(d => /would be uploaded to GitHub/i.test(d.textContent) && /id_rsa/.test(d.textContent))`, { timeout: 8000, what: 'upload-safety leak flagged for id_rsa' })
      // Add id_rsa to .gitignore → re-run → the leak clears (no false alarm once protected).
      fs.writeFileSync(giAbs, (origGi || '') + '\nid_rsa\n')
      await runInsightCheck('Security')
      await waitFor(`![...document.querySelectorAll('.debt-detail')].some(d => /id_rsa/.test(d.textContent) && /uploaded to GitHub/i.test(d.textContent))`, { timeout: 8000, what: 'leak clears once id_rsa is ignored' })
      await shot('wave18-upload-safety')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(rsaAbs, { force: true })
      if (hadGi) fs.writeFileSync(giAbs, origGi)
      else fs.rmSync(giAbs, { force: true })
    }
    return 'Upload-Safety: unignored id_rsa flagged as a GitHub leak; adding it to .gitignore clears it ✓'
  })

  await step('14l4d. Wave 14: Generate tests scaffolds a deterministic *.test for the open source file', async () => {
    const testFile = path.join(PROJECT, 'src', 'main.test.tsx')
    fs.rmSync(testFile, { force: true }) // clean start (hello-vite has no tests → the tests row appears)
    try {
      // Open a source file so Generate tests has a target (it reads the active editor tab). Other tests
      // may already have other tabs open (e.g. a module opened from the Architecture Map) — check the
      // ACTIVE tab specifically, not just "a tab named main.tsx exists somewhere in the tabbar".
      if (!(await js(`[...document.querySelectorAll('.ex-name')].some(e=>e.textContent==='main.tsx')`))) {
        await clickByText('.ex-row', 'src')
        // The folder's children are listed asynchronously. Before 2026-09-02 nothing in the suite
        // switched projects and came back, so `src` was always still open from step 2 and this
        // race never showed.
        await waitFor(`[...document.querySelectorAll('.ex-name')].some(e=>e.textContent==='main.tsx')`, { timeout: 8000, what: 'src to expand' })
      }
      await clickByText('.ex-row', 'main.tsx')
      await waitFor(`(document.querySelector('.tab.active .tab-name')?.textContent || '') === 'main.tsx'`, { timeout: 4000, what: 'main.tsx open and active in editor' })
      await openInsight()
      await waitFor(`[...document.querySelectorAll('.action-plan .action-row .btn')].some(b => b.textContent.trim() === 'Generate tests')`, { timeout: 8000, what: 'Generate tests button on the tests row' })
      await clickByText('.action-plan .action-row .btn', 'Generate tests')
      await waitFor(() => fs.existsSync(testFile), { timeout: 6000, what: 'generated test file on disk' })
      // PRODUCT GAP: generating a test clears Overview through changeToken without reloading.
      // genTestMsg also sits inside the nonempty-plan branch, hiding it when the plan empties.
      // Keep the visible success assertion even though the file was created on disk.
      await waitFor(`/Created/.test([...document.querySelectorAll('.iv-overview .iv-block > p')].find(p => /^Created /.test(p.textContent))?.textContent || '')`, { timeout: 3000, what: '"Created" confirmation' }).catch(async error => {
        console.log('[generate-tests diagnostic]', await js(`document.querySelector('.iv-overview')?.textContent || 'Overview not mounted'`))
        throw error
      })
      const content = fs.readFileSync(testFile, 'utf8')
      if (!/describe\(/.test(content) || !/TODO/.test(content)) throw new Error('scaffold missing describe/TODO: ' + content)
      await shot('wave14-gentests')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(testFile, { force: true })
    }
    return 'Generate tests: open source → deterministic *.test scaffold on disk (describe + TODO) ✓'
  })

  await step('14l4e. Wave 14: Run Doctor preflights how-to-run with a checklist + copy commands', async () => {
    await openInsight()
    await runInsightCheck('Run Doctor')
    // A scoped .iv-check:nth-child(3 of .iv-check) card with a verdict + at least one step + a copy-to-run command button.
    await waitFor(`!!document.querySelector('.iv-check:nth-child(3 of .iv-check) .ok-box, .iv-check:nth-child(3 of .iv-check) .error-box') && document.querySelectorAll('.iv-check:nth-child(3 of .iv-check) .iv-row').length > 0 && !!document.querySelector('.iv-check:nth-child(3 of .iv-check) .iv-cmd')`, { timeout: 8000, what: 'run doctor checklist + copy command' })
    await shot('wave14-run-doctor')
    await clickSel('[aria-label="Close Insight"]')
    return 'run doctor: install/start checklist with a copy-to-run command ✓'
  })

  await step('14l4f. Wave 15: Fix-Verify — "Fix with AI" then Apply posts a plain-English re-check verdict', async () => {
    const cssFile = path.join(PROJECT, 'src', 'wave15.css')
    fs.writeFileSync(cssFile, '.w15{color:#ef4444;padding:9px}.w15b{color:#ef4448;margin:9px}') // 2 hardcoded + 1 near-dup = 3 design nits
    try {
      // Mock the agent to actually FIX the design — rewrite the css with the colors REMOVED. This makes the
      // re-scan measurably drop the count, so the test proves verifyAfterApply genuinely re-runs the scan
      // (a stale/no-op re-check would read "No change" and fail — i.e. this assertion is NOT vacuous).
      writeAgentScript([
        'Removing the hardcoded colors.\nACTION write src/wave15.css\n```css\n.w15{padding:9px}\n.w15b{margin:9px}\n```',
        'ACTION done\nreplaced the hardcoded colors'
      ])
      await openInsight()
      await runInsightCheck('Design consistency')
      await openInsight('Overview')
      await waitFor(`[...document.querySelectorAll('.action-plan .action-row')].some(r => /design/i.test(r.textContent) && [...r.querySelectorAll('.btn')].some(b => b.textContent.trim() === 'Fix with AI'))`, { timeout: 8000, what: 'the design row with a Fix-with-AI button' })
      // Arm the DESIGN row specifically (snapshots its 3-nit "before"), so the css fix measurably reduces IT.
      await js(`(() => { const r=[...document.querySelectorAll('.action-plan .action-row')].find(x=>/design/i.test(x.textContent)); const b=[...r.querySelectorAll('.btn')].find(x=>x.textContent.trim()==='Fix with AI'); b.click(); return true })()`)
      await waitFor(`!!document.querySelector('.agent-panel')`, { timeout: 4000, what: 'agent dock opened by Fix with AI' })
      // Run the agent — build mode auto-applies with no click needed → onAgentApplied re-scans design and posts a verdict.
      await setNativeValue('.agent-input textarea', 'apply the fix', 'HTMLTextAreaElement')
      await clickByText('.agent-input .btn', 'Start')
      await waitFor(() => fs.readFileSync(cssFile, 'utf8').includes('padding:9px') && !fs.readFileSync(cssFile, 'utf8').includes('#ef4444'), { timeout: 20000, what: 'fix auto-applied to disk' })
      // The Fix-Verify banner appears — a scoped .verify-box (NOT ok-box/error-box). The colors were
      // removed, so the design count DROPPED → a "Fixed" (verify-fixed) or "Better" (verify-improved) verdict.
      await waitFor(`!!document.querySelector('.verify-box.verify-fixed, .verify-box.verify-improved')`, { timeout: 10000, what: 'fix-verify verdict banner showing the count dropped' })
      const verdictTxt = await js(`document.querySelector('.verify-box').textContent`)
      if (!/Fixed|Better/.test(verdictTxt)) throw new Error('re-scan must show the count dropped after the fix: ' + verdictTxt)
      await shot('wave15-fix-verify')
      await clickSel('[aria-label="Close Insight"]')
    } finally {
      fs.rmSync(cssFile, { force: true })
    }
    return 'Fix-Verify: Fix with AI → Apply → the re-scan proves the fix worked (count dropped) ✓'
  })

  await step('14l5. Wave 8: air-gapped model catalog in Settings → AI (installed + pull)', async () => {
    await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.modal .settings select')`, { what: 'settings AI tab' })
    // Pick the local provider → the on-device catalog loads (fake ollama).
    await setNativeValue('.modal .settings select', 'ollama', 'HTMLSelectElement')
    await waitFor(`[...document.querySelectorAll('.model-catalog .debt-row')].some(r => r.textContent.includes('qwen2.5-coder') && /installed/.test(r.textContent))`, { timeout: 8000, what: 'installed model row' })
    // A non-installed recommended model offers a copy (pull) button.
    const hasCopy = await js(`[...document.querySelectorAll('.model-catalog .debt-row .btn')].some(b => /Copy/.test(b.textContent))`)
    if (!hasCopy) throw new Error('no copy-pull button for a non-installed model')
    // Wave 9: a non-installed model also offers a one-click "Pull" (live download) button.
    const hasPull = await js(`[...document.querySelectorAll('.model-catalog .debt-row .btn')].some(b => b.textContent.trim() === 'Pull')`)
    if (!hasPull) throw new Error('no Pull button for a non-installed model')
    // Wave 10: start a pull (fake `pull` stays running) → the row shows "Pulling…" + a Cancel
    // button; clicking Cancel SIGKILLs it, its terminal 'system' line un-sticks the button
    // (never freezes at "Pulling…"), and the progress reads "cancelled".
    await clickByText('.model-catalog .debt-row .btn', 'Pull')
    await waitFor(`[...document.querySelectorAll('.model-catalog .debt-row .btn')].some(b => b.textContent.trim() === 'Cancel') && [...document.querySelectorAll('.model-catalog .debt-row .btn')].some(b => b.textContent.trim() === 'Pulling…')`, { timeout: 8000, what: 'live pull shows Cancel + Pulling…' })
    // Wave 11: close Settings mid-pull and reopen — the still-running pull REHYDRATES
    // (row shows "Pulling…" + Cancel again) instead of being silently orphaned.
    await clickSel('.modal-backdrop')
    await waitFor(`!document.querySelector('.modal .settings')`, { timeout: 4000, what: 'settings closed' })
    await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.model-catalog') && [...document.querySelectorAll('.model-catalog .debt-row .btn')].some(b => b.textContent.trim() === 'Cancel') && [...document.querySelectorAll('.model-catalog .debt-row .btn')].some(b => b.textContent.trim() === 'Pulling…')`, { timeout: 10000, what: 'pull rehydrated after Settings reopen' })
    await clickByText('.model-catalog .debt-row .btn', 'Cancel')
    await waitFor(`[...document.querySelectorAll('.model-catalog .pull-progress')].some(s => /cancelled/i.test(s.textContent))`, { timeout: 8000, what: 'cancelled pull labelled' })
    const stuck = await js(`[...document.querySelectorAll('.model-catalog .btn')].some(b => b.textContent.trim() === 'Pulling…')`)
    if (stuck) throw new Error('a cancelled pull left the button stuck at "Pulling…"')
    // A model the user pulled themselves (codellama, not in the curated six) is listed under
    // "Also installed" with a one-click Use — it used to be invisible here even though the
    // provider would run it happily.
    const mine = await js(`[...document.querySelectorAll('.model-catalog .debt-row')].some(r => /codellama:13b/.test(r.textContent) && [...r.querySelectorAll('.btn')].some(b => b.textContent.trim() === 'Use'))`)
    if (!mine) throw new Error('an uncurated installed model must be listed with a Use button')
    // The catalog states this machine's RAM, so "~8.9 GB" means something to a non-coder.
    const ram = await js(`/\\d+ GB RAM/.test(document.querySelector('.model-catalog .settings-subhead').textContent)`)
    if (!ram) throw new Error('the catalog must state the machine\'s RAM')
    await shot('wave8-catalog')
    // Restore the mock provider so later steps (and re-runs) are unaffected.
    await setNativeValue('.modal .settings select', 'mock', 'HTMLSelectElement')
    await clickSel('.modal-backdrop')
    return 'catalog: qwen installed + uncurated codellama listed w/ Use + RAM stated + Pull/Cancel/rehydrate'
  })

  await step('14m. Settings AI-budget cap persists; History shows a Time-Machine checkpoint', async () => {
    // Cap control in Settings → AI.
    await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.settings-tabs')`, { what: 'settings' })
    await clickByText('.settings-tabs .seg-btn', 'AI')
    /* Addressed by test id, not by "the last number input on the page": the AI tab now carries TWO
       budgets (tokens for chat, dollars for image/video), and a positional grab silently typed the
       token cap into the media one. Both are asserted, so neither can quietly stop persisting. */
    const setNum = (testid, value) => js(`(() => {
      const el = document.querySelector('[data-testid=${JSON.stringify(testid)}]');
      if (!el) return 'NOT_FOUND';
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK' })()`).then((r) => { if (r !== 'OK') throw new Error(`set ${testid} → ${r}`) })

    await setNum('cap-tokens', '500')
    await setNum('cap-media-usd', '7.5')
    await sleep(200)
    if ((await js(`localStorage.getItem('studio.spendCapK')`)) !== '500') throw new Error('token cap not persisted')
    if ((await js(`localStorage.getItem('studio.mediaCapUsd')`)) !== '7.5') throw new Error('image/video budget not persisted')
    await clickByLabel('.topbar-actions .btn', 'Settings')

    // The agent build run in step 13 dropped a "Before:" checkpoint → visible in Changes.
    await openPanelTab('Changes')
    const hasCheckpoint = await waitFor(
      `[...document.querySelectorAll('.hist-label')].some(e => e.textContent.includes('Before:')) ? 'yes' : (document.querySelector('.history-body') ? 'no-mark' : false)`,
      { timeout: 8000, what: 'history body' }
    )
    // Checkpoint exists only if a build run happened this session (it did, step 13/14c).
    await shot('checkpoints')
    await clickSel('.panel-close')
    return `both budgets persisted (500k tokens · $7.50 media) · checkpoints: ${hasCheckpoint}`
  })

  await step('15. Click-to-edit works via React fiber source (Next/CRA path, no stamping)', async () => {
    // A page that mimics a React 18 dev build: a DOM node carrying a
    // __reactFiber$ key whose owner chain has _debugSource. This is exactly
    // what Next.js/CRA dev servers produce — no Vite stamping involved.
    fs.mkdirSync(FIBER_PROJ, { recursive: true })
    fs.writeFileSync(
      path.join(FIBER_PROJ, 'index.html'),
      `<html><body>
      <button id="fb" style="padding:20px">Fiber button</button>
      <button id="sv" style="padding:20px">Svelte button</button>
      <button id="vu" style="padding:20px">Vue button</button>
      <script>
        function FakeButton() {}
        var el = document.getElementById('fb');
        el['__reactFiber$uitest'] = {
          return: { _debugSource: { fileName: '/fake/src/FakeButton.tsx', lineNumber: 7 }, type: FakeButton }
        };
        // Svelte dev-mode shape (loc.line is 0-based)
        document.getElementById('sv').__svelte_meta = { loc: { file: 'src/Card.svelte', line: 11, column: 2 } };
        // Vue 3 dev-mode shape
        document.getElementById('vu').__vueParentComponent = {
          parent: null, type: { __file: '/fake/src/Header.vue', name: 'AppHeader' }
        };
      </script></body></html>`
    )
    await clickByText('.topbar-actions .btn', 'Open project') // queue → fiber fixture
    await waitFor(`(document.querySelector('.left')?.textContent || '').includes('fiber-fixture')`, {
      what: 'fiber fixture opened'
    })
    await clickByText('.topbar-actions .btn', 'Run preview')
    await waitFor(`!!document.querySelector('.tab-preview .badge-running')`, { timeout: 30000, what: 'served' })
    await sleep(1200)
    await clickByText('.preview-toolbar .btn', 'Select element')
    const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    if (!guests.length) throw new Error('no webview')
    await guests[0].executeJavaScript(
      `document.getElementById('fb').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`
    )
    const chip = await waitFor(`document.querySelector('.sel-chip')?.textContent || ''`, {
      timeout: 10000,
      what: 'selection chip'
    })
    if (!chip.includes('FakeButton') || !chip.includes('/fake/src/FakeButton.tsx:7'))
      throw new Error(`sel-chip = "${chip}"`)
    await shot('fiber-select')
    await clickByText('.edit-panel .btn', 'Cancel')
    return chip
  })

  await step('15b. Same for Svelte (__svelte_meta) and Vue (__vueParentComponent)', async () => {
    const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    const pick = async (id) => {
      await clickByText('.preview-toolbar .btn', 'Select element')
      await guests[0].executeJavaScript(
        `document.getElementById(${JSON.stringify(id)}).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`
      )
      const chip = await waitFor(`document.querySelector('.sel-chip')?.textContent || ''`, {
        timeout: 10000,
        what: `${id} selection chip`
      })
      await clickByText('.edit-panel .btn', 'Cancel')
      return chip
    }
    const svelte = await pick('sv')
    if (!svelte.includes('src/Card.svelte:12')) throw new Error(`svelte chip = "${svelte}"`)
    const vue = await pick('vu')
    if (!vue.includes('AppHeader') || !vue.includes('/fake/src/Header.vue'))
      throw new Error(`vue chip = "${vue}"`)
    await clickByText('.topbar-actions .btn', 'Stop')
    await waitFor(`!document.querySelector('.tab-preview .badge-running')`, { what: 'stopped' })
    return `svelte: ${svelte} · vue: ${vue}`
  })

  await step('15e. Wave 23: the file tree updates LIVE when a file changes outside the app', async () => {
    // Real bug report: creating/deleting a file another way (Finder, a terminal command, npm install)
    // never showed up in the tree — it only ever reflected what the app's OWN writes did. This writes
    // directly to disk with plain Node fs, completely bypassing every app IPC call, exactly like an
    // external tool would.
    const NAME = `w23-external-${process.pid}.txt`
    const abs = path.join(FIBER_PROJ, NAME)
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
    fs.writeFileSync(abs, 'created outside the app\n')
    try {
      await waitFor(
        `[...document.querySelectorAll('.ex-name')].some(e => e.textContent === ${JSON.stringify(NAME)})`,
        { timeout: 6000, what: 'externally-created file appears in the tree with no app action' }
      )
      await shot('wave23-live-tree-create')
      // Now delete it the same external way and prove the tree drops it too — not just one-directional.
      fs.rmSync(abs, { force: true })
      await waitFor(
        `![...document.querySelectorAll('.ex-name')].some(e => e.textContent === ${JSON.stringify(NAME)})`,
        { timeout: 6000, what: 'externally-deleted file disappears from the tree' }
      )
    } finally {
      fs.rmSync(abs, { force: true })
    }
    return 'a file created by plain fs.writeFileSync (no app IPC at all) appeared in the tree unprompted; deleting it externally removed it too'
  })

  await step('15c. Explorer: + File creates it; × now PREVIEWS the loss, then moves it to the Trash', async () => {
    // Unique name so the Trash entry this test creates can be removed again by exact match — the suite
    // must not leave residue on the user's machine.
    const NAME = `w21-notes-${process.pid}.txt`
    await clickByLabel('.sb-action', 'New File')
    await waitFor(`!!document.querySelector('.ex-creating input')`, { what: 'the inline new-file row' })
    await js(`(() => {
      const el = document.querySelector('.ex-creating input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(NAME)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'OK' })()`)
    await waitFor(`[...document.querySelectorAll('.ex-name')].some(e => e.textContent === ${JSON.stringify(NAME)})`, { what: 'file in tree' })
    if (!fs.existsSync(path.join(FIBER_PROJ, NAME))) throw new Error('file not on disk')
    // Give it real content so the preview has a real size to report.
    fs.writeFileSync(path.join(FIBER_PROJ, NAME), 'hello from wave 21\n')
    // Delete is ⌫ on the focused row — the same safe confirm-and-Trash flow, reached the way VS
    // Code reaches it. The tree has no per-row × any more.
    const del = async () => {
      const picked = await js(`(() => {
        const row = [...document.querySelectorAll('.ex-row')].find(r => r.textContent.includes(${JSON.stringify(NAME)}));
        if (!row) return 'NO_ROW';
        row.click(); return 'OK' })()`)
      if (picked !== 'OK') throw new Error(`could not select ${NAME}: ${picked}`)
      await sleep(250)
      await js(`document.querySelector('.ex-scroll').focus(); true`)
      await key('Delete')
      await sleep(400)
    }

    // FIRST × — must now show a real preview of what would be lost, not just "press again".
    await del()
    await waitFor(`!!document.querySelector('.delete-preview')`, { timeout: 8000, what: 'delete preview strip' })
    const preview = await js(`document.querySelector('.delete-preview').textContent`)
    if (!/one file/i.test(preview)) throw new Error(`the preview must say what is being deleted: ${preview}`)
    if (!/bytes|KB|MB/.test(preview)) throw new Error(`the preview must state a real size: ${preview}`)
    if (!/Move to Trash/.test(preview)) throw new Error(`the confirm button must name the real action: ${preview}`)
    // It must NEVER claim this file is backed up. The fixture lives under the git-IGNORED .ui-test/,
    // so git can see nothing here — the honest answer is "I can't tell", never a reassuring zero.
    if (/All of it is already backed up/.test(preview)) throw new Error(`work git cannot see must never read as backed up: ${preview}`)
    // The fixture lives under the git-IGNORED .ui-test/, so the honest answer is either "I can't tell"
    // or the stronger certainty "it's on the ignore list, so it has never been backed up".
    if (!/can't tell whether|ignore list/.test(preview)) throw new Error(`a git-ignored project must not imply a backup exists: ${preview}`)
    await shot('wave21-delete-preview')

    // "Keep it" must genuinely cancel — the file stays on disk.
    await clickByText('.delete-preview .btn', 'Keep it')
    await waitFor(`!document.querySelector('.delete-preview')`, { what: 'preview dismissed' })
    await sleep(150)
    if (!fs.existsSync(path.join(FIBER_PROJ, NAME))) throw new Error('"Keep it" must NOT delete the file')

    // Arm again, then confirm through the strip's own button → the file goes to the Trash.
    await del()
    await waitFor(`!!document.querySelector('.delete-preview')`, { what: 'preview re-armed' })
    await clickByText('.delete-preview .btn', 'Move to Trash')
    await waitFor(() => !fs.existsSync(path.join(FIBER_PROJ, NAME)), { timeout: 8000, what: 'file moved to Trash' })
    // The toast must point at a REAL recovery route, not just say "deleted".
    const toast = await js(`document.querySelector('.toast')?.textContent || ''`)
    if (!/Trash/.test(toast)) throw new Error(`the confirmation must tell the user where it went: ${toast}`)
    purgeFromTrash(NAME)
    return 'created + × previewed the real loss (size, not-backed-up), Keep it cancelled, Move to Trash removed it with a recovery hint'
  })

  await step('15d. Wave 21 seatbelt: closing a tab with unsaved typing asks before throwing it away', async () => {
    const NAME = `w21-dirty-${process.pid}.txt`
    // Create through the app's own + File flow so the tree knows about it AND it opens as a tab.
    await clickByLabel('.sb-action', 'New File')
    await waitFor(`!!document.querySelector('.ex-creating input')`, { what: 'the inline new-file row' })
    await js(`(() => {
      const el = document.querySelector('.ex-creating input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(NAME)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return 'OK' })()`)
    await waitFor(`[...document.querySelectorAll('.tab .tab-name')].some(t => t.textContent.trim() === ${JSON.stringify(NAME)})`, { timeout: 10000, what: 'new file opened as a tab' })
    const ABS = path.join(FIBER_PROJ, NAME)

    const closeIt = () => js(`(() => {
      const tab = [...document.querySelectorAll('.tab')].find(t => (t.querySelector('.tab-name')?.textContent || '').trim() === ${JSON.stringify(NAME)});
      if (!tab) return 'NO_TAB';
      const x = tab.querySelector('.tab-close'); if (!x) return 'NO_X';
      x.click(); return 'OK' })()`)
    const tabOpen = () => js(`[...document.querySelectorAll('.tab .tab-name')].some(t => t.textContent.trim() === ${JSON.stringify(NAME)})`)

    // A CLEAN tab must still close in ONE click — the anti-intrusion guarantee.
    await closeIt()
    await sleep(300)
    if (await js(`!!document.querySelector('.unsaved-guard')`)) throw new Error('a CLEAN tab must close without interruption')
    if (await tabOpen()) throw new Error('a clean tab should have closed in one click')

    // Re-open from the tree, TYPE (making it dirty), then close → the seatbelt must stop it.
    await clickByText('.ex-row', NAME)
    await waitFor(`!!window.__studioEditor`, { timeout: 30000, what: 'editor ready' })
    await waitFor(`[...document.querySelectorAll('.tab .tab-name')].some(t => t.textContent.trim() === ${JSON.stringify(NAME)})`, { timeout: 8000, what: 'file re-opened' })
    await sleep(400)
    await typeVerified('typed but never saved')
    await waitFor(`[...document.querySelectorAll('.tab')].some(t => (t.querySelector('.tab-name')?.textContent || '').trim() === ${JSON.stringify(NAME)} && t.querySelector('.tab-dot'))`, { timeout: 6000, what: 'tab marked unsaved' })
    await closeIt()
    await waitFor(`!!document.querySelector('.unsaved-guard')`, { timeout: 6000, what: 'unsaved-work seatbelt' })
    const guard = await js(`document.querySelector('.unsaved-guard').textContent`)
    if (!guard.includes(NAME)) throw new Error(`the seatbelt must name the file: ${guard}`)
    if (!/nothing can bring it back/i.test(guard)) throw new Error(`it must say why this differs from a normal delete: ${guard}`)
    await shot('wave21-unsaved-seatbelt')

    // Cancel keeps the tab open AND keeps the typing.
    await clickByText('.unsaved-guard .btn', 'Cancel')
    await waitFor(`!document.querySelector('.unsaved-guard')`, { what: 'seatbelt dismissed' })
    if (!(await tabOpen())) throw new Error('Cancel must keep the tab open')
    if (!(await js(`(window.__studioEditor?.getModel()?.getValue() || '').includes('typed but never saved')`)))
      throw new Error('Cancel must keep the unsaved typing in the editor')

    // Discard closes it, and the file on disk is untouched (the typing never reached disk).
    await closeIt()
    await waitFor(`!!document.querySelector('.unsaved-guard')`, { what: 'seatbelt again' })
    await clickByText('.unsaved-guard .btn', 'Discard my typing')
    await waitFor(`![...document.querySelectorAll('.tab .tab-name')].some(t => t.textContent.trim() === ${JSON.stringify(NAME)})`, { timeout: 6000, what: 'tab closed after discard' })
    if (fs.readFileSync(ABS, 'utf8').includes('typed but never saved')) throw new Error('discarded typing must never reach the disk file')
    fs.rmSync(ABS, { force: true })
    return 'clean tab closes in one click; dirty tab held with a named warning; Cancel keeps tab + typing; Discard closes it and leaves the disk file untouched'
  })

  await step('16. A plain HTML folder previews via the built-in static server', async () => {
    await clickByText('.topbar-actions .btn', 'Open project') // second fixture: hello-static
    await waitFor(`(document.querySelector('.left')?.textContent || '').includes('hello-static')`, {
      what: 'static project opened'
    })
    const fw = await textOf('.left-fw')
    if (fw !== 'static-html') throw new Error(`framework badge = ${fw}`)
    await clickByText('.topbar-actions .btn', 'Run preview')
    await waitFor(`!!document.querySelector('.tab-preview .badge-running')`, {
      timeout: 30000,
      what: 'static server running'
    })
    await sleep(1500) // let the webview paint
    const guests = webContents.getAllWebContents().filter((w) => w.getType() === 'webview')
    const inner = guests.length
      ? await guests[0].executeJavaScript(`document.body.innerText`).catch(() => null)
      : null
    if (!inner || !inner.includes('plain website')) throw new Error(`webview body: ${JSON.stringify(inner)}`)
    const hasReload = guests.length
      ? await guests[0].executeJavaScript(`!!document.querySelector('script') && document.documentElement.outerHTML.includes('__studio_reload')`).catch(() => false)
      : false
    if (!hasReload) throw new Error('live-reload script not present in served page')
    await shot('static-preview')
    await clickByText('.topbar-actions .btn', 'Stop')
    await waitFor(`!document.querySelector('.tab-preview .badge-running')`, { what: 'static server stopped' })
    return `served + live-reload injected (${fw})`
  })

  await step('16b. Air-Gapped Mode: chip collapses AI providers to local-only, then restores', async () => {
    // Normalize to OFF via the chip (keeps React state + persisted flag in sync)
    // in case a prior crashed run left the flag on.
    if (await js(`!!document.querySelector('.air-gap-chip.status-chip-airgap')`)) {
      await clickSel('.air-gap-chip')
      await waitFor(`!document.querySelector('.air-gap-chip.status-chip-airgap')`, { timeout: 6000, what: 'reset air-gap off' })
    }
    const before = await js(`window.studio.listProviders().then(p => p.map(x => x.id).join(','))`)
    await clickSel('.air-gap-chip')
    await waitFor(`!!document.querySelector('.air-gap-chip.status-chip-airgap') && (document.querySelector('.air-gap-chip')?.textContent || '').includes('Air-gapped')`, { timeout: 6000, what: 'air-gapped chip on' })
    const gapped = await js(`window.studio.listProviders().then(p => p.map(x => x.id))`)
    if (gapped.some((id) => id !== 'ollama' && id !== 'mock')) throw new Error('non-local provider still listed under air-gap: ' + gapped.join(','))
    if (!gapped.includes('ollama')) throw new Error('ollama should remain available under air-gap')
    // Restore so the crash check + any later state is unaffected.
    await clickSel('.air-gap-chip')
    await waitFor(`!document.querySelector('.air-gap-chip.status-chip-airgap') && (document.querySelector('.air-gap-chip')?.textContent || '').includes('Online')`, { timeout: 6000, what: 'air-gap off' })
    const after = await js(`window.studio.listProviders().then(p => p.map(x => x.id).join(','))`)
    if (after !== before) throw new Error('provider list did not restore: ' + after + ' vs ' + before)
    await shot('air-gapped')
    return `collapsed to [${gapped.join(',')}], restored ${after.split(',').length} providers`
  })

  await step('16c. Activity bar: each icon opens its OWN surface (no two icons duplicate one)', async () => {
    /* Addressed by ACCESSIBLE NAME, not by :nth-of-type. Position was a false contract: adding the
       Create icon to the rail silently re-pointed every index in this step at the wrong button, and
       the step failed on a rail that was in fact perfectly correct. The name is what the user (and
       a screen reader) actually goes by, so that is what the test goes by. */
    const rail = '.activity-bar .ab-btn'
    const header = `(document.querySelector('.left .left-header')?.textContent || '')`

    await clickByLabel(rail, 'Extensions')
    await waitFor(`${header}.includes('Extensions')`, { timeout: 6000, what: 'Extensions sidebar' })
    if (await js(`!!document.querySelector('.modal .settings')`)) throw new Error('Extensions must not open the Settings modal')

    // Create (images + video): its own sidebar surface, and never the Settings modal.
    await clickByLabel(rail, 'Create images and video')
    await waitFor(`${header}.includes('Create')`, { timeout: 6000, what: 'Create sidebar' })
    if (await js(`!!document.querySelector('.modal .settings')`)) throw new Error('Create must not open the Settings modal')
    if (!(await js(`!!document.querySelector('[data-testid="media-panel"]')`))) throw new Error('Create panel did not render')

    // Account: a sidebar view showing real connection state — NOT a second door to Settings.
    await clickByLabel(rail, 'Account')
    await waitFor(`${header}.includes('Account')`, { timeout: 6000, what: 'Account sidebar' })
    if (await js(`!!document.querySelector('.modal .settings')`))
      throw new Error('Account opened the Settings modal — that is the duplicate-popup bug this step guards')
    if (!(await js(`!!document.querySelector('.account-panel')`))) throw new Error('Account panel did not render')

    // Settings is the ONLY icon that may open the modal.
    await clickByLabel(rail, 'Settings')
    await waitFor(`!!document.querySelector('.modal .settings')`, { timeout: 6000, what: 'Settings modal' })
    const tab = await js(`(document.querySelector('.settings-tabs .seg-btn.active')?.textContent || '').trim()`)
    if (tab !== 'AI') throw new Error(`Settings should open on AI, got "${tab}"`)
    await js(`document.querySelector('.modal-backdrop').click(), 'ok'`)
    await waitFor(`!document.querySelector('.modal .settings')`, { timeout: 6000, what: 'settings closed' })

    // No two rail icons may claim the same accessible name, or "each icon opens its own surface"
    // cannot be checked by name at all — and a user could not tell them apart either.
    const names = await js(`[...document.querySelectorAll('.activity-bar .ab-btn')].map(b => b.getAttribute('aria-label') || '')`)
    if (new Set(names).size !== names.length) throw new Error(`two rail icons share a name: ${names.join(' | ')}`)

    // Explorer restores the file tree.
    await clickByLabel(rail, 'Explorer')
    await waitFor(`!!document.querySelector('.ex-row')`, { timeout: 6000, what: 'file tree back' })
    await shot('activity-bar')
    return `${names.length} rail icons, all uniquely named; Extensions / Create / Account / Settings each open a distinct surface; only ⚙ opens the modal`
  })

  await step('16d. No glyph without Windows/Linux font coverage ever reaches the DOM', async () => {
    // Mathematical Alphanumerics (the old 𝗃𝗌 file icon) and U+2B73 (the old export arrow)
    // render as tofu boxes off macOS. This walks the real rendered text, so it catches a
    // regression anywhere in the tree, not just at the sites that were fixed.
    const tofu = await js(`(() => {
      const bad = [0x1D5C3, 0x1D5CC, 0x2B73];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      let n;
      while ((n = walk.nextNode())) {
        for (const ch of n.nodeValue || '') if (bad.includes(ch.codePointAt(0))) hits.push(ch);
      }
      return hits.join(',');
    })()`)
    if (tofu) throw new Error(`codepoints with no Windows/Linux font coverage rendered: ${tofu}`)
    return 'no tofu-risk codepoints in the live DOM'
  })

  await step('18. Menu bar: every top-level menu exists, and its items DO the thing', async () => {
    const menu = Menu.getApplicationMenu()
    if (!menu) throw new Error('no application menu is installed — Electron\'s generic default is not a menu bar')
    const labels = menu.items.map((i) => i.label)
    // The set VS Code has, which is what was asked for.
    for (const want of ['File', 'Edit', 'Selection', 'View', 'Go', 'Run', 'Terminal', 'Window', 'Help']) {
      if (!labels.includes(want)) throw new Error(`menu "${want}" missing — have: ${labels.join(', ')}`)
    }
    /* Always re-read the live menu: it is REBUILT whenever the renderer pushes new state (that is
       how "Show Panel" becomes "Hide Panel"), so any reference held across a click is stale. */
    const item = (top, label) => {
      const live = Menu.getApplicationMenu()
      const m = live && live.items.find((i) => i.label === top)
      return (m && m.submenu && m.submenu.items.find((i) => i.label === label)) || null
    }
    const find = (top, label) => {
      const hit = item(top, label)
      if (!hit) throw new Error(`${top} ▸ ${label} not found`)
      return hit
    }
    /* The rebuild is driven by an IPC round-trip from the renderer, so the new label appears a tick
       or two after the state changes. */
    const waitForItem = async (top, label) => {
      for (let i = 0; i < 40; i++) {
        if (item(top, label)) return item(top, label)
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`${top} ▸ ${label} never appeared (the menu did not rebuild from renderer state)`)
    }
    // No dead items: every command entry must carry a click handler or a role.
    const dead = []
    for (const top of menu.items) {
      if (!top.submenu) continue
      for (const it of top.submenu.items) {
        if (it.type === 'separator') continue
        if (it.submenu) {
          for (const sub of it.submenu.items) {
            if (sub.type !== 'separator' && !sub.role && typeof sub.click !== 'function') dead.push(`${top.label} ▸ ${it.label} ▸ ${sub.label}`)
          }
          continue
        }
        if (!it.role && typeof it.click !== 'function') dead.push(`${top.label} ▸ ${it.label}`)
      }
    }
    if (dead.length) throw new Error(`menu items that do nothing: ${dead.join(', ')}`)

    // Now prove three of them actually work, end to end, by clicking the REAL menu item.
    // Earlier steps close the panel and that choice is remembered, so open it first and then
    // exercise the toggle in both directions.
    if (!(await js(`!!document.querySelector('.panel')`))) {
      ;(await waitForItem('View', 'Show Panel')).click()
      await waitFor(`!!document.querySelector('.panel')`, { timeout: 6000, what: 'menu opened the panel' })
    }
    ;(await waitForItem('View', 'Hide Panel')).click()
    await waitFor(`!document.querySelector('.panel')`, { timeout: 6000, what: 'menu closed the panel' })
    // ...and the label flips back, because the menu is rebuilt from renderer state.
    ;(await waitForItem('View', 'Show Panel')).click()
    await waitFor(`!!document.querySelector('.panel')`, { timeout: 6000, what: 'menu reopened the panel' })

    // Terminal ▸ New Terminal opens the terminal panel and adds a session.
    find('Terminal', 'Show Terminal').click()
    await waitFor(`!!document.querySelector('.term-drawer')`, { timeout: 8000, what: 'menu opened the terminal' })
    const before = await count('.term-tab')
    find('Terminal', 'New Terminal').click()
    await waitFor(`document.querySelectorAll('.term-tab').length === ${before + 1}`, { timeout: 10000, what: 'menu added a terminal tab' })

    // View ▸ Command Palette… opens the palette (and Esc closes it).
    find('View', 'Command Palette…').click()
    await waitFor(`!!document.querySelector('.palette')`, { timeout: 6000, what: 'menu opened the palette' })
    await js(`(document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 'ok')`)
    await waitFor(`!document.querySelector('.palette')`, { timeout: 6000, what: 'palette closed' })
    await shot('menu-bar')
    await clickSel('.panel-close')
    return `${labels.length} menus, no dead items; Hide/Show Panel + New Terminal + Command Palette driven from the real menu`
  })

  await step('19. Extensions: install from a folder, approve a tool, and the GitHub warning is real', async () => {
    // A tiny real extension on disk — the folder install path takes no network at all.
    const extSrc = path.join(__dirname, '..', '.ui-test', 'demo-extension')
    fs.rmSync(extSrc, { recursive: true, force: true })
    fs.mkdirSync(extSrc, { recursive: true })
    const server = path.join(extSrc, 'server.cjs')
    fs.writeFileSync(
      server,
      `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c.toString()
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch (e) { continue }
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1.0.0' } } })
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echoes back', inputSchema: { type: 'object' } }] } })
    else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`
    )
    fs.writeFileSync(
      path.join(extSrc, 'atomic-extension.json'),
      JSON.stringify({ id: 'demo-connector', name: 'Demo Connector', version: '1.0.0', description: 'a test connector', kind: 'mcp', command: process.execPath, args: [server] })
    )
    // Stub the folder picker for this step only, the same way the harness stubs "open project".
    const realOpen = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [extSrc] })

    try {
      await clickByLabel('.topbar-actions .btn', 'Settings')
      await waitFor(`!!document.querySelector('.modal .settings')`, { what: 'settings' })
      await clickByText('.settings-tabs .seg-btn', 'Extensions')
      await waitFor(`!!document.querySelector('.ext-view')`, { what: 'extensions view' })
      // The old placeholder must be gone — it promised a feature that now exists.
      if (await js(`!!document.querySelector('.ext-marketplace-soon')`)) throw new Error('the "coming soon" box is still there')

      // The install actions live behind the "+" in the search row, VS Code's ⋯ menu position.
      await clickSel('.ext-more')
      await clickByText('.ext-install .btn', 'From a folder')
      const rowText = `[...document.querySelectorAll('.ext-row')].find(r => r.textContent.includes('Demo Connector'))`
      await waitFor(`!!(${rowText})`, { timeout: 10000, what: 'installed connector row' })
      // Installed but INERT: nothing downloaded starts running by itself.
      const enableLabel = await js(`(${rowText}).querySelector('.ext-action').textContent.trim()`)
      if (!/Enable/.test(enableLabel)) throw new Error('a freshly installed connector must start disabled: ' + enableLabel)

      await js(`((${rowText}).querySelector('.ext-action').click(), 'OK')`)
      // Tool approval lives on the detail page — open the row to reach it.
      await js(`((${rowText}).click(), 'OK')`)
      await waitFor(`!!document.querySelector('.ext-detail')`, { timeout: 8000, what: 'extension detail page' })
      await js(`([...document.querySelectorAll('.ext-detail-tab')].find(t => /Features/.test(t.textContent)).click(), 'OK')`)
      await waitFor(`document.querySelectorAll('.ext-tools input').length === 1`, { timeout: 15000, what: 'tool list after enabling' })
      const approvedBefore = await js(`document.querySelector('.ext-tools input').checked`)
      if (approvedBefore) throw new Error('a tool must arrive UNapproved — enabling a connector is not approving its tools')
      await js(`(document.querySelector('.ext-tools input').click(), 'OK')`)
      await waitFor(`document.querySelector('.ext-tools input').checked === true`, { timeout: 6000, what: 'tool approved' })
      await shot('extensions-detail')
      await clickSel('.ext-detail .panel-close')

      // The GitHub path must say, in words, that this runs someone else's code.
      await js(`(() => { const el = document.querySelector('.ext-install-git input.text-input');
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, 'https://github.com/example/thing');
        el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK' })()`)
      await clickByText('.ext-install-git .btn', 'Install')
      await waitFor(`!!document.querySelector('.install-confirm')`, { timeout: 6000, what: 'install warning' })
      const warning = await textOf('.install-confirm')
      if (!/runs someone else's code/i.test(warning) || !/read and change your files/i.test(warning)) {
        throw new Error('the install warning must say plainly what it allows: ' + warning)
      }
      await clickByText('.install-confirm .btn', 'Cancel')
      await waitFor(`!document.querySelector('.install-confirm')`, { what: 'warning dismissed' })
      await shot('extensions-connectors')

      // Clean up so later runs start from nothing.
      await js(`((${rowText}).click(), 'OK')`)
      await waitFor(`!!document.querySelector('.ext-detail')`, { timeout: 8000, what: 'detail page for uninstall' })
      await clickByText('.ext-detail-actions .btn', 'Uninstall')
      await waitFor(`![...document.querySelectorAll('.ext-row')].some(r => r.textContent.includes('Demo Connector'))`, {
        timeout: 8000,
        what: 'connector removed'
      })
      await clickSel('.modal-backdrop')
      return 'folder install → disabled connector → tools listed unapproved → approval sticks → GitHub warning states the risk'
    } finally {
      dialog.showOpenDialog = realOpen
    }
  })

  await step('20. The agent USES the app it changed, and the run ends with proof', async () => {
    // The differentiator: not "the agent says it added a button", but the agent pressing that
    // button in the running app and handing back a screenshot of the result.
    const clickable = `import React from 'react'
import ReactDOM from 'react-dom/client'

function App(): React.JSX.Element {
  const [msg, setMsg] = React.useState('not clicked')
  return (
    <div style={{ fontFamily: 'system-ui', padding: 40, textAlign: 'center' }}>
      <h1 style={{ color: '#2563eb' }}>Hello from ATOMIC Studio</h1>
      <p id="out">{msg}</p>
      <button onClick={() => setMsg('CLICKED_OK')}>Press me</button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`
    writeAgentScript([
      'Adding the button now.\nACTION write src/main.tsx\n```tsx\n' + clickable + '\n```',
      'Starting the preview so I can try it.\nACTION run_preview',
      'Pressing the button I just added.\nACTION preview_click Press me',
      'Taking a screenshot of the result.\nACTION preview_snap',
      'ACTION done\nAdded a button and pressed it — the page now says CLICKED_OK.'
    ])

    /* Earlier steps move the open project on (hello-static, the fiber fixture), so re-open the vite
       sample through the REAL "Open project…" path — calling the IPC directly only changes the main
       process's idea of the project and leaves the window showing the old one. */
    const prevOpen = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJECT] })
    try {
      await clickByText('.topbar-actions .btn', 'Open project')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(n => n.textContent === 'vite.config.ts')`, {
        timeout: 25000,
        what: 'hello-vite reopened'
      })
    } finally {
      dialog.showOpenDialog = prevOpen
    }

    if (!(await js(`!!document.querySelector('.agent-panel')`))) await clickByLabel('.topbar-actions .btn', 'Agent')
    await waitFor(`!!document.querySelector('.agent-panel')`, { what: 'agent dock' })
    await setNativeValue('.agent-input textarea', 'Add a button and prove it works', 'HTMLTextAreaElement')
    await clickByText('.agent-input .btn', 'Start')

    // The click has to have really happened INSIDE the preview — read the live page, not our own UI.
    await waitFor(
      async () => {
        const wc = webContents.getAllWebContents().find((w) => /localhost:\d+/.test(w.getURL() || ''))
        if (!wc) return false
        try {
          return await wc.executeJavaScript(`document.getElementById('out') && document.getElementById('out').textContent === 'CLICKED_OK'`)
        } catch (e) {
          return false
        }
      },
      // Includes a cold vite start at the end of a long suite run.
      { timeout: 150000, what: 'the agent actually pressed the button in the running app' }
    )
    // The receipt only exists on a finished run, so this single wait covers both — and it fails with
    // the thing actually under test rather than an intermediate signal.

    /* The proof now lives on the Build Receipt itself, so assert the screenshot IS on the receipt —
       stronger than the old artifact-title check, which only proved a card existed. */
    try {
      await waitFor(`!!document.querySelector('.receipt .receipt-shot')`, {
        timeout: 45000,
        what: 'the receipt carrying a screenshot of the working app'
      })
    } catch (e) {
      // Say WHAT the agent actually did — a bare timeout here tells nobody anything.
      const trace = await js(`JSON.stringify({
        steps: [...document.querySelectorAll('.ap-tl-label')].map(n => n.textContent),
        results: [...document.querySelectorAll('.ap-tl-item')].map(n => n.className),
        done: !!document.querySelector('.msg-done'),
        err: [...document.querySelectorAll('.msg-err')].map(n => n.textContent).join(' | '),
        chat: [...document.querySelectorAll('.ap-conversation .msg')].map(n => n.textContent.slice(0, 120))
      })`)
      throw new Error(e.message + ' :: ' + trace)
    }
    const shotLen = await js(`document.querySelector('.receipt .receipt-shot').src.length`)
    if (shotLen < 5000) throw new Error(`the receipt screenshot must be a real image, got ${shotLen} chars`)
    await shot('agent-proof-receipt')
    fs.writeFileSync(TARGET_ABS, originalSource) // hand the fixture back as we found it
    return `agent pressed its own button in the live app; receipt carries a ${Math.round(shotLen / 1024)} KB screenshot`
  })

  await step('22. AI Build Receipt: the numbers are real, and Undo puts the whole run back', async () => {
    /* The signature feature. Every figure on the receipt has to be measured, not narrated — so this
       checks the receipt against what actually happened on disk, then uses its own Undo button and
       confirms the file really went back. */
    const before = fs.readFileSync(TARGET_ABS, 'utf8')
    const marker = 'RECEIPT_TEST_LINE'
    writeAgentScript([
      'Reading it first.\nACTION read_file src/main.tsx',
      'Adding the line.\nACTION write src/main.tsx\n```tsx\n' + `// ${marker}\n` + before + '\n```',
      'ACTION done\nAdded a marker comment to main.tsx.'
    ])
    if (!(await js(`!!document.querySelector('.agent-panel')`))) await clickByLabel('.topbar-actions .btn', 'Agent')
    await setNativeValue('.agent-input textarea', 'Add a marker comment', 'HTMLTextAreaElement')
    await clickByText('.agent-input .btn', 'Start')

    await waitFor(`!!document.querySelector('.receipt')`, { timeout: 45000, what: 'the build receipt' })
    await waitFor(() => fs.readFileSync(TARGET_ABS, 'utf8').includes(marker), { timeout: 20000, what: 'the edit on disk' })

    const receipt = await js(`JSON.stringify({
      files: [...document.querySelectorAll('.receipt-file .receipt-path')].map(n => n.textContent),
      stats: [...document.querySelectorAll('.receipt-stats span')].map(n => n.textContent),
      hasUndo: !!document.querySelector('.receipt-actions .btn-danger')
    })`)
    const r = JSON.parse(receipt)
    if (!r.files.some((f) => /main\.tsx/.test(f))) throw new Error(`the receipt must list the file it changed: ${receipt}`)
    const stats = r.stats.join(' | ')
    // Measured, not narrated: a real byte delta, a real check count, a real duration, real tokens.
    if (!/\d+\s*(B|KB|MB)/.test(stats)) throw new Error(`no size delta on the receipt: ${stats}`)
    if (!/checks?/.test(stats)) throw new Error(`no check count on the receipt: ${stats}`)
    if (!/\d+\s*(ms|s)\b/.test(stats)) throw new Error(`no duration on the receipt: ${stats}`)
    if (!/tokens/.test(stats)) throw new Error(`no token count on the receipt: ${stats}`)
    // What is deliberately absent must STAY absent: an unbacked perf/bundle number would poison
    // every number beside it.
    if (/bundle|performance/i.test(stats)) throw new Error(`the receipt must not claim what it cannot measure: ${stats}`)
    if (!r.hasUndo) throw new Error('a build run must offer to undo itself')
    await shot('build-receipt')

    // The receipt's own Undo — the part that makes it more than a summary.
    await clickByText('.receipt-actions .btn', 'Undo this whole run')
    await waitFor(() => !fs.readFileSync(TARGET_ABS, 'utf8').includes(marker), {
      timeout: 20000,
      what: 'the run rolled back on disk'
    })
    if (fs.readFileSync(TARGET_ABS, 'utf8') !== before) throw new Error('rollback must restore the file byte-for-byte')
    return `receipt listed ${r.files.length} file, real size/checks/duration/tokens, and its Undo restored the file exactly`
  })

  await step('21. Project Memory: you teach it once, the agent writes to it, and it survives a restart', async () => {
    /* Insight (and memory) need a project, and by this point in the run earlier steps have moved
       the open project around — so open the fixture explicitly rather than inheriting whatever is
       loaded, the same way step 20 does. */
    const prevOpen = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJECT] })
    try {
      await clickByText('.topbar-actions .btn', 'Open project')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(n => n.textContent === 'vite.config.ts')`, {
        timeout: 25000,
        what: 'the fixture project open'
      })
    } finally {
      dialog.showOpenDialog = prevOpen
    }
    await openInsight('Memory')
    await openInsight('Memory')
    await waitFor(`!!document.querySelector('.memory-panel')`, { timeout: 15000, what: 'memory panel' })

    // Teach the project something that could never be recovered by re-reading the code.
    await js(`(() => {
      const sel = document.querySelector('.memory-panel .mem-kind');
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, 'forbidden');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const inp = document.querySelector('.memory-panel .mem-add input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, 'MEMORY_RULE never touch the production database');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK' })()`)
    await clickByText('.memory-panel .mem-add .btn', 'Remember')
    await waitFor(`[...document.querySelectorAll('.memory-panel .mem-row')].some(r => /MEMORY_RULE/.test(r.textContent))`, {
      timeout: 8000,
      what: 'the memory listed'
    })

    // The preview runs the SAME retrieval the agent runs — a forbidden rule is always included,
    // whatever the task happens to be about.
    await js(`(() => {
      const inputs = document.querySelectorAll('.memory-panel .mem-add input');
      const inp = inputs[inputs.length - 1];
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, 'change the button colour');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK' })()`)
    await clickByText('.memory-panel .btn', 'Preview')
    await waitFor(`[...document.querySelectorAll('.mem-preview-row')].some(r => /MEMORY_RULE/.test(r.textContent))`, {
      timeout: 8000,
      what: 'a forbidden rule is loaded even for an unrelated task'
    })

    // The agent can write memory itself, and it is labelled as the AI's, not the user's.
    writeAgentScript([
      'Noting that for next time.\nACTION remember business-rule MEMORY_AI prices are records, never charges',
      'ACTION done\nRemembered a business rule.'
    ])
    if (!(await js(`!!document.querySelector('.agent-panel')`))) await clickByLabel('.topbar-actions .btn', 'Agent')
    await setNativeValue('.agent-input textarea', 'Remember how pricing works', 'HTMLTextAreaElement')
    await clickByText('.agent-input .btn', 'Start')
    await waitFor(`[...document.querySelectorAll('.ap-tl-label')].some(l => /Remembered|remember/i.test(l.textContent))`, {
      timeout: 30000,
      what: 'the agent used the remember action'
    })
    await openInsight('Memory')
    await waitFor(
      `[...document.querySelectorAll('.memory-panel .mem-row')].some(r => /MEMORY_AI/.test(r.textContent) && r.querySelector('.mem-by-ai'))`,
      { timeout: 20000, what: "the agent's memory, marked as written by the AI" }
    )
    await shot('project-memory')

    // Durability: memory is in the main process, not renderer state — reload the window and it is
    // still there. That is the whole point of calling it memory.
    await js(`(window.location.reload(), 'OK')`)
    await waitFor(`!!document.querySelector('.topbar .brand')`, { timeout: 20000, what: 'app reloaded' })
    /* Studio does not reopen the last project on restart (a real gap, noted in DEVLOG), so open it
       again the way a user would — which is also the stronger test: memory is keyed to the PROJECT,
       not to anything the window was holding. */
    const reopen = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJECT] })
    try {
      await clickByText('.topbar-actions .btn', 'Open project')
      await waitFor(`[...document.querySelectorAll('.ex-name')].some(n => n.textContent === 'vite.config.ts')`, {
        timeout: 25000,
        what: 'the project reopened after the reload'
      })
    } finally {
      dialog.showOpenDialog = reopen
    }
    await openInsight('Memory')
    await waitFor(
      `[...document.querySelectorAll('.memory-panel .mem-row')].some(r => /MEMORY_RULE/.test(r.textContent))`,
      { timeout: 20000, what: 'memory survived a full reload' }
    )
    await clickSel('[aria-label="Close Insight"]')
    return 'taught once, previewed via the real retrieval, written by the agent (labelled AI), survived a reload'
  })

  await step('23. Builder mode hides the code (menu included) and Developer mode brings it all back', async () => {
    const modeChip = `(document.querySelector('.mode-chip')?.textContent || '').trim()`
    const topMenus = () => (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label)

    // ---- baseline: the full IDE
    await waitFor(`/Developer mode/.test(${modeChip})`, { timeout: 8000, what: 'developer mode chip' })
    if (!(await js(`!!document.querySelector('.ex-tree')`))) throw new Error('developer mode has no file tree')
    // A file must be OPEN before the switch, or "nothing was lost" proves nothing.
    if ((await count('.tabbar .tab')) < 2) {
      if (!(await js(`[...document.querySelectorAll('.ex-name')].some(e=>e.textContent==='main.tsx')`))) {
        await clickByText('.ex-row', 'src')
        // The folder expands asynchronously (a real listDir round-trip): clicking straight through
        // raced it, and the row simply wasn't there yet.
        await waitFor(`[...document.querySelectorAll('.ex-name')].some(e=>e.textContent==='main.tsx')`, {
          timeout: 8000,
          what: 'src expanded'
        })
      }
      await clickByText('.ex-row', 'main.tsx')
      await waitFor(`document.querySelectorAll('.tabbar .tab').length > 1`, { timeout: 8000, what: 'a code tab' })
    }
    const tabsBefore = await js(`[...document.querySelectorAll('.tabbar .tab .tab-name')].map(e=>e.textContent).join(',')`)
    for (const m of ['Terminal', 'Selection']) if (!topMenus().includes(m)) throw new Error(`developer menu is missing ${m}`)

    /* The one-time invitation is how a non-coder ever discovers Builder Mode. It must be PRESENT on
       a first run (this suite starts on a fresh userData, and 22 steps have just driven the app with
       it on screen — proving it blocks nothing), and it must answer itself for good when used. */
    if (!(await js(`!!document.querySelector('.mode-invite')`)))
      throw new Error('a never-chosen install showed no invitation — Builder Mode would be undiscoverable')

    // ---- switch to Builder, the way a first-time user would
    await clickByText('.mode-invite .btn', 'Try Builder mode')
    await waitFor(`/Builder mode/.test(${modeChip})`, { timeout: 8000, what: 'builder mode chip' })
    if (await js(`!!document.querySelector('.mode-invite')`)) throw new Error('the one-time invitation came back after being answered')
    if ((await js(`window.studio.getMode().then(m => m.mode)`)) !== 'builder')
      throw new Error('the main process did not record the switch (a restart would undo it)')

    // The code surface is gone — tree, code tabs, and the rail icons that lead back into code.
    if (await js(`!!document.querySelector('.ex-tree')`)) throw new Error('builder mode still shows the file tree')
    if (!(await js(`!!document.querySelector('.builder-home')`))) throw new Error('builder sidebar lost its open/new project actions')
    const builderTabs = await count('.tabbar .tab')
    if (builderTabs !== 1) throw new Error(`builder mode should show only the Preview tab, found ${builderTabs}`)
    for (const label of ['Terminal', 'Extensions', 'Search everywhere']) {
      if (await js(`[...document.querySelectorAll('.activity-bar .ab-btn')].some(b => (b.getAttribute('aria-label')||'').startsWith(${JSON.stringify(label)}))`))
        throw new Error(`builder mode still offers "${label}" in the activity bar`)
    }
    // The dock is not a toggle here: it is the product, so there is no button that could lose it.
    if (!(await js(`!!document.querySelector('.right')`))) throw new Error('builder mode must always show the assistant dock')
    if (await js(`[...document.querySelectorAll('.topbar-actions .btn')].some(b => b.textContent.trim() === 'Agent')`))
      throw new Error('builder mode still shows the Agent toggle for an always-on dock')
    if (!(await js(`[...document.querySelectorAll('.topbar-actions .btn')].some(b => /Preview my app|Stop preview/.test(b.textContent))`)))
      throw new Error('builder mode kept the developer wording on the preview button')

    // The panel keeps only the two plain-English tabs, and Insight drops the engineering half.
    await clickByLabel('.topbar-actions .btn', 'Project')
    await waitFor(`!!document.querySelector('.panel-tabs')`, { timeout: 8000, what: 'builder bottom panel' })
    const panelLabels = await js(`[...document.querySelectorAll('.panel-tabs .seg-btn')].map(b=>b.textContent.trim()).join(',')`)
    // Insight left the bottom panel on 2026-09-03 — Builder Mode's panel is History alone now, and
    // Insight is reached as a workspace view (Overview + Review in this mode).
    if (panelLabels !== 'History') throw new Error(`builder panel tabs should be History — got "${panelLabels}"`)
    // Insight is a workspace view now, not a panel tab — this used to click a "Health" tab that
    // no longer exists (NOT_FOUND). openInsight() drives the same route a user takes.
    await openInsight('Overview')
    await waitFor(`!!document.querySelector('.iv')`, { timeout: 8000, what: 'builder Insight view' })
    if (await js(`!!document.querySelector('.ctx-find')`)) throw new Error('builder Health still shows "Find related files" (a code surface)')
    if (await js(`!!document.querySelector('.arch-map, .tangle-card, .orphans-card')`))
      throw new Error('builder Health still shows the architecture/x-ray cards')
    if (!(await js(`!!document.querySelector('.app-passport, .work-safety, .ship-readiness, .action-plan')`)))
      throw new Error('builder Health lost the plain-English half too — it should keep those')

    // The menu bar hides the same things the window does: no back door through ⌘-keys.
    for (const m of ['Terminal', 'Selection']) if (topMenus().includes(m)) throw new Error(`builder menu still shows ${m}`)
    await shot('builder-mode')

    // Settings is the considered home for the choice (the chip is the shortcut), and its own tabs
    // follow the mode: editor preferences and extension toggles configure surfaces Builder hides.
    await clickSel('.activity-bar .ab-btn:last-of-type')
    await waitFor(`!!document.querySelector('.modal .settings')`, { timeout: 8000, what: 'settings modal' })
    const settingsTabs = await js(`[...document.querySelectorAll('.settings-tabs .seg-btn')].map(b=>b.textContent.trim()).join(',')`)
    if (settingsTabs !== 'Mode,AI,API Keys,About') throw new Error(`builder Settings tabs should be Mode,AI,API Keys,About — got "${settingsTabs}"`)
    await clickByText('.settings-tabs .seg-btn', 'Mode')
    await waitFor(`document.querySelectorAll('.mode-settings .mode-card').length === 2`, { timeout: 8000, what: 'the two mode cards' })
    if (!(await js(`!!document.querySelector('.mode-card.active')`))) throw new Error('the Mode tab does not show which mode is current')
    await js(`document.querySelector('.modal-backdrop').click(), 'ok'`)
    await waitFor(`!document.querySelector('.modal .settings')`, { timeout: 8000, what: 'settings closed' })

    // ---- and back: the hiding was reversible, and nothing was thrown away
    await clickSel('.mode-chip')
    await waitFor(`/Developer mode/.test(${modeChip})`, { timeout: 8000, what: 'developer mode chip again' })
    await waitFor(`!!document.querySelector('.ex-row')`, { timeout: 8000, what: 'file tree back' })
    const tabsAfter = await js(`[...document.querySelectorAll('.tabbar .tab .tab-name')].map(e=>e.textContent).join(',')`)
    if (tabsAfter !== tabsBefore) throw new Error(`open files did not come back: "${tabsAfter}" vs "${tabsBefore}"`)
    for (const m of ['Terminal', 'Selection']) if (!topMenus().includes(m)) throw new Error(`${m} menu did not come back`)
    await clickSel('.panel-close')
    return `builder hides tree/tabs/terminal/search/extensions + 5 menus and trims Insight; back in developer every tab returned (${tabsAfter})`
  })


  await step('24. Create: a photo is generated on the user’s own account and lands in the project', async () => {
    /* The whole promise of this feature is "your account, your file". So this step proves the two
       things a screenshot cannot: the picture becomes a REAL file inside the project, and the panel
       tells the user whose account is paying BEFORE the button is live. */
    const GEN_DIR = path.join(PROJECT, 'assets', 'generated')
    fs.rmSync(GEN_DIR, { recursive: true, force: true })

    // Back to Developer mode's full shell if step 23 left us elsewhere, then open Create.
    await clickByLabel('.activity-bar .ab-btn', 'Create images and video')
    await waitFor(`!!document.querySelector('[data-testid="media-panel"]')`, { timeout: 8000, what: 'the Create panel' })
    // The panel renders BEFORE its provider list arrives: MediaPanel mounts, then a useEffect
    // awaits mediaProviders() and populates the <select>. Counting options the moment the panel
    // exists is a race, and it lost intermittently when the machine was busy — the failure read
    // "only 0 image services offered", which looks like a policy filter and is not one.
    // (Found 2026-09-01 running test:agent immediately before test:ui.)
    await waitFor(`document.querySelectorAll('[data-testid="media-provider"] option').length > 0`, {
      timeout: 8000,
      what: 'the image-service list to load'
    })

    // Every real service must say which account pays and how to get a key — a picker full of
    // services with no plan note is how people end up billing the wrong account.
    const providerCount = await js(`document.querySelectorAll('[data-testid="media-provider"] option').length`)
    if (providerCount < 3) throw new Error(`only ${providerCount} image services offered`)

    /* A service with no key must SAY so, refuse to run, and lead somewhere real. An "Add the key"
       button that opens a Settings page with no row for that service is precisely the dead-control
       lie this codebase refuses everywhere else, so the row is asserted, not assumed. */
    const hasReplicate = await js(`[...document.querySelectorAll('[data-testid="media-provider"] option')].some(o => o.value === 'replicate')`)
    if (hasReplicate) {
      await js(`(() => {
        const sel = document.querySelector('[data-testid="media-provider"]');
        sel.value = 'replicate';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'OK';
      })()`)
      await waitFor(`!!document.querySelector('[data-testid="media-nokey"]')`, { timeout: 6000, what: 'the no-key callout' })
      if (!(await js(`document.querySelector('[data-testid="media-generate"]').disabled`)))
        throw new Error('a service with no key must not offer a live Create button')
      await clickByText('[data-testid="media-nokey"] .btn', 'Add the key')
      await waitFor(`!!document.querySelector('.modal .settings')`, { timeout: 6000, what: 'Settings opened from the Create panel' })
      const keyLabels = await js(`[...document.querySelectorAll('.modal .settings .key-label')].map(e => e.textContent.trim()).join(' | ')`)
      for (const svc of ['Replicate', 'fal.ai', 'Stability AI']) {
        if (!keyLabels.includes(svc)) throw new Error(`Settings has no place to paste a ${svc} key: ${keyLabels}`)
      }
      await js(`document.querySelector('.modal-backdrop').click(), 'ok'`)
      await waitFor(`!document.querySelector('.modal .settings')`, { timeout: 6000, what: 'settings closed' })
    }

    // Choose the deterministic provider, describe the picture, and create it.
    await js(`(() => {
      const sel = document.querySelector('[data-testid="media-provider"]');
      const opt = [...sel.options].find(o => o.value === 'mock-media');
      if (!opt) return 'NO_MOCK';
      sel.value = 'mock-media';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    })()`).then((r) => { if (r !== 'OK') throw new Error(`mock media provider missing from the picker (${r})`) })

    await js(`(() => {
      const t = document.querySelector('[data-testid="media-prompt"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(t, 'a calm blue pharmacy reception');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`)

    await waitFor(`!document.querySelector('[data-testid="media-generate"]').disabled`, { timeout: 8000, what: 'the Create button to become live' })
    await clickSel('[data-testid="media-generate"]')

    // The file on disk is the deliverable — assert it, not just the tile.
    await waitFor(
      () => fs.existsSync(GEN_DIR) && fs.readdirSync(GEN_DIR).filter((f) => f.endsWith('.png')).length > 0,
      { timeout: 20000, what: 'a generated PNG inside the project' }
    )
    const pngs = fs.readdirSync(GEN_DIR).filter((f) => f.endsWith('.png'))
    const bytes = fs.readFileSync(path.join(GEN_DIR, pngs[0]))
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50) throw new Error('what landed on disk is not a real PNG')
    if (!fs.existsSync(path.join(GEN_DIR, pngs[0] + '.json'))) throw new Error('the asset has no receipt beside it')
    if (!/^a-calm-blue-pharmacy-reception-/.test(pngs[0])) throw new Error(`the filename does not describe the prompt: ${pngs[0]}`)

    // And it shows up in the gallery, with the money question answered on screen.
    await waitFor(`document.querySelectorAll('[data-testid="media-tile"]').length > 0`, { timeout: 10000, what: 'the new tile in the gallery' })
    const panelText = await js(`document.querySelector('[data-testid="media-panel"]').innerText`)
    if (!/your own/i.test(panelText)) throw new Error('the panel never says the generation is on the user’s own account')
    if (!/Charged to your/i.test(panelText)) throw new Error('the panel never says which account is charged')
    await shot('create-media')

    /* Start from a photo: the picture just generated becomes the input to an EDIT, and the result is
       a second real file that records what it came from. Driven through the actual picker, because
       the risk in this feature is a control that narrows the model list wrongly and silently sends
       nothing. */
    await waitFor(`!!document.querySelector('[data-testid="media-source"]')`, { timeout: 8000, what: 'the start-from-a-photo picker' })
    await js(`(() => {
      const sel = document.querySelector('[data-testid="media-source"]');
      const opt = [...sel.options].find(o => o.value && o.value.endsWith('.png'));
      if (!opt) return 'NO_SOURCE';
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    })()`).then((r) => { if (r !== 'OK') throw new Error(`the generated photo was not offered as a source (${r})`) })

    // Choosing a photo must NARROW the model list to models that can actually take one.
    await waitFor(`!!document.querySelector('[data-testid="media-source-preview"]')`, { timeout: 6000, what: 'the chosen photo shown back' })
    const editModels = await js(`[...document.querySelectorAll('[data-testid="media-provider"] option')].map(o => o.value)`)
    if (!editModels.length) throw new Error('choosing a photo left no service that can use it')
    const btnLabel = await js(`document.querySelector('[data-testid="media-generate"]').textContent.trim()`)
    if (!/Edit this photo/i.test(btnLabel)) throw new Error(`the button should say what it will do, got "${btnLabel}"`)

    await js(`(() => {
      const t = document.querySelector('[data-testid="media-prompt"]');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(t, 'make the walls blue');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return 'OK';
    })()`)
    await waitFor(`!document.querySelector('[data-testid="media-generate"]').disabled`, { timeout: 8000, what: 'the Edit button to become live' })
    await clickSel('[data-testid="media-generate"]')
    await waitFor(
      () => fs.existsSync(GEN_DIR) && fs.readdirSync(GEN_DIR).filter((f) => f.endsWith('.png')).length > 1,
      { timeout: 20000, what: 'the edited photo to land in the project' }
    )
    const edited = fs.readdirSync(GEN_DIR).filter((f) => f.startsWith('make-the-walls-blue-'))
    if (!edited.length) throw new Error(`the edit was not saved under its own prompt: ${fs.readdirSync(GEN_DIR).join(', ')}`)
    // It must record the photo it came from, or an edit is indistinguishable from a fresh generation.
    const editSide = JSON.parse(fs.readFileSync(path.join(GEN_DIR, edited[0] + '.json'), 'utf8'))
    if (!editSide.sourceFile || !editSide.sourceFile.endsWith(pngs[0])) throw new Error(`the edit does not record its source photo: ${editSide.sourceFile}`)
    await shot('create-media-edit')

    /* Deleting removes the real file, not just the tile. Targeted at a NAMED tile: the gallery is
       newest-first, so once the edit exists, "the first Delete button" is no longer the tile this
       assertion is about — it deleted the edit and then waited for the original to vanish. */
    await js(`(() => {
      const tile = [...document.querySelectorAll('[data-testid="media-tile"]')]
        .find(t => (t.textContent || '').includes(${JSON.stringify(pngs[0])}) || (t.querySelector('.media-path')?.title || '').includes(${JSON.stringify(pngs[0])}));
      if (!tile) return 'NOT_FOUND';
      const btn = [...tile.querySelectorAll('.media-tile-actions .btn')].find(b => b.textContent.trim() === 'Delete');
      if (!btn) return 'NO_DELETE';
      btn.click();
      return 'OK';
    })()`).then((r) => { if (r !== 'OK') throw new Error(`delete the original tile → ${r}`) })
    await waitFor(
      () => !fs.existsSync(path.join(GEN_DIR, pngs[0])),
      { timeout: 8000, what: 'the deleted file to actually leave the disk' }
    )
    // …and only that one: deleting a tile must not take its neighbours with it.
    if (!fs.existsSync(path.join(GEN_DIR, edited[0]))) throw new Error('deleting one tile also removed the edited photo')
    fs.rmSync(GEN_DIR, { recursive: true, force: true })
    fs.rmSync(path.join(PROJECT, 'assets'), { recursive: true, force: true })
    return `no-key service refused + routed to a real Settings row; generated ${pngs[0]}, edited it into ${edited[0]} (source recorded), gallery showed both, delete removed the real file`
  })

  await step('S1. Settings → Git server: saves the config and prints the preflight ladder', async () => {
    await clickByLabel('.topbar-actions .btn', 'Settings')
    await waitFor(`!!document.querySelector('.modal .settings')`, { what: 'settings' })
    await clickByText('.seg-btn', 'Git server')
    await waitFor(`!!document.querySelector('[data-test="git-server-host"]')`, { what: 'git server form' })

    await js(`(() => {
      const set = (sel, v) => { const el = document.querySelector(sel);
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true })) }
      set('[data-test="git-server-host"]', 'git.example')
      set('[data-test="git-server-user"]', 'git')
      set('[data-test="git-server-root"]', ${JSON.stringify(SERVER_GIT_DIR)})
      return 'OK' })()`)
    await clickByText('.settings-section .btn', 'Test connection')
    await waitFor(`document.querySelectorAll('.gs-step').length === 4`, { what: 'four preflight steps' })

    const ladder = await js(`[...document.querySelectorAll('.gs-step')].map(e => e.dataset.ok).join(',')`)
    if (ladder !== 'true,true,true,true') throw new Error(`ladder should be all green against the fake ssh: ${ladder}`)
    await shot('settings-git-server')
    await clickByLabel('.topbar-actions .btn', 'Settings')
    return 'host/user/root saved · preflight ladder rendered with four steps'
  })

  await step('S2. Publish this folder: an unconfigured server sends you to Settings', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plain-'))
    fs.writeFileSync(path.join(plain, 'index.html'), '<h1>plain</h1>\n')
    // openProjectAt (not a raw "Open project" click + a `.left`-content wait): by this point in
    // the suite the sidebar can be showing ANY view a prior step left active (Create/media, in
    // this exact position) — `.left`'s content depends on which, so a wait keyed to it is racy
    // in a way the command-centre name is not. openProjectAt also answers the unsaved-work
    // seatbelt if an earlier failure left a dirty tab behind.
    await openProjectAt(plain)
    await clickByLabel('.ab-btn', 'Source Control')
    await waitFor(`/not a git repository/.test(document.querySelector('.scm-empty')?.textContent || '')`, { what: 'empty state' })

    await clickByText('.scm-empty .btn', 'Publish this folder')
    await waitFor(`!!document.querySelector('[data-test="git-server-host"]')`, { timeout: 8000, what: 'redirect to Settings' })
    await clickByLabel('.topbar-actions .btn', 'Settings')
    return 'no server configured → Publish opens Settings rather than failing'
  })

  await step('17. No renderer crashes or console errors across the whole run', async () => {
    if (crashes.length) throw new Error(crashes.join(' | '))
    if (consoleErrors.length) throw new Error(`${consoleErrors.length} console error(s): ${consoleErrors.join(' | ')}`)
    return 'clean'
  })

  // --- restore -------------------------------------------------------------
  for (const [file, original] of [[TARGET_ABS, originalSource], [VITE_CFG, originalCfg]]) {
    if (fs.readFileSync(file, 'utf8') !== original) {
      fs.writeFileSync(file, original, 'utf8')
      console.log(`\n  (restored ${path.relative(REPO, file)} to its original contents)`)
    }
  }

  // --- report --------------------------------------------------------------
  console.log(`\n\x1b[1m${results.length - failed}/${results.length} steps passed\x1b[0m`)
  if (failed) {
    console.log('\n\x1b[31mFailures:\x1b[0m')
    for (const r of results.filter((x) => !x.ok)) console.log(`  · ${r.name}\n    ${r.detail}`)
  }
  console.log(`\nScreenshots: ${SHOTS}\n`)
  return failed === 0 ? 0 : 1
}

// ---------------------------------------------------------------- bootstrap
require('../out/main/index.js')

app.whenReady().then(async () => {
  // Wait for the real main process to create its window.
  for (let i = 0; i < 200 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0]
    if (!win) await sleep(50)
  }
  if (!win) {
    console.error('No BrowserWindow was created by the app.')
    app.exit(1)
    return
  }

  // Monaco rejects its in-flight delayer promises with its own CancellationError
  // whenever an editor is disposed (we unmount it on every tab switch). Library
  // noise, not app code — everything else is a real error.
  const BENIGN = /Autofill|devtools|Extension|Uncaught \(in promise\) Canceled: Canceled|ResizeObserver loop/i

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3 && !BENIGN.test(message)) consoleErrors.push(`${message} (${sourceId}:${line})`)
  })
  // Capture exceptions before Chromium reduces thrown objects to "[object Event]".
  // CDP preserves the exception object and the original throw-site stack.
  win.webContents.debugger.attach('1.3')
  win.webContents.debugger.on('message', async (_event, method, params) => {
    if (method !== 'Runtime.exceptionThrown') return
    const d = params.exceptionDetails
    const exception = d.exception
    let properties = []
    if (exception?.objectId) {
      try {
        const result = await win.webContents.debugger.sendCommand('Runtime.getProperties', {
          objectId: exception.objectId, ownProperties: false
        })
        properties = result.result.filter(p => p.value && ['message', 'stack', 'type', 'filename', 'lineno', 'colno', 'error', 'reason', 'target', 'currentTarget', 'isTrusted'].includes(p.name))
          .map(p => ({ name: p.name, value: p.value.value ?? p.value.description }))
      } catch (error) {
        properties = [{ name: 'inspectionError', value: error.message }]
      }
    }
    const detail = JSON.stringify({ text: d.text, exception: exception?.description,
      properties, url: d.url, line: d.lineNumber, stack: d.stackTrace })
    // Diagnostic supplement only: the original console errors remain in the gate.
    console.log('[renderer exception] ' + detail)
  })
  await win.webContents.debugger.sendCommand('Runtime.enable')
  // Worker load errors are often bare Events with no message/stack. Preserve the
  // constructor URL and the creation stack as well as every ErrorEvent field.
  const workerDiagnostics = `(() => {
    if (window.__uiWorkerDiagnostics) return
    window.__uiWorkerDiagnostics = true
    const NativeWorker = window.Worker
    window.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const creationStack = new Error('Worker created').stack
        const worker = Reflect.construct(target, args, newTarget)
        worker.addEventListener('error', event => {
          console.warn('[worker error] ' + JSON.stringify({ url: String(args[0]),
            options: args[1], type: event.type, message: event.message ?? null,
            filename: event.filename ?? null, line: event.lineno ?? null,
            column: event.colno ?? null, error: event.error ? {
              message: event.error.message, stack: event.error.stack
            } : null, creationStack }))
        })
        return worker
      }
    })
  })()`
  win.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[worker error]')) console.log(message)
  })
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: workerDiagnostics })
  await win.webContents.executeJavaScript(workerDiagnostics)

  win.webContents.on('render-process-gone', (_e, d) => crashes.push(`renderer gone: ${d.reason}`))
  win.webContents.on('preload-error', (_e, p, err) => crashes.push(`preload error ${p}: ${err.message}`))
  win.webContents.on('unresponsive', () => crashes.push('window became unresponsive'))

  if (!win.webContents.isLoading()) {
    /* already loaded */
  } else {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
  }
  await sleep(800) // let React mount + the initial IPC round-trips settle

  let code = 1
  try {
    code = await run()
  } catch (err) {
    console.error('\nHarness crashed:', err)
    code = 1
  }
  app.exit(code)
})
