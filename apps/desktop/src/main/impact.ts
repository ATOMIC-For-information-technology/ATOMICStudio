import { architectureMap } from './index-service'
import type { BlastRadius, ConfigAdvisory } from '../shared/types'

/**
 * Blast Radius — the missing counterpart to the AI Confidence Meter. Confidence says HOW CAREFUL
 * the AI was; Blast Radius says HOW LOAD-BEARING the place it touched is, at the one irreversible
 * moment (Apply). It rides the existing import graph (architectureMap): the more files that
 * depend on a staged file — directly and one hop further — the higher the risk if it breaks.
 * Advisory only: it never blocks or delays Apply.
 */
export function blastRadius(root: string, paths: string[]): Record<string, BlastRadius> {
  const map = architectureMap(root)
  // Reverse adjacency: file → the SET of files that import it (a Set so importing the same target
  // via two import statements counts the dependent once, not twice).
  const importers = new Map<string, Set<string>>()
  for (const e of map.edges) {
    let s = importers.get(e.to)
    if (!s) importers.set(e.to, (s = new Set()))
    s.add(e.from)
  }
  const entries = new Set(map.nodes.filter((n) => n.isEntry).map((n) => n.path))
  const known = new Set(map.nodes.map((n) => n.path))
  const graphCapped = map.edges.length >= 2000 // mirror architectureMap's edge cap
  const out: Record<string, BlastRadius> = {}

  for (const p of paths) {
    const direct = [...(importers.get(p) ?? [])]
    // Bounded 2-hop: dependents + who imports THEM. Dedup so a shared importer counts once.
    const reachSet = new Set<string>(direct)
    for (const d of direct) for (const d2 of importers.get(d) ?? []) reachSet.add(d2)
    reachSet.delete(p) // never count the file itself
    const isEntry = entries.has(p)
    const dependents = direct.length
    const reach = reachSet.size
    // A brand-new / unindexed staged file isn't in the graph yet → its reach is unknown, not 0.
    const indexed = known.has(p) || importers.has(p)
    const partial = graphCapped || !indexed

    let band: BlastRadius['band']
    if (isEntry || reach >= 8) band = 'high'
    else if (reach >= 3) band = 'medium'
    else band = 'low'

    let summary: string
    if (!indexed) {
      band = 'low'
      summary = 'New or not-yet-indexed file — blast radius unknown. Nothing depends on it yet.'
    } else if (isEntry) {
      summary = 'This is an entry point — the app starts here, so a break is felt everywhere. Review carefully.'
    } else if (band === 'high') {
      summary = `${reach} parts of your app rely on this file — if it breaks, they break too. Review carefully.`
    } else if (band === 'medium') {
      summary = `${dependents} file${dependents === 1 ? '' : 's'} import this — a few things depend on it.`
    } else if (partial) {
      // The graph hit its size cap, so importer edges for this file may have been dropped — the
      // count is a FLOOR, never a clean bill of health. Don't reassure on an incomplete graph.
      summary = 'This project is large, so its dependency map is incomplete — the true blast radius may be higher. Review carefully.'
    } else {
      summary = 'Few or no other files depend on this — low blast radius.'
    }

    out[p] = { dependents, reach, isEntry, band, summary, partial }
  }
  return out
}

/**
 * Wiring/Config Guard — the blind spot Blast Radius can't see. The riskiest files to overwrite (your
 * secrets file, your dependency list, your deploy/CI config) usually have NOTHING importing them, so
 * they read as "low impact" today. This is a pure, curated matcher over a short set of well-known
 * plumbing files by basename/segment — no graph, no I/O. Advisory only; never blocks Apply.
 */
const CONFIG_MATCHERS: { test: (base: string, rel: string) => boolean; label: string; why: string }[] = [
  { test: (b) => b === '.env' || (b.startsWith('.env.') && !/\.(example|sample|template)$/.test(b)), label: 'secrets file', why: 'This is where your passwords and API keys live — rewriting it can break logins or leak secrets.' },
  { test: (b) => b === 'package.json', label: 'dependency list', why: "This lists the app's libraries and scripts — a wrong edit can stop it installing or starting." },
  { test: (b) => b === 'package-lock.json' || b === 'yarn.lock' || b === 'pnpm-lock.yaml' || b === 'npm-shrinkwrap.json' || b === 'bun.lockb', label: 'lockfile', why: 'This pins exact library versions — hand-editing it can produce a broken or inconsistent install.' },
  { test: (b, rel) => /(^|\/)\.github\/workflows\//.test(rel) || b === '.gitlab-ci.yml' || b === '.travis.yml' || b === 'azure-pipelines.yml', label: 'CI/deploy config', why: 'This controls how your app builds and deploys automatically — a mistake here can break releases.' },
  { test: (b) => b === 'dockerfile' || b.startsWith('dockerfile.') || b === 'docker-compose.yml' || b === 'docker-compose.yaml' || b === 'compose.yml' || b === 'compose.yaml', label: 'container config', why: 'This defines how your app is packaged and run in containers — changes can break the running environment.' },
  { test: (b) => /^tsconfig(\.\w+)?\.json$/.test(b) || /^(electron\.)?(vite|vitest)\.config\.[mc]?[jt]s$/.test(b) || /^(next|nuxt|svelte|astro|remix|rollup|webpack|esbuild|tailwind|postcss|babel)\.config\.[mc]?[jt]s$/.test(b), label: 'build config', why: "This configures how the code is compiled/bundled — a wrong edit can stop the build." },
  // DB migrations ONLY on known ORM/DB layouts (or a .sql file under a migrations dir) — NOT any folder
  // literally named "migrations" (e.g. an account/data-migration UI is ordinary code, not a schema change).
  { test: (b, rel) => /(^|\/)(prisma|supabase)\/migrations\//.test(rel) || /(^|\/)db\/migrate\//.test(rel) || /(^|\/)alembic\/versions\//.test(rel) || (/(^|\/)migrations?\//.test(rel) && /\.sql$/.test(b)) || b === 'schema.prisma', label: 'database migration', why: 'This changes your database structure — editing it can corrupt or lose data. Review very carefully.' }
]

export function configAdvisory(paths: string[]): Record<string, ConfigAdvisory> {
  const out: Record<string, ConfigAdvisory> = {}
  for (const p of paths) {
    const rel = p.replace(/\\/g, '/')
    const base = (rel.split('/').pop() ?? '').toLowerCase()
    const hit = CONFIG_MATCHERS.find((m) => m.test(base, rel.toLowerCase()))
    out[p] = hit ? { sensitive: true, label: hit.label, why: hit.why } : { sensitive: false, label: '', why: '' }
  }
  return out
}
