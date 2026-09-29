const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const desktopRoot = resolve(__dirname, '..')
const source = join(desktopRoot, 'src', 'renderer', 'out')
const target = join(desktopRoot, 'out', 'renderer')

if (!existsSync(join(source, 'index.html'))) {
  throw new Error(`Next.js export is missing: ${join(source, 'index.html')}`)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
