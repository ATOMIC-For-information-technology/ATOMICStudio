/* eslint-disable */
/**
 * Turn a vendored VS Code file-icon theme JSON into a typed TS module the renderer imports.
 *
 *   node scripts/gen-icon-theme.cjs
 *
 * Why generate instead of importing the JSON directly: `resolveJsonModule` would make `tsc` infer
 * a literal type for a 55 KB object on every typecheck of both projects, and the theme is not
 * data that changes — it is a pinned upstream asset. The generated module is committed, so the
 * build needs no extra step and the app makes no network request; re-run this only when the
 * pinned upstream commit is bumped.
 *
 * `information_for_contributors` and `version` are dropped: they are provenance for the upstream
 * repository, and the provenance that matters HERE is written into the generated header.
 */
const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const src = join(root, 'src', 'renderer', 'src', 'assets', 'file-icons', 'seti', 'vs-seti-icon-theme.json')
const out = join(root, 'src', 'renderer', 'src', 'assets', 'file-icons', 'seti-theme.gen.ts')

// Pinned upstream. Bump BOTH of these together with the vendored files.
const UPSTREAM = {
  repo: 'https://github.com/microsoft/vscode',
  path: 'extensions/theme-seti',
  commit: 'a11e4a544c9c19643f08fb400d8659ebb84cbc8f'
}

const theme = JSON.parse(readFileSync(src, 'utf8'))
const keep = [
  'iconDefinitions', 'fonts', 'file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded',
  'fileExtensions', 'fileNames', 'folderNames', 'folderNamesExpanded', 'languageIds', 'light', 'highContrast'
]
const slim = {}
for (const k of keep) if (theme[k] !== undefined) slim[k] = theme[k]

const header = `/* GENERATED FILE — do not edit by hand. Run: node scripts/gen-icon-theme.cjs
 *
 * The Seti file-icon theme, vendored from VS Code so the app never fetches an icon at runtime.
 *
 *   upstream   ${UPSTREAM.repo}
 *   path       ${UPSTREAM.path}
 *   commit     ${UPSTREAM.commit}
 *
 * Seti UI is (c) 2014 Jesse Weed, MIT — see \`seti/ThirdPartyNotices.txt\` beside the vendored
 * assets for the full notice, kept verbatim from upstream. The glyphs live in \`seti/seti.woff\`,
 * loaded by a local \`@font-face\` in \`styles.css\`; nothing here reaches the network. No
 * Microsoft name, logo or product branding is used.
 */
import type { IconTheme } from '../../../../shared/file-icons'

export const SETI_UPSTREAM = ${JSON.stringify(UPSTREAM, null, 2)} as const

export const setiTheme: IconTheme = `

writeFileSync(out, header + JSON.stringify(slim, null, 2) + '\n', 'utf8')

const bytes = readFileSync(out).length
console.log(`wrote ${out} (${(bytes / 1024).toFixed(1)} KB)`)
console.log(
  `  ${Object.keys(slim.iconDefinitions).length} icons · ${Object.keys(slim.fileExtensions || {}).length} extensions · ` +
    `${Object.keys(slim.fileNames || {}).length} names · ${Object.keys(slim.languageIds || {}).length} languages`
)
