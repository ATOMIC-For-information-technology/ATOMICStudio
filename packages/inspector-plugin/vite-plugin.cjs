/**
 * Vite plugin wrapper for the source-stamping Babel plugin.
 *
 * Runs with enforce:'pre' so it stamps JSX/TSX BEFORE the project's own React
 * plugin compiles it. It only ADDS data-canvas-* attributes and re-emits JSX
 * (types preserved), so the project's normal transform still runs afterward.
 * Dev-only; injected by ATOMIC Studio when it launches a project's dev server —
 * the project's own files are never modified.
 */
const babel = require('@babel/core')
const stampPlugin = require('./babel-plugin.cjs')

module.exports = function inspectorVitePlugin(opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd()
  return {
    name: 'atomic-studio-inspector',
    enforce: 'pre',
    apply: 'serve', // dev only
    async transform(code, id) {
      const clean = id.split('?')[0]
      if (!/\.[jt]sx$/.test(clean)) return null
      if (clean.includes('node_modules')) return null
      try {
        const result = await babel.transformAsync(code, {
          filename: clean,
          babelrc: false,
          configFile: false,
          sourceMaps: true,
          retainLines: true,
          parserOpts: { plugins: ['jsx', 'typescript'] },
          generatorOpts: { retainLines: true },
          plugins: [[stampPlugin, { projectRoot }]]
        })
        if (!result || !result.code) return null
        return { code: result.code, map: result.map }
      } catch {
        // If our pre-transform ever fails, fall through to the project's own transform untouched.
        return null
      }
    }
  }
}
