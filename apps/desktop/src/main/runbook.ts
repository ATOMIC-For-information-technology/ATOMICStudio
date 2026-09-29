import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectBrain } from './index-service'
import { dependencyAudit } from './dependency'
import { audit } from './audit'
import { buildRunbook, type Runbook } from '../shared/runbook'

/** Harvest projectBrain + package.json scripts + Dependency Health + .env presence, then fold to
 * a Runbook. All signals already exist; this is a pure gatherer + one buildRunbook() call. */
export async function runbook(root: string): Promise<Runbook> {
  const brain = await projectBrain(root)
  const dep = dependencyAudit(root)

  // A package.json that EXISTS but won't parse is still a JS app (with a broken manifest) — don't
  // misdiagnose it as a static/unknown project just because JSON.parse threw.
  const hasPackageJson = existsSync(join(root, 'package.json'))
  let scripts: Record<string, string> = {}
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: unknown }
    if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts as Record<string, string>
  } catch {
    /* broken/absent manifest → no scripts, but hasPackageJson already reflects presence */
  }

  const phantomPackages = dep.findings.filter((f) => f.kind === 'phantom').map((f) => f.package)
  const missingEnv = brain.envVars.filter((v) => v.referenced && !v.declared).map((v) => v.name) // NAMES only
  const dbModels = brain.dbSchema.reduce((n, s) => n + s.models.length, 0)

  // Python signals (only meaningful when there's no package.json — Node stays primary).
  const hasRequirementsTxt = existsSync(join(root, 'requirements.txt'))
  const hasPyproject = existsSync(join(root, 'pyproject.toml'))
  const pythonEntry = ['manage.py', 'app.py', 'main.py', 'wsgi.py', 'asgi.py'].find((f) => existsSync(join(root, f)))
  const pythonPackageManager = brain.stack.packageManagers.includes('poetry') ? 'poetry' : 'pip'

  audit('runbook', root)
  return buildRunbook({
    packageManager: brain.stack.packageManagers[0] || 'npm',
    hasPackageJson,
    hasLockfile: dep.hasLockfile,
    scripts,
    phantomPackages,
    missingEnv,
    hasEnvFile: existsSync(join(root, '.env')),
    hasEnvExample: existsSync(join(root, '.env.example')) || existsSync(join(root, '.env.sample')),
    dbModels,
    isStaticHtml: !hasPackageJson && existsSync(join(root, 'index.html')),
    partial: brain.partial,
    hasRequirementsTxt,
    hasPyproject,
    pythonPackageManager,
    pythonEntry,
    pythonFrameworks: brain.stack.frameworks.filter((f) => /django|flask|fastapi/i.test(f))
  })
}
