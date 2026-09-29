import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CaptureOpts } from './terminal'
import { gitLog } from './git-history'
import { git, shellQuote, tail, isSafeRef, isSafeRelPath, DIFF_CAPTURE, LOG_CAPTURE } from './git-exec'
import { cached, coldStamp, findRepo, gitSnapshot } from './git-snapshot'
import type { GitChange, GitCommitInfo, GitInfo, GitResult, GitBranch, GitRemote, GitMergeResult, GitStageResult } from '../shared/types'
import type { ChangedFile, ChangedFileList } from '../shared/worksafety'

/**
 * Host-agnostic git porcelain. Nothing in this file knows what a "forge" is —
 * clone/push/pull take a plain URL or the repo's configured remote, which is what
 * lets the very same code drive GitHub, a self-hosted ATOMIC server over ssh://,
 * or a bare repo on a USB stick.
 */

/**
 * The legacy summary shape, still read by the status-bar branch chip, the Agent panel's health
 * row and the Work-Safety fold. It used to cost SEVEN processes of its own; since 2026-09-02 it is
 * a projection of `gitSnapshot` (one process, two on a clean tree). `changes` is now scoped to the
 * opened folder like every other project-level count in the app — the old whole-repo list made a
 * clean `examples/hello-vite` report 185 changed files that belonged to the parent repository.
 */
export async function gitInfo(projectPath: string): Promise<GitInfo> {
  const s = await gitSnapshot(projectPath)
  if (!s.isRepo) return { isRepo: false, isRepoRoot: false, branch: '', changes: [] }
  return { isRepo: true, isRepoRoot: s.isRepoRoot, isIgnored: s.isIgnored, branch: s.branch, changes: s.changes }
}

/* ── cold data behind repository-state stamps ──────────────────────────────────────────── */

/**
 * Branch catalog, history and remotes are loaded only when their section is opened, and then
 * served from memory until the git files that define them change (see `coldStamp`). A repo the
 * `.git` walk cannot locate gets no cache at all — a miss is cheap, a stale hit is a lie.
 */
export async function gitBranchesCached(projectPath: string): Promise<GitBranch[]> {
  const loc = findRepo(projectPath)
  return cached(`branches|${projectPath}`, loc ? coldStamp(loc, 'branches') : '', () => gitBranches(projectPath))
}

export async function gitTimelineCached(projectPath: string): Promise<GitCommitInfo[]> {
  const loc = findRepo(projectPath)
  return cached(`timeline|${projectPath}`, loc ? coldStamp(loc, 'timeline') : '', () => gitTimeline(projectPath))
}

export async function gitRemotesCached(projectPath: string): Promise<GitRemote[]> {
  const loc = findRepo(projectPath)
  return cached(`remotes|${projectPath}`, loc ? coldStamp(loc, 'remotes') : '', () => gitRemotes(projectPath))
}

/**
 * Commit STAGED content.
 *
 * BEHAVIOUR CHANGE (2026-08-31): this used to run `git add -A` unconditionally, so
 * "commit this one fix" silently committed every unrelated edit in the working tree
 * and the commit message became a lie. Staging is not a power-user nicety. The old
 * behaviour survives as `stageAll`, for the Builder-mode "back up everything"
 * button — a genuinely different intent that deserves a genuinely different call.
 *
 * The conflict-marker gate uses `git diff --check`, which is git's OWN detector,
 * rather than re-deriving it here: git will already refuse a file whose index entry
 * is unmerged, but it happily commits one the user "resolved" by hand and staged
 * with a `<<<<<<<` still in it. On a shared team server that lands broken code on
 * everyone else's branch, so it is caught before the commit, not after the push.
 */
