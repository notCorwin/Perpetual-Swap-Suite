import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { intervalFor, snapshotProcessTree, startSampling } from './index.mjs'

test('samples a controlled process tree, separate backend, CPU time and energy', { timeout: 15000 }, async () => {
  const source = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('message', m => {
      if (m === 'usage') process.send({ type: 'usage', usage: process.cpuUsage() });
      if (m === 'stop') { grandchild.once('exit', () => process.exit()); grandchild.kill(); }
    });
    process.send({ type: 'ready', pid: grandchild.pid });
    function burn() { const end = Date.now() + 4; while (Date.now() < end) Math.sqrt(Math.random()); setImmediate(burn); }
    burn();
  `
  const target = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const backend = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  let grandchildPid, sampler
  try {
    const [ready] = await once(target, 'message')
    assert.equal(ready.type, 'ready')
    grandchildPid = ready.pid
    const samples = []
    sampler = await startSampling({ rootPids: [target.pid, backend.pid], intervalMS: 500, samples })
    const getUsage = async () => { target.send('usage'); const [message] = await once(target, 'message'); return message.usage }
    await sampler.sampleBoundary('start')
    const before = await getUsage()
    await delay(1200)
    const after = await getUsage()
    await sampler.sampleBoundary('end')
    const result = await sampler.stop()
    assert.equal(samples.filter(sample => sample.boundary === 'start').length, 1)
    assert.equal(samples.filter(sample => sample.boundary === 'end').length, 1)
    const measured = samples.find(sample => sample.boundary === 'end').interval.runtime.breakdown
    for (const metric of Object.values(measured)) if (metric.complete) assert.equal(BigInt(metric.totalExact), BigInt(metric.pCoreExact) + BigInt(metric.eCoreExact))
    assert.equal(result.samples, samples)
    assert.ok(samples.length >= 3)
    const first = samples[0], last = samples.at(-1)
    const root = last.processes.find(p => p.pid === target.pid)
    const grandchild = last.processes.find(p => p.pid === grandchildPid)
    assert.equal(root.group, 'runtime')
    assert.equal(grandchild.group, 'runtime')
    assert.equal(last.processes.find(p => p.pid === backend.pid).group, 'backend')
    assert.equal(last.missingPids.length, 0)
    assert.ok(root.counters.residentBytes > 0 && root.counters.physicalFootprintBytes > 0)
    assert.ok(last.frontmostPid === null || Number.isInteger(last.frontmostPid))
    const start = first.processes.find(p => p.pid === target.pid).counters
    const finish = root.counters
    const nativeCpuNs = (finish.cpuUserNs - start.cpuUserNs) + (finish.cpuSystemNs - start.cpuSystemNs)
    const nodeCpuNs = ((after.user - before.user) + (after.system - before.system)) * 1000
    assert.ok(nodeCpuNs > 100_000_000, `Expected sustained CPU work, observed ${nodeCpuNs} ns`)
    assert.ok(Math.abs(nativeCpuNs - nodeCpuNs) < Math.max(100_000_000, nodeCpuNs * 0.3), `Mach-converted CPU ${nativeCpuNs} ns, process.cpuUsage() ${nodeCpuNs} ns`)
    if (last.cpuEnergySupported) {
      assert.ok(BigInt(finish.cpuEnergyNjExact) > BigInt(start.cpuEnergyNjExact))
      assert.ok(last.interval.runtime.cpuEnergyJoules >= 0)
    }
    const overlap = await snapshotProcessTree({ rootPids: [target.pid], extraPids: [grandchildPid] })
    assert.equal(overlap.processes.find(p => p.pid === grandchildPid).group, 'backend')
    assert.equal(overlap.totals.combined.processCount, overlap.totals.runtime.processCount + overlap.totals.backend.processCount)
    console.log(`CPU calibration: proc_pid_rusage=${nativeCpuNs} ns; process.cpuUsage=${nodeCpuNs} ns; timebase=${last.timebase.numer}/${last.timebase.denom}; cpu energy supported=${last.cpuEnergySupported}`)
  } finally {
    if (sampler) await sampler.stop().catch(() => {})
    if (target.exitCode === null && target.connected) {
      const exited = once(target, 'exit')
      target.send('stop')
      await Promise.race([exited, delay(1000)])
    }
    if (target.exitCode === null && target.signalCode === null) target.kill()
    if (backend.exitCode === null && backend.signalCode === null) backend.kill()
  }
})

test('marks an interval incomplete when a sampled child exits', { timeout: 10000 }, async () => {
  const source = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('message', () => child.kill());
    process.send(child.pid);
    setInterval(() => {}, 1000);
  `
  const target = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  let sampler, childPid
  try {
    ;[childPid] = await once(target, 'message')
    sampler = await startSampling({ rootPids: [target.pid], intervalMS: 500 })
    assert.ok(sampler.samples[0].processes.some(process => process.pid === childPid))
    target.send('stop-child')
    await delay(650)
    const result = await sampler.stop()
    const interval = result.samples.find(sample => sample.interval?.disappearedPids.includes(childPid))?.interval
    assert.ok(interval, 'The disappearance must be recorded, not silently excluded')
    assert.equal(interval.runtime.complete, false)
    assert.equal(interval.runtime.cpuNs, null)
    assert.equal(interval.runtime.cpuEnergyJoules, null)
    assert.equal(interval.combined.complete, false)
  } finally {
    await sampler?.stop().catch(() => {})
    if (childPid) { try { process.kill(childPid) } catch {} }
    target.kill()
  }
})

