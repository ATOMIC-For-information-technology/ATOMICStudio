/**
 * Angular Template Plugin for ATOMIC Studio Inspector.
 *
 * Stamps source location attributes onto Angular template elements:
 *   data-canvas-file="<path relative to project root>"
 *   data-canvas-line="<line>"
 *   data-canvas-name="<tag>"
 *
 * Supports both:
 * 1. External HTML templates (*.component.html)
 * 2. Inline templates inside TypeScript component definitions (*.component.ts, *.ts)
 *
 * Handles nested elements, custom component tags, structural directives (*ngIf, *ngFor, @if, @for),
 * event bindings ((click)="..."), property bindings, multi-line tags, and self-closing elements.
 * Dev-only; never enable in production.
 */
const { relative, isAbsolute } = require('path')

const ATTR_FILE = 'data-canvas-file'
const ATTR_LINE = 'data-canvas-line'
const ATTR_NAME = 'data-canvas-name'

/**
 * Calculate 1-based line number for a character index in a string.
 * @param {string} text
 * @param {number} index
 * @param {number} [lineOffset=0]
 * @returns {number}
 */
function getLineNumber(text, index, lineOffset = 0) {
  let line = 1 + lineOffset
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { // '\n'
      line++
    }
  }
  return line
}

/**
 * Normalise a file path relative to project root.
 * @param {string} file
 * @param {string} projectRoot
 * @returns {string}
 */
function normaliseFilePath(file, projectRoot) {
  if (!file) return ''
  let p = file.split('?')[0]
  if (isAbsolute(p) && projectRoot) {
    p = relative(projectRoot, p)
  }
  return p.replace(/\\/g, '/')
}

/**
 * Stamp HTML template content with data-canvas-* attributes.
 *
 * @param {string} html - HTML template string.
 * @param {string} filePath - Normalised relative file path.
 * @param {number} [lineOffset=0] - Starting line offset in the file (0-indexed offset before template).
 * @returns {string} - Stamped HTML template.
 */
function stampTemplateHtml(html, filePath, lineOffset = 0) {
  if (!html || typeof html !== 'string') return html

  let out = ''
  let i = 0
  const len = html.length

  while (i < len) {
    // 1. Skip HTML comments: <!-- ... -->
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      if (end === -1) {
        out += html.slice(i)
        break
      }
      out += html.slice(i, end + 3)
      i = end + 3
      continue
    }

    // 2. Skip Angular interpolations: {{ ... }}
    if (html.startsWith('{{', i)) {
      const end = html.indexOf('}}', i + 2)
      if (end === -1) {
        out += html.slice(i)
        break
      }
      out += html.slice(i, end + 2)
      i = end + 2
      continue
    }

    // 3. Skip closing tags: </tag>
    if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i + 2)
      if (end === -1) {
        out += html.slice(i)
        break
      }
      out += html.slice(i, end + 1)
      i = end + 1
      continue
    }

    // 4. Opening or self-closing tag: <tag ...>
    if (html.charCodeAt(i) === 60) { // '<'
      const nextChar = html.charAt(i + 1)
      // Must be a letter or Angular custom element start
      if (/^[a-zA-Z]/.test(nextChar)) {
        const tagStartIndex = i
        const line = getLineNumber(html, tagStartIndex, lineOffset)

        // Read tag name
        let nameEnd = i + 1
        while (nameEnd < len && /^[a-zA-Z0-9_-]/.test(html.charAt(nameEnd))) {
          nameEnd++
        }
        const tagName = html.slice(i + 1, nameEnd)
        const lowerName = tagName.toLowerCase()

        // Skip <script> and <style> entirely
        if (lowerName === 'script' || lowerName === 'style') {
          const closeTag = `</${tagName}>`
          const closeIdx = html.toLowerCase().indexOf(closeTag.toLowerCase(), nameEnd)
          if (closeIdx === -1) {
            out += html.slice(i)
            break
          }
          out += html.slice(i, closeIdx + closeTag.length)
          i = closeIdx + closeTag.length
          continue
        }

        // Scan through attributes until the end of the opening tag (> or />)
        let cursor = nameEnd
        let inQuote = null
        let tagEnd = -1

        while (cursor < len) {
          const c = html.charAt(cursor)

          if (inQuote) {
            if (c === inQuote) {
              inQuote = null
            }
          } else {
            if (c === '"' || c === "'") {
              inQuote = c
            } else if (c === '>') {
              tagEnd = cursor
              break
            }
          }
          cursor++
        }

        if (tagEnd !== -1) {
          const rawTag = html.slice(tagStartIndex, tagEnd + 1)

          // Skip if already stamped
          if (rawTag.includes(ATTR_FILE)) {
            out += rawTag
            i = tagEnd + 1
            continue
          }

          // Check if self-closing: ends with '/>'
          const isSelfClosing = html.charAt(tagEnd - 1) === '/'
          const insertPos = isSelfClosing ? tagEnd - 1 : tagEnd

          const beforeClose = html.slice(tagStartIndex, insertPos).trimEnd()
          const afterClose = html.slice(insertPos, tagEnd + 1)

          const stamp = ` ${ATTR_FILE}="${filePath}" ${ATTR_LINE}="${line}" ${ATTR_NAME}="${lowerName}"`
          out += beforeClose + stamp + (isSelfClosing ? ' ' : '') + afterClose
          i = tagEnd + 1
          continue
        }
      }
    }

    out += html.charAt(i)
    i++
  }

  return out
}