export async function gitCommit(projectPath: string, message: string, stageAll = false): Promise<GitResult> {
  if (!message.trim()) return { ok: false, error: 'Write a short message describing the change.' }
  if (stageAll) {
    const add = await git(projectPath, 'add -A')
    if (add.code !== 0) return { ok: false, error: tail(add.output) }
  }
  const check = await git(projectPath, 'diff --cached --check', false, DIFF_CAPTURE)
  // --check also reports whitespace errors; only the conflict-marker rows are fatal here.
  // Trailing whitespace is a style opinion and blocking a commit over one would be rude.
  const marked = [...new Set(
    check.output
      .split('\n')
      .filter((l) => /leftover conflict marker/i.test(l))
      .map((l) => l.split(':')[0].trim())
      .filter(Boolean)
  )]
  if (marked.length) {
    const more = marked.length > 3 ? ` +${marked.length - 3} more` : ''
    return { ok: false, error: `Unresolved conflict markers in ${marked.slice(0, 3).join(', ')}${more}. Resolve them before committing.` }
  }
  // shellQuote, NOT JSON.stringify. This line used JSON.stringify, which is not a shell escape:
  // it emits DOUBLE quotes, and a POSIX shell still expands $(...), backticks and $VAR inside
  // those. A commit message is not merely the user's own typing — `draftGitText` has the model
  // write it — so `fix: $(id)` in a drafted message reached a shell and ran. Measured before the
  // change: the JSON.stringify form executed an embedded payload, this form does not. Every other
  // interpolation in this file already goes through shellQuote or isSafeRef; this was the one gap.
  const res = await git(projectPath, `commit -m ${shellQuote(message.trim())}`)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/**
 * Push. `setUpstream` is the "publish this branch" case.
 *
 * Plain `git push` FAILS on a branch that has no upstream — "fatal: The current branch main has
 * no upstream branch" — which is exactly the state every project is in the first time it is
 * pointed at a self-hosted server. The panel knows whether an upstream exists (it renders
 * "no upstream" from the same data), so it asks for the right one rather than this function
 * guessing from an error string.
 */
export async function gitPush(projectPath: string, setUpstream = false): Promise<GitResult> {
  if (!setUpstream) {
    const res = await git(projectPath, 'push', true)
    return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
  }
  const head = await git(projectPath, 'rev-parse --abbrev-ref HEAD')
  const branch = head.output.trim()
  // A detached HEAD has no branch to publish, and 'HEAD' is not a ref anyone means to push.
  if (head.code !== 0 || !branch || branch === 'HEAD' || !isSafeRef(branch)) {
    return { ok: false, error: 'There is no branch here to publish — check out a branch first.' }
  }
  const res = await git(projectPath, `push -u origin ${shellQuote(branch)}`, true)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

export async function gitPull(projectPath: string): Promise<GitResult> {
  const res = await git(projectPath, 'pull --ff-only', true)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

export async function gitCheckout(projectPath: string, branch: string, create: boolean): Promise<GitResult> {
  if (!/^[\w./-]+$/.test(branch)) return { ok: false, error: 'Invalid branch name.' }
  const res = await git(projectPath, `checkout ${create ? '-b ' : ''}${branch}`)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/** Combined staged+working diff for AI drafting (git supercharge). */
export async function gitDiff(projectPath: string): Promise<string> {
  const res = await git(projectPath, 'diff HEAD')
  if (res.code === 0 && res.output.trim()) return res.output
  const staged = await git(projectPath, 'diff --cached')
  return staged.output
}

// ---------------------------------------------------------------- timeline

/**
 * The first page of history, kept for the callers that only ever wanted "the recent commits" and
 * for the stamp-validated cold cache below.
 *
 * It now delegates to `gitLog` rather than carrying its own format string and its own line-splitting
 * parser. Two parsers for one stream is how the short hash ended up stored under the name `hash`:
 * this one abbreviated, everything downstream assumed it had an addressable id, and expanding a
 * commit could list files it could not then diff. One format, one parser, in `shared/gitlog.ts`.
 */
export async function gitTimeline(projectPath: string): Promise<GitCommitInfo[]> {
  const page = await gitLog(projectPath, { limit: 30 })
  return page.commits
}

/** Files touched by one commit (for the timeline's expand view). */
export async function gitCommitFiles(projectPath: string, hash: string): Promise<string[]> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return []
  const res = await git(projectPath, `show --stat --format= ${hash}`)
  if (res.code !== 0) return []
  return res.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('|'))
    .slice(0, 50)
}

/**
 * Read a file's content as of the last commit (Wave 19 "Get this file back"). Returns null when the
 * path isn't in HEAD (a brand-new file) or on any error. SECURITY: `git()` runs through a shell, so the
 * path is strictly validated (a plain relative path — no shell metacharacters, no traversal, no absolute)
 * AND single-quoted; the validation guarantees no single quote can appear, so the quoting can't be broken.
 */
export async function gitShowHead(projectPath: string, relPath: string): Promise<string | null> {
  if (!relPath || relPath.length > 400 || /[^\w./ -]/.test(relPath) || relPath.includes('..') || relPath.startsWith('/')) return null
  // `HEAD:./<path>` resolves RELATIVE TO cwd (the project), so a project-relative path is correct even
  // when the project is a subfolder of a bigger repo. Single-quoted; the validation blocks any quote.
  const res = await git(projectPath, `show 'HEAD:./${relPath}'`)
  return res.code === 0 ? res.output : null
}

/**
 * What's changed since the last backup (Wave 19): the working-tree changes vs HEAD, each labelled
 * modified/new/deleted with +added/−removed line counts. Reuses gitHotspots' proven `--numstat` parse
 * (same regex + binary '-'→0 clamp), then folds in gitInfo's untracked ('??') rows so brand-new files
 * are never dropped (numstat only lists TRACKED changes). Not a git repo → [] (never throws).
 */
export async function gitWorkingStat(projectPath: string, subPath?: string): Promise<ChangedFileList> {
  const inRepo = await git(projectPath, 'rev-parse --is-inside-work-tree')
  // Not a repo: an empty list that is honestly EXACT (there is nothing to miscount).
  if (inRepo.code !== 0) return { files: [], total: 0, capped: false, exact: true }
  // Scope EVERYTHING to the opened folder (`-- .`) and strip the repo-root prefix so paths are
  // PROJECT-relative — otherwise a subfolder-of-a-repo would leak sibling files and mis-target restore.
  const prefix = (await git(projectPath, 'rev-parse --show-prefix')).output.trim()
  const strip = (p: string): string => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)
  // --no-renames splits a rename into delete+add (never a phantom "{old => new}" path); numstat gives
  // the ± counts, name-status gives the true kind (numstat alone can't tell a delete from a shrink).
  // Scope to the path we actually care about (a delete preview asks about ONE folder). Doing it here
  // rather than filtering afterwards matters: the 200-row cap below would otherwise be spent on
  // unrelated files and report "nothing changed" for the very folder being deleted.
  // Quote for the shell rather than allow-listing characters: the old test rejected ordinary names
  // (an apostrophe, a comma, most non-ASCII) and silently fell back to the WHOLE project, so the row cap
  // was spent on unrelated files and the caller was told "nothing changed here".
  const spec = subPath ? shellQuote(subPath) : '.'
  // These three inherited the default 20 KB TAIL capture — on a busy working tree git's own output was
  // cut AND the surviving rows were the LAST ones, so the count under-reported and the list showed the
  // wrong files. Same class of bug as gitHotspots (Wave 20): keep the HEAD, with real headroom.
  const CAP: CaptureOpts = { keep: 'head', max: 2_000_000 }
  const [numstat, nameStatus, status] = await Promise.all([
    git(projectPath, `-c core.quotePath=false diff --no-renames --numstat HEAD -- ${spec}`, false, CAP),
    git(projectPath, `-c core.quotePath=false diff --no-renames --name-status HEAD -- ${spec}`, false, CAP),
    git(projectPath, `-c core.quotePath=false status --porcelain --untracked-files=all -- ${spec}`, false, CAP)
  ])
  const counts = new Map<string, { added: number; removed: number }>()
  for (const raw of numstat.output.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(raw)
    if (!m) continue
    counts.set(strip(m[3].trim()), { added: m[1] === '-' ? 0 : parseInt(m[1], 10) || 0, removed: m[2] === '-' ? 0 : parseInt(m[2], 10) || 0 })
  }
  const out: ChangedFile[] = []
  const seen = new Set<string>()
  for (const raw of nameStatus.output.split('\n')) {
    const m = /^([A-Z])\t(.+)$/.exec(raw.trim())
    if (!m) continue
    const file = strip(m[2].trim())
    if (!file || seen.has(file)) continue
    seen.add(file)
    const c = counts.get(file) ?? { added: 0, removed: 0 }
    out.push({ file, kind: m[1] === 'D' ? 'deleted' : m[1] === 'A' ? 'new' : 'modified', added: c.added, removed: c.removed })
  }
  // Untracked files (?? — expanded to individual files, not a collapsed folder) → brand-new.
  for (const line of status.output.split('\n')) {
    if (!line.startsWith('??')) continue
    const file = strip(line.slice(3).trim())
    if (!file || seen.has(file)) continue
    seen.add(file)
    out.push({ file, kind: 'new', added: 0, removed: 0 })
  }
  // `out.length` is the TRUE total whenever nothing was cut off, so the banner can print an exact
  // number instead of an eternal "at least". exact=false ⇒ every count downstream is a floor.
  const exact = !numstat.truncated && !nameStatus.truncated && !status.truncated
  return { files: out.slice(0, 200), total: out.length, capped: out.length > 200, exact }
}

/**
 * Is one specific path git-IGNORED? A project can be tracked while the file being deleted (.env, a build
 * folder) is not — git reports no changes for it forever, which reads as "already backed up" when in
 * truth it has never been backed up at all. Returns null when git can't answer.
 */
export async function gitPathIgnored(projectPath: string, relPath: string): Promise<boolean | null> {
  if (!relPath || relPath.includes('..')) return null
  const res = await git(projectPath, `check-ignore -q ${shellQuote(relPath)}`)
  return res.code === 0 ? true : res.code === 1 ? false : null
}

// ---------------------------------------------------------------- staging

/**
 * Stage specific paths. Every path is re-validated here rather than trusted from the
 * renderer: `shellQuote` stops shell injection, but a path that escapes the project
 * is a different failure (staging a file the user never opened), so traversal and
 * absolute paths are refused outright — the same rule fs-service applies.
 *
 * `--` terminates option parsing, so a file literally named `-f` stages as a file.
 */
export async function gitStage(projectPath: string, relPaths: string[]): Promise<GitStageResult> {
  const safe = relPaths.filter(isSafeRelPath)
  if (!safe.length) return { ok: false, error: 'Nothing valid to stage.', staged: 0 }
  const res = await git(projectPath, `add -- ${safe.map(shellQuote).join(' ')}`)
  return res.code === 0 ? { ok: true, staged: safe.length } : { ok: false, error: tail(res.output), staged: 0 }
}

/**
 * Unstage specific paths. `restore --staged` is the modern spelling but it needs a
 * HEAD to restore *from*: in a repo whose first commit has not happened yet there is
 * no HEAD, and the only way to unstage is `rm --cached`. Falling back rather than
 * reporting failure matters because "git init, add everything, oops" is the single
 * most likely moment for a beginner to reach for Unstage.
 */
export async function gitUnstage(projectPath: string, relPaths: string[]): Promise<GitStageResult> {
  const safe = relPaths.filter(isSafeRelPath)
  if (!safe.length) return { ok: false, error: 'Nothing valid to unstage.', staged: 0 }
  const quoted = safe.map(shellQuote).join(' ')
  const res = await git(projectPath, `restore --staged -- ${quoted}`)
  if (res.code === 0) return { ok: true, staged: safe.length }
  const head = await git(projectPath, 'rev-parse --verify HEAD')
  if (head.code !== 0) {
    const rm = await git(projectPath, `rm --cached -r --quiet -- ${quoted}`)
    if (rm.code === 0) return { ok: true, staged: safe.length }
    return { ok: false, error: tail(rm.output), staged: 0 }
  }
  return { ok: false, error: tail(res.output), staged: 0 }
}

/**
 * What is staged right now, in the same shape as gitWorkingStat so the panel can
 * render one list component twice. No untracked pass here: a file cannot be both
 * untracked and staged, so `--cached` alone is complete (unlike the working-tree
 * scan, where dropping the '??' rows would hide every brand-new file).
 */
export async function gitStagedStat(projectPath: string): Promise<ChangedFileList> {
  const inRepo = await git(projectPath, 'rev-parse --is-inside-work-tree')
  if (inRepo.code !== 0) return { files: [], total: 0, capped: false, exact: true }
  const prefix = (await git(projectPath, 'rev-parse --show-prefix')).output.trim()
  const strip = (p: string): string => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)
  const [numstat, nameStatus] = await Promise.all([
    git(projectPath, `-c core.quotePath=false diff --cached --no-renames --numstat -- .`, false, DIFF_CAPTURE),
    git(projectPath, `-c core.quotePath=false diff --cached --no-renames --name-status -- .`, false, DIFF_CAPTURE)
  ])
  const counts = new Map<string, { added: number; removed: number }>()
  for (const raw of numstat.output.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(raw)
    if (!m) continue
    counts.set(strip(m[3].trim()), { added: m[1] === '-' ? 0 : parseInt(m[1], 10) || 0, removed: m[2] === '-' ? 0 : parseInt(m[2], 10) || 0 })
  }
  const out: ChangedFile[] = []
  const seen = new Set<string>()
  for (const raw of nameStatus.output.split('\n')) {
    const m = /^([A-Z])\t(.+)$/.exec(raw.trim())
    if (!m) continue
    const file = strip(m[2].trim())
    if (!file || seen.has(file)) continue
    seen.add(file)
    const c = counts.get(file) ?? { added: 0, removed: 0 }
    out.push({ file, kind: m[1] === 'D' ? 'deleted' : m[1] === 'A' ? 'new' : 'modified', added: c.added, removed: c.removed })
  }
  const exact = !numstat.truncated && !nameStatus.truncated
  return { files: out.slice(0, 200), total: out.length, capped: out.length > 200, exact }
}

