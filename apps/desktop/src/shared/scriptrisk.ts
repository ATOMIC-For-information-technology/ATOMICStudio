/**
 * Script-risk fold — reads a project shortcut BEFORE the AI is allowed to run it.
 *
 * The agent's safe-list lets it run `npm run <anything>` without asking, on the assumption that a
 * project's own scripts are build/test chores. On real projects one of those shortcuts is `deploy`
 * (publishes to a live site) or `db:reset` (wipes a database) — outcomes nothing in this app can undo.
 *
 * This judges the script's BODY, not its name, because both directions matter:
 *   - a script called `test` whose body is `prisma migrate reset --force` IS dangerous
 *   - a script called `deploy` whose body is `cp -r dist /tmp/x` is NOT
 *
 * Curated table, not a heuristic — the precedent set when typosquat detection moved off edit-distance
 * so real packages were never falsely accused. A command we didn't curate is a miss, never a false alarm;
 * there is deliberately no "all your scripts are safe" verdict for this to lie with.
 * PURE: strings in, verdict out. No I/O.
 */
export type ScriptRisk = 'safe' | 'risky' | 'unknown'

export interface ScriptVerdict {
  risk: ScriptRisk
  /** The chain we followed, e.g. ['ship', 'deploy'] when `ship` is `npm run deploy`. */
  chain: string[]
  /** The exact command text that triggered a refusal — shown to the user verbatim. */
  matched: string | null
  /** Plain English consequence: 'this publishes your app to a live website'. */
  why: string | null
  /** True when we had to judge by NAME because the scripts map was unreadable. */
  byNameOnly: boolean
}

/** Curated risky commands: [pattern, plain-English consequence]. Ordered most-specific first. */
const RISKY: [RegExp, string][] = [
  // `--prod` gets no leading \b — a boundary between a space and a dash never matches.
  [/\b(wrangler|vercel|netlify|firebase|surge|gh-pages)\b[^\n]*(?:\b(?:deploy|publish|release)\b|--prod\b)/i, 'this publishes your app to a live website'],
  [/\b(wrangler|vercel|netlify|firebase)\s+(pages\s+)?(deploy|publish)\b/i, 'this publishes your app to a live website'],
  [/\bprisma\s+migrate\s+reset\b/i, 'this ERASES everything in your database and rebuilds it empty'],
  [/\b(drizzle-kit\s+drop|sequelize\s+db:drop|knex\s+migrate:rollback\s+--all)\b/i, 'this destroys database tables'],
  [/\b(db|database):(reset|drop|wipe|nuke|destroy)\b/i, 'this erases your database'],
  [/\bmongo(sh)?\b[^\n]*\bdropDatabase\b/i, 'this erases a MongoDB database'],
  [/\bpsql\b[^\n]*\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, 'this drops a database table or schema'],
  // Two rm rules. The first is the catastrophic form (root, home, a bare variable). The second catches
  // ANY other recursive-force rm — `rm -rf *`, `rm -rf src` — except the two build outputs every project
  // deletes routinely. Narrowing this to only `/` previously let a script erase the project itself.
  [/\brm\s+-[a-z]*[rf][a-z]*\s+(?:-[a-z]+\s+)*(?:\/(?:\s|$|\*)|~|\$HOME|\$\{?\w+\}?\s*\/?(?:\s|$))/i, 'this force-deletes your home or system folders'],
  [/\brm\s+-[a-z]*[rf][a-z]*\s+(?:-[a-z]+\s+)*(?!(?:\.?\/)?(?:dist|build|out|coverage|node_modules|\.next|\.turbo|\.cache)\b)[\w.*/~$-]+/i, 'this force-deletes files that cannot be recovered'],
  [/\bgit\s+clean\b[^\n]*\s-[a-z]*f/i, 'this permanently deletes every file you have not backed up'],
  [/\bgit\s+reset\s+--hard\b/i, 'this throws away every change you have not backed up'],
  [/\bgit\s+(stash\s+clear|branch\s+-D)\b/i, 'this discards saved work'],
  [/\b(fly|flyctl)\s+(deploy|apps\s+destroy)\b/i, 'this publishes to or destroys a live Fly.io app'],
  [/\b(serverless|sls)\s+(deploy|remove)\b/i, 'this changes a live serverless deployment'],
  [/\b(cdk|pulumi)\s+(deploy|up|destroy)\b/i, 'this changes or destroys live cloud infrastructure'],
  [/\bgcloud\s+[\w-]+\s+deploy\b/i, 'this deploys to Google Cloud'],
  [/\baws\s+s3\s+(sync|rm)\b/i, 'this overwrites or deletes files in cloud storage'],
  [/\baws\s+(cloudformation|lambda|ecs)\s+(deploy|update|delete)/i, 'this changes live AWS infrastructure'],
  [/\b(railway|heroku|dokku)\b[^\n]*\b(up|deploy|push)\b/i, 'this publishes your app to a live host'],
  [/\bsupabase\s+db\s+(reset|push)\b/i, 'this resets or overwrites a live database'],
  [/\bprisma\s+db\s+push\b[^\n]*--force-reset/i, 'this force-resets your database'],
  [/\bgh\s+(release\s+create|repo\s+delete|workflow\s+run)\b/i, 'this publishes a release or triggers a live workflow'],
  [/\bgit\s+push\b[^\n]*(--force|-f)\b/i, 'this force-pushes and can erase work on the shared copy'],
  [/\bgit\s+push\b(?![^\n]*(?:--dry-run|-n\b))/i, 'this uploads your code to the shared copy on GitHub'],
  [/\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i, 'this publishes a package publicly to the npm registry'],
  [/\beas\s+(build|submit)\b/i, 'this spends build credits and can submit to an app store'],
  [/\b(kubectl|helm)\s+(apply|delete|upgrade|install)\b/i, 'this changes a live server cluster'],
  [/\bterraform\s+(apply|destroy)\b/i, 'this changes or destroys live cloud infrastructure'],
  [/\bdocker\s+(push|system\s+prune)\b/i, 'this publishes or prunes Docker data'],
  [/\bssh\b[^\n]*\b(rm|systemctl|pm2|rsync)\b/i, 'this runs commands on a remote server'],
  [/\brsync\b(?![^\n]*(?:--dry-run|\s-n\b))[^\n]*\s\S+@\S+:/i, 'this copies files onto a remote server'],
  [/\bpm2\s+(restart|reload|delete|stop)\b/i, 'this restarts or stops a live service'],
  [/\bcertbot\b|\bsystemctl\s+(restart|stop|disable)\b/i, 'this changes live server services']
]

