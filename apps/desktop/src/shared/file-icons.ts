/**
 * File-icon theme resolution — VS Code's file-icon-theme contract, implemented as a pure fold.
 *
 * This is a DIFFERENT system from `components/Icon.tsx`, and the split is deliberate (DESIGN.md):
 *
 *   product icons    ATOMIC's authored monochrome set — Refresh, New File, Git, Settings. One
 *                    family, one weight, `currentColor`, drawn in-repo.
 *   file-type icons  a data-driven, locally bundled icon THEME — what a `.ts` or a `Dockerfile`
 *                    looks like. Coloured, per-language, and swappable.
 *
 * The old `FileTree.fileIcon()` collapsed thirty file types onto nine product glyphs, so every
 * JavaScript, TypeScript, Go, Rust and Java file drew the same outline. That is not an icon theme;
 * it is a placeholder, and it is what this replaces.
 *
 * IO-free and DOM-free on purpose: it lives in `shared/` so `scripts/test-agent.cjs` can check the
 * matching rules without an Electron window, and so it typechecks under both tsconfigs.
 */

export interface IconDefinition {
  /** The glyph's codepoint in the theme font, as the theme writes it: "\\E001". */
  fontCharacter?: string
  fontColor?: string
  fontSize?: string
  /** Which of the theme's `fonts` to draw with; the first font when omitted. */
  fontId?: string
  /** SVG/PNG themes point at a file instead of a glyph. Resolved against the theme's own folder. */
  iconPath?: string
}

export interface IconThemeFont {
  id?: string
  src: { path: string; format: string }[]
  weight?: string
  style?: string
  size?: string
}

/** The parts of a theme that a light/high-contrast block may override. */
export interface IconThemeVariant {
  file?: string
  folder?: string
  folderExpanded?: string
  rootFolder?: string
  rootFolderExpanded?: string
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  languageIds?: Record<string, string>
}

export interface IconTheme extends IconThemeVariant {
  iconDefinitions: Record<string, IconDefinition>
  fonts?: IconThemeFont[]
  light?: IconThemeVariant
  highContrast?: IconThemeVariant
}

export type IconVariant = 'dark' | 'light' | 'hc'

export interface IconQuery {
  /** The leaf name only — never a path. */
  name: string
  isDir?: boolean
  expanded?: boolean
  /** The workspace root row, which themes may style separately. */
  isRoot?: boolean
  /** The containing folder's leaf name, for parent-qualified rules. */
  parentName?: string
}

/**
 * How a resolved icon should be drawn. `char` is the real character (the theme's `"\\E001"`
 * escape already decoded), so the renderer never has to parse theme syntax.
 */
export interface ResolvedIcon {
  id: string
  char: string | null
  color: string | null
  fontSize: string | null
  fontId: string | null
  iconPath: string | null
}

/* ── language ids ───────────────────────────────────────────────────────────────────────── */