// ---------------------------------------------------------------- branches

/**
 * Local branches with their upstream and ahead/behind counts, in ONE call.
 *
 * `for-each-ref` is used rather than `branch -vv` because its output is a format
 * string we choose — no locale-dependent decoration to reverse-engineer, and no
 * ambiguity when a branch name contains a space-like character. Unit separators
 * (\x1f) keep the split honest for the same reason gitTimeline uses them.
 *
 * A branch with no upstream reports ahead/behind 0 — not "unknown". That is the
 * truthful answer to "how far is this from its remote": there is no remote.
 */
export async function gitBranches(projectPath: string): Promise<GitBranch[]> {
  const res = await git(
    projectPath,
    `for-each-ref --format='%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)' refs/heads`,
    false,
    LOG_CAPTURE
  )
  if (res.code !== 0) return []
  return res.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('\x1f'))
    .map((l) => {
      const [name, upstream, track, head] = l.split('\x1f')
      const ahead = /ahead (\d+)/.exec(track ?? '')
      const behind = /behind (\d+)/.exec(track ?? '')
      return {
        name,
        current: head?.trim() === '*',
        remote: upstream?.trim() || undefined,
        ahead: ahead ? parseInt(ahead[1], 10) : 0,
        behind: behind ? parseInt(behind[1], 10) : 0
      }
    })
    .filter((b) => Boolean(b.name))
}

