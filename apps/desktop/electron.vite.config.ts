import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        /* node-pty is a native module: it cannot be bundled, and its .node binary must be loaded
           from node_modules at runtime. Everything else stays bundled as before. */
        external: ['node-pty']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          preview: resolve(__dirname, 'src/preload/preview.ts')
        }
      }
    }
  }
})