/**
 * Filename → VS Code language id.
 *
 * Seti resolves most everyday types through `languageIds`, not `fileExtensions`: it has no `js`,
 * `ts`, `json`, `md`, `py`, `go`, `rs`, `java`, `css` or `html` extension key at all. VS Code
 * supplies the mapping from its built-in language extensions' `contributes.languages`; this table
 * is the same data for the languages the bundled theme actually defines, kept here rather than
 * importing forty `package.json` files.
 *
 * Keys are lower-case; lookup lower-cases the filename first, which is what VS Code does for
 * extension and filename matching.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  // JavaScript / TypeScript
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', es6: 'javascript',
  jsx: 'javascriptreact',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'typescriptreact',
  // data / config
  json: 'json', jsonl: 'jsonl', ndjson: 'jsonl',
  jsonc: 'jsonc',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', svg: 'xml',
  properties: 'properties', ini: 'properties', cfg: 'properties', conf: 'properties',
  env: 'dotenv',
  // web
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', styl: 'stylus', pcss: 'postcss',
  vue: 'vue',
  hbs: 'handlebars', handlebars: 'handlebars', mustache: 'mustache',
  jade: 'jade', pug: 'jade', haml: 'haml',
  erb: 'erb', njk: 'nunjucks', jinja: 'jinja', jinja2: 'jinja',
  blade: 'blade', razor: 'razor', cshtml: 'razor',
  // languages
  py: 'python', pyi: 'python', pyw: 'python',
  rb: 'ruby', gemspec: 'ruby', rake: 'ruby',
  go: 'go', rs: 'rust',
  java: 'java', gradle: 'gradle', groovy: 'groovy',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', dart: 'dart',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cu: 'cuda-cpp', cuh: 'cuda-cpp',
  m: 'objective-c', mm: 'objective-cpp',
  cs: 'csharp', fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  php: 'php', pl: 'perl', pm: 'perl',
  lua: 'lua', r: 'r', jl: 'julia',
  ex: 'elixir', exs: 'elixir', elm: 'elm',
  hs: 'haskell', hx: 'haxe', ml: 'ocaml', mli: 'ocaml',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  coffee: 'coffeescript',
  res: 'rescript', resi: 'rescript',
  vala: 'vala', vapi: 'vala',
  sql: 'sql',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'shellscript', ksh: 'shellscript',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  tf: 'terraform', tfvars: 'terraform',
  tex: 'latex', sty: 'latex', bib: 'tex',
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  gd: 'godot', tres: 'godot', tscn: 'godot'
}

/** Whole filenames that decide a language on their own. Lower-cased. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  'docker-compose.yml': 'dockercompose',
  'docker-compose.yaml': 'dockercompose',
  'compose.yml': 'dockercompose',
  'compose.yaml': 'dockercompose',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitignore': 'ignore',
  '.gitattributes': 'ignore',
  '.npmignore': 'ignore',
  '.dockerignore': 'ignore',
  '.eslintignore': 'ignore',
  '.env': 'dotenv',
  '.npmrc': 'properties',
  '.editorconfig': 'properties',
  '.nvmrc': 'properties',
  commit_editmsg: 'git-commit',
  merge_msg: 'git-commit'
}

/** Filename prefixes that carry a language even with a suffix, e.g. `.env.local`, `Dockerfile.dev`. */
const LANGUAGE_BY_PREFIX: [string, string][] = [
  ['.env.', 'dotenv'],
  ['dockerfile.', 'dockerfile']
]

/**
 * Every extension a name should be tried under, longest first.
 *
 * `app.spec.ts` yields ['spec.ts', 'ts']; `.gitignore` yields ['gitignore'] — a dotfile's whole
 * tail IS its extension, which is why the scan starts at the first dot wherever it is rather than
 * skipping a leading one. A trailing dot yields nothing rather than an empty candidate.
 */
export function extensionCandidates(lowerName: string): string[] {
  const out: string[] = []
  for (let i = lowerName.indexOf('.'); i >= 0 && i < lowerName.length - 1; i = lowerName.indexOf('.', i + 1)) {
    out.push(lowerName.slice(i + 1))
  }
  // indexOf walks left→right, so the longest (earliest-dot) candidate is already first.
  return out
}

/**
 * VS Code's language id for a filename, or null.
 *
 * Multi-dot names are read longest-suffix-first (`x.d.ts` tries `d.ts` before `ts`) so a compound
 * entry wins where one exists, which is the rule VS Code's extension matching uses.
 */
export function languageIdFor(fileName: string): string | null {
  const lower = fileName.toLowerCase()
  const byName = LANGUAGE_BY_FILENAME[lower]
  if (byName) return byName
  for (const [prefix, lang] of LANGUAGE_BY_PREFIX) {
    if (lower.startsWith(prefix)) return lang
  }
  for (const ext of extensionCandidates(lower)) {
    const lang = LANGUAGE_BY_EXTENSION[ext]
    if (lang) return lang
  }
  return null
}

/* ── theme lookup ───────────────────────────────────────────────────────────────────────── */

