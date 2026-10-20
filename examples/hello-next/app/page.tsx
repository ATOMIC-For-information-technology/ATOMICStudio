import React from 'react'
import Card from '../components/Card'

export default function Page(): React.JSX.Element {
  return (
    <main className="container">
      <h1 className="title">Hello from Next.js 👋</h1>
      <p className="description">
        This sample Next.js App Router app is running live in ATOMIC Studio.
      </p>
      <Card />
    </main>
  )
}
