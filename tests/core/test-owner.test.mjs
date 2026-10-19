import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { startTestOwnerWatchdog } from '../../electron/test-owner.js'

async function ownerProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  return { child, exited }
}

test('SIGKILL of either real Node owner ends monitoring once while the other owner remains alive', { timeout: 5_000 }, async t => {
  for (const source of ['runner', 'parent']) {
    await t.test(source, async t => {
      const { child, exited } = await ownerProcess(t)
      const losses = []
      let resolveLoss
      const lost = new Promise(resolve => { resolveLoss = resolve })
      const stop = startTestOwnerWatchdog({
        ownerPID: source === 'runner' ? String(child.pid) : process.pid,
        parentPID: source === 'parent' ? child.pid : process.pid,
        intervalMS: 10,
        onOwnerLost: owner => { losses.push(owner); resolveLoss(owner) },
      })
      t.after(stop)
      await delay(25)
      assert.deepEqual(losses, [], 'A live owner must not terminate the app.')
      child.kill('SIGKILL')
      assert.equal((await exited)[1], 'SIGKILL')
      assert.deepEqual(await lost, { pid: child.pid, source })
      await delay(35)
      assert.equal(losses.length, 1, 'Later checks cannot request another shutdown.')
      assert.doesNotThrow(() => process.kill(process.pid, 0))
    })
  }
})

test('disposal cancels monitoring before a real owner exits', { timeout: 5_000 }, async t => {
  const { child, exited } = await ownerProcess(t)
  const losses = []
  const stop = startTestOwnerWatchdog({ ownerPID: child.pid, parentPID: 1, intervalMS: 10, onOwnerLost: owner => losses.push(owner) })
  t.after(stop)
  stop()
  stop()
  child.kill('SIGKILL')
  await exited
  await delay(35)
  assert.deepEqual(losses, [])
})

test('malformed explicit owner PIDs reject instead of probing a process group or PID 1', t => {
  const kill = t.mock.method(process, 'kill', () => { assert.fail('Invalid owners must never reach process.kill.') })
  for (const ownerPID of ['', ' ', '0', '1', '-1', '1.5', '2e3', 'NaN', '12oops', null, false, 0, 1, -2, 1.2, NaN, Infinity, 2 ** 31]) {
    assert.throws(() => startTestOwnerWatchdog({ ownerPID, parentPID: 1, onOwnerLost() {} }), /PERPETUAL_SWAP_TEST_OWNER_PID/)
  }
  assert.equal(kill.mock.callCount(), 0)
})

test('permission-denied owners remain alive and Finder parent PID 1 is never probed', async t => {
  const calls = [], losses = []
  t.mock.method(process, 'kill', (pid, signal) => {
    calls.push([pid, signal])
    throw Object.assign(new Error('Denied'), { code: 'EPERM' })
  })
  const stop = startTestOwnerWatchdog({ ownerPID: 23456, parentPID: 1, intervalMS: 10, onOwnerLost: owner => losses.push(owner) })
  t.after(stop)
  await delay(25)
  stop()
  assert.ok(calls.length >= 2)
  assert.ok(calls.every(([pid, signal]) => pid === 23456 && signal === 0))
  assert.deepEqual(losses, [])
})

test('the runner environment and launch parent are captured once and duplicate owners are probed once', async t => {
  const previous = process.env.PERPETUAL_SWAP_TEST_OWNER_PID
  t.after(() => {
    if (previous === undefined) delete process.env.PERPETUAL_SWAP_TEST_OWNER_PID
    else process.env.PERPETUAL_SWAP_TEST_OWNER_PID = previous
  })
  process.env.PERPETUAL_SWAP_TEST_OWNER_PID = '23456'
  const calls = []
  t.mock.method(process, 'kill', (pid, signal) => { calls.push([pid, signal]); return true })
  const stop = startTestOwnerWatchdog({ parentPID: 23456, intervalMS: 10, onOwnerLost() { assert.fail('The owner remains alive.') } })
  t.after(stop)
  assert.deepEqual(calls, [[23456, 0]])
  process.env.PERPETUAL_SWAP_TEST_OWNER_PID = '34567'
  await delay(25)
  stop()
  assert.ok(calls.length >= 2)
  assert.ok(calls.every(([pid, signal]) => pid === 23456 && signal === 0), 'Changing the environment must not replace a launch owner.')
})

test('an owner already gone is detected during startup and the watchdog never keeps Node alive', { timeout: 5_000 }, async t => {
  const { child, exited } = await ownerProcess(t)
  child.kill('SIGKILL')
  await exited
  const losses = []
  const stop = startTestOwnerWatchdog({ ownerPID: child.pid, parentPID: 1, onOwnerLost: owner => losses.push(owner) })
  t.after(stop)
  assert.deepEqual(losses, [{ pid: child.pid, source: 'runner' }])

  const moduleURL = new URL('../../electron/test-owner.js', import.meta.url).href
  const probe = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startTestOwnerWatchdog } from ${JSON.stringify(moduleURL)};
    startTestOwnerWatchdog({ ownerPID: process.ppid, parentPID: 1, onOwnerLost() { process.exitCode = 1 } });
  `], { stdio: ['ignore', 'ignore', 'pipe'] })
  const closed = once(probe, 'close')
  t.after(async () => {
    if (probe.exitCode === null && probe.signalCode === null) probe.kill('SIGKILL')
    await closed
  })
  let diagnostics = ''
  probe.stderr.on('data', chunk => { diagnostics += chunk })
  assert.deepEqual(await closed, [0, null], diagnostics)
})
