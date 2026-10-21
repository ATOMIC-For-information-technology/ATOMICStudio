#!/usr/bin/env node
/**
 * Headless unit test for ATOMIC Studio i18n translation engine.
 * Tests:
 *  1. Canonical English dictionary completeness.
 *  2. Arabic translation dictionary completeness for Welcome screen.
 *  3. Fallback to English when Arabic key is missing or empty.
 *  4. Fallback to raw key string when key does not exist.
 *  5. RTL / LTR direction mapping.
 *  6. Safe locale parsing on invalid or missing stored values.
 *  7. Language switching, subscriber notifications, and storage persistence.
 *
 * Can be run with:
 *   node apps/desktop/scripts/test-i18n.mjs
 *   npx tsx apps/desktop/scripts/test-i18n.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Re-exec via tsx if not already running under tsx
if (!process.env.__TSX_ACTIVE && !process.execArgv.some((a) => a.includes('tsx') || a.includes('strip-types'))) {
  const isWin = process.platform === 'win32'
  const npxCmd = isWin ? 'npx.cmd' : 'npx'
  const result = spawnSync(npxCmd, ['tsx', fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, __TSX_ACTIVE: '1' }
  })
  process.exit(result.status ?? 1)
}

const {
  en,
  ar,
  t,
  getLocale,
  setLocale,
  subscribeLocale,
  getDirection,
  isValidLocale,
  parseLocale,
  resolveTranslation,
  setStorageAdapter
} = await import('../src/renderer/src/i18n/index.js')

let passed = 0
let failed = 0

function assert(condition, message) {
  if (!condition) {
    failed++
    console.error(`  \x1b[31mFAIL\x1b[0m ${message}`)
    throw new Error(message)
  }
}

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (err) {
    // Already logged in assert
  }
}

console.log('\n--- ATOMIC Studio i18n Test Suite ---\n')

// 1. Locale validation & parsing
test('Safe locale parsing defaults to "en"', () => {
  assert(isValidLocale('en') === true, 'en is valid')
  assert(isValidLocale('ar') === true, 'ar is valid')
  assert(isValidLocale('fr') === false, 'fr is not supported')
  assert(isValidLocale(null) === false, 'null is not valid')
  assert(isValidLocale(undefined) === false, 'undefined is not valid')

  assert(parseLocale('en') === 'en', 'parseLocale("en") === "en"')
  assert(parseLocale('ar') === 'ar', 'parseLocale("ar") === "ar"')
  assert(parseLocale('invalid') === 'en', 'parseLocale("invalid") defaults to "en"')
  assert(parseLocale(null) === 'en', 'parseLocale(null) defaults to "en"')
  assert(parseLocale(undefined) === 'en', 'parseLocale(undefined) defaults to "en"')
})

// 2. Direction mapping
test('Direction mapping correctly associates locale with RTL / LTR', () => {
  assert(getDirection('en') === 'ltr', 'English direction is LTR')
  assert(getDirection('ar') === 'rtl', 'Arabic direction is RTL')
})

// 3. Canonical English dictionary
test('Canonical English dictionary has all required Welcome screen keys', () => {
  assert(en.welcome.title === 'ATOMIC Studio', 'en title exists')
  assert(en.welcome.subtitle.includes('An IDE where the agent'), 'en subtitle exists')
  assert(en.welcome.cards.openProject.title === 'Open a project', 'en openProject card exists')
  assert(en.welcome.cards.newProject.title === 'Start something new', 'en newProject card exists')
  assert(en.welcome.cards.connectWorkspace.title === 'Connect to a workspace', 'en connectWorkspace card exists')
  assert(en.welcome.clone.prompt === 'Have a repository URL?', 'en clone prompt exists')
  assert(en.welcome.clone.action === 'Clone a repository…', 'en clone action exists')
  assert(en.welcome.recent.title === 'Recent', 'en recent title exists')
  assert(en.welcome.recent.emptyTitle === 'Nothing here yet', 'en empty title exists')
  assert(en.welcome.recent.emptySub === 'Folders you open appear here, most recent first.', 'en empty sub exists')
  assert(en.welcome.footer.commandPalette.includes('command palette'), 'en footer exists')
  assert(en.common.today === 'Today', 'en relative today exists')
  assert(en.common.yesterday === 'Yesterday', 'en relative yesterday exists')
})

// 4. Arabic translation dictionary
test('Arabic dictionary has translations for Welcome screen', () => {
  assert(ar.welcome?.title === 'ATOMIC Studio', 'ar title exists')
  assert(ar.welcome?.subtitle?.includes('بيئة تطوير'), 'ar subtitle translated')
  assert(ar.welcome?.cards?.openProject?.title === 'فتح مشروع', 'ar openProject title translated')
  assert(ar.welcome?.cards?.newProject?.title === 'بدء مشروع جديد', 'ar newProject title translated')
  assert(ar.welcome?.cards?.connectWorkspace?.title === 'الاتصال ببيئة عمل', 'ar connectWorkspace title translated')
  assert(ar.welcome?.clone?.prompt === 'هل لديك رابط مستودع؟', 'ar clone prompt translated')
  assert(ar.welcome?.clone?.action === 'استنساخ مستودع…', 'ar clone action translated')
  assert(ar.welcome?.recent?.title === 'الأحدث', 'ar recent title translated')
  assert(ar.welcome?.recent?.emptyTitle === 'لا يوجد شيء هنا بعد', 'ar empty title translated')
  assert(ar.welcome?.footer?.commandPalette?.includes('لوحة الأوامر'), 'ar footer translated')
  assert(ar.common?.today === 'اليوم', 'ar today translated')
  assert(ar.common?.yesterday === 'أمس', 'ar yesterday translated')
})

// 5. Missing translation fallback to English
test('Missing key in Arabic falls back gracefully to English', () => {
  const mockDicts = {
    en: { greeting: 'Hello', nested: { label: 'Click me' } },
    ar: { greeting: 'مرحبا' } // nested.label is omitted in Arabic
  }

  const existingAr = resolveTranslation('ar', 'greeting', mockDicts)
  assert(existingAr === 'مرحبا', 'Existing Arabic key resolves in Arabic')

  const fallback = resolveTranslation('ar', 'nested.label', mockDicts)
  assert(fallback === 'Click me', 'Missing Arabic key falls back to English value')
})

// 6. Empty string in Arabic fallback to English
test('Empty string in Arabic falls back gracefully to English', () => {
  const mockDicts = {
    en: { welcome: 'Welcome' },
    ar: { welcome: '   ' } // Empty / whitespace string
  }

  const fallback = resolveTranslation('ar', 'welcome', mockDicts)
  assert(fallback === 'Welcome', 'Empty Arabic key falls back to English')
})

// 7. Non-existent key safety
test('Non-existent key in both languages returns raw key path without throwing', () => {
  const result = resolveTranslation('ar', 'completely.missing.key')
  assert(result === 'completely.missing.key', 'Non-existent key safely returns key path')
  assert(result !== undefined, 'Result is never undefined')
})

// 8. Storage persistence, language switching, and subscription
test('Language switching updates state, notifies subscribers, and persists to storage', () => {
  const mockStorage = {}
  const adapter = {
    getItem: (k) => mockStorage[k] ?? null,
    setItem: (k, v) => {
      mockStorage[k] = v
    }
  }

  setStorageAdapter(adapter)
  assert(getLocale() === 'en', 'Initial locale is "en"')

  let notified = 0
  const unsubscribe = subscribeLocale(() => {
    notified++
  })

  // Switch to Arabic
  setLocale('ar')
  assert(getLocale() === 'ar', 'Locale changed to "ar"')
  assert(getDirection(getLocale()) === 'rtl', 'Direction for "ar" is "rtl"')
  assert(mockStorage['studio.language'] === 'ar', 'Saved to storage as "ar"')
  assert(notified === 1, 'Subscriber notified once on change')

  // Setting the same locale should not re-trigger
  setLocale('ar')
  assert(notified === 1, 'Same locale does not trigger subscriber')

  // Setting invalid locale should be ignored
  setLocale('invalid')
  assert(getLocale() === 'ar', 'Invalid locale ignored')
  assert(notified === 1, 'Invalid locale does not trigger subscriber')

  // Switch back to English
  setLocale('en')
  assert(getLocale() === 'en', 'Locale changed back to "en"')
  assert(getDirection(getLocale()) === 'ltr', 'Direction for "en" is "ltr"')
  assert(mockStorage['studio.language'] === 'en', 'Saved to storage as "en"')
  assert(notified === 2, 'Subscriber notified on switch to "en"')

  unsubscribe()
  setLocale('ar')
  assert(notified === 2, 'Unsubscribed listener is no longer called')
})

// 9. Startup restoration from storage
test('Initial load restores saved locale from storage', () => {
  const mockStorage = { 'studio.language': 'ar' }
  const adapter = {
    getItem: (k) => mockStorage[k] ?? null,
    setItem: (k, v) => {
      mockStorage[k] = v
    }
  }

  setStorageAdapter(adapter)
  assert(getLocale() === 'ar', 'Restored "ar" from storage')
  assert(getDirection(getLocale()) === 'rtl', 'Direction restored as "rtl"')

  // Reset back to English for cleanliness
  setLocale('en')
})

console.log(`\nResults: ${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
} else {
  console.log('All i18n tests passed successfully!\n')
  process.exit(0)
}
