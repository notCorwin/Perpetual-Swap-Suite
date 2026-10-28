import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installMainLoopWitness } from '../../scripts/main-loop-witness.mjs'
import { startProcessWitness } from '../support/process-witness.mjs'

function loopRuntime() {
  let wall = 0, callback, cancellations = 0
  const target = {}
  const runtime = { target, pid: 123, thread: { threadId: 0, isMainThread: true }, timeOriginMS: 1_000,
    now: () => wall, readCPU: () => ({ user: wall, system: 0 }),
    schedule: operation => { callback = operation; return 1 }, cancel: () => { cancellations++ } }
  return { runtime, target, fire: at => { wall = at; callback() }, get cancellations() { return cancellations } }
}
function electronHost(main, { installError, collectionError, driver } = {}) {
  let collections = 0
  return { get collections() { return collections }, evaluate: async (operation, options) => {
    if (operation === installMainLoopWitness) {
      const result = operation(null, { ...options, runtime: main.runtime })
      if (installError) throw installError
      return result
    }
    collections++
    assert.equal(driver.cancellations, 1, 'The Node timer must stop before the fallible Electron collection RPC.')
    if (collectionError) throw collectionError
    const witness = main.target.__mainLoopWitness
    if (!witness || witness.ownerId !== options.ownerId) {
      if (options.starting) return {}
      throw new Error('Owned remote witness missing')
    }
    return { mainLoop: witness.stop(), writers: [{ role: 'electron-main', selfTiming: {} }] }
  } }
}

test('process witness retains aligned independently owned Node and Electron evidence exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'process-witness-')), driver = loopRuntime(), main = loopRuntime()
  const electron = electronHost(main, { driver })
  try {
    const stop = await startProcessWitness(electron, 'fixture', { capacity: 6_002, directory, driverRuntime: driver.runtime })
    driver.fire(20); main.fire(20); driver.fire(40); main.fire(170)
    const pending = stop()
    assert.equal(stop(), pending)
    const report = await pending
    assert.equal(report.complete, true)
    assert.equal(electron.collections, 1)
    assert.equal(driver.cancellations, 1)
    assert.equal(main.cancellations, 1)
    assert.equal(report.nodeDriverLoop.role, 'node-driver')
    assert.equal(report.mainLoop.role, 'electron-main')
    assert.equal(report.nodeDriverLoop.ownerId, report.mainLoop.ownerId)
    assert.equal(report.nodeDriverLoop.intervalMS, 20)
    assert.equal(report.nodeDriverLoop.capacity, 6_002)
    assert.equal(report.nodeDriverLoop.samples[2].callbackAtMS, 40)
    assert.equal(report.mainLoop.samples[2].callbackAtMS, 170)
    assert.deepEqual(JSON.parse(await readFile(report.artifact, 'utf8')), report)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Electron collection failure still finalizes and writes independent driver evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'process-witness-')), driver = loopRuntime(), main = loopRuntime()
  const failure = new Error('Electron closed'), electron = electronHost(main, { driver, collectionError: failure })
  try {
    const stop = await startProcessWitness(electron, 'failed-collection', { directory, driverRuntime: driver.runtime })
    let retained
    await assert.rejects(stop(), error => {
      assert.equal(error.cause, failure)
      assert.equal(error.processWitness.complete, false)
      assert.equal(error.processWitness.nodeDriverLoop.samples.at(-1).kind, 'stop')
      assert.equal(error.processWitness.nodeDriverLoop.complete, true)
      assert.equal(error.processWitness.mainLoop, undefined)
      retained = error.processWitness
      return true
    })
    assert.deepEqual(JSON.parse(await readFile(retained.artifact, 'utf8')), retained)
    assert.equal(driver.cancellations, 1)
    assert.equal(electron.collections, 1)
  } finally { main.target.__mainLoopWitness?.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('a failed partial start releases both owned timers and retains the original error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'process-witness-')), driver = loopRuntime(), main = loopRuntime()
  const failure = new Error('Lost install reply'), electron = electronHost(main, { driver, installError: failure })
  try {
    await assert.rejects(startProcessWitness(electron, 'partial-start', { directory, driverRuntime: driver.runtime }), error => {
      assert.equal(error.cause, failure)
      assert.equal(error.errors[0], failure)
      assert.equal(error.processWitness.nodeDriverLoop.complete, true)
      assert.equal(error.processWitness.mainLoop.complete, true)
      assert.deepEqual(error.processWitness.collectionErrors.map(error => error.stage), ['start-electron'])
      return true
    })
    assert.equal(driver.cancellations, 1)
    assert.equal(main.cancellations, 1)
    assert.equal(main.target.__mainLoopWitness, undefined)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a rejected duplicate start cannot stop another caller and preserves collection and artifact failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'process-witness-')), driver = loopRuntime(), main = loopRuntime()
  try {
    await writeFile(join(directory, 'file'), '')
    installMainLoopWitness(null, { ownerId: 'existing', runtime: main.runtime })
    const electron = electronHost(main, { driver })
    await assert.rejects(startProcessWitness(electron, 'duplicate', { directory: join(directory, 'file', 'child'), driverRuntime: driver.runtime }), error => {
      assert.match(error.errors[0].message, /already installed/)
      assert.equal(error.errors.length, 2)
      assert.deepEqual(error.processWitness.collectionErrors.map(error => error.stage), ['start-electron', 'write-artifact'])
      return true
    })
    assert.equal(driver.cancellations, 1)
    assert.equal(main.cancellations, 0)
    assert.equal(main.target.__mainLoopWitness.ownerId, 'existing')
  } finally { main.target.__mainLoopWitness?.stop(); await rm(directory, { recursive: true, force: true }) }
})

test('original start and subsequent collection failures are both retained', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'process-witness-')), driver = loopRuntime(), main = loopRuntime()
  const first = new Error('Start failed'), second = new Error('Collection failed')
  try {
    await assert.rejects(startProcessWitness(electronHost(main, { driver, installError: first, collectionError: second }), 'both-failed',
      { directory, driverRuntime: driver.runtime }), error => {
      assert.deepEqual(error.errors, [first, second])
      assert.equal(error.processWitness.nodeDriverLoop.complete, true)
      return true
    })
    assert.equal(driver.cancellations, 1)
  } finally { main.target.__mainLoopWitness?.stop(); await rm(directory, { recursive: true, force: true }) }
})
