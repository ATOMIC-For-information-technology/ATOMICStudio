import type React from 'react'

// Declare Electron's <webview> tag for JSX with the handful of props we use.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          allowpopups?: string
          partition?: string
          preload?: string
        },
        HTMLElement
      >
    }
  }
}

export {}
