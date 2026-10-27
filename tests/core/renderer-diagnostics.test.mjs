import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { startRendererDiagnostics } from '../../scripts/renderer-diagnostics.mjs'

const execute = promisify(execFile)

for (const cpuProfile of [true, false]) test(`${cpuProfile ? 'CPU and timeline' : 'timeline-only'} diagnostics retain reloaded clocks and stop once`, async () => {
  const output = await mkdtemp(join(tmpdir(), 'renderer-diagnostics-'))
  const page = new EventEmitter()
  let clock = { timeOrigin: 1000, now: 20, wallTime: 1020, url: 'app://first' }, stops = 0, detachments = 0
  page.evaluate = async () => ({ ...clock })
  page.context = () => { assert.equal(cpuProfile, true, 'Timeline-only diagnostics must not initialize the CPU profiler.'); return { newCDPSession: async () => ({
    send: async method => method === 'Profiler.stop' ? { profile: { nodes: [], samples: [] } } : undefined,
    detach: async () => { detachments += 1 },
  }) } }
  const electron = { evaluate: async (_callback, path) => {
    if (!path) return
    stops += 1
    await writeFile(path, '[]')
    return { file: path, bufferUsage: { percentage: .2 } }
  } }
  try {
    const stop = await startRendererDiagnostics(electron, page, output, cpuProfile ? undefined : { cpuProfile: false })
    clock = { timeOrigin: 2000, now: 5, wallTime: 2005, url: 'app://reloaded' }
    page.emit('domcontentloaded')
    await Promise.all([stop(), stop()])
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    assert.equal(manifest.diagnosticOnly, true)
    assert.equal(manifest.cpuProfileRequested, cpuProfile)
    assert.equal(manifest.cpuProfileComplete, cpuProfile ? true : null)
    if (cpuProfile) assert.deepEqual(JSON.parse(await readFile(join(output, 'renderer.cpuprofile'), 'utf8')), { nodes: [], samples: [] })
    else await assert.rejects(access(join(output, 'renderer.cpuprofile')), { code: 'ENOENT' })
    assert.deepEqual(manifest.errors, [])
    assert.deepEqual(manifest.documentClocks, [
      { phase: 'profile-start', timeOrigin: 1000, now: 20, wallTime: 1020, url: 'app://first' },
      { phase: 'domcontentloaded', ...clock }, { phase: 'profile-stop', ...clock },
    ])
    assert.equal(stops, 1)
    assert.equal(detachments, cpuProfile ? 1 : 0)
    assert.equal(page.listenerCount('domcontentloaded'), 0)
  } finally { await rm(output, { recursive: true, force: true }) }
})

for (const benchmark of ['resource', 'traffic']) for (const [name, diagnosticDirectory, args, message] of [
  ['normal acceptance rejects inherited profiling', 'separate-profile', [], new RegExp(`Normal ${benchmark} acceptance rejects renderer profiling`)],
  ['explicit diagnostics require a separate output', '', ['--diagnostic'], /--diagnostic requires PERPETUAL_SWAP_RENDERER_DIAGNOSTICS/],
]) test(`${benchmark}: ${name}`, async () => {
  await assert.rejects(execute(process.execPath, [`scripts/market-${benchmark}-benchmark.mjs`, ...(benchmark === 'resource' ? ['--offscreen'] : []), ...args], {
    cwd: new URL('../..', import.meta.url), env: { ...process.env, PERPETUAL_SWAP_RENDERER_DIAGNOSTICS: diagnosticDirectory },
  }), error => error.code === 1 && message.test(error.stderr))
})
