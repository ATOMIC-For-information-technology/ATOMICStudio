/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Headless, LIVE end-to-end test of ATOMIC Studio's full click-to-edit loop.
 *
 * Runs UNDER ELECTRON (not plain node) because keyvault.ts uses app/safeStorage.
 * It exercises the exact same main-process functions the GUI buttons call —
 * editFile (real model call) -> snapshot -> write -> undo, plus the 2-model
 * "Polish" workflow and the self-healing auto-fix engine — on a throwaway copy
 * of the sample file, using the free GEMINI_API_KEY already in the environment.
 *
 * The only part it does NOT do is the on-screen mouse click that selects an
 * element (that produces {file,line,elementName}); those are supplied directly,
 * exactly as the verified inspector stamping would.
 *
 * Modules are transpiled from src/ to .loop-test/ by esbuild before this runs
 * (see the npm "test:full-loop" wrapper), so we can require the real TS logic.
 *
 * Exit code 0 = every stage PASS, 1 = any stage FAIL.
 */
const { app } = require('electron')
const { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

// Isolate keyvault storage to a throwaway userData dir so this test never reads
// or overwrites any API keys the real app has saved.
const TEST_USERDATA = join(os.tmpdir(), 'atomic-studio-loop-test-userdata')
app.setPath('userData', TEST_USERDATA)

const BUILD = join(__dirname, '..', '.loop-test')
const req = (m) => require(join(BUILD, m))

// Real product modules (transpiled).
const { editFile, stripFences } = req('main/ai-edit.js')
const { PROVIDERS, getProvider, complete } = req('main/providers.js')
const { setApiKey, getApiKey } = req('main/keyvault.js')
const { snapshot, undo, canUndo } = req('main/undo.js')
const { polishWorkflow } = req('main/goals.js')
const { runWorkflow } = req('main/workflow-engine.js')

const EXAMPLE = join(__dirname, '..', '..', '..', 'examples', 'hello-vite')
const SRC = join(EXAMPLE, 'src', 'main.tsx')
const COPY_REL = 'src/main.loop-test.tsx' // relative to project root, as the GUI passes it
const COPY_ABS = join(EXAMPLE, COPY_REL)

const results = []
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const short = (s, n = 120) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n)

// Gemini free tier can 429; retry an editFile-style call once on rate limit.
async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await fn()
    if (r.ok) return r
    const msg = String(r.error || '')
    if (attempt === 1 && /429|rate|quota|exhaust|RESOURCE_EXHAUSTED/i.test(msg)) {
      console.log(`     …${label} rate-limited, waiting 20s then retrying once`)
      await new Promise((res) => setTimeout(res, 20000))
      continue
    }
    return r
  }
}