/** Layer the variant block over the base, the way VS Code applies `light` / `highContrast`. */
function layerFor(theme: IconTheme, variant: IconVariant): IconThemeVariant[] {
  if (variant === 'light' && theme.light) return [theme.light, theme]
  if (variant === 'hc' && theme.highContrast) return [theme.highContrast, theme]
  return [theme]
}

function pick(layers: IconThemeVariant[], read: (l: IconThemeVariant) => string | undefined): string | null {
  for (const l of layers) {
    const v = read(l)
    if (v) return v
  }
  return null
}

function fromMap(
  layers: IconThemeVariant[],
  read: (l: IconThemeVariant) => Record<string, string> | undefined,
  key: string
): string | null {
  for (const l of layers) {
    const m = read(l)
    if (m && Object.prototype.hasOwnProperty.call(m, key)) return m[key]
  }
  return null
}

/**
 * The icon id for one entry, in VS Code's documented precedence:
 *
 *   1. filename qualified by its parent folder   `src/index.ts`
 *   2. exact filename                            `package.json`
 *   3. multi-part extension + parent folder      `src/spec.ts`
 *   4. multi-part extension                      `spec.ts`
 *   5. simple extension                          `ts`
 *   6. language id                               `typescript`
 *   7. the theme's default file icon
 *
 * Folders use `folderNames` / `folderNamesExpanded` and fall back to the theme's folder icon;
 * a theme with no folder icon at all (Seti is one) returns null, and the row draws just its
 * disclosure arrow — which is exactly how Seti looks in VS Code.
 *
 * Every comparison is lower-cased: the icon-theme spec matches names case-insensitively, so a
 * theme keyed on `readme.md` still matches a file called `README.md`.
 */
export function resolveIconId(theme: IconTheme, q: IconQuery, variant: IconVariant = 'dark'): string | null {
  const layers = layerFor(theme, variant)
  const lower = q.name.toLowerCase()
  const parent = q.parentName ? q.parentName.toLowerCase() : null

  if (q.isDir) {
    if (q.isRoot) {
      const root = pick(layers, (l) => (q.expanded ? l.rootFolderExpanded : l.rootFolder))
      if (root) return root
    }
    const named = q.expanded
      ? fromMap(layers, (l) => l.folderNamesExpanded, lower) ?? fromMap(layers, (l) => l.folderNames, lower)
      : fromMap(layers, (l) => l.folderNames, lower)
    if (named) return named
    return pick(layers, (l) => (q.expanded ? l.folderExpanded : l.folder))
  }

  if (parent) {
    const qualified = fromMap(layers, (l) => l.fileNames, `${parent}/${lower}`)
    if (qualified) return qualified
  }
  const byName = fromMap(layers, (l) => l.fileNames, lower)
  if (byName) return byName

  const candidates = extensionCandidates(lower)
  if (parent) {
    for (const ext of candidates) {
      const qualified = fromMap(layers, (l) => l.fileExtensions, `${parent}/${ext}`)
      if (qualified) return qualified
    }
  }
  for (const ext of candidates) {
    const byExt = fromMap(layers, (l) => l.fileExtensions, ext)
    if (byExt) return byExt
  }

  const lang = languageIdFor(q.name)
  if (lang) {
    const byLang = fromMap(layers, (l) => l.languageIds, lang)
    if (byLang) return byLang
  }

  return pick(layers, (l) => l.file)
}

/** `"\\E001"` as the theme writes it → the actual character. Returns null for anything else. */
export function decodeFontCharacter(raw: string | undefined): string | null {
  if (!raw) return null
  const m = /^\\+([0-9a-fA-F]{2,6})$/.exec(raw.trim())
  if (m) return String.fromCodePoint(parseInt(m[1], 16))
  // Some themes write the literal glyph instead of an escape.
  return raw.length > 0 && raw.length <= 4 ? raw : null
}

/**
 * Resolve an entry all the way to what the renderer needs to draw. Returns null when the theme
 * has nothing for this row (a folder in a theme with no folder icons), which the caller renders
 * as an empty but still-reserved icon slot so filenames stay aligned.
 */