/**
 * Tools that are unambiguously LOCAL build/test/lint work. Anything in this list is never treated as a
 * publish just because the word "deploy" or "release" appears in its arguments.
 */
const LOCAL_TOOLS =
  /^(?:npm|npx|pnpm|yarn|bun|node|deno|tsc|tsx|ts-node|vite|next|nuxt|astro|webpack|rollup|esbuild|parcel|swc|babel|jest|vitest|mocha|ava|cypress|playwright|eslint|prettier|biome|stylelint|rimraf|mkdir|cp|mv|echo|cd|set|cross-env|dotenv|env|concurrently|npm-run-all|run-s|run-p|wait-on|nodemon|tsup|turbo|nx|lerna|changeset|standard-version|semantic-release|husky|lint-staged|electron|electron-vite|electron-builder|expo|react-scripts|craco|ng|vue-cli-service|svelte-kit|remix|gatsby|hugo|jekyll|make|cmake|gradle|mvn|cargo|go|python3?|pip3?|poetry|uv|ruff|black|pytest)$/i

/**
 * SECOND TIER — the safety net for tools we never curated. The first-tier table names specific tools and
 * says exactly what they do; this catches the SHAPE of a publish/destroy performed by something we have
 * never heard of (a company's own CLI, a brand-new host). It deliberately returns 'unknown' — "I can't
 * vouch for this", not a confident claim — and it exempts the local build tools above so ordinary work
 * is untouched. Without it, an uncurated tool was simply a miss.
 */
const SUSPICIOUS_VERB = /(?:^|\s)(?:deploy|publish|release|destroy|teardown|drop-db|nuke)(?:\s|$)|--prod\b|--force-reset\b|--no-preserve-root\b/i

function suspiciousShape(body: string): string | null {
  for (const seg of body.split(/&&|\|\||;|\|/)) {
    const trimmed = seg.trim()
    if (!trimmed || !SUSPICIOUS_VERB.test(trimmed)) continue
    // The first word is the program being run. Skip env assignments to find it.
    const words = trimmed.split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w))
    const tool = (words[0] || '').split('/').pop() || ''
    if (!tool || LOCAL_TOOLS.test(tool)) continue
    return trimmed.slice(0, 120)
  }
  return null
}

/** Names that SOUND dangerous — used only when the body is unreadable, never to override a real body. */
const RISKY_NAME = /^(pre|post)?(deploy|publish|release|ship|prod|production|db:reset|db:drop|reset-db|migrate:reset|nuke|destroy)$/i

const MAX_DEPTH = 4

function matchBody(body: string): { matched: string; why: string } | null {
  for (const [re, why] of RISKY) {
    const m = re.exec(body)
    if (m) return { matched: m[0], why }
  }
  return null
}

