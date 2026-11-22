import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runBuildBenchmark } from '../../scripts/run-build-benchmark.mjs'

test('benchmark entrypoints require a safe report destination before building', async () => {
  for (const target of ['chart', 'instruments', 'okx']) {
    const calls = []
    const run = (...args) => { calls.push(args) }
    await assert.rejects(runBuildBenchmark(target, [], {}, run), /Specify --output/)
    assert.deepEqual(calls, [])
    await assert.rejects(runBuildBenchmark(target, ['--output', '.build/report'], {}, run), /\.build/)
    assert.deepEqual(calls, [])
    await assert.rejects(runBuildBenchmark(target, ['--output', '/tmp/first', '--output', '.build/second'], {}, run), /only once/)
    assert.deepEqual(calls, [])
  }
})

test('benchmark entrypoints forward the output and keep existing sandbox protections', async () => {
  for (const target of ['chart', 'instruments', 'okx']) {
    const calls = []
    await runBuildBenchmark(target, ['--output', '/tmp/benchmark-report'], {}, (...args) => { calls.push(args) })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0].slice(0, 2), ['npm', ['run', 'build']])
    assert.equal(calls[1][0], process.execPath)
    assert.ok(calls[1][1].includes('--desktop'))
    if (target === 'okx') {
      assert.ok(calls[1][1].includes('--allow-network'))
      assert.equal(calls[1][2].OKX_LIVE_CHART_OUTPUT, '/tmp/benchmark-report')
    } else assert.deepEqual(calls[1][1].slice(-2), ['--output', '/tmp/benchmark-report'])
  }
})
