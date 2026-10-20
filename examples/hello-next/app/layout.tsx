import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Hello Next — ATOMIC Studio',
  description: 'Minimal Next.js App Router example for ATOMIC Studio'
}

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
