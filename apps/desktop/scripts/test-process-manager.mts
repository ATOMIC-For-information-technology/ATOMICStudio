// Headless integration test for the ProcessManager (no Electron required).
// Verifies: framework detection, dev-server spawn, and local-URL discovery
// against the real examples/hello-vite project.
//
// Run with:  npx tsx apps/desktop/scripts/test-process-manager.mts
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ProcessManager } from '../src/main/process-manager'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sampleProject = resolve(__dirname, '../../../examples/hello-vite')

const pm = new ProcessManager()

function fail(msg: string): never {
  console.error('❌ ' + msg)
  pm.stop()
  process.exit(1)
}

// 1) Detection
const info = pm.inspectProject(sampleProject)
console.log('Detected:', info)
if (info.framework !== 'vite') fail(`expected framework "vite", got "${info.framework}"`)
if (info.devScript !== 'dev') fail(`expected devScript "dev", got "${info.devScript}"`)
console.log('✅ framework + dev script detected')

// 2) Spawn + URL discovery (with a timeout)
const timeout = setTimeout(() => fail('dev server did not report a URL within 60s'), 60_000)

pm.on('state', (s) => {
  if (s.status === 'running' && s.url) {
    clearTimeout(timeout)
    console.log('✅ dev server running at', s.url)
    pm.stop()
    setTimeout(() => {
      console.log('✅ PASS — ProcessManager end-to-end OK')
      process.exit(0)
    }, 500)
  }
  if (s.status === 'error') fail('dev server errored: ' + s.error)
})

pm.start(info)