/**
 * Classify `npm run <name>` for a project whose package.json scripts are `scripts`.
 *
 * - `scripts === null` (unreadable/absent package.json) ⇒ judge by name only, and SAY so via byNameOnly.
 * - a name that isn't declared ⇒ `safe`: `npm run nope` just errors with "Missing script".
 * - `pre<name>` / `post<name>` are classified too — npm runs them, so a `postbuild: wrangler deploy`
 *   would otherwise sneak through a plain `npm run build`.
 * - a body that is itself `npm run <other>` is followed, depth-capped with a cycle guard.
 */
export function classifyScript(
  name: string,
  scripts: Record<string, string> | null,
  opts?: {
    maxDepth?: number
    /**
     * Read a project file the script hands off to (`node scripts/build.js`). Supplied by the main
     * process, which has fs + the project root. Returning null means "can't read it" — only THEN do we
     * fall back to refusing, so an ordinary build that we could have vetted is not blocked.
     */
    readFile?: (relPath: string) => string | null
  }
): ScriptVerdict {
  const clean = (name || '').trim()
  if (!clean) return { risk: 'safe', chain: [], matched: null, why: null, byNameOnly: false }

  if (scripts === null) {
    // We could not read the project's scripts. Judge the NAME, and be explicit that we're guessing.
    const risky = RISKY_NAME.test(clean)
    return {
      risk: risky ? 'risky' : 'unknown',
      chain: [clean],
      matched: risky ? clean : null,
      why: risky ? `a script named “${clean}” usually publishes or resets something live` : null,
      byNameOnly: true
    }
  }

  const maxDepth = opts?.maxDepth ?? MAX_DEPTH
  const seen = new Set<string>()
  const chain: string[] = []

  let truncated = false
  let truncatedBy: string | null = null
  let suspect: string | null = null
  const visit = (n: string, depth: number): ScriptVerdict | null => {
    if (seen.has(n)) return null // already walked this one — a cycle, not new information
    if (depth > maxDepth) {
      truncated = true // we stopped early: we do NOT know this chain is safe
      return null
    }
    seen.add(n)
    chain.push(n)
    // npm runs pre<name> and post<name> around the script itself — all three count.
    for (const key of [`pre${n}`, n, `post${n}`]) {
      const body = scripts[key]
      if (typeof body !== 'string' || !body.trim()) continue
      const hit = matchBody(body)
      if (hit) return { risk: 'risky', chain: [...chain], matched: hit.matched, why: hit.why, byNameOnly: false }
      // Not on the curated list, but it LOOKS like a publish/destroy by a tool we don't know.
      const shape = suspiciousShape(body)
      if (shape && !suspect) {
        suspect = shape
      }
      // A body that hands off to a FILE (node x.js, bash deploy.sh) is opaque to us — we cannot see what
      // it does, so we must not call the chain safe.
      // A body that hands off to a FILE. Try to READ it — the guard already has the project root, so
      // refusing outright would block ordinary `node scripts/build.js` builds it could have vetted.
      // Flags are skipped (`node --test` hands off to nothing), and leading VAR=value / wrapper
      // prefixes (cross-env, dotenv, npx …) are allowed before the runner, or they hid real deploys.
      for (const hm of body.matchAll(
        /(?:^|[;&|]|&&)\s*(?:(?:[A-Z_][A-Z0-9_]*=\S*|cross-env|dotenv|env|npx|concurrently|--)\s+)*(?:node|bash|sh|zsh|ts-node|tsx|python3?|deno)\s+(?:-\S+\s+)*([\w./-]+)|(?:^|[;&|]|&&)\s*(\.\/[\w./-]+)/g
      )) {
        const target = hm[1] || hm[2]
        if (!target || target.startsWith('-')) continue
        const src = opts?.readFile ? opts.readFile(target) : null
        if (src === null) {
          truncated = true // genuinely can't read it → honest "I can't tell", never a false "safe"
          truncatedBy = truncatedBy ?? target
          continue
        }
        const fileVerdict = classifyFileBody(target, src)
        if (fileVerdict.risk === 'risky') return { ...fileVerdict, chain: [...chain, target] }
      }
      // Follow indirection: npm/pnpm/bun run X, yarn X, yarn run X, and the run-s/run-p/npm-run-all
      // aggregators. The old `(?!run\b)` guard on yarn wrongly skipped `yarn run deploy` entirely.
      for (const m of body.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)|\b(?:yarn|pnpm|bun)\s+(?!run\b|add\b|install\b|remove\b|-)([\w:.-]+)|\b(?:run-s|run-p|npm-run-all)\s+([\w:.\- ]+)/g)) {
        const raw = m[1] || m[2] || m[3]
        if (!raw) continue
        for (const next of raw.trim().split(/\s+/)) {
          if (!next) continue
          const d2 = visit(next, depth + 1)
          if (d2) return d2
        }
        continue
      }
    }
    return null
  }

  const found = visit(clean, 1)
  if (found) return found
  // We stopped before seeing everything (too deep, or the script hands off to a file we can't read).
  // That is "I couldn't tell", NOT "safe" — failing open here is how a deploy sneaks through.
  if (truncated) {
    return {
      risk: 'unknown',
      chain: chain.length ? chain : [clean],
      // Name the actual thing we couldn't read — "something" leaves a non-coder with no next step.
      matched: truncatedBy,
      why: truncatedBy
        ? `this shortcut runs ${truncatedBy}, which I couldn't read, so I can't tell what it does`
        : "this shortcut chains through more steps than I can follow, so I can't tell what it does",
      byNameOnly: false
    }
  }
  if (suspect) {
    return {
      risk: 'unknown',
      chain: chain.length ? chain : [clean],
      matched: suspect,
      why: "this looks like it publishes or destroys something, but it uses a tool I don't recognise, so I can't be sure",
      byNameOnly: false
    }
  }
  // Declared-and-clean, or not declared at all (npm would just error) — both are safe to run.
  return { risk: 'safe', chain: chain.length ? chain : [clean], matched: null, why: null, byNameOnly: false }
}