/**
 * Delete a branch. `force` is the difference between git refusing to drop unmerged
 * work and git dropping it anyway, so it is an explicit argument the UI must pass —
 * never a silent retry with -D when -d fails. That retry is how people lose work.
 */
export async function gitBranchDelete(projectPath: string, branch: string, force = false): Promise<GitResult> {
  if (!isSafeRef(branch)) return { ok: false, error: 'Invalid branch name.' }
  const res = await git(projectPath, `branch ${force ? '-D' : '-d'} -- ${shellQuote(branch)}`)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/** Update remote-tracking refs without touching the working tree. Prunes deleted branches. */
export async function gitFetch(projectPath: string, remote?: string): Promise<GitResult> {
  if (remote && !isSafeRef(remote)) return { ok: false, error: 'Invalid remote name.' }
  const res = await git(projectPath, `fetch --prune ${remote ? shellQuote(remote) : '--all'}`, true)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

// ---------------------------------------------------------------- remotes

/**
 * A URL we are willing to hand to git.
 *
 * `shellQuote` already stops SHELL injection, but it does nothing about GIT OPTION
 * injection: a "URL" beginning with `-` is read by git as a flag, and
 * `--upload-pack=<command>` turns a clone into arbitrary code execution on this
 * machine. Every call site also passes `--`, so this is the second of two locks.
 */
export function isSafeGitUrl(url: string): boolean {
  const u = (url ?? '').trim()
  if (!u || u.length > 2048 || u.startsWith('-') || /[\r\n\0]/.test(u)) return false
  // ssh://user@host/path · git@host:path · https://host/path · /absolute/path · file://
  return /^(?:ssh|git|https?|file):\/\//.test(u) || /^[\w.-]+@[\w.-]+:[^\s]+$/.test(u) || u.startsWith('/')
}

export async function gitRemotes(projectPath: string): Promise<GitRemote[]> {
  const res = await git(projectPath, 'remote -v')
  if (res.code !== 0) return []
  const map = new Map<string, GitRemote>()
  for (const line of res.output.split('\n')) {
    const m = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const cur = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' }
    if (m[3] === 'fetch') cur.fetchUrl = m[2]
    else cur.pushUrl = m[2]
    map.set(m[1], cur)
  }
  return [...map.values()]
}

/** `git init` in a folder that is not yet a repository. Safe to call on one that already is. */
export async function gitInit(projectPath: string): Promise<GitResult> {
  const res = await git(projectPath, 'init')
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/** Add or repoint a remote. Idempotent: an existing name is updated, not duplicated. */
export async function gitRemoteAdd(projectPath: string, name: string, url: string): Promise<GitResult> {
  if (!isSafeRef(name)) return { ok: false, error: 'Invalid remote name.' }
  if (!isSafeGitUrl(url)) return { ok: false, error: 'That does not look like a git URL.' }
  const existing = await gitRemotes(projectPath)
  const verb = existing.some((r) => r.name === name) ? 'set-url' : 'add'
  const res = await git(projectPath, `remote ${verb} -- ${shellQuote(name)} ${shellQuote(url.trim())}`)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/**
 * Clone any git URL into destDir/<name>. Host-agnostic by design — this is the
 * function that makes a self-hosted `ssh://git@host/srv/atomic/git/x.git` a
 * first-class citizen alongside a GitHub HTTPS URL, with no special case for either.
 */
export async function gitClone(url: string, destDir: string, name?: string): Promise<GitResult & { path?: string }> {
  if (!isSafeGitUrl(url)) return { ok: false, error: 'That does not look like a git URL.' }
  const leaf = (name?.trim() || basename(url.trim().replace(/\/+$/, ''), '.git')).replace(/[^\w.-]/g, '')
  if (!leaf) return { ok: false, error: 'Could not work out a folder name for that URL.' }
  const target = join(destDir, leaf)
  if (existsSync(target)) return { ok: false, error: `${target} already exists.` }
  const res = await git(destDir, `clone -- ${shellQuote(url.trim())} ${shellQuote(target)}`, true)
  if (res.code !== 0) return { ok: false, error: tail(res.output) }
  return { ok: true, path: target }
}

// ---------------------------------------------------------------- merge & conflicts

/** Paths git currently considers UNMERGED. The authoritative conflict list. */
export async function gitConflicts(projectPath: string): Promise<string[]> {
  const res = await git(projectPath, 'diff --name-only --diff-filter=U', false, DIFF_CAPTURE)
  if (res.code !== 0) return []
  return res.output.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 200)
}

/**
 * Merge a branch into the current one.
 *
 * A merge that stops on conflicts is NOT an error — it is the normal, expected
 * outcome that the whole conflict UI exists to serve. So conflicts come back as
 * data (`ok: false` with a populated `conflicts`), and only a merge that failed for
 * some other reason gets an `error` string. Collapsing the two would make the panel
 * show a red failure toast at the exact moment the user needs to start working.
 */
export async function gitMerge(projectPath: string, branch: string): Promise<GitMergeResult> {
  if (!isSafeRef(branch)) return { ok: false, error: 'Invalid branch name.', conflicts: [] }
  const res = await git(projectPath, `merge --no-edit -- ${shellQuote(branch)}`)
  if (res.code === 0) return { ok: true, conflicts: [] }
  const conflicts = await gitConflicts(projectPath)
  return conflicts.length ? { ok: false, conflicts } : { ok: false, error: tail(res.output), conflicts: [] }
}

/** Throw the whole merge away and go back to where we were. */
export async function gitMergeAbort(projectPath: string): Promise<GitResult> {
  const res = await git(projectPath, 'merge --abort')
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/**
 * Mark one file resolved. This is `git add`, which is the only thing "resolved"
 * has ever meant to git — there is no separate resolve state to set.
 */
export async function gitResolveFile(projectPath: string, relPath: string): Promise<GitResult> {
  if (!isSafeRelPath(relPath)) return { ok: false, error: 'Invalid path.' }
  const res = await git(projectPath, `add -- ${shellQuote(relPath)}`)
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/** Finish a merge once every conflict is staged. Refuses while any remain. */
export async function gitMergeContinue(projectPath: string): Promise<GitResult> {
  const left = await gitConflicts(projectPath)
  if (left.length) return { ok: false, error: `${left.length} file${left.length === 1 ? '' : 's'} still need resolving.` }
  const res = await git(projectPath, 'commit --no-edit')
  return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.output) }
}

/** Is a merge (or rebase) in progress right now? Drives the panel's conflict banner. */
export async function gitMergeInProgress(projectPath: string): Promise<boolean> {
  const res = await git(projectPath, 'rev-parse --verify --quiet MERGE_HEAD')
  return res.code === 0 && Boolean(res.output.trim())
}
