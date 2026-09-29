import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A plain, unmodified Vite project. ATOMIC Studio injects the click-to-edit
// stamping at launch — this config is intentionally left untouched.
export default defineConfig({
  plugins: [react()],
  server: { host: 'localhost' }
})
