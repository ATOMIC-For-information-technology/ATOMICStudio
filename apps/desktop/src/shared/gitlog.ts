/**
 * Parse the machine-readable `git log` stream into commits.
 *
 * WHY A RECORD SEPARATOR AND NOT LINES. The previous reader (`gitTimeline`) split its output on
 * newlines, which is why it could never carry a commit BODY: a body is the one field that routinely
 * contains newlines, so a line-oriented parser cannot tell "the rest of this commit" from "the next
 * commit". `%x01` starts each record and `%x1f` separates the fields inside it — two control
 * characters git never emits from its own formatting — so a body can hold anything, including blank
 * lines, bullet lists, and a diff someone pasted into their message.
 *
 * Pure and IO-free: it typechecks under both tsconfigs, and the headless suite feeds it raw fixtures
 * directly. That is the only way to test the awkward cases — a root commit with no parents, a merge
 * with two, a body containing the separator itself — without building a repository for each one.
 */

import type { GitCommitInfo } from './types'

/** Starts a record. */
export const REC = '\u0001'
/** Separates fields within a record. */
export const FIELD = '\u001f'

/**
 * The `--pretty=format:` string this parser expects, kept beside the parser that reads it so the two
 * cannot drift: every field is positional, and reordering one without the other would mis-assign
 * every commit silently rather than fail.
 *
 * %H full hash · %h abbreviated · %P parents · %an author name · %ae author email
 * %at author timestamp · %D ref names · %s subject · %b body   (body LAST, because it runs on)
 */
export const LOG_FORMAT =
  `${REC}%H${FIELD}%h${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%D${FIELD}%s${FIELD}%b`

/** Number of fields before the body. The body absorbs everything after them. */
const BODY_AT = 8

export function parseGitLog(raw: string): GitCommitInfo[] {
  const out: GitCommitInfo[] = []
  for (const record of raw.split(REC)) {
    // The stream opens with a separator, so the first chunk is always empty.
    if (record.length === 0) continue
    const parts = record.split(FIELD)
    if (parts.length <= BODY_AT) continue

    const [hash, short, parents, author, email, at, refs, subject] = parts
    // A commit message really can contain \x1f — rare, but a paste of binary-ish text will do it.
    // Re-joining everything past the fixed fields keeps such a body intact rather than truncating it
    // at the first stray byte.
    const body = parts.slice(BODY_AT).join(FIELD)

    // A record whose first field is not a full object id means the format and this parser have
    // drifted. Skip it rather than emit a commit that cannot be addressed.
    if (!/^[0-9a-f]{40}$/i.test(hash)) continue

    out.push({
      hash,
      short,
      parents: parents.length > 0 ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      ts: (parseInt(at, 10) || 0) * 1000,
      // `%D` is "HEAD -> main, origin/main, tag: v1.0". Split on the comma git puts between them;
      // the arrow and the `tag:` prefix are kept, because they are the distinction a reader wants.
      refs: refs.length > 0 ? refs.split(', ').map((r) => r.trim()).filter(Boolean) : [],
      subject,
      // git emits a trailing newline after the body; the body's own blank lines stay.
      body: body.replace(/\n+$/, '')
    })
  }
  return out
}
