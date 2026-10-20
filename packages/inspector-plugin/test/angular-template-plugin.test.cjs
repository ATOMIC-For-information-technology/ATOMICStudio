/**
 * Comprehensive Automated Tests for Angular Click-to-Edit Support in ATOMIC Studio
 *
 * Verifies:
 * 1. External Angular template stamping (.component.html)
 * 2. Accurate line numbers for selected template elements
 * 3. Multi-line tags, void tags, self-closing tags
 * 4. Nested HTML elements and nested Angular components
 * 5. Structural directives (*ngIf, *ngFor) and event bindings ((click))
 * 6. Expressions containing > and < inside attribute quotes
 * 7. Preservation of HTML comments, script/style tags, and interpolations
 * 8. Inline templates in TypeScript (.component.ts) with correct source line offset
 * 9. transformAngular entry point and path normalisation
 * 10. Vite plugin integration (Angular + React JSX regression)
 * 11. Runtime angularSource resolution & safe fallback (no fabricated locations)
 * 12. Framework detection (Angular, React, Vue, Svelte, Next, Vite)
 */
const assert = require('node:assert')
const path = require('node:path')
const {
  stampTemplateHtml,
  stampInlineComponentTemplates,
  transformAngular,
  normaliseFilePath,
  getLineNumber,
  ATTR_FILE,
  ATTR_LINE,
  ATTR_NAME
} = require('../angular-template-plugin.cjs')
const inspectorVitePlugin = require('../vite-plugin.cjs')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS: ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL: ${name}`)
    console.error(err)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS: ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL: ${name}`)
    console.error(err)
  }
}