async function run() {
  console.log('\n=== ATOMIC Studio — FULL LOOP live test (provider: gemini) ===\n')

  const key = process.env.GEMINI_API_KEY
  if (!key) {
    rec('GEMINI_API_KEY present', false, 'set GEMINI_API_KEY in the environment')
    return finish()
  }
  rec('GEMINI_API_KEY present', true, `${key.slice(0, 6)}… (${key.length} chars)`) // masked

  // Fresh throwaway copy of the sample.
  copyFileSync(SRC, COPY_ABS)
  const originalCopy = readFileSync(COPY_ABS, 'utf8')

  // ---- Stage 1: provider registry ----
  const ids = PROVIDERS.map((p) => p.id)
  rec('providers list includes gemini', ids.includes('gemini'), ids.join(', '))
  const gem = getProvider('gemini')
  rec('gemini provider resolves', Boolean(gem && gem.needsKey && gem.baseURL), gem ? gem.defaultModel : 'missing')

  // ---- Stage 2: seed the key via the real keychain vault ----
  setApiKey('gemini', key)
  rec('keyvault round-trips the key', getApiKey('gemini') === key)

  // ---- Stage 3: the "wow" — real edit of the clicked element ----
  const editReq = {
    projectPath: EXAMPLE,
    file: COPY_REL,
    line: 8, // the <h1> in main.tsx, as the inspector stamp would report
    elementName: 'h1',
    instruction: 'Change the heading text to exactly "ATOMIC Studio works" and make the heading color green.',
    provider: 'gemini'
  }
  const edit = await withRetry(() => editFile(editReq), 'edit')
  const changed = edit.ok && edit.newContent && edit.newContent !== originalCopy
  const reflects = edit.ok && /ATOMIC Studio works/i.test(edit.newContent || '') &&
    /green|#0|rgb\(|008000|22c55e|16a34a/i.test(edit.newContent || '')
  rec('edit call returns ok', Boolean(edit.ok), edit.ok ? '' : short(edit.error))
  rec('edit changed the file', Boolean(changed))
  rec('edit reflects the request (text + color)', Boolean(reflects),
    reflects ? '' : 'model output did not clearly contain both changes')

  // Mirror the applyEdit handler: snapshot -> write.
  let wrote = false
  if (edit.ok && edit.newContent) {
    snapshot(COPY_ABS, `${editReq.instruction} (${editReq.file})`)
    writeFileSync(COPY_ABS, edit.newContent, 'utf8')
    wrote = readFileSync(COPY_ABS, 'utf8') === edit.newContent
  }
  rec('applyEdit writes the new file + snapshots undo', wrote && canUndo())

  // ---- Stage 4: one-click undo restores exactly ----
  const restoredFile = undo()
  const afterUndo = existsSync(COPY_ABS) ? readFileSync(COPY_ABS, 'utf8') : ''
  rec('undo restores the file byte-for-byte', restoredFile && afterUndo === originalCopy)

  // ---- Stage 5: 2-model "Polish" workflow ----
  // Product routing sends draft->groq, finalize->anthropic. For a one-free-key
  // run we override resolveProvider to gemini for BOTH steps (test-only; the
  // product's routing.ts is untouched). This still exercises the real DAG,
  // dependsOn/injectFrom chaining, and stopOnError.
  const beforeWf = readFileSync(COPY_ABS, 'utf8')
  const wf = polishWorkflow(COPY_REL, 'Make the "Click me" button visually nicer and more prominent.', 'button', beforeWf)
  const forceGemini = () => ({ providerId: 'gemini', model: undefined })
  const wfRun = await withRetry(
    () =>
      runWorkflow(wf, {
        resolveProvider: forceGemini,
        complete: async ({ providerId, model, system, user }) =>
          complete({ providerId, model, apiKey: getApiKey(providerId), system, user })
      }).then((r) => ({ ok: r.ok, run: r, error: r.ok ? '' : Object.values(r.results).find((x) => !x.ok)?.error })),
    'workflow'
  )
  const wfr = wfRun.run
  const bothSteps = wfr && wfr.order.includes('draft') && wfr.order.includes('finalize')
  rec('workflow ran both steps (draft -> finalize)', Boolean(bothSteps), wfr ? wfr.order.join(' -> ') : '')
  const finalText = wfr && wfr.results.finalize && wfr.results.finalize.text
  const wfChanged = wfRun.ok && finalText && stripFences(finalText).trim() && stripFences(finalText).trim() !== beforeWf.trim()
  rec('workflow produced a changed file', Boolean(wfChanged), wfRun.ok ? '' : short(wfRun.error))

  // ---- Stage 6: self-healing auto-fix ----
  // Break the file (remove a closing tag), then run the real auto-fix prompt
  // path (mirrors the autoFix handler) and confirm it repairs the break.
  const broken = originalCopy.replace('</button>', '') // now invalid JSX
  writeFileSync(COPY_ABS, broken, 'utf8')
  const fixReq = {
    projectPath: EXAMPLE,
    file: COPY_REL,
    line: 0,
    instruction:
      'The app is showing this error, likely caused by the most recent change. ' +
      'Fix the file so the error is resolved while keeping all working behavior.\n\nERROR:\n' +
      "Unexpected token, expected `</` (JSX element <button> has no matching closing tag)",
    provider: 'gemini'
  }
  const fix = await withRetry(() => editFile(fixReq), 'auto-fix')
  const repaired = fix.ok && fix.newContent && /<\/button>/.test(fix.newContent)
  rec('auto-fix returns ok', Boolean(fix.ok), fix.ok ? '' : short(fix.error))
  rec('auto-fix repaired the broken JSX', Boolean(repaired),
    repaired ? '' : 'result still missing </button>')

  finish()
}

function finish() {
  // Cleanup: remove test key + throwaway copy.
  try { setApiKey('gemini', '') } catch { /* ignore */ }
  try { if (existsSync(COPY_ABS)) rmSync(COPY_ABS) } catch { /* ignore */ }
  try { if (existsSync(BUILD)) rmSync(BUILD, { recursive: true, force: true }) } catch { /* ignore */ }
  try { if (existsSync(TEST_USERDATA)) rmSync(TEST_USERDATA, { recursive: true, force: true }) } catch { /* ignore */ }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n=== RESULT: ${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ' — ALL PASS'} ===\n`)
  app.exit(failed ? 1 : 0)
}

app.whenReady().then(() =>
  run().catch((e) => {
    console.error('HARNESS CRASH:', e)
    finish()
  })
)
