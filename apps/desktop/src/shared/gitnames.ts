/**
 * What may name a repository on a git server.
 *
 * This lives in `shared` because BOTH sides need the same answer: the main process
 * validates before it builds a path that reaches a shell, and the renderer validates
 * so an obviously-bad name never costs a round trip. Two copies of a
 * security-relevant rule drift; this is one copy.
 *
 * The renderer's check is a convenience ONLY. The main process re-validates every
 * time — a renderer is not a trust boundary.
 *
 * `.` and `..` match the character class, so they are excluded by name. `.lock` is
 * excluded because git refuses those itself.
 */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

export function validRepoName(name: string): boolean {
  if (!REPO_NAME_RE.test(name)) return false
  if (name === '.' || name === '..') return false
  if (name.endsWith('.lock')) return false
  return true
}

/** Why a name was rejected, in words a user can act on. Null when the name is fine. */
export function repoNameError(name: string): string | null {
  if (!name.trim()) return 'Give the repository a name.'
  if (name.length > 64) return 'Use 64 characters or fewer.'
  if (name === '.' || name === '..') return 'That name is reserved.'
  if (name.endsWith('.lock')) return 'A name cannot end in .lock.'
  if (!REPO_NAME_RE.test(name)) return 'Use letters, numbers, dot, dash or underscore only.'
  return null
}