async function main() {
  console.log('\n--- Running Angular Click-to-Edit Test Suite ---')

// 1. External template stamping (.component.html)
test('1. External template: stamps file, line, and tag name onto elements', () => {
  const html = `<div class="hero">
  <h1>Title</h1>
  <button (click)="onClick()">Click</button>
</div>`
  const result = stampTemplateHtml(html, 'src/app/app.component.html', 0)

  assert(result.includes('data-canvas-file="src/app/app.component.html"'))
  assert(result.includes('data-canvas-line="1" data-canvas-name="div"'))
  assert(result.includes('data-canvas-line="2" data-canvas-name="h1"'))
  assert(result.includes('data-canvas-line="3" data-canvas-name="button"'))
})

// 2. Exact line numbers for elements
test('2. Exact line numbers: matches start line of opening tags', () => {
  const html = `
<!-- Header line 2 -->
<header>
  <nav>
    <a href="/">Home</a>
  </nav>
</header>
<main>
  <section>
    <p>Paragraph</p>
  </section>
</main>`
  const result = stampTemplateHtml(html, 'src/app/page.component.html', 0)

  assert(result.includes('<header data-canvas-file="src/app/page.component.html" data-canvas-line="3" data-canvas-name="header">'))
  assert(result.includes('<nav data-canvas-file="src/app/page.component.html" data-canvas-line="4" data-canvas-name="nav">'))
  assert(result.includes('<a href="/" data-canvas-file="src/app/page.component.html" data-canvas-line="5" data-canvas-name="a">'))
  assert(result.includes('<main data-canvas-file="src/app/page.component.html" data-canvas-line="8" data-canvas-name="main">'))
  assert(result.includes('<section data-canvas-file="src/app/page.component.html" data-canvas-line="9" data-canvas-name="section">'))
  assert(result.includes('<p data-canvas-file="src/app/page.component.html" data-canvas-line="10" data-canvas-name="p">'))
})

// 3. Multi-line opening tags and self-closing tags
test('3. Multi-line tags and self-closing tags', () => {
  const html = `<button
  type="button"
  (click)="handleClick()"
  class="btn btn-primary"
>
  Save
</button>
<input type="text" placeholder="Name" />
<img src="avatar.png" alt="User">`

  const result = stampTemplateHtml(html, 'src/app/form.component.html', 0)

  // Multi-line tag starts on line 1
  assert(result.includes('data-canvas-file="src/app/form.component.html" data-canvas-line="1" data-canvas-name="button"'))
  // Self-closing input on line 8
  assert(result.includes('data-canvas-file="src/app/form.component.html" data-canvas-line="8" data-canvas-name="input" />'))
  // Void tag img on line 9
  assert(result.includes('data-canvas-file="src/app/form.component.html" data-canvas-line="9" data-canvas-name="img">'))
})

// 4. Nested HTML elements and nested Angular custom components
test('4. Nested elements and custom Angular components', () => {
  const html = `<div class="wrapper">
  <app-header title="Dashboard"></app-header>
  <div class="card">
    <app-user-profile [userId]="user.id"></app-user-profile>
  </div>
</div>`
  const result = stampTemplateHtml(html, 'src/app/dashboard.component.html', 0)

  assert(result.includes('data-canvas-name="div"'))
  assert(result.includes('data-canvas-name="app-header"'))
  assert(result.includes('data-canvas-name="app-user-profile"'))
})

// 5. Structural directives (*ngIf, *ngFor) and event bindings
test('5. Structural directives and event bindings', () => {
  const html = `<ul class="list">
  <li *ngFor="let item of items; let i = index" (click)="selectItem(item)">
    <span *ngIf="item.active" class="badge">Active</span>
    {{ item.name }}
  </li>
</ul>`
  const result = stampTemplateHtml(html, 'src/app/list.component.html', 0)

  assert(result.includes('<ul class="list" data-canvas-file="src/app/list.component.html" data-canvas-line="1" data-canvas-name="ul">'))
  assert(result.includes('<li *ngFor="let item of items; let i = index" (click)="selectItem(item)" data-canvas-file="src/app/list.component.html" data-canvas-line="2" data-canvas-name="li">'))
  assert(result.includes('<span *ngIf="item.active" class="badge" data-canvas-file="src/app/list.component.html" data-canvas-line="3" data-canvas-name="span">'))
})

// 6. Expressions containing > or < inside attribute values
test('6. Attribute expressions containing > or < in quotes', () => {
  const html = `<div *ngIf="items.length > 0" [class.highlight]="count < 10">
  <p>Has items</p>
</div>`
  const result = stampTemplateHtml(html, 'src/app/test.component.html', 0)

  // Should correctly parse the opening tag despite > inside *ngIf="..."
  assert(result.includes('*ngIf="items.length > 0"'))
  assert(result.includes('[class.highlight]="count < 10"'))
  assert(result.includes('data-canvas-file="src/app/test.component.html" data-canvas-line="1" data-canvas-name="div"'))
  assert(result.includes('data-canvas-file="src/app/test.component.html" data-canvas-line="2" data-canvas-name="p"'))
})

// 7. Preservation of comments, script/style tags, and interpolations
test('7. Preservation of comments, style tags, and interpolations with comparisons', () => {
  const html = `<!-- <div>This is commented out</div> -->
<style>.btn { color: red; }</style>
<div class="content">
  <span>{{ score > 50 ? 'Pass' : 'Fail' }}</span>
</div>`
  const result = stampTemplateHtml(html, 'src/app/comments.component.html', 0)

  // Commented div must NOT be stamped
  assert(result.includes('<!-- <div>This is commented out</div> -->'))
  // Style tag must NOT be stamped
  assert(!result.includes('data-canvas-name="style"'))
  // Real div on line 3 must be stamped
  assert(result.includes('data-canvas-line="3" data-canvas-name="div"'))
  // Span on line 4 must be stamped
  assert(result.includes('data-canvas-line="4" data-canvas-name="span"'))
})

// 8. Idempotency: skip elements already stamped
test('8. Idempotency: does not double-stamp already stamped elements', () => {
  const html = `<button data-canvas-file="src/app/btn.html" data-canvas-line="5" data-canvas-name="button">Click</button>`
  const result = stampTemplateHtml(html, 'src/app/btn.html', 0)

  assert.strictEqual(result, html)
})

// 9. Inline templates in TypeScript (.component.ts)
test('9. Inline templates in .component.ts: stamps correct TS file and line numbers', () => {
  const tsCode = `import { Component } from '@angular/core';

@Component({
  selector: 'app-inline-card',
  standalone: true,
  template: \`
    <div class="card">
      <h2>Title</h2>
      <button (click)="action()">Button</button>
    </div>
  \`
})
export class InlineCardComponent {}`

  const result = stampInlineComponentTemplates(tsCode, 'src/app/inline-card.component.ts')

  assert(result.includes('data-canvas-file="src/app/inline-card.component.ts"'))
  // <div class="card"> is on line 7 of the TS file
  assert(result.includes('data-canvas-line="7" data-canvas-name="div"'))
  // <h2> is on line 8 of the TS file
  assert(result.includes('data-canvas-line="8" data-canvas-name="h2"'))
  // <button> is on line 9 of the TS file
  assert(result.includes('data-canvas-line="9" data-canvas-name="button"'))
})

// 10. Inline templates with single or double quotes
test('10. Inline templates with single quotes', () => {
  const tsCode = `@Component({
  selector: 'app-mini',
  template: '<div class="mini"><span>Hi</span></div>'
})
export class MiniComponent {}`

  const result = stampInlineComponentTemplates(tsCode, 'src/app/mini.component.ts')

  assert(result.includes('data-canvas-file="src/app/mini.component.ts"'))
  assert(result.includes('data-canvas-line="3" data-canvas-name="div"'))
  assert(result.includes('data-canvas-line="3" data-canvas-name="span"'))
})

// 11. transformAngular entry point and path normalisation
test('11. transformAngular: handles external html and ts files, ignores node_modules and d.ts', () => {
  const htmlCode = `<h1>Title</h1>`
  const htmlRes = transformAngular(htmlCode, 'b:\\Kalvium\\OSS\\ATOMICStudio\\src\\app\\app.component.html', 'b:\\Kalvium\\OSS\\ATOMICStudio')
  assert(htmlRes !== null)
  assert(htmlRes.includes('data-canvas-file="src/app/app.component.html"'))

  const nodeModulesRes = transformAngular(htmlCode, 'node_modules/some-pkg/template.html')
  assert.strictEqual(nodeModulesRes, null)

  const dtsRes = transformAngular(`export declare class X {}`, 'src/types.d.ts')
  assert.strictEqual(dtsRes, null)
})

// 12. Vite plugin integration: Angular templates + React JSX regression
  await testAsync('12. Vite plugin: transforms Angular templates and preserves React JSX stamping', async () => {
    const projectRoot = path.resolve(process.cwd(), 'test-root')
    const plugin = inspectorVitePlugin({ projectRoot })

    // 1. Angular HTML
    const angularHtml = await plugin.transform(
      `<div><h1>Angular</h1></div>`,
      path.resolve(projectRoot, 'src/app/app.component.html')
    )
    assert(angularHtml !== null)
    assert(angularHtml.code.includes('data-canvas-file="src/app/app.component.html"'))
    assert(angularHtml.code.includes('data-canvas-name="h1"'))

    // 2. Angular TS with inline template
    const angularTs = await plugin.transform(
      `@Component({ template: '<p>Inline</p>' }) export class X {}`,
      path.resolve(projectRoot, 'src/app/x.component.ts')
    )
    assert(angularTs !== null)
    assert(angularTs.code.includes('data-canvas-file="src/app/x.component.ts"'))
    assert(angularTs.code.includes('data-canvas-name="p"'))

    // 3. React JSX regression guard
    const reactJsx = await plugin.transform(
      `export function App() { return <button>Click</button> }`,
      path.resolve(projectRoot, 'src/App.tsx')
    )
    assert(reactJsx !== null)
    assert(reactJsx.code.includes('data-canvas-file="src/App.tsx"'))
    assert(reactJsx.code.includes('data-canvas-name="button"'))

    // 4. Plain JS without JSX or Angular
    const plainJs = await plugin.transform(
      `export const x = 1`,
      path.resolve(projectRoot, 'src/util.js')
    )
    assert.strictEqual(plainJs, null)
  })

// 13. Runtime angularSource simulation matching preview.ts PAGE_WORLD_PICKER
test('13. Runtime angularSource: resolves component metadata and safely falls back', () => {
  // Simulate preview.ts angularSource function
  function angularSource(el, mockWindow) {
    var comp = null
    if (mockWindow.ng && typeof mockWindow.ng.getOwningComponent === 'function') {
      try {
        comp = mockWindow.ng.getOwningComponent(el) || (typeof mockWindow.ng.getComponent === 'function' ? mockWindow.ng.getComponent(el) : null)
      } catch (e) {
        comp = null
      }
    }
    if (!comp && el.__ngContext__) {
      var ctx = el.__ngContext__
      if (Array.isArray(ctx)) {
        comp = ctx[8] || null
        if (!comp || typeof comp !== 'object') {
          for (var i = 0; i < ctx.length; i++) {
            if (ctx[i] && typeof ctx[i] === 'object' && ctx[i].constructor && (ctx[i].constructor.ɵcmp || ctx[i].constructor.ɵfac)) {
              comp = ctx[i]
              break
            }
          }
        }
      } else if (typeof ctx === 'object') {
        comp = ctx.component || ctx
      }
    }
    if (!comp || typeof comp !== 'object') return null

    var ctor = comp.constructor
    if (!ctor) return null

    var cmpDef = ctor.ɵcmp || ctor.ɵdir || null
    var debugInfo = (cmpDef && cmpDef.debugInfo) || ctor.debugInfo || null

    var file = (debugInfo && (debugInfo.filePath || debugInfo.file)) || ctor.__file || (cmpDef && cmpDef.type && cmpDef.type.__file) || null
    if (!file || typeof file !== 'string') return null

    var line = (debugInfo && (debugInfo.lineNumber || debugInfo.line)) || 0
    var name = (cmpDef && cmpDef.type && cmpDef.type.name) || ctor.name || (el.tagName ? el.tagName.toLowerCase() : 'component')

    return { file: file, line: Number(line) || 0, name: name }
  }

  // A. Component with debugInfo (Angular 17/18+)
  class TestAppComponent {}
  TestAppComponent.ɵcmp = {
    type: TestAppComponent,
    debugInfo: { filePath: 'src/app/app.component.ts', lineNumber: 15 }
  }
  const compInstance = new TestAppComponent()
  const elWithNg = { tagName: 'BUTTON' }
  const mockWinWithNg = {
    ng: {
      getOwningComponent: (node) => (node === elWithNg ? compInstance : null)
    }
  }

  const resA = angularSource(elWithNg, mockWinWithNg)
  assert.deepStrictEqual(resA, {
    file: 'src/app/app.component.ts',
    line: 15,
    name: 'TestAppComponent'
  })

  // B. Component via __ngContext__ array (Ivy LView)
  const elWithContext = {
    tagName: 'H1',
    __ngContext__: [null, null, null, null, null, null, null, null, compInstance]
  }
  const resB = angularSource(elWithContext, {})
  assert.deepStrictEqual(resB, {
    file: 'src/app/app.component.ts',
    line: 15,
    name: 'TestAppComponent'
  })

  // C. Component without file metadata -> returns null (safe fallback, no fabricated locations)
  class PlainComp {}
  PlainComp.ɵcmp = { type: PlainComp }
  const unmappedEl = {
    tagName: 'DIV',
    __ngContext__: [null, null, null, null, null, null, null, null, new PlainComp()]
  }
  const resC = angularSource(unmappedEl, {})
  assert.strictEqual(resC, null)

  // D. Plain non-Angular DOM element -> returns null
  const plainEl = { tagName: 'P' }
  const resD = angularSource(plainEl, {})
  assert.strictEqual(resD, null)
})

// 14. Framework detection in ProcessManager
test('14. Framework detection: correctly identifies Angular alongside other frameworks', () => {
  // Test framework detection logic from process-manager.ts
  function detectFramework(deps) {
    if (deps.expo) return 'expo'
    if (deps.next) return 'next'
    if (deps['@angular/core'] || deps['@angular/cli']) return 'angular'
    if (deps.vite || deps['@vitejs/plugin-react']) return 'vite'
    if (deps.vue) return 'vue'
    if (deps.svelte) return 'svelte'
    if (deps.react) return 'react'
    return 'unknown'
  }

  assert.strictEqual(detectFramework({ '@angular/core': '^18.0.0' }), 'angular')
  assert.strictEqual(detectFramework({ '@angular/cli': '^18.0.0' }), 'angular')
  assert.strictEqual(detectFramework({ next: '14.0.0', react: '18.0.0' }), 'next')
  assert.strictEqual(detectFramework({ vite: '5.0.0' }), 'vite')
  assert.strictEqual(detectFramework({ vue: '3.0.0' }), 'vue')
  assert.strictEqual(detectFramework({ svelte: '4.0.0' }), 'svelte')
  assert.strictEqual(detectFramework({ react: '18.0.0' }), 'react')
  assert.strictEqual(detectFramework({ lodash: '4.0.0' }), 'unknown')
})

  console.log(`\nTests finished: ${passed} passed, ${failed} failed.\n`)
  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
