const { spawn } = require('node:child_process')
const http = require('node:http')
const { resolve } = require('node:path')

const desktopRoot = resolve(__dirname, '..')
const bin = (name) => resolve(desktopRoot, '..', '..', 'node_modules', '.bin', name)
const children = new Set()
let stopping = false

function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: desktopRoot, env, stdio: 'inherit' })
  children.add(child)
  child.once('exit', (code) => {
    children.delete(child)
    if (!stopping && code) stop(code)
  })
  return child
}

function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 100).unref()
}

function waitForNext(attempt = 0) {
  const req = http.get('http://127.0.0.1:5173', (res) => {
    res.resume()
    run(bin('electron-vite'), ['--ignoreConfigWarning'], {
      ...process.env,
      ELECTRON_RENDERER_URL: 'http://127.0.0.1:5173'
    })
  })
  req.on('error', () => {
    if (attempt >= 120) return stop(1)
    setTimeout(() => waitForNext(attempt + 1), 250)
  })
}

process.on('SIGINT', () => stop(130))
process.on('SIGTERM', () => stop(143))

run(bin('next'), ['dev', 'src/renderer', '--hostname', '127.0.0.1', '--port', '5173'])
waitForNext()
