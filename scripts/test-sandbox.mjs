#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { operationReportHasFailures, writeOperationReport } from './operation-report.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const registration = fileURLToPath(new URL('./sandbox-register.mjs', import.meta.url))
const signalExit = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }
const git = args => { const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' }); return result.status === 0 ? result.stdout.trim() : null }
const node = args => [process.execPath, '--import', registration, ...args]
const npm = args => [process.platform === 'win32' ? 'npm.cmd' : 'npm', ...args]

async function testFiles(directory, suffix) {
  const files = (await readdir(join(projectRoot, directory))).filter(file => file.endsWith(suffix)).sort().map(file => join(directory, file))
  if (!files.length) throw new Error(`No ${suffix} tests found in ${directory}.`)
  return files
}
export async function sandboxCommands(mode, args = []) {
  if (mode === 'command') {
    if (!args.length) throw new Error('command requires an executable after --.')
    // Use the project's supported runtime even when the shell resolves another
    // Node, and install recording before any application module is imported.
    return [basename(args[0]).replace(/\.exe$/, '') === 'node' || resolve(args[0]) === process.execPath ? node(args.slice(1)) : args]
  }
  if (!['core', 'e2e', 'foreground', 'all'].includes(mode) || args.length) throw new Error('Usage: node scripts/test-sandbox.mjs core|e2e|foreground|all|command [--foreground] [--allow-network] [--gpu-trace] [--output PATH] [-- COMMAND ARGS...]')
  const commands = []
  if (mode === 'core' || mode === 'all') commands.push(node(['--experimental-strip-types', '--test', ...await testFiles('src', '.test.ts'), ...await testFiles('tests/core', '.test.mjs')]))
  if (mode !== 'core') commands.push(npm(['run', 'build']), node(['--test-concurrency=1', '--test', ...await testFiles('tests/e2e', mode === 'foreground' ? '.foreground.mjs' : '.e2e.mjs')]))
  return commands
}

function execute(command, { environment, logPath, onChild }) {
  return new Promise(resolveResult => {
    const log = createWriteStream(logPath)
    const child = spawn(command[0], command.slice(1), { cwd: projectRoot, env: environment, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'] })
    onChild(child)
    let logError = null
    log.on('error', error => { logError = error.message })
    child.stdout.pipe(process.stdout, { end: false }); child.stdout.pipe(log, { end: false })
    child.stderr.pipe(process.stderr, { end: false }); child.stderr.pipe(log, { end: false })
    let launchError = null
    child.on('error', error => { launchError = error.message; console.error(error.message) })
    child.on('close', (code, signal) => {
      onChild(null)
      log.end(() => resolveResult({ code: code ?? signalExit[signal] ?? 1, signal, launchError, logError }))
    })
  })
}

export async function runSandbox({ mode = 'core', args = [], output, allowNetwork = false, gpuTrace = false, foreground = false } = {}) {
  const commands = await sandboxCommands(mode, args)
  const id = `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`
  const directory = output ? resolve(output, id) : join(projectRoot, '.build/sandbox', id)
  const operations = join(directory, 'operations'), temporary = join(directory, 'tmp'), userData = join(directory, 'user-data')
  await Promise.all([operations, temporary, userData].map(path => mkdir(path, { recursive: true })))
  const presentation = foreground || mode === 'foreground' ? 'foreground' : 'background'
  const environment = { ...process.env, PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_TEST_UI: presentation, PERPETUAL_SWAP_ALLOW_NETWORK: allowNetwork ? '1' : '0',
    PERPETUAL_SWAP_GPU_TRACE: gpuTrace ? '1' : '0', PERPETUAL_SWAP_OPERATION_DIR: operations, PERPETUAL_SWAP_OPERATION_SESSION: id,
    PERPETUAL_SWAP_USER_DATA: userData, TMPDIR: temporary, TMP: temporary, TEMP: temporary }
  const manifest = { schemaVersion: 1, id, mode, startedAt: new Date().toISOString(), directory,
    revision: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])),
    runtime: { node: process.version, electron: process.versions.electron ?? null, platform: platform(), arch: arch() },
    environment: { sandbox: true, presentation, network: allowNetwork ? 'live explicitly enabled' : 'loopback and injected fixtures only', nativeGpuTrace: gpuTrace, operationDirectory: operations, temporaryDirectory: temporary, userDataDirectory: userData },
    commands: commands.map(command => ({ command, status: 'pending' })), outcome: { status: 'running' } }
  const save = () => writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await save()
  console.log(`Sandbox: ${directory}`)
  console.log(`Test windows: ${presentation}${presentation === 'background' ? '; native foreground paint acceptance is separate (npm run test:foreground)' : ' (may show windows and take focus)'}.`)
  let exitCode = 0, activeChild = null, interrupted = null, killTimer
  const stopChild = signal => {
    if (!activeChild?.pid) return
    try {
      // A test may own Electron and native helper grandchildren. Stop its
      // dedicated group so cancellation cannot leave market work running.
      if (process.platform === 'win32') activeChild.kill(signal)
      else process.kill(-activeChild.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') console.error(`Sandbox shutdown: ${error.message}`) }
  }
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
    interrupted = signal; stopChild(signal)
    if (!killTimer) { killTimer = setTimeout(() => stopChild('SIGKILL'), 10_000); killTimer.unref() }
  }]))
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler)
  try {
    for (let index = 0; index < commands.length; index++) {
      if (interrupted) { exitCode = signalExit[interrupted]; break }
      const record = manifest.commands[index]
      record.status = 'running'; record.startedAt = new Date().toISOString(); await save()
      const result = await execute(commands[index], { environment, logPath: join(directory, `command-${index + 1}.log`), onChild: child => { activeChild = child } })
      Object.assign(record, result, { endedAt: new Date().toISOString(), status: result.code === 0 ? 'passed' : 'failed' })
      await save()
      if (result.code !== 0) { exitCode = result.code; break }
    }
  } catch (error) {
    exitCode ||= 1; manifest.runnerError = error.message; console.error(error.stack ?? error.message)
  } finally {
    clearTimeout(killTimer)
    for (const [signal, handler] of Object.entries(handlers)) process.removeListener(signal, handler)
    if (interrupted) exitCode = signalExit[interrupted]
    manifest.endedAt = new Date().toISOString()
    manifest.outcome = { status: interrupted ? 'interrupted' : exitCode ? 'failed' : 'passed', exitCode, signal: interrupted }
    try {
      const report = await writeOperationReport(directory)
      manifest.recordedOperations = report.totals.count
      console.log(`Operations: ${report.totals.count}; errors: ${report.totals.errors}; cancelled: ${report.totals.cancelled}. Report: ${join(directory, 'summary.md')}`)
      if (operationReportHasFailures(report)) {
        console.error('The operation recording is incomplete or invalid; see summary.json.')
        if (!exitCode) { exitCode = 1; manifest.outcome.status = 'failed'; manifest.outcome.exitCode = exitCode }
      }
    } catch (error) {
      manifest.reportError = error.message; console.error(`Operation report failed: ${error.message}`)
      // Preserve test/command failures. A successful test with no reviewable
      // report is itself an unsuccessful sandbox run.
      if (!exitCode) { exitCode = 1; manifest.outcome.status = 'failed'; manifest.outcome.exitCode = exitCode }
    }
    await save()
  }
  return { directory, exitCode, manifest }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = process.argv.slice(2), mode = input.shift() ?? 'core'
    let allowNetwork = false, gpuTrace = false, foreground = false, output
    while (input.length && input[0] !== '--') {
      const flag = input.shift()
      if (flag === '--allow-network') allowNetwork = true
      else if (flag === '--foreground') foreground = true
      else if (flag === '--gpu-trace') gpuTrace = true
      else if (flag === '--output' && input.length) output = input.shift()
      else throw new Error(`Unknown sandbox option: ${flag}`)
    }
    if (input[0] === '--') input.shift()
    const result = await runSandbox({ mode, args: input, output, allowNetwork, gpuTrace, foreground })
    process.exitCode = result.exitCode
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
}
