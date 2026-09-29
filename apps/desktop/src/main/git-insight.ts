import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { git, LOG_CAPTURE } from './git-exec'
import type { AuthorStat, CrossRepoGraph, CrossRepoHotspot, FileOwnership, GitHotspot, ModuleOwner } from '../shared/types'

/**
 * History folds for the Project Brain: churn hotspots, authorship, cross-repo graph.
 *
 * Split out of git.ts unchanged — these are read-only analyses over `git log`, with
 * a different audience and a different failure mode from the porcelain in git-core
 * (a wrong hotspot ranking misinforms; a wrong `git merge` loses work).
 */

/**
 * Change hotspots for the Project Brain: the files touched most often (and with
 * the most churn) across recent history. `--numstat` gives "adds<TAB>dels<TAB>file"
 * per file per commit; we aggregate in JS. Not a git repo → [] (never throws).
 *
 * Paths are PROJECT-relative (same namespace as the index/tech-debt/architecture
 * folds), exactly like gitAuthorship below: `-- .` scopes history to the opened
 * folder and --show-prefix is stripped off each path. Without this, opening a
 * monorepo SUBFOLDER yields repo-root-relative paths that join with nothing.
 */
export async function gitHotspots(projectPath: string, limit = 12): Promise<GitHotspot[]> {
  const inRepo = await git(projectPath, 'rev-parse --is-inside-work-tree')
  if (inRepo.code !== 0) return []
  const pfx = await git(projectPath, 'rev-parse --show-prefix')
  const prefix = pfx.code === 0 ? pfx.output.trim() : ''
  // Empty --format= drops commit headers; only numstat body lines remain.
  // --no-renames splits a rename into old-delete + new-add so we never store a
  // phantom "{old => new}" path key (default rename detection would).
  const res = await git(projectPath, '-c core.quotePath=false log -n 400 --no-merges --no-renames --numstat --format= -- .', false, LOG_CAPTURE)
  if (res.code !== 0) return []
  const stat = new Map<string, { commits: number; churn: number }>()
  for (const raw of res.output.split('\n')) {
    // "<adds>\t<dels>\t<file>"; binary files show "-\t-\tfile".
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(raw)
    if (!m) continue
    const adds = m[1] === '-' ? 0 : parseInt(m[1], 10) || 0
    const dels = m[2] === '-' ? 0 : parseInt(m[2], 10) || 0
    const raw3 = m[3].trim()
    const file = prefix && raw3.startsWith(prefix) ? raw3.slice(prefix.length) : raw3
    const cur = stat.get(file) ?? { commits: 0, churn: 0 }
    cur.commits += 1
    cur.churn += adds + dels
    stat.set(file, cur)
  }
  return [...stat.entries()]
    .map(([file, s]) => ({ file, commits: s.commits, churn: s.churn }))
    .sort((a, b) => b.commits - a.commits || b.churn - a.churn)
    .slice(0, limit)
}

/**
 * Team Knowledge Graph — who has touched each file, by commit count, so the
 * owner (authors[0]) and experts are visible. %x1e leads each commit RECORD;
 * %x1f separates the author NAME from the EMAIL on that first line (--name-only
 * file lines never carry either separator). Authors are deduped by lowercased
 * EMAIL, so one person committing under several name aliases is a single owner;
 * the friendliest (most-used) name is displayed. --no-renames avoids a phantom
 * "{old => new}" path. Not a git repo → [] (never throws).
 */
export async function gitAuthorship(projectPath: string, limit = 400): Promise<FileOwnership[]> {
  const inRepo = await git(projectPath, 'rev-parse --is-inside-work-tree')
  if (inRepo.code !== 0) return []
  // `-- .` scopes history to the OPENED folder (not the whole enclosing repo), and
  // --show-prefix gives that folder's path relative to the repo root so we can
  // strip it and report project-relative paths — correct for a monorepo subfolder.
  const pfx = await git(projectPath, 'rev-parse --show-prefix')
  const prefix = pfx.code === 0 ? pfx.output.trim() : ''
  const res = await git(projectPath, `-c core.quotePath=false log -n ${limit} --no-merges --no-renames --name-only --pretty=format:%x1e%an%x1f%ae -- .`, false, LOG_CAPTURE)
  if (res.code !== 0) return []
  interface Acc {
    commits: number
    names: Map<string, number>
    email: string
  }
  const byFile = new Map<string, Map<string, Acc>>()
  for (const rec of res.output.split('\x1e')) {
    const lines = rec.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) continue // author line + at least one file
    const [name = '', email = ''] = lines[0].split('\x1f')
    const canon = (email || name).trim().toLowerCase()
    if (!canon) continue
    const dn = name.trim() || email.trim()
    for (const raw of lines.slice(1)) {
      const file = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
      let authors = byFile.get(file)
      if (!authors) {
        authors = new Map<string, Acc>()
        byFile.set(file, authors)
      }
      let acc = authors.get(canon)
      if (!acc) {
        acc = { commits: 0, names: new Map<string, number>(), email: email.trim().toLowerCase() }
        authors.set(canon, acc)
      }
      acc.commits += 1
      acc.names.set(dn, (acc.names.get(dn) ?? 0) + 1)
    }
  }
  const displayName = (names: Map<string, number>): string =>
    [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '—'
  return [...byFile.entries()].map(([file, authors]) => ({
    file,
    authors: [...authors.values()]
      .map((acc) => ({ name: displayName(acc.names), commits: acc.commits, email: acc.email || undefined }))
      .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
  }))
}

