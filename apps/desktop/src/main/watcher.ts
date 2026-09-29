import { watch, type FSWatcher } from 'node:fs'
import { HIDDEN_DIRS } from './fs-service'

const DEBOUNCE_MS = 350

/**
 * Watches a project root for changes made OUTSIDE the app itself — Finder, a terminal command,
 * `npm install`, another editor, a branch checkout. Without this, the file tree and open tabs only ever
 * reflected what the app's own writeFile/deletePath calls did — anything that touched disk another way
 * looked to the app like nothing had happened.
 *
 * Debounced and filtered against the same HIDDEN_DIRS noise-list the tree already uses, so a large
 * `npm install` (tens of thousands of node_modules writes) collapses into silence rather than spamming
 * the renderer. Never throws: an unwatchable root (permissions, an unusual platform) just means the tree
 * falls back to the app's own manual refresh points — it must never crash opening a project.
 */
export function watchProject(root: string, onChange: (paths: string[]) => void, onGitMeta?: () => void): () => void {
  let watcher: FSWatcher | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<string>()
  const gitMeta = onGitMeta ? debounced(onGitMeta, GIT_DEBOUNCE_MS) : null

  const flush = (): void => {
    timer = null
    if (!pending.size) return
    const paths = [...pending]
    pending.clear()
    onChange(paths)
  }

  const isNoise = (rel: string): boolean => rel.split(/[\\/]/).some((seg) => HIDDEN_DIRS.has(seg))

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) {
        const rel = filename.split('\\').join('/')
        // `.git/**` is on the noise list for the TREE (nobody browses objects/), but the index,
        // HEAD, refs and merge state are exactly what the Source Control view must follow when
        // a terminal runs `git add`, `git commit` or `git checkout`. Route those to their own
        // signal instead of dropping them with the rest.
        if (rel === '.git' || rel.startsWith('.git/')) {
          if (gitMeta && isGitMetaRelevant(rel.slice(5))) gitMeta.fire()
          return
        }
        if (isNoise(rel)) return
        pending.add(rel)
      } else {
        // Some platforms omit the filename on certain events — fall back to a bare "something changed".
        pending.add('')
      }
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, DEBOUNCE_MS)
    })
    watcher.on('error', () => {
      /* watching failed mid-flight (e.g. the folder itself was removed) — degrade silently */
    })
  } catch {
    /* recursive watching unsupported here — the app's own manual refresh points still work */
  }

  return () => {
    if (timer) clearTimeout(timer)
    gitMeta?.cancel()
    watcher?.close()
  }
}

/* ── git metadata ──────────────────────────────────────────────────────────────────────── */

const GIT_DEBOUNCE_MS = 120

function debounced(fn: () => void, ms: number): { fire: () => void; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null
  return {
    fire: () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        t = null
        fn()
      }, ms)
    },
    cancel: () => {
      if (t) clearTimeout(t)
      t = null
    }
  }
}

/**
 * Which entries under a `.git` directory can change what the Source Control view shows.
 *
 * `objects/` is by far the noisiest subtree (every `git add` writes blobs there) and never changes
 * the view on its own — the index or a ref changes after it, and THAT is the signal. `*.lock`
 * files are git's own transaction markers: the real file lands a moment later and fires again.
 * Everything else (HEAD, index, ORIG_HEAD, MERGE_HEAD, FETCH_HEAD, packed-refs, refs/**, logs/,
 * config, rebase-merge/) is relevant.
 */
export function isGitMetaRelevant(rel: string): boolean {
  if (!rel) return true // the .git entry itself appeared or vanished (git init / rm -rf .git)
  const first = rel.split('/')[0]
  if (first === 'objects' || first === 'lfs' || first === 'hooks' || first === 'modules') return false
  if (rel.endsWith('.lock')) return false
  return true
}

/**
 * Watch a `.git` directory that lives OUTSIDE the opened project (a subfolder of a bigger repo,
 * or a linked worktree whose metadata sits in the main repo). The project watcher cannot see it,
 * so without this a `git commit` in the terminal would leave the panel showing files as still
 * staged until the next working-tree edit happened to trigger a refresh.
 */
export function watchGitDir(gitDir: string, onChange: () => void): () => void {
  let watcher: FSWatcher | null = null
  const fire = debounced(onChange, GIT_DEBOUNCE_MS)
  try {
    watcher = watch(gitDir, { recursive: true }, (_event, filename) => {
      const rel = filename ? filename.split('\\').join('/') : ''
      if (isGitMetaRelevant(rel)) fire.fire()
    })
    watcher.on('error', () => {
      /* the directory went away — the project watcher's own signals still work */
    })
  } catch {
    /* recursive watching unsupported here */
  }
  return () => {
    fire.cancel()
    watcher?.close()
  }
}
