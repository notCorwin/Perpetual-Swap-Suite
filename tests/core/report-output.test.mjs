import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join, resolve } from 'node:path'
import { reportOutput } from '../../scripts/report-output.mjs'

test('diagnostic output requires an explicit persistent destination', async () => {
  const before = process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR
  delete process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR
  try {
    await assert.rejects(reportOutput(undefined, 'bench.json', '--output'), /Specify --output/)
    assert.equal(await reportOutput('user/result.json', 'bench.json', '--output'), resolve('user/result.json'))
    await assert.rejects(reportOutput('.build/in-use.json', 'bench.json', '--output'), /\.build/)
    process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR = '/tmp/explicit-report'
    assert.equal(await reportOutput(undefined, 'bench.json', '--output'), join('/tmp/explicit-report', 'bench.json'))
    assert.equal(await reportOutput('other.json', 'bench.json', '--output'), resolve('other.json'))
  } finally {
    if (before === undefined) delete process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR
    else process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR = before
  }
})
