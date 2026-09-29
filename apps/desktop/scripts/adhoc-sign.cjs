/* eslint-disable */
/**
 * electron-builder `afterPack` hook — ad-hoc sign the packaged macOS app.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────────────────────
 * On 2026-08-14 the first local build was **deleted by macOS on launch**: "ATOMIC Studio.app was not
 * opened because it contains malware." Nothing was wrong with the code. The bundle still carried the
 * Electron binary's ORIGINAL linker-signed ad-hoc signature (`Identifier=Electron`), and
 * electron-builder had since rewritten the bundle around it — app.asar, Info.plist, the executable
 * name. A signature that no longer matches its bundle reads to macOS 26 exactly like a tampered app,
 * and Gatekeeper/XProtect does not merely refuse it, it moves it to the Trash.
 *
 * `mac.identity: null` in package.json means "don't sign", which is right in the sense that we have no
 * Developer ID — but "don't sign" left the STALE signature in place, which is worse than none. The fix
 * is to replace it with a valid ad-hoc signature of our own: free, no certificate, no Apple account,
 * and enough for an app built and run on this same Mac.
 *
 * This does NOT make the app distributable. Handing the .app to someone else still trips Gatekeeper on
 * their machine (unsigned + un-notarised). Shipping to other people needs a paid Developer ID plus
 * notarisation — a separate decision, deliberately not taken here.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) {
    console.log(`  • ad-hoc signing SKIPPED — no bundle at ${appPath}`)
    return
  }

  // The bundle id, so the signature identifies this app rather than inheriting "Electron".
  const identifier = context.packager.appInfo.id || 'limited.atomic.studio'

  console.log(`  • ad-hoc signing  app=${appName}.app identifier=${identifier}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', identifier, appPath], { stdio: 'inherit' })

  // Verify rather than assume: an invalid signature is the exact failure this hook exists to prevent,
  // and a build that silently produced one again would be indistinguishable from a working build
  // until the moment macOS deletes it.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('  • ad-hoc signature verified — macOS will run this locally')
}
