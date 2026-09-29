import React from 'react'
import ReactDOM from 'react-dom/client'

function App(): React.JSX.Element {
  const [msg, setMsg] = React.useState('not clicked')
  return (
    <div style={{ fontFamily: 'system-ui', padding: 40, textAlign: 'center' }}>
      <h1 style={{ color: '#2563eb' }}>Hello from ATOMIC Studio</h1>
      <p id="out">{msg}</p>
      <button onClick={() => setMsg('CLICKED_OK')}>Press me</button>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
