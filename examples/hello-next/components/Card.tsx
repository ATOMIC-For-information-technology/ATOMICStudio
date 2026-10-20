'use client'

import React, { useState } from 'react'

export interface CardProps {
  initialCount?: number
}

export default function Card({ initialCount = 0 }: CardProps): React.JSX.Element {
  const [count, setCount] = useState<number>(initialCount)

  return (
    <section className="card" aria-label="Interactive demo card">
      <h2 className="card-title">Interactive Component</h2>
      <p className="card-text">
        Click to test live state updates, or select any element to test click-to-edit.
      </p>
      <button
        type="button"
        className="button"
        onClick={() => setCount((prev) => prev + 1)}
      >
        Clicks: {count}
      </button>
    </section>
  )
}
