/* eslint-disable */
/**
 * Install the freshly built app into /Applications.
 *
 * `release/` is wiped by every build, so an app launched from there disappears the next time anything
 * is rebuilt. This puts it where macOS expects it: Spotlight finds it, the Dock keeps it, and it
 * survives rebuilds.
 *
 *   npm run install:mac      (builds, signs, then installs)
 *
 * Two things it deliberately does rather than assumes:
 *   • **Quits the running copy first.** Replacing a bundle while it is running gives you a half-old,
 *     half-new app whose signature no longer matches — the exact condition macOS treats as malware.
 *   • **Re-verifies the signature after the copy.** `cp` can subtly disturb a bundle, and a signature
 *     that breaks in transit fails at launch, not here, which is a miserable thing to debug later.
 */
const { execFileSync, execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const APP_NAME = 'ATOMIC Studio.app'
const SRC = path.resolve(__dirname, '..', 'release', 'mac-arm64', APP_NAME)
const DEST = path.join('/Applications', APP_NAME)

if (process.platform !== 'darwin') {
  console.error('install:mac only runs on macOS.')
  process.exit(1)
}
if (!fs.existsSync(SRC)) {
  console.error(`No build found at ${SRC}\nRun "npm run dist" first.`)
  process.exit(1)
}

// A running copy must not be overwritten in place.
try {
  const running = execSync(`pgrep -f ${JSON.stringify(`${APP_NAME}/Contents/MacOS`)} || true`).toString().trim()
  if (running) {
    console.log('  • quitting the running copy first')
    execSync(`pkill -f ${JSON.stringify(`${APP_NAME}/Contents/MacOS`)} || true`)
    execSync('sleep 2')
  }
} catch {
  /* nothing was running */
}

if (fs.existsSync(DEST)) {
  console.log(`  • replacing existing ${DEST}`)
  fs.rmSync(DEST, { recursive: true, force: true })
}

console.log(`  • copying → ${DEST}`)
// -R preserves the bundle; -p keeps permissions so the executable stays executable.
execFileSync('cp', ['-Rp', SRC, DEST], { stdio: 'inherit' })

console.log('  • verifying the signature survived the copy')
execFileSync('codesign', ['--verify', '--deep', '--strict', DEST], { stdio: 'inherit' })

console.log(`\nInstalled: ${DEST}\nOpen it from Spotlight (⌘-Space → "ATOMIC Studio").`)
