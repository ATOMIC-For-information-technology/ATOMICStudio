/**
 * Babel plugin: stamp source location onto host JSX elements.
 *
 * For every host element (lowercase tag → real DOM node) it adds:
 *   data-canvas-file="<path relative to project root>"
 *   data-canvas-line="<line>"
 *   data-canvas-name="<tag>"
 *
 * The live-preview bridge reads the nearest of these off a clicked DOM node to
 * map the click back to the exact source line — the technique used by
 * react-dev-inspector / Onlook. Dev-only; never enable in production builds.
 */
const { relative, isAbsolute } = require('path')

const ATTR_FILE = 'data-canvas-file'
const ATTR_LINE = 'data-canvas-line'
const ATTR_NAME = 'data-canvas-name'

module.exports = function inspectorBabelPlugin({ types: t }) {
  return {
    name: 'atomic-studio-inspector',
    visitor: {
      JSXOpeningElement(path, state) {
        const nameNode = path.node.name
        // Only stamp host elements: a plain lowercase JSXIdentifier (div, button…).
        if (nameNode.type !== 'JSXIdentifier') return
        const tag = nameNode.name
        if (!/^[a-z]/.test(tag)) return // components (uppercase) don't render their own DOM node
        if (tag === 'Fragment') return

        // Skip if we've already stamped this element.
        const already = path.node.attributes.some(
          (a) => a.type === 'JSXAttribute' && a.name && a.name.name === ATTR_FILE
        )
        if (already) return

        const loc = path.node.loc || nameNode.loc
        if (!loc) return

        const root = state.opts.projectRoot || state.file.opts.root || process.cwd()
        let file = state.filename || state.file.opts.filename || ''
        if (file && isAbsolute(file) && root) file = relative(root, file)

        const mk = (key, value) =>
          t.jsxAttribute(t.jsxIdentifier(key), t.stringLiteral(String(value)))

        path.node.attributes.push(
          mk(ATTR_FILE, file),
          mk(ATTR_LINE, loc.start.line),
          mk(ATTR_NAME, tag)
        )
      }
    }
  }
}
