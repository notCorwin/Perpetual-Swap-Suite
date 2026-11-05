import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { snapshotProcessTree, startSampling } from './index.mjs'

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
    const before = await getUsage()
    await delay(1200)
    const after = await getUsage()
    const result = await sampler.stop()
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
