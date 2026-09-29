import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execStream } from './terminal'
import type { LogLine } from '../shared/types'

/**
 * "New project…" — scaffold a fresh LOCAL project from a starter template.
 * static-html previews instantly (built-in static server, zero deps);
 * vite-react scaffolds + runs `npm install` so Run preview works right away.
 */

const HELLO_TSX = `import React from 'react'
import ReactDOM from 'react-dom/client'

function App(): React.JSX.Element {
  return (
    <div style={{ fontFamily: 'system-ui', padding: 40, textAlign: 'center' }}>
      <h1 style={{ color: '#2563eb' }}>Your new app 🎉</h1>
      <p>Click any element in the preview and describe a change — or ask the Agent.</p>
      <button style={{ padding: '8px 16px', fontSize: 16 }}>Click me</button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
`

export const PROJECT_TEMPLATES: Record<string, { label: string; needsInstall: boolean; files: Record<string, string> }> = {
  'static-html': {
    label: 'Simple website (no setup)',
    needsInstall: false,
    files: {
      'index.html':
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>My website</title>\n  <style>\n    body { font-family: system-ui, sans-serif; text-align: center; padding: 48px; }\n    h1 { color: #2563eb; }\n  </style>\n</head>\n<body>\n  <h1>Your new website 🎉</h1>\n  <p>Open index.html in the editor, press Run preview, and start building.</p>\n</body>\n</html>\n'
    }
  },
  'vite-react': {
    label: 'React app (Vite)',
    needsInstall: true,
    files: {
      'package.json': JSON.stringify(
        {
          name: 'new-atomic-app',
          private: true,
          version: '0.0.0',
          scripts: { dev: 'vite', build: 'vite build' },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
          devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.3.0', typescript: '^5.5.0', '@types/react': '^18.3.3', '@types/react-dom': '^18.3.0' }
        },
        null,
        2
      ) + '\n',
      'index.html':
        '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>New ATOMIC app</title>\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="/src/main.tsx"></script>\n</body>\n</html>\n',
      'vite.config.ts': "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({ plugins: [react()] })\n",
      'src/main.tsx': HELLO_TSX
    }
  }
}

export interface CreateProjectResult {
  ok: boolean
  path?: string
  error?: string
}

export async function createProject(
  parentDir: string,
  name: string,
  template: string,
  onLog: (line: LogLine) => void
): Promise<CreateProjectResult> {
  const tpl = PROJECT_TEMPLATES[template]
  if (!tpl) return { ok: false, error: `Unknown template: ${template}` }
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) return { ok: false, error: 'Give the project a name.' }
  const dir = join(parentDir, slug)
  if (existsSync(dir)) return { ok: false, error: `${dir} already exists — pick another name.` }

  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(tpl.files)) {
    const abs = join(dir, file)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }

  if (tpl.needsInstall) {
    onLog({ stream: 'system', text: `[new-project] installing dependencies in ${dir}…`, ts: Date.now() })
    const res = await execStream('npm install --no-audit --no-fund', dir, onLog, 300_000).done
    if (res.code !== 0) {
      return { ok: false, error: 'npm install failed — open the project anyway and run it from the Terminal.', path: dir }
    }
    onLog({ stream: 'system', text: '[new-project] dependencies installed.', ts: Date.now() })
  }
  return { ok: true, path: dir }
}
