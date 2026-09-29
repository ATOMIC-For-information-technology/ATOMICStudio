/* eslint-disable */
/**
 * ATOMIC Studio — LIVE media probe. One real generation, against one real account.
 *
 * The adapters in `main/media.ts` were written from each provider's documented request shapes and
 * have never met a paid key. This is how they meet one: a single call, the smallest/cheapest model
 * by default, and the provider's RAW response printed when it fails — because the friendly message
 * the app shows a user is deliberately short, and fixing a wire-shape bug needs the whole body.
 *
 *   cd apps/desktop
 *   npx electron scripts/try-provider.cjs replicate image
 *   npx electron scripts/try-provider.cjs openai image --model gpt-image-1
 *   npx electron scripts/try-provider.cjs gemini video --prompt "slow pan across a pharmacy"
 *
 * Reads the SAME encrypted vault the app writes, so the key is pasted once into Settings → API keys
 * and never touches a terminal, a file, or this script's arguments.
 *
 * Output lands in .live-probe/ (gitignored, deletable) — never in a real project.
 */
process.env.STUDIO_MEDIA_DEBUG = '1' // make media.ts print raw provider bodies

const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execSync } = require('node:child_process')

/*
 * Two things must match the live app or the vault is unreadable:
 *   1. userData — where the encrypted file lives.
 *   2. **the app NAME** — macOS safeStorage derives its Keychain entry from it, so a probe running as
 *      the default "Electron" gets a different Keychain item and decryption fails. That failure is
 *      indistinguishable from "no key" unless you look for it, which is exactly the trap this script
 *      fell into the first time it ran.
 */
const LIVE_APP_NAME = '@atomic-studio/desktop'
const LIVE_USER_DATA = path.join(os.homedir(), 'Library', 'Application Support', '@atomic-studio', 'desktop')
app.setName(LIVE_APP_NAME)
if (process.platform === 'darwin' && fs.existsSync(LIVE_USER_DATA)) app.setPath('userData', LIVE_USER_DATA)

const REPO = path.resolve(__dirname, '../../..')
const SRC = path.resolve(__dirname, '../src')
const WORK = path.resolve(__dirname, '../.live-probe')
const OUTPROJ = path.join(WORK, 'project')
const esbuild = path.join(REPO, 'node_modules', '.bin', 'esbuild')

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--inspect'))
const positional = argv.filter((a) => !a.startsWith('--'))
const flag = (name) => {
  const i = argv.indexOf('--' + name)
  return i === -1 ? undefined : argv[i + 1]
}

const providerId = positional[0]
const kind = positional[1] || 'image'

if (!providerId) {
  console.log(`
Usage: npx electron scripts/try-provider.cjs <provider> [image|video] [--model X] [--prompt "..."] [--source path.png]

  provider   openai | gemini | replicate | fal | stability
`)
  process.exit(1)
}

fs.mkdirSync(OUTPROJ, { recursive: true })
execSync(
  `"${esbuild}" ` +
    ['media', 'keyvault', 'policy', 'util']
      .map((m) => `"${path.join(SRC, 'main', m + '.ts')}"`)
      .join(' ') +
    ` --outdir="${path.join(WORK, 'main')}" --format=cjs --platform=node --log-level=silent`,
  { cwd: REPO }
)
execSync(`"${esbuild}" "${path.join(SRC, 'shared', 'media.ts')}" --outdir="${path.join(WORK, 'shared')}" --format=cjs --platform=node --log-level=silent`, {
  cwd: REPO
})

const B = (s) => `\x1b[1m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`

app.whenReady().then(async () => {
  const reg = require(path.join(WORK, 'shared', 'media.js'))
  const media = require(path.join(WORK, 'main', 'media.js'))
  const vault = require(path.join(WORK, 'main', 'keyvault.js'))

  const provider = reg.getMediaProvider(providerId)
  if (!provider) {
    console.log(RED(`Unknown provider "${providerId}". Try: ${reg.MEDIA_PROVIDERS.map((p) => p.id).join(', ')}`))
    return app.exit(1)
  }

  // Cheapest model of the requested kind, unless one was named — the probe should never be the
  // expensive way to find out a key works.
  const candidates = provider.models.filter((m) => m.kind === kind).sort((a, b) => a.approxUsd - b.approxUsd)
  const model = flag('model') || candidates[0]?.id
  if (!model) {
    console.log(RED(`${provider.label} has no ${kind} model in the registry.`))
    return app.exit(1)
  }
  const chosen = reg.getMediaModel(providerId, model)
  const prompt = flag('prompt') || (kind === 'video' ? 'a slow pan across a calm blue pharmacy reception' : 'a calm blue pharmacy reception, photographic')
  const source = flag('source')

  console.log('')
  console.log(B(`Live probe — ${provider.label}`))
  console.log(`  model    ${model}${chosen ? '' : DIM('  (not in the registry — sent as typed)')}`)
  console.log(`  kind     ${kind}`)
  console.log(`  prompt   ${prompt}`)
  if (source) console.log(`  source   ${source}`)
  console.log(`  cost     ${chosen ? `about $${chosen.approxUsd.toFixed(3)} on YOUR ${provider.label} account` : 'unknown'}`)

  if (!vault.hasApiKey(provider.id)) {
    console.log('')
    console.log(RED(`No ${provider.label} key found in the vault.`))
    console.log(`Open ATOMIC Studio → ⚙ Settings → API keys, paste it into the "${provider.label}" row, press Save, then run this again.`)
    console.log(DIM(`Get one at: ${provider.keyUrl}`))
    console.log(DIM(provider.planNote))
    return app.exit(1)
  }
  console.log(`  key      ${GREEN('found in the vault')}`)
  console.log('')
  console.log(DIM('Calling the provider for real…'))

  const started = Date.now()
  const res = await media.generate({
    projectPath: OUTPROJ,
    kind,
    providerId,
    model,
    prompt,
    ...(source ? { sourceFile: source } : {}),
    ...(chosen?.sizes?.length ? { size: chosen.sizes[0] } : {}),
    ...(kind === 'video' && chosen?.durations?.length ? { seconds: chosen.durations[0] } : {}),
    onProgress: (note) => console.log(DIM('  … ' + note))
  })
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  console.log('')
  if (res.ok) {
    const abs = path.join(OUTPROJ, res.receipt.file)
    console.log(GREEN(B(`WORKS — ${provider.label} ${model}`)))
    console.log(`  file   ${abs}`)
    console.log(`  size   ${(res.receipt.bytes / 1024).toFixed(1)} KB`)
    console.log(`  took   ${secs}s`)
    return app.exit(0)
  }

  console.log(RED(B(`FAILED after ${secs}s`)))
  console.log(`  ${res.error}`)
  console.log('')
  console.log(DIM('(the raw provider response is printed above, if there was one)'))
  app.exit(2)
})
