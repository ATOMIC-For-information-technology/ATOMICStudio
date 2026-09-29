import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'studio.agentPanel.collapsed'

type CollapsedMap = Record<string, boolean>

const read = (): CollapsedMap => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  } catch {
    return {}
  }
}

/**
 * Remembers which Agent Panel sections are collapsed, persisted across sessions.
 * Returns the map plus a toggle; each section reads its own key with a default.
 */
export function useCollapsed(): { collapsed: CollapsedMap; toggle: (id: string) => void; isCollapsed: (id: string, dflt?: boolean) => boolean } {
  const [collapsed, setCollapsed] = useState<CollapsedMap>(read)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed))
  }, [collapsed])

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const isCollapsed = useCallback((id: string, dflt = false): boolean => collapsed[id] ?? dflt, [collapsed])

  return { collapsed, toggle, isCollapsed }
}