export function resolveFileIcon(theme: IconTheme, q: IconQuery, variant: IconVariant = 'dark'): ResolvedIcon | null {
  const id = resolveIconId(theme, q, variant)
  if (!id) return null
  const def = theme.iconDefinitions?.[id]
  if (!def) return null
  return {
    id,
    char: decodeFontCharacter(def.fontCharacter),
    color: def.fontColor ?? null,
    fontSize: def.fontSize ?? null,
    fontId: def.fontId ?? null,
    iconPath: def.iconPath ?? null
  }
}

/* ── importing a theme safely ───────────────────────────────────────────────────────────── */

export interface ThemeValidation {
  ok: boolean
  /** Why it was refused, in words a person can act on. */
  error?: string
  /** Asset paths the theme references, already checked for traversal and scheme. */
  assets: string[]
}

const ASSET_EXT = /\.(svg|png|woff2?|ttf|otf)$/i

/**
 * Is this JSON a file-icon theme we are willing to load from disk?
 *
 * File-icon themes are imported as DATA, never as code — the same line `PRODUCT.md` draws for
 * VS Code colour themes. So every asset path must be relative, inside the theme's own folder, and
 * a font or image; anything with a scheme (`http:`, `data:`, `file:`), an absolute path, or a `..`
 * segment is refused outright rather than sanitised, because a "cleaned" traversal is still a
 * theme asking to read somewhere it should not.
 */
export function validateIconTheme(raw: unknown, maxAssets = 4096): ThemeValidation {
  const assets: string[] = []
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'The theme file is not a JSON object.', assets }
  const theme = raw as Record<string, unknown>
  const defs = theme.iconDefinitions
  if (!defs || typeof defs !== 'object') return { ok: false, error: 'The theme has no iconDefinitions.', assets }

  const takePath = (p: unknown, where: string): string | null => {
    if (typeof p !== 'string' || !p) return `${where} is not a path.`
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return `${where} points at a URL; themes may only use local files.`
    if (p.startsWith('/') || p.startsWith('\\') || /^[a-z]:[\\/]/i.test(p)) return `${where} is an absolute path.`
    if (p.split(/[\\/]/).some((seg) => seg === '..')) return `${where} escapes the theme folder.`
    if (!ASSET_EXT.test(p)) return `${where} is not an image or font.`
    assets.push(p)
    return null
  }

  for (const [id, def] of Object.entries(defs as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') return { ok: false, error: `Icon "${id}" is malformed.`, assets }
    const d = def as Record<string, unknown>
    if (d.iconPath !== undefined) {
      const err = takePath(d.iconPath, `Icon "${id}"`)
      if (err) return { ok: false, error: err, assets }
    }
    if (d.fontCharacter !== undefined && typeof d.fontCharacter !== 'string') {
      return { ok: false, error: `Icon "${id}" has a non-string fontCharacter.`, assets }
    }
  }

  const fonts = theme.fonts
  if (fonts !== undefined) {
    if (!Array.isArray(fonts)) return { ok: false, error: 'fonts must be a list.', assets }
    for (const f of fonts) {
      const src = (f as { src?: unknown })?.src
      if (!Array.isArray(src)) return { ok: false, error: 'A font has no src list.', assets }
      for (const s of src) {
        const err = takePath((s as { path?: unknown })?.path, 'A font source')
        if (err) return { ok: false, error: err, assets }
      }
    }
  }

  // A theme is data. Anything that asks to RUN is refused BY NAME, so the refusal explains itself
  // rather than silently ignoring the key and leaving the author guessing.
  for (const forbidden of ['contributes', 'main', 'browser', 'activationEvents', 'commands', 'scripts']) {
    if (theme[forbidden] !== undefined) {
      return { ok: false, error: `Themes are data only — "${forbidden}" is not allowed in an icon theme.`, assets }
    }
  }

  if (assets.length > maxAssets) {
    return { ok: false, error: `The theme references ${assets.length} assets; the limit is ${maxAssets}.`, assets }
  }
  return { ok: true, assets }
}
