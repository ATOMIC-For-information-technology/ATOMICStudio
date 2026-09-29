import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { startStaticServer, type StaticServerHandle } from './static-server'
import type {
  DetectedFramework,
  DevServerState,
  LogLine,
  ProjectInfo
} from '../shared/types'

/**
 * Owns the lifecycle of the opened project's dev server.
 *
 * Phase 0 uses child_process.spawn (not node-pty) to avoid native-module
 * rebuilds; we parse stdout to discover the local URL. A later phase swaps in
 * node-pty for full terminal fidelity (colour, interactive prompts).
 */
export class ProcessManager extends EventEmitter {
  private child: ChildProcess | null = null
  private staticServer: StaticServerHandle | null = null
  private state: DevServerState = { status: 'idle', url: null, error: null }

  getState(): DevServerState {
    return this.state
  }

  /** Inspect a folder and guess framework + the dev script to run. */
  inspectProject(projectPath: string): ProjectInfo {
    const name = basename(projectPath)
    const pkgPath = join(projectPath, 'package.json')

    if (!existsSync(pkgPath)) {
      // No package.json — treat as a static HTML folder.
      const hasIndex = existsSync(join(projectPath, 'index.html'))
      return {
        path: projectPath,
        name,
        framework: hasIndex ? 'static-html' : 'unknown',
        devScript: null
      }
    }

    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {}
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch {
      /* ignore malformed package.json */
    }

    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const scripts = pkg.scripts ?? {}
    const framework = detectFramework(deps)
    const devScript = pickDevScript(scripts)

    /* A package.json does not make a folder a node app. Anyone who has run `npm init` on a plain
       website has one, and the old order gave up the moment it existed: framework "unknown", no dev
       script, and Run preview failing with "No dev/start script" — on a folder with index.html
       sitting in the root, which the built-in static server can serve perfectly well. If nothing
       runnable was found, fall back to what is actually there. */
    if (!devScript && framework === 'unknown' && existsSync(join(projectPath, 'index.html'))) {
      return { path: projectPath, name, framework: 'static-html', devScript: null }
    }

    return { path: projectPath, name, framework, devScript }
  }

  /** Start the dev server for a project. No-op if one is already running. */
  start(project: ProjectInfo): void {
    if (this.child || this.staticServer) return

    // Plain website folder → built-in static server with live reload.
    if (project.framework === 'static-html') {
      this.setState({ status: 'starting', url: null, error: null })
      startStaticServer(project.path, (text) =>
        this.emitLog({ stream: 'system', text, ts: Date.now() })
      )
        .then((handle) => {
          this.staticServer = handle
          this.setState({ status: 'running', url: handle.url, error: null })
        })
        .catch((err: Error) => {
          this.setState({ status: 'error', url: null, error: err.message })
        })
      return
    }

    // For Vite projects, run our stamped runner (createServer + inspector plugin)
    // so click-to-edit works without touching the user's files. Fall back to the
    // project's own dev script for everything else — or if resolution fails.
    //
    // Resolved BEFORE the dev-script guard on purpose. `run-vite.mjs` calls the project's own
    // `createServer` directly and never reads package.json's "scripts", so a Vite app needs no dev
    // script for Studio to preview it. The guard used to run first, which failed a scaffolded Vite
    // project — vite in dependencies, index.html and src/main.tsx present, no "dev" script — with
    // "No dev/start script", on a folder this runner serves perfectly well. Widening the
    // static-html fallback instead would NOT work: that index.html loads /src/main.tsx, which needs
    // Vite's transform, so the static server would render a broken page rather than an honest error.
    const stamped = project.framework === 'vite' ? resolveStampPaths() : null
    const devScript = project.devScript

    if (!stamped && !devScript) {
      this.setState({
        status: 'error',
        url: null,
        error:
          project.framework === 'vite'
            ? 'This is a Vite project, but Studio could not load its own Vite runner and package.json has no "dev"/"start"/"serve" script to fall back on. Add "dev": "vite" to its scripts.'
            : 'No "dev"/"start"/"serve" script found in package.json — add one that starts this project, e.g. "dev": "vite".'
      })
      return
    }

    this.setState({ status: 'starting', url: null, error: null })
    if (stamped) {
      this.emitLog({ stream: 'system', text: '[atomic-studio] launching Vite with click-to-edit stamping…', ts: Date.now() })
      this.child = spawn(process.execPath, [stamped.runner], {
        cwd: project.path,
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          BROWSER: 'none',
          ELECTRON_RUN_AS_NODE: '1',
          STUDIO_PROJECT_ROOT: project.path,
          STUDIO_STAMP_PLUGIN: stamped.stamp
        },
        shell: false
      })
    } else if (devScript) {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      this.child = spawn(npmCmd, ['run', devScript], {
        cwd: project.path,
        env: { ...process.env, FORCE_COLOR: '0', BROWSER: 'none' },
        shell: false
      })
    }

