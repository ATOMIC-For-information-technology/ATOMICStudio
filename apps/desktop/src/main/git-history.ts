import { gitArgv, LOG_CAPTURE } from './git-exec'
import { parseGitLog, LOG_FORMAT } from '../shared/gitlog'
import { validRef, validRepoPath, safeArg } from '../shared/gitref'
import type { GitLogPage, GitLogQuery } from '../shared/types'

/**
 * Paged history.
 *
 * Replaces `gitTimeline`'s fixed `log -n 30`, which was not a page but a ceiling: no way to ask for
 * the next thirty, no search, no parents for a graph, and no body — the History section could show a
 * commit and then had nowhere to go. Everything here runs through `gitArgv`, so no part of a user's
 * query is ever parsed by a shell, and every value they supply is validated by `shared/gitref.ts`
 * first, because an argv array still lets a leading `-` be read as an option.
 */

/** A renderer cannot ask for the whole repository. */
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

export async function gitLog(projectPath: string, q: GitLogQuery = {}): Promise<GitLogPage> {
  const limit = Math.min(Math.max(Math.floor(q.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const skip = Math.max(Math.floor(q.skip ?? 0), 0)

  const argv = [
    'log',
    '--no-color',
    '--date-order',
    '--decorate=short',
    `--skip=${skip}`,
    // Ask for ONE more than the page. If it arrives there is a next page; if it does not, this is
    // the end. That is one process, where a separate `rev-list --count` would be a second one and
    // could still disagree with this page under a concurrent commit.
    '-n', String(limit + 1),
    `--pretty=format:${LOG_FORMAT}`
  ]

  // Free text becomes the VALUE half of one `--flag=value` argv element, so a term beginning with
  // `-` cannot present itself as a separate option. `--fixed-strings` matters for more than
  // correctness: an unanchored regex from a search box is a denial of service against a big history.
  const grep = q.grep ? safeArg(q.grep) : null
  if (grep) argv.push(`--grep=${grep}`, '--fixed-strings', '--regexp-ignore-case')

  const author = q.author ? safeArg(q.author) : null
  if (author) argv.push(`--author=${author}`)

  // `-S` takes its value attached, and `--pickaxe-regex` is deliberately NOT set, so this stays a
  // literal-string search for the same reason `--fixed-strings` is used above.
  const pickaxe = q.pickaxe ? safeArg(q.pickaxe) : null
  if (pickaxe) argv.push(`-S${pickaxe}`)

  // An invalid ref is DROPPED rather than passed through for git to reject: git would read
  // `--exec=…` as an option, not as a bad ref, which is precisely the argument-injection case.
  for (const r of q.refs ?? []) {
    if (validRef(r)) argv.push(r)
  }

  // The path goes last and after `--`, which is what makes a file named `-f` a path rather than a
  // flag. `--follow` needs exactly one pathspec, so it is added only when there is one.
  if (q.path && validRepoPath(q.path)) argv.push('--follow', '--', q.path)

  const res = await gitArgv(projectPath, argv, { cap: LOG_CAPTURE })
  // A repository with no commits yet exits non-zero ("does not have any commits yet"). That is an
  // empty history, not a failure, and the panel should say so rather than show an error.
  if (res.code !== 0) return { commits: [], nextSkip: null }

  const all = parseGitLog(res.output)
  const hasMore = all.length > limit
  return {
    commits: hasMore ? all.slice(0, limit) : all,
    // Truncated output means git had more to say than we would read, so this page is already a
    // floor. Offering "load more" from a cut-off page would skip whatever was dropped, so paging
    // stops here rather than quietly losing commits.
    nextSkip: hasMore && !res.truncated ? skip + limit : null
  }
}
