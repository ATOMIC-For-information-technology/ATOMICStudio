// Configure Monaco to run fully offline inside Electron — no CDN. We bundle the
// editor locally and wire its web workers through bundler-standard worker URLs, then
// point @monaco-editor/react at this local instance. Imported once from main.tsx.
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import { registerMonacoLoad } from './theme'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(self as any).MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url))
    if (label === 'css' || label === 'scss' || label === 'less')
      return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url))
    if (label === 'html' || label === 'handlebars' || label === 'razor')
      return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url))
    if (label === 'typescript' || label === 'javascript')
      return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url))
    return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url))
  }
}

loader.config({ monaco })

/** Map a file extension to a Monaco language id. */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', vue: 'html', svelte: 'html',
    md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml', xml: 'xml',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', php: 'php',
    c: 'c', h: 'c', cpp: 'cpp', sh: 'shell', bash: 'shell', sql: 'sql', toml: 'ini'
  }
  return map[ext] ?? 'plaintext'
}

/* This module is only ever reached through the lazily-loaded editor chunk, so its evaluation is the
   moment Monaco genuinely exists in the page. Tell the theme engine, which until now has been
   holding the workbench's colours without an editor to paint them onto. */
registerMonacoLoad(Promise.resolve(monaco))
