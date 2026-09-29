import React from 'react'
import ReactDOM from 'react-dom/client'

function App(): React.JSX.Element {
  return (
    <div style={{ fontFamily: 'system-ui', padding: 40, textAlign: 'center' }}>
      <h1 style={{ color: '#2563eb' }}>Hello from ATOMIC Studio 👋</h1>
      <p>This sample app is shown live in the iPhone, iPad and Desktop frames.</p>
      <button style={{ padding: '8px 16px', fontSize: 16 }}>Click me</button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
