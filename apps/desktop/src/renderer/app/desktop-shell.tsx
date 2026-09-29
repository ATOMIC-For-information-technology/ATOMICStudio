'use client'

import dynamic from 'next/dynamic'
import { useLayoutEffect } from 'react'
import { applyTheme } from '../src/theme'
import { defaultTheme } from '../../shared/theme'

const App = dynamic(() => import('../src/App').then((module) => module.App), {
  ssr: false,
  loading: () => <div className="app-loading" aria-label="Loading ATOMIC Studio" />
})

export function DesktopShell() {
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-platform', navigator.userAgent.includes('Mac') ? 'mac' : 'other')
    applyTheme(defaultTheme())
  }, [])

  return <App />
}
