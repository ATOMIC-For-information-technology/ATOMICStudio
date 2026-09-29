import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * Built-in dev server for plain HTML folders (framework: 'static-html') — the
 * "any website folder just works" path. Serves files from the project root
 * with live reload: every served .html page gets a small injected script that
 * listens on an SSE endpoint; any file change in the project triggers a
 * refresh. Zero dependencies.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
}

const RELOAD_PATH = '/__studio_reload'
const RELOAD_SNIPPET =
  `<script>/* atomic-studio live reload */` +
  `new EventSource('${RELOAD_PATH}').onmessage=()=>location.reload();</script>`

export interface StaticServerHandle {
  url: string
  close: () => void
}

export function startStaticServer(
  root: string,
  onLog: (text: string) => void
): Promise<StaticServerHandle> {
  const rootAbs = resolve(root)
  const clients = new Set<ServerResponse>()

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])

    if (urlPath === RELOAD_PATH) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      res.write('\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    // Resolve the file, confined to the project root.
    let file = normalize(join(rootAbs, urlPath))
    if (file !== rootAbs && !file.startsWith(rootAbs + sep)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    try {
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
      if (!existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${urlPath}`)
        return
      }
      const ext = extname(file).toLowerCase()
      const type = MIME[ext] ?? 'application/octet-stream'
      /* Never let the preview cache. Responses used to carry no cache headers at all, which does not
         mean "don't cache" — with no `Cache-Control`, `Expires` or `ETag`, Chromium falls back to
         HEURISTIC caching and may reuse a response it already holds. The symptom is the worst one
         this product can have: the agent writes a file, says so in the panel, and the preview still
         shows the previous page — telling the user a change landed while showing proof it did not.
         `no-store` is correct here rather than merely polite: this server exists to show the file as
         it is on disk right now, and it re-reads it on every request anyway. */
      const noStore = { 'Content-Type': type, 'Cache-Control': 'no-store, must-revalidate' }
      if (ext === '.html' || ext === '.htm') {
        let html = readFileSync(file, 'utf8')
        html = html.includes('</body>')
          ? html.replace('</body>', `${RELOAD_SNIPPET}</body>`)
          : html + RELOAD_SNIPPET
        res.writeHead(200, noStore).end(html)
      } else {
        res.writeHead(200, noStore).end(readFileSync(file))
      }
    } catch (e) {
      res.writeHead(500).end(e instanceof Error ? e.message : 'Server error')
    }
  })

  // Watch the whole folder (recursive works on macOS + Windows) and ping
  // every connected page. Debounced so editor save-bursts reload once.
  let watcher: FSWatcher | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  try {
    watcher = watch(rootAbs, { recursive: true }, (_event, filename) => {
      if (filename && String(filename).startsWith('.')) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        onLog(`[static] change detected${filename ? ` (${filename})` : ''} — reloading preview`)
        for (const c of clients) c.write('data: reload\n\n')
      }, 120)
    })
  } catch {
    onLog('[static] file watching unavailable — manual refresh needed')
  }

  return new Promise((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise)
    // Port 0 = OS-assigned free port; no clashes with real dev servers.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const url = `http://localhost:${port}/`
      onLog(`[static] serving ${rootAbs} at ${url}`)
      resolvePromise({
        url,
        close: () => {
          watcher?.close()
          for (const c of clients) c.end()
          clients.clear()
          server.close()
        }
      })
    })
  })
}