/**
 * Stamp inline templates found inside Angular TypeScript components.
 * Finds @Component({ ... template: `...` ... }) and stamps the inner HTML with
 * correct line numbers referencing the TypeScript source file.
 *
 * @param {string} code - TypeScript source code.
 * @param {string} filePath - Normalised relative path to .ts file.
 * @returns {string} - Modified TypeScript code.
 */
function stampInlineComponentTemplates(code, filePath) {
  if (!code || typeof code !== 'string') return code
  if (!code.includes('@Component') || !code.includes('template')) return code

  // Match @Component({ ... template: `...` ... }) or template: '...' or template: "..."
  // Regex finds 'template' property key followed by colon and template string literal.
  const templatePropRegex = /template\s*:\s*([`'"])([\s\S]*?)\1/g
  let match
  let result = ''
  let lastIndex = 0

  while ((match = templatePropRegex.exec(code)) !== null) {
    const quote = match[1]
    const templateContent = match[2]
    const fullMatchStart = match.index
    const quoteIndex = fullMatchStart + match[0].indexOf(quote)

    // Calculate line number where template content starts (1-based line of first char of template)
    // The line offset passed to stampTemplateHtml should be (line of quote - 1)
    const quoteLine = getLineNumber(code, quoteIndex, 0)
    const lineOffset = quoteLine - 1

    const stampedTemplate = stampTemplateHtml(templateContent, filePath, lineOffset)

    result += code.slice(lastIndex, fullMatchStart)
    result += `template: ${quote}${stampedTemplate}${quote}`
    lastIndex = fullMatchStart + match[0].length
  }

  if (lastIndex === 0) return code
  result += code.slice(lastIndex)
  return result
}

/**
 * Main Angular transformation entry point.
 * Given code and file path, stamps external HTML templates or TS inline templates.
 *
 * @param {string} code
 * @param {string} id - Absolute or relative file path.
 * @param {string} [projectRoot=process.cwd()]
 * @returns {string|null} - Transformed code, or null if untouched.
 */
function transformAngular(code, id, projectRoot = process.cwd()) {
  const clean = (id || '').split('?')[0]
  if (clean.includes('node_modules')) return null

  const normalisedPath = normaliseFilePath(clean, projectRoot)

  // 1. External Angular component template: *.component.html or *.html
  if (/\.html$/i.test(clean)) {
    const stamped = stampTemplateHtml(code, normalisedPath, 0)
    return stamped !== code ? stamped : null
  }

  // 2. TypeScript Angular component with inline template: *.ts
  if (/\.ts$/i.test(clean) && !/\.d\.ts$/i.test(clean)) {
    if (code.includes('@Component') && code.includes('template')) {
      const stamped = stampInlineComponentTemplates(code, normalisedPath)
      return stamped !== code ? stamped : null
    }
  }

  return null
}

module.exports = {
  ATTR_FILE,
  ATTR_LINE,
  ATTR_NAME,
  getLineNumber,
  normaliseFilePath,
  stampTemplateHtml,
  stampInlineComponentTemplates,
  transformAngular
}
