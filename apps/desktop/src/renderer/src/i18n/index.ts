import { useSyncExternalStore } from 'react'
import { en, type TranslationSchema, type Locale, type Direction } from './locales/en'
import { ar } from './locales/ar'

export * from './locales/en'
export { ar } from './locales/ar'

type NestedKeyOf<ObjectType extends object> = {
  [Key in keyof ObjectType & (string | number)]: ObjectType[Key] extends object
    ? `${Key}.${NestedKeyOf<ObjectType[Key]>}`
    : `${Key}`
}[keyof ObjectType & (string | number)]

export type TranslationKey = NestedKeyOf<TranslationSchema> | (string & {})

export const STORAGE_KEY = 'studio.language'
export const DEFAULT_LOCALE: Locale = 'en'

export interface StorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Check if value is a supported locale. */
export function isValidLocale(val: unknown): val is Locale {
  return val === 'en' || val === 'ar'
}

/** Parse an unknown stored value safely into a valid locale, defaulting to English. */
export function parseLocale(val: unknown): Locale {
  return isValidLocale(val) ? val : DEFAULT_LOCALE
}

/** Map locale to CSS layout direction. */
export function getDirection(locale: Locale): Direction {
  return locale === 'ar' ? 'rtl' : 'ltr'
}

/** Safely traverse a dot-delimited path in a dictionary. */
export function getNestedValue(obj: unknown, path: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const segments = path.split('.')
  let curr: any = obj
  for (const seg of segments) {
    if (curr && typeof curr === 'object' && seg in curr) {
      curr = curr[seg]
    } else {
      return undefined
    }
  }
  return typeof curr === 'string' ? curr : undefined
}

/**
 * Pure translation resolver:
 * 1. Checks active dictionary.
 * 2. If missing, null, or empty string, falls back to English.
 * 3. If missing in English, returns the raw key path.
 */
export function resolveTranslation(
  locale: Locale,
  key: string,
  dictionaries: { en: unknown; ar: unknown } = { en, ar }
): string {
  const activeDict = dictionaries[locale]
  const val = getNestedValue(activeDict, key)
  if (typeof val === 'string' && val.trim().length > 0) {
    return val
  }

  // Fallback to canonical English
  const fallbackVal = getNestedValue(dictionaries.en, key)
  if (typeof fallbackVal === 'string' && fallbackVal.trim().length > 0) {
    return fallbackVal
  }

  // Safety fallback: return key name itself
  return key
}

function createDefaultStorage(): StorageAdapter {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  const mem: Record<string, string> = {}
  return {
    getItem: (k: string) => mem[k] ?? null,
    setItem: (k: string, v: string) => {
      mem[k] = v
    }
  }
}

let storageAdapter: StorageAdapter = createDefaultStorage()
let activeLocale: Locale = DEFAULT_LOCALE

// Try initial load from storage
try {
  const saved = storageAdapter.getItem(STORAGE_KEY)
  activeLocale = parseLocale(saved)
} catch {
  activeLocale = DEFAULT_LOCALE
}

const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return activeLocale
}

export function setLocale(next: Locale): void {
  if (!isValidLocale(next)) return
  if (activeLocale === next) return
  activeLocale = next
  try {
    storageAdapter.setItem(STORAGE_KEY, next)
  } catch {
    /* ignore storage failure */
  }
  listeners.forEach((listener) => listener())
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setStorageAdapter(adapter: StorageAdapter): void {
  storageAdapter = adapter
  const saved = adapter.getItem(STORAGE_KEY)
  activeLocale = parseLocale(saved)
  listeners.forEach((listener) => listener())
}

/** Look up a key for the current or specified locale. */
export function t(key: TranslationKey, locale: Locale = activeLocale): string {
  return resolveTranslation(locale, key, { en, ar })
}

/** React hook for UI components to read translations and react to language changes. */
export function useTranslation() {
  const locale = useSyncExternalStore(
    subscribeLocale,
    getLocale,
    () => DEFAULT_LOCALE
  )

  return {
    t: (key: TranslationKey) => t(key, locale),
    locale,
    setLocale,
    dir: getDirection(locale)
  }
}
