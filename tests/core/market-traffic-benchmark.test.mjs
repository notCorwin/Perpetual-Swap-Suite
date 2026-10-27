import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const benchmark = join(root, 'scripts/market-traffic-benchmark.mjs')

test('foreground market traffic mode rejects local use before app resolution or Electron launch', async () => {
  const guardedEnvironment = {
    PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_TEST_UI: 'foreground', PERPETUAL_SWAP_ALLOW_NETWORK: '0',
    PERPETUAL_SWAP_USER_DATA: join(tmpdir(), 'market-traffic-foreground-profile'), PERPETUAL_SWAP_TEST_GUARD: '',
    GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'macOS',
  }
  const priorArgv = process.argv
  const priorEnvironment = Object.fromEntries(Object.keys(guardedEnvironment).map(key => [key, process.env[key]]))
  try {
    process.argv = [process.execPath, benchmark, '--foreground', '--expect-optimized', '--baseline-report',
      join(tmpdir(), 'missing-market-traffic-baseline.json'), '--app-root', join(tmpdir(), 'missing-market-traffic-app')]
    Object.assign(process.env, guardedEnvironment)
    await assert.rejects(import(`${pathToFileURL(benchmark).href}?local-foreground-guard`),
      /Native foreground tests are restricted to GitHub-hosted macOS CI/)
  } finally {
    process.argv = priorArgv
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('--baseline-report rejects hidden/local comparison mode before app resolution', async () => {
  const guardedEnvironment = {
    PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_ALLOW_NETWORK: '0',
    PERPETUAL_SWAP_USER_DATA: join(tmpdir(), 'market-traffic-hidden-profile'), PERPETUAL_SWAP_TEST_GUARD: '/unused',
  }
  const priorArgv = process.argv
  const priorEnvironment = Object.fromEntries(Object.keys(guardedEnvironment).map(key => [key, process.env[key]]))
  try {
    process.argv = [process.execPath, benchmark, '--expect-optimized', '--baseline-report',
      join(tmpdir(), 'missing-market-traffic-baseline.json'), '--app-root', join(tmpdir(), 'missing-market-traffic-app')]
    Object.assign(process.env, guardedEnvironment)
    await assert.rejects(import(`${pathToFileURL(benchmark).href}?hidden-baseline-rejected`),
      /--baseline-report is supported only with --foreground/)
  } finally {
    process.argv = priorArgv
    for (const [key, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