/**
 * Same curated judgement, applied to a FILE's contents rather than a package.json entry — for
 * `node deploy.js`, which the agent's safe list also allows. Reuses matchBody so the table and the
 * plain-English reasons stay in exactly one place.
 */
/**
 * Byte ranges covered by string literals, template literals and comments. An `execSync('wrangler …')`
 * written INSIDE another string is a fixture, not a command — this repo's own test suite writes exactly
 * that, and scanning it blindly refused `node scripts/test-agent.cjs` as "this publishes your app".
 */
function maskedRanges(src: string): [number, number][] {
  const out: [number, number][] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      out.push([i, end === -1 ? src.length : end])
      i = end === -1 ? src.length : end
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      out.push([i, end === -1 ? src.length : end + 2])
      i = end === -1 ? src.length : end + 2
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length) {
        if (src[j] === '\\') j += 2
        else if (src[j] === c) break
        else j++
      }
      out.push([i, Math.min(j + 1, src.length)])
      i = j + 1
    } else i++
  }
  return out
}

const insideMask = (ranges: [number, number][], idx: number): boolean =>
  ranges.some(([a, b]) => idx > a && idx < b)

export function classifyFileBody(fileName: string, source: string): ScriptVerdict {
  // Scan only what the file would actually EXECUTE, not its whole text. Running the shell-command table
  // over entire source files refuses far too much — this repo's own test suite mentions `git push` in
  // string fixtures and would be blocked. A shell script has no such wrapper, so scan it whole.
  const isShell = /\.(sh|bash|zsh)$/i.test(fileName)
  const targets: string[] = []
  if (isShell) {
    targets.push(source)
  } else {
    // Command strings handed to child_process (exec/execSync/spawn/spawnSync/fork) or a zx-style $`...`.
    const masked = maskedRanges(source)
    for (const m of source.matchAll(/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(\s*(['"`])([\s\S]*?)\1/g)) {
      // The CALLEE must be real code. (The argument is a string by definition — that's fine.)
      if (m.index !== undefined && insideMask(masked, m.index)) continue
      targets.push(m[2])
    }
    for (const m of source.matchAll(/\$`([\s\S]*?)`/g)) {
      if (m.index !== undefined && insideMask(masked, m.index)) continue
      targets.push(m[1])
    }
  }
  for (const t of targets) {
    const hit = matchBody(t)
    if (hit) return { risk: 'risky', chain: [fileName], matched: hit.matched, why: hit.why, byNameOnly: false }
  }
  return { risk: 'safe', chain: [fileName], matched: null, why: null, byNameOnly: false }
}

/**
 * The refusal sentence shown to the user. It must match the verdict it is describing: a 'risky' verdict
 * knows what the command does, an 'unknown' verdict explicitly does NOT — telling the user "it looks
 * like it changes something live" for an unknown would be inventing a reason we never had.
 */
export function scriptRefusal(v: ScriptVerdict): string {
  const via = v.chain.length > 1 ? ` (via ${v.chain.join(' → ')})` : ''
  const runIt = ' If you know it is safe, run it yourself in the Terminal panel.'
  if (v.risk === 'unknown') {
    const because = v.why ?? "I couldn't read this project's shortcuts, so I have no way to check what it does"
    return `I did not run this${via} because ${because}.${runIt}`
  }
  const guess = v.byNameOnly ? " I couldn't read this project's package.json, so I judged it by name." : ''
  return `I did not run this${via} because ${v.why ?? 'it looks like it changes something live'} — the command is: ${v.matched ?? v.chain[0]}.${guess}${runIt}`
}

