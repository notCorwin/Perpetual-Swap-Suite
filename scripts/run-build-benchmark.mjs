#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reportOutput } from './report-output.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const targets = {
  chart: { script: 'scripts/chart-scroll-performance.mjs', file: 'chart-scroll-performance.json' },
  instruments: { script: 'scripts/instrument-navigation-benchmark.mjs', file: 'instrument-navigation.json' },
  okx: { script: 'scripts/okx-live-chart.mjs', file: 'okx-live-chart' },
}

function outputArgument(args) {
  let result
  for (let index = 0; index < args.length; index++) {
    let output
    if (args[index] === '--output') {
      output = args[++index]
      if (!output || output.startsWith('--')) throw new Error('--output requires a path.')
    } else if (args[index].startsWith('--output=')) {
      output = args[index].slice('--output='.length)
      if (!output) throw new Error('--output requires a path.')
    }
    if (output !== undefined) {
      if (result !== undefined) throw new Error('Specify --output only once.')
      result = output
    }
  }
  return result
}

function run(command, args, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit' })
    const onInterrupt = () => child.kill('SIGINT')
    const onTerminate = () => child.kill('SIGTERM')
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    const detach = () => { process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate) }
    child.once('error', error => { detach(); reject(error) })
    child.once('close', (code, signal) => { detach(); code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal || code}).`)) })
  })
}

// Check the destination before an expensive build or a protected Electron run.
export async function runBuildBenchmark(target, args, environment = process.env, execute = run) {
  const config = targets[target]
  if (!config) throw new Error('Choose chart, instruments, or okx.')
  const requested = outputArgument(args) || (target === 'okx' ? environment.OKX_LIVE_CHART_OUTPUT : undefined)
  // Do not inherit a stale sandbox report directory from an unrelated command.
  if (!requested) throw new Error(target === 'okx'
    ? 'Specify --output DIRECTORY or set OKX_LIVE_CHART_OUTPUT before running the OKX chart test.'
    : 'Specify --output FILE before running the benchmark.')
  await reportOutput(requested, config.file, '--output')
  const testEnv = { ...environment }
  let forwarded = args
  if (target === 'okx') {
    testEnv.OKX_LIVE_CHART_OUTPUT = requested
    forwarded = []
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--output') { index++; continue }
      if (args[index].startsWith('--output=')) continue
      forwarded.push(args[index])
    }
    if (forwarded.length) throw new Error(`Unknown OKX chart arguments: ${forwarded.join(' ')}`)
  }
  await execute('npm', ['run', 'build'], environment)
  const flags = target === 'okx' ? ['--allow-network', '--scenario', 'okx-live-chart',
    ...['network', 'database', 'cpu', 'io', 'ipc'].flatMap(value => ['--require-category', value]),
    ...['electron-main', 'renderer', 'market-backend', 'market-reader', 'market-writer', 'prepared-chart'].flatMap(value => ['--require-role', value])] : []
  await execute(process.execPath, ['scripts/test-sandbox.mjs', 'command', '--desktop', ...flags, '--', config.script, ...forwarded], testEnv)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBuildBenchmark(process.argv[2], process.argv.slice(3)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
