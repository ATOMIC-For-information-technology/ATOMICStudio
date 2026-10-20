import { defineConfig } from 'vite'

// Minimal Vite configuration for the sample Angular project.
// In ATOMIC Studio, the inspector plugin stamps external templates (.component.html)
// and inline templates (.component.ts) with data-canvas-* attributes during dev preview.
export default defineConfig({
  server: { host: 'localhost' }
})
