import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { _electron } from 'playwright'

test('a hidden Electron app exits when its runner dies even while the Playwright parent is alive', { timeout: 25_000 }, async t => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-electron-owner-'))
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(owner, 'spawn')
  const ownerExit = once(owner, 'exit')
  let electron, child
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
    await ownerExit
    if (child && child.exitCode === null && child.signalCode === null) await electron.close()
    await rm(userData, { recursive: true, force: true })
  })
  electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_TEST_UI: 'background',
      PERPETUAL_SWAP_USER_DATA: userData, PERPETUAL_SWAP_TEST_OWNER_PID: String(owner.pid) } })
  child = electron.process()
  const exited = once(child, 'exit')
  const page = await electron.firstWindow()
  await page.getByRole('heading', { name: 'Perpetual Swap Suite', exact: true }).waitFor()
  const native = await electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), alwaysOnTop: window.isAlwaysOnTop() }
  })
  assert.deepEqual(native, { visible: false, focused: false, focusable: false, alwaysOnTop: false })
  owner.kill('SIGKILL')
  await ownerExit
  assert.deepEqual(await exited, [0, null], 'Owner loss must shut down and flush the actual app normally.')
})