test('serializes boundary requests with stop', { timeout: 10000 }, async () => {
  const sampler = await startSampling({ rootPids: [process.pid], includeWebKit: false })
  const start = sampler.sampleBoundary('start')
  const end = sampler.sampleBoundary('end')
  const stop = sampler.stop()
  await Promise.all([start, end])
  const result = await stop
  assert.deepEqual(result.samples.filter(sample => sample.boundary).map(sample => sample.boundary), ['start', 'end'])
  await assert.rejects(sampler.sampleBoundary('start'), /stopped/)
})


test('keeps counter availability independent and marks both sides of group migration', () => {
  const snapshot = (end, group, user, energy) => ({ sampleStartMonotonicNsExact: String(end - 1), sampleEndMonotonicNsExact: String(end),
    cpuEnergySupported: false, cpuCyclesSupported: true, cpuInstructionsSupported: true,
    cpuPTimeSupported: true, cpuPEnergySupported: false, cpuPCyclesSupported: true, cpuPInstructionsSupported: true,
    processes: [{ pid: 42, birthIdentity: '42:1:0', group, counters: {
      startMonotonicNsExact: '1', cpuUserNsExact: String(user), cpuSystemNsExact: '0',
      cpuPUserNsExact: '0', cpuPSystemNsExact: '0', cpuEnergyNjExact: String(energy), cpuPEnergyNjExact: String(energy / 2),
      cpuCyclesExact: String(energy), cpuPCyclesExact: String(energy / 2), cpuInstructionsExact: String(energy), cpuPInstructionsExact: String(energy / 2),
    } }] })
  const old = snapshot(100, 'runtime', 10, 10), current = snapshot(200, 'runtime', 8, 20)
  const result = intervalFor(old, current).runtime
  assert.equal(result.complete, true)
  assert.equal(result.cpuNsExact, null)
  assert.equal(result.cpuEnergyNjExact, '10')
  assert.equal(result.breakdown.cpuEnergyNj.pCoreExact, '5')
  assert.equal(result.breakdown.cpuCycles.totalExact, '10')
  const moved = intervalFor(old, snapshot(200, 'backend', 20, 20))
  assert.equal(moved.runtime.complete, false)
  assert.equal(moved.backend.complete, false)
  assert.equal(moved.combined.complete, true)
  assert.equal(moved.combined.cpuEnergyNjExact, '10')
})

test('counts periodic deadlines missed while a boundary is sampled', { timeout: 10000 }, async () => {
  const sampler = await startSampling({ rootPids: [process.pid], includeWebKit: false, intervalMS: 500,
    onSample: async sample => { if (sample.boundary === 'start') await delay(600) } })
  try {
    await sampler.sampleBoundary('start')
    const result = await sampler.stop()
    assert.ok(result.skippedSamples >= 1)
  } finally { await sampler.stop().catch(() => {}) }
})


test('counts deadlines before stop while a boundary remains in flight', { timeout: 10000 }, async () => {
  const sampler = await startSampling({ rootPids: [process.pid], includeWebKit: false, intervalMS: 500,
    onSample: async sample => { if (sample.boundary === 'start') await delay(700) } })
  const boundary = sampler.sampleBoundary('start')
  await delay(550)
  const stop = sampler.stop()
  await boundary
  const result = await stop
  assert.ok(result.skippedSamples >= 1)
})

test('validates Mach ticks before conversion and records the rounding remainder', () => {
  const snapshot = (end, total, pcore) => ({ sampleStartMonotonicNsExact: String(end - 1), sampleEndMonotonicNsExact: String(end),
    timebase: { numer: 125, denom: 3 }, cpuPTimeSupported: true,
    processes: [{ pid: 42, birthIdentity: '42:1:0', group: 'runtime', counters: {
      startMonotonicNsExact: '1', cpuUserTicksExact: String(total), cpuSystemTicksExact: '0', cpuPUserTicksExact: String(pcore), cpuPSystemTicksExact: '0',
      cpuUserNsExact: String(Math.floor(total * 125 / 3)), cpuSystemNsExact: '0', cpuPUserNsExact: String(Math.floor(pcore * 125 / 3)), cpuPSystemNsExact: '0',
    } }] })
  const before = snapshot(100, 2, 1), after = snapshot(200, 4, 3)
  const valid = intervalFor(before, after).runtime.breakdown.cpuTimeNs
  assert.equal(valid.complete, true)
  assert.equal(valid.totalExact, '83')
  assert.equal(valid.pCoreExact, '83')
  assert.equal(valid.eCoreExact, '0')
  assert.equal(valid.totalTicksExact, '2')
  const remainder = intervalFor(before, snapshot(200, 4, 2)).runtime.breakdown.cpuTimeNs
  assert.equal(remainder.eCoreRoundingAdjustmentNsExact, '1')
  assert.equal(BigInt(remainder.pCoreExact) + BigInt(remainder.eCoreExact), BigInt(remainder.totalExact))
  const invalid = intervalFor(before, snapshot(200, 4, 4)).runtime.breakdown.cpuTimeNs
  assert.equal(invalid.complete, false)
  assert.equal(invalid.pCoreExact, null)
  assert.equal(invalid.totalExact, '83')
})
