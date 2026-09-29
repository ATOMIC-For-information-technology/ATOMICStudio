import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { errMessage } from './util'
import type { SimulatorDevice, SimulatorResult } from '../shared/types'

const run = promisify(execFile)

/**
 * Real iOS Simulator integration for macOS via `xcrun simctl`. Lets Studio show
 * a running dev URL inside a genuine iPhone/iPad simulator (Mobile Safari), not
 * just a CSS device frame — and, for Expo/React-Native projects, install & run a
 * simulator build. All calls no-op with a clear message off macOS / without Xcode.
 */

const isMac = process.platform === 'darwin'

async function xcrun(args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  if (!isMac) return { ok: false, stdout: '', error: 'iOS Simulator is only available on macOS.' }
  try {
    const { stdout } = await run('xcrun', args, { maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, stdout }
  } catch (e) {
    const msg = errMessage(e)
    const friendly = /xcrun: error|unable to find utility|SimulatorKit|CoreSimulator/i.test(msg)
      ? 'Xcode / iOS Simulator not found. Install Xcode from the App Store, then open it once.'
      : msg
    return { ok: false, stdout: '', error: friendly }
  }
}

/** List available iPhone/iPad simulators (available runtimes only). */
export async function listSimulators(): Promise<SimulatorDevice[]> {
  const res = await xcrun(['simctl', 'list', 'devices', 'available', '--json'])
  if (!res.ok) return []
  let parsed: { devices?: Record<string, Array<{ udid: string; name: string; state: string; isAvailable?: boolean }>> }
  try {
    parsed = JSON.parse(res.stdout)
  } catch {
    return []
  }
  const out: SimulatorDevice[] = []
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    if (!/iOS/i.test(runtime)) continue
    // runtime id looks like "com.apple.CoreSimulator.SimRuntime.iOS-26-5" → "26.5"
    const iosVersion = (runtime.split('.').pop() ?? '')
      .replace(/^iOS-?/i, '')
      .replace(/-/g, '.')
    for (const d of devices) {
      if (d.isAvailable === false) continue
      if (!/iPhone|iPad/i.test(d.name)) continue
      out.push({ udid: d.udid, name: d.name, state: d.state, runtime: `iOS ${iosVersion}` })
    }
  }
  // Booted first, then iPhones before iPads, newest-looking names first.
  out.sort((a, b) => {
    if ((a.state === 'Booted') !== (b.state === 'Booted')) return a.state === 'Booted' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Boot a simulator (opens the Simulator.app window) and wait until it's ready. */
async function bootSimulator(udid: string): Promise<SimulatorResult> {
  const boot = await xcrun(['simctl', 'boot', udid])
  // "Unable to boot device in current state: Booted" is fine — already running.
  if (!boot.ok && !/current state: Booted/i.test(boot.error ?? '')) {
    return { ok: false, error: boot.error }
  }
  // Bring the Simulator app window to the front.
  await run('open', ['-a', 'Simulator']).catch(() => undefined)
  await xcrun(['simctl', 'bootstatus', udid, '-b']).catch(() => undefined)
  return { ok: true }
}

/** Open a URL (the dev server) in the booted simulator's Mobile Safari. */
export async function openUrl(udid: string, url: string): Promise<SimulatorResult> {
  const boot = await bootSimulator(udid)
  if (!boot.ok) return boot
  const res = await xcrun(['simctl', 'openurl', udid, url])
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/** Capture a PNG screenshot of the booted simulator as a data URL (for in-app streaming). */
export async function screenshot(udid: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  if (!isMac) return { ok: false, error: 'macOS only.' }
  try {
    // `simctl io <udid> screenshot -` writes PNG bytes to stdout.
    const { stdout } = await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', '-'], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024
    })
    return { ok: true, dataUrl: `data:image/png;base64,${(stdout as Buffer).toString('base64')}` }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}