/** Roll file ownership up to directory owners (pure), deduping by identity (email). */
export function rollupOwners(files: FileOwnership[]): ModuleOwner[] {
  const byDir = new Map<string, Map<string, { commits: number; name: string; email?: string }>>()
  for (const f of files) {
    const dir = f.file.includes('/') ? f.file.slice(0, f.file.lastIndexOf('/')) : '.'
    let owners = byDir.get(dir)
    if (!owners) {
      owners = new Map<string, { commits: number; name: string; email?: string }>()
      byDir.set(dir, owners)
    }
    for (const a of f.authors) {
      const canon = (a.email ?? a.name).trim().toLowerCase()
      const cur = owners.get(canon)
      if (cur) cur.commits += a.commits
      else owners.set(canon, { commits: a.commits, name: a.name, email: a.email })
    }
  }
  return [...byDir.entries()]
    .map(([dir, m]) => ({
      dir,
      owners: [...m.values()].map((o) => ({ name: o.name, commits: o.commits, email: o.email }) as AuthorStat).sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * Cross-repo Knowledge Graph (zero-storage MVP): aggregate owners + churn hotspots across the
 * caller's list of project paths (the renderer's own recents — no new registry is persisted).
 * Reuses gitAuthorship + gitHotspots per repo, canonicalizes owners by lowercased email exactly
 * like the single-repo graph, and repo-qualifies every hotspot path so same-named files across
 * repos never collide. Bounded: paths are deduped by root, pruned to those that exist, and
 * capped; each repo's git log is a smaller sample. Non-git / empty paths contribute nothing.
 */
export async function crossRepoGraph(
  paths: string[],
  opts?: { maxRepos?: number; perRepoLimit?: number; topHotspots?: number }
): Promise<CrossRepoGraph> {
  const maxRepos = opts?.maxRepos ?? 12
  const perRepoLimit = opts?.perRepoLimit ?? 200
  const topHotspots = opts?.topHotspots ?? 15

  // Resolve each path to its git TOPLEVEL and dedupe by that — a non-git folder is skipped, and
  // two subfolders of one monorepo (or a dir + the same dir) collapse to a single repo.
  const seen = new Set<string>()
  const roots: string[] = []
  for (const p of paths) {
    const dir = (p || '').replace(/\/+$/, '')
    if (!dir || !existsSync(dir)) continue
    const top = await git(dir, 'rev-parse --show-toplevel')
    const root = top.code === 0 ? top.output.trim() : ''
    if (!root || seen.has(root)) continue
    seen.add(root)
    roots.push(root)
    if (roots.length >= maxRepos) break
  }

  const ownerMap = new Map<string, { name: string; email?: string; commits: number; repos: Set<string> }>()
  const hotspots: CrossRepoHotspot[] = []
  const usedRepos: string[] = []
  // Roots are already deduped by absolute toplevel; two DISTINCT repos may share a basename, so
  // disambiguate the display name (foo, foo~2) while keying repo identity off the unique root.
  const nameOf = new Map<string, string>()
  const nameCount = new Map<string, number>()
  for (const root of roots) {
    const base = basename(root)
    const n = (nameCount.get(base) ?? 0) + 1
    nameCount.set(base, n)
    nameOf.set(root, n === 1 ? base : `${base}~${n}`)
  }
  for (const root of roots) {
    const repoName = nameOf.get(root) as string
    const files = await gitAuthorship(root, perRepoLimit) // [] on a non-repo — harmless
    const spots = await gitHotspots(root, topHotspots)
    if (!files.length && !spots.length) continue
    usedRepos.push(repoName)
    for (const f of files)
      for (const a of f.authors) {
        const canon = (a.email ?? a.name).trim().toLowerCase()
        let cur = ownerMap.get(canon)
        if (!cur) ownerMap.set(canon, (cur = { name: a.name, email: a.email, commits: 0, repos: new Set() }))
        cur.commits += a.commits
        cur.repos.add(root) // count by unique ROOT, not name — same-basename repos stay distinct
      }
    for (const s of spots) hotspots.push({ file: `${repoName}/${s.file}`, repo: repoName, commits: s.commits, churn: s.churn })
  }

  const owners = [...ownerMap.values()]
    .map((o) => ({ name: o.name, email: o.email, commits: o.commits, repos: o.repos.size }))
    .sort((a, b) => b.commits - a.commits || b.repos - a.repos || a.name.localeCompare(b.name))
  const topSpots = hotspots.sort((a, b) => b.churn - a.churn || b.commits - a.commits).slice(0, topHotspots)
  return { repos: usedRepos, owners, hotspots: topSpots }
}
