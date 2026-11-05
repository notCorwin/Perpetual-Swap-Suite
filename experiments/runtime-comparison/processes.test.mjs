import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import { findAppPids } from './measurement/index.mjs'
import { registerProcess, stop } from './processes.mjs'

const execute = promisify(execFile)

test('cleans up a LaunchServices app without readiness after its launcher exits', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-compare-lifecycle-'))
  const bundlePath = join(directory, 'Stalled Comparison.app')
  let controller, pid
  try {
    await mkdir(join(bundlePath, 'Contents/MacOS'), { recursive: true })
    // No NSApplication, window, activation or readiness message is created.
    const source = join(directory, 'stalled.c')
    await writeFile(source, '#include <unistd.h>\nint main(void) { for (;;) pause(); }\n')
    await writeFile(join(bundlePath, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>stalled</string><key>CFBundleIdentifier</key><string>com.perpetualswapsuite.comparison.stall</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/><key>LSUIElement</key><false/></dict></plist>')
    await execute('/usr/bin/xcrun', ['clang', source, '-o', join(bundlePath, 'Contents/MacOS/stalled')])
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', bundlePath])
    const child = spawn('/usr/bin/open', ['-n', '-g', '-W', bundlePath], { stdio: 'ignore' })
    controller = registerProcess({ child, bundlePath })
    for (let tries = 0; tries < 30 && !pid; tries++) { ;[pid] = await findAppPids(bundlePath); if (!pid) await delay(100) }
    assert.ok(pid, 'LaunchServices must identify an app before readiness')
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
    assert.doesNotThrow(() => process.kill(pid, 0), 'The app outlives its open -W launcher')
    const result = await stop(controller)
    assert.equal(result.forced, false)
    assert.deepEqual(await findAppPids(bundlePath), [])
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    if (controller) await stop(controller).catch(() => {})
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    await rm(directory, { recursive: true, force: true })
  }
})

test('interruption cleanup reaps owned child processes before exiting', { timeout: 10000 }, async () => {
  const moduleURL = new URL('./processes.mjs', import.meta.url).href
  const code = `
    import { spawn } from 'node:child_process';
    import { registerProcess, installInterruptionCleanup } from ${JSON.stringify(moduleURL)};
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    registerProcess({ child });
    installInterruptionCleanup(async () => {});
    console.log(child.pid);
    setInterval(() => {}, 1000);
  `
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] })
  let pid
  try {
    const lines = createInterface({ input: parent.stdout })
    ;[pid] = await once(lines, 'line'); pid = Number(pid); lines.close()
    const exit = once(parent, 'exit')
    parent.kill('SIGINT')
    assert.equal((await exit)[0], 130)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
  }
})
