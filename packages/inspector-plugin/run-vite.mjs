/**
 * ATOMIC Studio dev-server runner for Vite projects.
 *
 * Launched by the Studio ProcessManager with cwd = the project. It resolves the
 * PROJECT'S OWN vite install (not Studio's), loads the project's vite.config,
 * and merges in the source-stamping plugin — so click-to-edit works without
 * modifying any of the user's files. Prints the local URL for the shell to pick up.
 *
 * Env:
 *   STUDIO_PROJECT_ROOT  absolute path to the project
 *   STUDIO_STAMP_PLUGIN  absolute path to Studio's vite-plugin.cjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const projectRoot = process.env.STUDIO_PROJECT_ROOT || process.cwd()
const stampPath = process.env.STUDIO_STAMP_PLUGIN

async function main() {
  const req = createRequire(pathToFileURL(projectRoot.endsWith('/') ? projectRoot : projectRoot + '/'))

  // Resolve the project's own Vite so their config/plugins load correctly.
  let vite
  try {
    vite = await import(pathToFileURL(req.resolve('vite')).href)
  } catch (e) {
    console.error('[atomic-studio] could not resolve vite in the project:', e.message)
    process.exit(1)
  }
  // Handle CJS/ESM interop: createServer may be a named export or under .default.
  const createServer = vite.createServer || (vite.default && vite.default.createServer)
  if (typeof createServer !== 'function') {
    console.error('[atomic-studio] this Vite build did not expose createServer')
    process.exit(1)
  }

  const makeStamp = req(stampPath) // Studio's plugin (absolute path; its own requires resolve from Studio)
  const server = await createServer({
    root: projectRoot,
    // configFile left undefined → Vite auto-resolves the project's vite.config.
    plugins: [makeStamp({ projectRoot })],
    server: { host: 'localhost' }
  })

  await server.listen()
  server.printUrls() // emits "Local: http://localhost:5173/" → shell parses this
}

main().catch((e) => {
  console.error('[atomic-studio] dev server failed:', e)
  process.exit(1)
})