    // The guard above returns unless one of the two branches can run, so this is unreachable in
    // practice — it is here because narrowing `devScript` for the spawn call is what makes the
    // branch above type-check, and a silent no-op start would be worse than an early return.
    if (!this.child) return

    this.child.stdout?.on('data', (buf: Buffer) => this.handleOutput(buf.toString(), 'stdout'))
    this.child.stderr?.on('data', (buf: Buffer) => this.handleOutput(buf.toString(), 'stderr'))

    this.child.on('error', (err) => {
      this.setState({ status: 'error', url: this.state.url, error: err.message })
    })

    this.child.on('exit', (code) => {
      this.child = null
      if (this.state.status !== 'error') {
        this.setState({
          status: 'stopped',
          url: null,
          error: code && code !== 0 ? `Dev server exited with code ${code}` : null
        })
      }
    })
  }

  stop(): void {
    if (this.staticServer) {
      this.staticServer.close()
      this.staticServer = null
      this.setState({ status: 'stopped', url: null, error: null })
      return
    }
    if (!this.child) return
    const child = this.child
    this.child = null
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'])
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* ignore */
    }
    this.setState({ status: 'stopped', url: null, error: null })
  }

  private handleOutput(text: string, stream: 'stdout' | 'stderr'): void {
    this.emitLog({ stream, text, ts: Date.now() })

    // Only look for a URL while we are still starting up.
    if (this.state.status === 'starting' || this.state.status === 'stopped') {
      const url = findLocalUrl(text)
      if (url) {
        this.setState({ status: 'running', url, error: null })
      }
    }
  }

  private setState(next: DevServerState): void {
    this.state = next
    this.emit('state', next)
  }

  private emitLog(line: LogLine): void {
    this.emit('log', line)
  }
}

/**
 * Resolve the absolute paths to Studio's Vite runner + stamping plugin.
 * Returns null (→ fall back to the project's own dev script) if the inspector
 * package can't be resolved for any reason.
 */
function resolveStampPaths(): { runner: string; stamp: string } | null {
  try {
    return {
      runner: require.resolve('@atomic-studio/inspector-plugin/run-vite'),
      stamp: require.resolve('@atomic-studio/inspector-plugin/vite')
    }
  } catch {
    return null
  }
}

function detectFramework(deps: Record<string, string>): DetectedFramework {
  if (deps.expo) return 'expo'
  if (deps.next) return 'next'
  if (deps.vite || deps['@vitejs/plugin-react']) return 'vite'
  if (deps.vue) return 'vue'
  if (deps.svelte) return 'svelte'
  if (deps.react) return 'react'
  return 'unknown'
}

function pickDevScript(scripts: Record<string, string>): string | null {
  for (const candidate of ['dev', 'start', 'serve']) {
    if (scripts[candidate]) return candidate
  }
  return null
}

/** Strip ANSI codes and pull the first http://localhost-style URL out of a chunk. */
function findLocalUrl(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\[[0-9;]*m/g, '')
  const match = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"]*/i)
  if (!match) return null
  // Normalise 0.0.0.0 to localhost so the webview can load it.
  return match[0].replace('0.0.0.0', 'localhost')
}
