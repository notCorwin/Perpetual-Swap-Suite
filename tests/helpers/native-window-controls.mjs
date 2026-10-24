import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const source = fileURLToPath(new URL('./native-window-controls.m', import.meta.url))
const directory = fileURLToPath(new URL('../../.build/native-window-controls/', import.meta.url))
const flags = ['-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-fobjc-arc', '-Wall', '-Wextra', '-Werror']
let measurements = Promise.resolve()

async function compile(architecture) {
  const arch = { arm64: 'arm64', x64: 'x86_64' }[architecture]
  if (!arch) throw new Error(`Unsupported native window probe architecture: ${architecture}`)
  const fingerprint = createHash('sha256').update(await readFile(source)).update(JSON.stringify([arch, flags])).digest('hex')
  const addon = join(directory, `controls-${arch}-${fingerprint}.node`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try { await access(addon); return addon } catch (error) { if (error.code !== 'ENOENT') throw error }
  const intermediate = `${addon}.${process.pid}-${randomUUID()}.tmp`
  try {
    await execute('xcrun', ['clang', ...flags, '-arch', arch, source, '-o', intermediate])
    await rename(intermediate, addon)
  } finally { await rm(intermediate, { force: true }) }
  return addon
}

async function measure(electron, windowId) {
  if (process.platform !== 'darwin') throw new Error('Native window controls can only be measured on macOS.')
  const identity = await electron.evaluate(({ BrowserWindow }, windowId) => {
    if (process.platform !== 'darwin' || process.env.PERPETUAL_SWAP_E2E !== '1')
      throw new Error('The native window probe requires a macOS test Electron main process.')
    const windows = windowId === undefined ? BrowserWindow.getAllWindows() : [BrowserWindow.fromId(windowId)]
    if (windows.length !== 1 || !windows[0] || windows[0].isDestroyed())
      throw new Error('Pass the exact windowId when there is not exactly one test window.')
    return { windowId: windows[0].id, architecture: process.arch }
  }, windowId)
  const addonPath = await compile(identity.architecture)
  const reportDirectory = await mkdtemp(join(directory, 'report-'))
  try {
    const reportPath = join(reportDirectory, 'geometry.json')
    await electron.evaluate(({ BrowserWindow }, { windowId, addonPath, reportPath }) => {
      const target = BrowserWindow.fromId(windowId)
      if (!target || target.isDestroyed()) throw new Error(`Test window ${windowId} no longer exists.`)
      if (target.isVisible() || target.isFocused() || target.isFocusable())
        throw new Error('The native window probe requires a hidden, unfocused, nonfocusable test window.')
      const handle = target.getNativeWindowHandle()
      if (handle.length !== 8) throw new Error('Expected a 64-bit macOS NSView handle.')
      const values = {
        PERPETUAL_SWAP_NATIVE_WINDOW_CONTROLS_HANDLE: `0x${handle.readBigUInt64LE().toString(16)}`,
        PERPETUAL_SWAP_NATIVE_WINDOW_CONTROLS_REPORT: reportPath,
      }
      const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
      try {
        Object.assign(process.env, values)
        process.dlopen({ exports: {} }, addonPath)
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }, { windowId: identity.windowId, addonPath, reportPath })
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    if (report.error) throw new Error(`Native window controls probe: ${report.error}`)
    return { windowId: identity.windowId, ...report }
  } finally { await rm(reportDirectory, { recursive: true, force: true }) }
}

// Rectangles use AppKit points (DIP), relative to the outer window's top-left.
// A missing standard button is null; hidden is the real NSButton flag.
export async function measureNativeWindowControls(electron, windowId) {
  const result = measurements.then(() => measure(electron, windowId))
  measurements = result.catch(() => {})
  return result
}
