/**
 * What we are willing to hand to `git` as a ref, a path, or a free-text value.
 *
 * WHY THIS EXISTS, AND WHY IT IS SEPARATE FROM `gitArgv`. An argv array closes SHELL injection —
 * no parser sees the string, so `$(...)`, backticks and `;` are just characters. It does NOT close
 * ARGUMENT injection: `git log -o/tmp/x` is one argv element, perfectly shell-safe, and still an
 * option. Anything a user, a server or a config file supplies can therefore still steer git by
 * starting with `-`, which is exactly the hole `git-core.ts`'s `isSafeGitUrl` was added to close
 * after `--upload-pack=` turned a clone URL into remote command execution. Every value validated
 * here is one of those; the two defences are complementary and both are required.
 *
 * Deliberately STRICTER than `git check-ref-format`. This is an injection guard first and a
 * validity check second: refusing a legal-but-exotic ref costs a user one rename, while accepting
 * an argument-shaped one costs considerably more. Where the two disagree, this file wins.
 *
 * Pure and IO-free on purpose — it typechecks under both tsconfigs (no `electron`, no DOM, no Node),
 * so the main process, the renderer and the headless suite all enforce one definition rather than
 * three that drift. `git-exec.ts` already carried `isSafeRef`/`isSafeRelPath` for the shell-string
 * runner; those stay for their existing callers, and everything new uses these.
 */

/** Longest ref we will accept. git's own limit is the filesystem's; this is a sanity bound. */
const MAX_REF = 256
/** Longest project-relative path. Matches `git-exec.ts`'s existing `isSafeRelPath`. */
const MAX_PATH = 400
/** Longest free-text argument (a search term, a stash message). */
const MAX_ARG = 1000

/** C0 controls, DEL, and NUL — none can appear in a ref, a path, or an argument we build. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The allowed ref alphabet. An ALLOW-list, not a deny-list: every character git treats specially
 * (`~` `^` `:` `?` `*` `[` `\` space) and every character a shell would treat specially is absent
 * by construction, so a character class nobody thought of cannot leak through. `@` is excluded too,
 * which removes the whole `@{...}` reflog and upstream syntax — `HEAD@{1}` is a query, not a ref,
 * and a caller that wants one should say so explicitly rather than smuggle it through a name.
 */
const REF_CHARS = /^[A-Za-z0-9._/-]+$/

/**
 * A ref name we will pass to git.
 *
 * Accepts branch and tag names, `HEAD`, and abbreviated or full object ids. Refuses, in order: an
 * empty or over-long name; anything starting with `-` (the argument-injection case — `-o`, `--exec`,
 * `--upload-pack=...`); any character outside the allow-list; and then the structural rules git
 * itself enforces, because a name git would reject at use time is better refused here, where the
 * message can be ours.
 */
export function validRef(s: string): boolean {
  if (typeof s !== 'string') return false
  if (s.length === 0 || s.length > MAX_REF) return false
  // Argument injection. Checked before the alphabet so the intent is unmissable: `-` IS in the
  // allow-list (refs like `my-branch` need it) and is forbidden only in the leading position.
  if (s.startsWith('-')) return false
  if (CONTROL.test(s)) return false
  if (!REF_CHARS.test(s)) return false

  // `..` is a range operator (`main..feature`), not part of a name. A ref containing it would
  // silently mean something other than the single ref the caller intended.
  if (s.includes('..')) return false
  // `@{` cannot occur — `@` is outside the allow-list — but the rule is stated so that widening
  // REF_CHARS later cannot quietly re-admit reflog syntax.
  if (s.includes('@{')) return false
  // git refuses a ref whose final component ends in `.lock`: it would collide with the lock file
  // git writes when updating that very ref.
  if (s.endsWith('.lock') || s.includes('.lock/')) return false

  // Structural: no leading or trailing `/`, no empty component, no component starting or ending
  // with `.`. These are git's own check-ref-format rules, and they also rule out `.` and `..` as
  // whole components, which is a second line of defence on traversal.
  if (s.startsWith('/') || s.endsWith('/') || s.includes('//')) return false
  if (s.endsWith('.')) return false
  for (const part of s.split('/')) {
    if (part.length === 0) return false
    if (part.startsWith('.') || part.endsWith('.')) return false
  }
  return true
}

/**
 * A project-relative path we will pass to git, ALWAYS after a `--` end-of-options separator.
 *
 * That separator is the caller's job and is not optional: `--` is what makes a file named `-f`
 * unambiguous to git. This function refuses such a name anyway, because a defence that depends on
 * every future call site remembering one token is not a defence.
 *
 * Traversal and absolute paths are refused outright rather than normalised. Escaping the project is
 * a different failure from a malformed name — it reads or writes outside the folder the user opened
 * — and it is the same rule `fs-service.ts` applies to every path it resolves.
 */
export function validRepoPath(s: string): boolean {
  if (typeof s !== 'string') return false
  if (s.length === 0 || s.length > MAX_PATH) return false
  if (s.startsWith('-') || CONTROL.test(s)) return false

  // Absolute, in every spelling: POSIX root, a Windows drive (`C:\...`, `C:/...`), and a UNC or
  // root-relative backslash path. Checked before traversal so `/../etc` is refused as absolute.
  if (s.startsWith('/') || s.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(s)) return false

  // Traversal, by COMPONENT rather than by substring: a substring test on '..' also rejects the
  // perfectly ordinary `my..file.txt`, and a file named that is not a security problem. Both
  // separators are split on, because a Windows-style path can reach this from a config or a server.
  for (const part of s.split(/[/\\]/)) {
    if (part === '..') return false
  }
  return true
}

/**
 * Sanitise free text that becomes the VALUE of a git option — a `--grep` term, an `--author`
 * filter, a stash message. Returns the cleaned string, or null when nothing usable is left.
 *
 * A leading `-` is deliberately NOT rejected here: `-1 regression` is a legitimate stash message,
 * and refusing it would be a bug the user cannot work around. Safety comes from HOW the caller
 * passes it — always as the value half of a single `--flag=value` argv element, or after `--`, and
 * never as a bare positional where git would read it as an option. A caller that cannot guarantee
 * that should be using `validRef`/`validRepoPath` instead.
 *
 * NUL is stripped rather than rejected: it cannot survive the argv boundary at all (execve
 * terminates the string there, so it would silently truncate the argument into something the user
 * did not type), and a pasted search term is exactly where stray bytes turn up.
 */
export function safeArg(s: string): string | null {
  if (typeof s !== 'string') return null
  const cleaned = s.replace(/\u0000/g, '').trim()
  if (cleaned.length === 0) return null
  return cleaned.slice(0, MAX_ARG)
}
