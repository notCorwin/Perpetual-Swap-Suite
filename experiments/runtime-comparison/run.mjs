import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { mkdir, writeFile, readFile, cp, access, readdir, rename } from 'node:fs/promises'
import { constants, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { prepareBackgroundApp } from '../../scripts/electron-test-runtime.mjs'
import { summarizeOperations, operationReportHasFailures } from '../../scripts/operation-report.mjs'
import { resourceCandle } from '../../electron/market-resource-fixtures.js'
import { buildIndicatorSeries, projectIndicatorCandle } from '../../electron/services/indicators.js'
import { assertRunning, registerProcess, stop, installInterruptionCleanup } from './processes.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url)), execute = promisify(execFile)
const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const smoke = args.includes('--smoke'), runtimeOption = option('--runtime', 'all'), rounds = Number(option('--rounds', smoke ? 1 : 3))
const count = Number(option('--count', smoke ? 8 : 287)), durationMS = Number(option('--duration-ms', smoke ? 1500 : 20000))
const scenarios = option('--scenarios', 'idle,realtime,history,download').split(',')
const variants = option('--variants', `${option('--transport', 'http')}:${option('--telemetry', 'full')}`).split(',').map(value => {
  const [transport, telemetry] = value.split(':')
  if (!['http', 'native'].includes(transport) || !['full', 'off'].includes(telemetry)) throw new Error('Invalid transport/telemetry variant.')
  return { transport, telemetry }
})
if (scenarios.some(value => !['idle', 'realtime', 'history', 'download'].includes(value)) || !scenarios.length) throw new Error('Invalid comparison scenarios.')
const diagnostics = args.includes('--diagnostics')
const backendWorkProbe = args.includes('--backend-work-probe') || Boolean(process.env.RADAR_BACKEND_WORK_PROBE)
const sampleStacks = args.includes('--sample-stacks'), v8Profile = args.includes('--v8-profile')
const engineProfile = args.includes('--engine-profile')
const marketEpochMS = Number(option('--market-epoch-ms', Math.floor(Date.now() / 900000) * 900000 + 1000))
if (!Number.isSafeInteger(marketEpochMS) || Math.abs(marketEpochMS - Date.now()) > 86400000) throw new Error('Market epoch must be an integer within one day.')
if (!['electron', 'tauri', 'all'].includes(runtimeOption) || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 5
  || !Number.isSafeInteger(count) || count < 1 || count > 1000 || !Number.isSafeInteger(durationMS) || durationMS < 500) throw new Error('Invalid comparison options.')
const directory = resolve(root, option('--output', `artifacts/runtime-comparison/${new Date().toISOString().replaceAll(':', '-')}`))
await mkdir(directory, { recursive: true })
const log = message => console.log(`${new Date().toISOString()} ${message}`)
const pause = ms => new Promise(done => setTimeout(done, ms))
async function fingerprint() {
  const files = {}
  const visit = async path => {
    for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.build', 'gen', 'target'].includes(entry.name)) continue
      const file = `${path}/${entry.name}`
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile() && !file.endsWith('.md')) files[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
    }
  }
  for (const path of ['dist/assets', 'electron', 'experiments/runtime-comparison']) await visit(path)
  for (const file of ['dist/index.html', 'package.json', 'package-lock.json']) files[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}
function comparePaths(reference, current) {
  let maxCoordinateDelta = 0
  if (reference.length !== current.length) return { compatible: false, reason: 'Indicator path count differs.' }
  for (let index = 0; index < reference.length; index++) {
    if (reference[index][0] !== current[index][0]) return { compatible: false, reason: 'Indicator path identities differ.' }
    const a = reference[index][1], b = current[index][1]
    if (typeof a !== 'string' || typeof b !== 'string') return { compatible: false, reason: 'An indicator path is missing.' }
    const expression = /[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi
    const left = a.match(expression)?.map(Number) ?? [], right = b.match(expression)?.map(Number) ?? []
    if (a.replace(expression, '#') !== b.replace(expression, '#') || left.length !== right.length) return { compatible: false, reason: 'Indicator path topology differs.' }
    for (let number = 0; number < left.length; number++) maxCoordinateDelta = Math.max(maxCoordinateDelta, Math.abs(left[number] - right[number]))
  }
  return { compatible: Number.isFinite(maxCoordinateDelta), maxCoordinateDelta, interpretation: 'Data values are checked against the full-series oracle. Coordinates may vary with native text metrics; physical pixels are not compared.' }
}
function launch(executable, args, env, name) {
  assertRunning()
  const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} did not become ready. ${errors.slice(-2000)}`)), 180000)
    createInterface({ input: child.stdout }).on('line', line => {
      output += `${line}\n`
      if (line.startsWith('RADAR_COMPARE event=ready ')) {
        const parsed = Object.fromEntries([...line.matchAll(/(\w+)=([^ ]+)/g)].map(([, key, value]) => [key, /^\d+(\.\d+)?$/.test(value) ? Number(value) : value === 'true' ? true : value === 'false' ? false : value]))
        clearTimeout(timer); resolveReady(parsed)
      }
      try { const parsed = JSON.parse(line); if (parsed.ready) { clearTimeout(timer); resolveReady(parsed) } } catch { /* Native runtimes may log non-JSON diagnostics. */ }
    })
    child.stderr.on('data', bytes => { errors += String(bytes) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`${name} exited (${code}). ${errors.slice(-3000)}`)) })
  })
  return registerProcess({ child, ready, logs: () => ({ output, errors }) })
}
async function launchTauri(configured, env, trial) {
  const stdout = join(trial, 'tauri.stdout.log'), stderr = join(trial, 'tauri.stderr.log')
  await Promise.all([writeFile(stdout, ''), writeFile(stderr, '')])
  const sourceApp = resolve(configured.executable, '../../..')
  if (!sourceApp.endsWith('.app')) throw new Error('Tauri must launch through its guarded .app bundle.')
  const app = join(trial, 'Tauri Comparison.app')
  await cp(sourceApp, app, { recursive: true, mode: constants.COPYFILE_FICLONE })
  const args = ['-n', '-g', '-W', '--stdout', stdout, '--stderr', stderr]
  for (const [key, value] of Object.entries(env)) if (value !== undefined) args.push('--env', `${key}=${value}`)
  args.push(app)
  // LaunchServices establishes the app's responsibility identity so its
  // launchd-hosted WebKit XPC processes can be attributed to this exact app.
  assertRunning()
  const child = spawn('/usr/bin/open', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let launchError = ''
  child.stderr.on('data', value => { launchError += String(value) })
  const ready = (async () => {
    for (let tries = 0; tries < 600; tries++) {
      const text = await readFile(stdout, 'utf8')
      for (const line of text.split('\n')) {
        try { const value = JSON.parse(line); if (value.ready) return value } catch { /* Wait for a complete readiness line. */ }
      }
      if (child.exitCode !== null) throw new Error(`Tauri launch exited: ${launchError} ${await readFile(stderr, 'utf8')}`)
      await pause(100)
    }
    throw new Error(`Tauri did not become ready: ${await readFile(stderr, 'utf8')}`)
  })()
  return registerProcess({ child, ready, bundlePath: app, logs: () => ({ output: readFileSync(stdout, 'utf8'), errors: readFileSync(stderr, 'utf8') }) })
}
async function post(url, path, value) {
  const response = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(180000) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `${path} failed (${response.status}).`)
  return result
}
async function connected(url) {
  for (let tries = 0; tries < 600; tries++) {
    const response = await fetch(new URL('status', url)).then(value => value.json())
    if (response.connected) return
    await pause(100)
  }
  throw new Error('Runtime did not connect to the common bridge.')
}
const shell = async runtime => {
  if (runtime === 'electron') {
    const sourceApp = join(root, 'node_modules/electron/dist/Electron.app')
    const prepared = await prepareBackgroundApp({ sourceApp, executableName: 'Electron', cacheRoot: join(root, 'artifacts/runtime-comparison/electron-cache') })
    return { executable: prepared.executable, args: [join(root, 'experiments/runtime-comparison/electron.cjs')], metadata: { version: JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'))).version, backgroundGuard: prepared } }
  }
  const executable = process.env.RADAR_COMPARE_TAURI_EXECUTABLE ?? join(root, 'artifacts/runtime-comparison/Radar Tauri Comparison.app/Contents/MacOS/radar-tauri-compare')
  await access(executable, constants.X_OK)
  return { executable, args: [], metadata: { executable } }
}
const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const sourceFingerprint = await fingerprint()
const report = { schemaVersion: 1, revision, dirty: Boolean((await execute('git', ['status', '--porcelain'], { cwd: root })).stdout.trim()),
  backendWorkProbe,
  sourceFingerprint,
  marketEpochMS,
  startedAt: new Date().toISOString(), machine: { platform: process.platform, arch: process.arch, node: process.version,
    hardware: (await execute('sysctl', ['-n', 'hw.model'])).stdout.trim(), macOS: (await execute('sw_vers', ['-productVersion'])).stdout.trim(),
    powerAtStart: (await execute('pmset', ['-g', 'batt'])).stdout.trim(), thermalAtStart: (await execute('pmset', ['-g', 'therm'])).stdout.trim(),
    otherActivity: 'The user continues normal desktop work; ambient load, thermal conditions and CPU frequency are not controlled.' },
  scope: 'Identical production rendering/data sources, HTTP/SSE or native IPC around the same Node worker backend. Recording is selected at startup for each variant. Rust business-logic rewrite is not measured.',
  measurement: { nativePresentation: false, realNetworkOrWebSocketTransport: false, frameLatency: 'DOM correctness at a subsequent RAF opportunity; not native compositor or photon latency.',
    requestedCadenceMS: 500, syntheticInteractionCadenceMS: 200, count, periods: 384, nonFocusableWindowsBehindUser: true,
    activePageSimulated: true, downloadAuditExcluded: true, clock: 'Constant offset aligns market candle boundaries; real timers, performance.now and native OS counters are not slowed or accelerated.',
    energy: { totalAppAvailable: false, reason: 'Total app/device energy and GPU energy cannot be attributed. Privileged powermetrics is unavailable; per-task CPU energy is measured separately with the supported kernel nanojoule counter.' } },
  smoke, rounds, variants, scenarios, diagnostics, sampleStacks, v8Profile, engineProfile, runs: [], outcome: 'running' }
let reportWrites = Promise.resolve()
function saveReport() {
  const contents = JSON.stringify(report, null, 2)
  reportWrites = reportWrites.then(async () => {
    const temporary = join(directory, `.report.${process.pid}.tmp`)
    await writeFile(temporary, contents)
    await rename(temporary, join(directory, 'report.json'))
  })
  return reportWrites
}
await saveReport()
installInterruptionCleanup(async (signal, cleanup) => {
  report.outcome = 'interrupted'; report.error = `Comparison interrupted by ${signal}.`
  report.cleanup = cleanup.map(value => value.status === 'fulfilled' ? value.value : { error: String(value.reason) })
  report.finishedAt = new Date().toISOString()
  await saveReport()
})
let measurement
if (!smoke || args.includes('--measure')) measurement = await import('./measurement/index.mjs')
let template = join(directory, 'seed-template')
try {
  // Clone only a closed, pristine seed. Copying a previous measured trial
  // would silently reuse its completed download in the next runtime.
  const clockImport = ['--import', join(root, 'experiments/runtime-comparison/clock.mjs'), '--import', join(root, 'experiments/runtime-comparison/fixture-policy.mjs')]
  if (backendWorkProbe) clockImport.push('--import', join(root, 'experiments/runtime-comparison/backend-work-probe.mjs'))
  const seedReport = option('--seed-report', '')
  if (seedReport) {
    const source = resolve(seedReport), bytes = await readFile(source), previous = JSON.parse(bytes)
    if (previous.marketEpochMS !== marketEpochMS || previous.measurement?.count !== count || previous.measurement?.periods !== 384
      || !previous.runs?.some(run => run.outcome === 'passed' && run.final?.actualRows === count * 384 * 3)) throw new Error('Reusable seed report does not validate this exact market epoch and fixture size.')
    template = previous.reusedSeed?.directory ?? join(dirname(source), 'seed-template')
    await access(template)
    report.reusedSeed = { report: source, sha256: createHash('sha256').update(bytes).digest('hex'), directory: template,
      validity: 'Exact fixture size and virtual market epoch; each trial reseeds and validates the oracle, source cardinality and final live values.' }
  } else {
  const seeder = launch(process.execPath, [...clockImport, join(root, 'experiments/runtime-comparison/server.mjs')], {
    RADAR_COMPARE_CLOCK_OFFSET_MS: String(report.marketEpochMS - Date.now()),
    RADAR_COMPARE_DOWNLOAD_ONLY: '1',
    RADAR_COMPARE_PROFILE: template, RADAR_COMPARE_COUNT: String(count), PERPETUAL_SWAP_OPERATION_DIR: join(directory, 'seed-operations'),
    PERPETUAL_SWAP_OPERATION_TRACE: '1',
    PERPETUAL_SWAP_OPERATION_SESSION: 'comparison-seed', PERPETUAL_SWAP_ALLOW_NETWORK: '0', PERPETUAL_SWAP_SANDBOX: '1',
  }, 'fixture seeder')
  try { await seeder.ready } finally {
    const stopped = await stop(seeder)
    if (stopped.forced || stopped.code !== 0) throw new Error(`Pristine seed did not close successfully: ${JSON.stringify(stopped)}`)
  }
  }
  for (let round = 0; round < rounds; round++) {
    const rotated = variants.map((_, index) => variants[(index + round) % variants.length])
    for (const variant of rotated) {
    const order = runtimeOption === 'all' ? (round % 2 ? ['tauri', 'electron'] : ['electron', 'tauri']) : [runtimeOption]
    for (const runtime of order) {
      const trial = join(directory, `${round + 1}-${variant.transport}-${variant.telemetry}-${runtime}`); await mkdir(trial, { recursive: true })
      const profile = join(trial, 'data')
      await cp(template, profile, { recursive: true, mode: constants.COPYFILE_FICLONE })
      let backend, app
      const result = { runtime, ...variant, round: round + 1, phases: [], outcome: 'running' }; report.runs.push(result)
      try {
        log(`Preparing ${runtime} ${variant.transport}/${variant.telemetry}, round ${round + 1}, ${count} contracts`)
        if (v8Profile) await mkdir(join(trial, 'v8-profiles'), { recursive: true })
        if (engineProfile && runtime === 'electron') await mkdir(join(trial, 'engine-profiles'), { recursive: true })
        backend = launch(process.execPath, [...(v8Profile ? ['--cpu-prof', `--cpu-prof-dir=${join(trial, 'v8-profiles')}`] : []), ...clockImport, join(root, 'experiments/runtime-comparison/server.mjs')], {
          RADAR_COMPARE_CLOCK_OFFSET_MS: String(report.marketEpochMS - Date.now()),
          RADAR_COMPARE_DOWNLOAD_ONLY: '1',
          RADAR_COMPARE_PROFILE: profile, RADAR_COMPARE_COUNT: String(count), PERPETUAL_SWAP_OPERATION_DIR: variant.telemetry === 'off' ? undefined : join(trial, 'operations'),
          PERPETUAL_SWAP_OPERATION_TRACE: variant.telemetry === 'off' ? '0' : '1',
          RADAR_COMPARE_TELEMETRY: variant.telemetry, RADAR_COMPARE_TRANSPORT: variant.transport,
          RADAR_COMPARE_DIAGNOSTICS: diagnostics ? '1' : '0',
          RADAR_BACKEND_WORK_PROBE: backendWorkProbe ? join(trial, 'backend-work') : undefined,
          RADAR_COMPARE_ENGINE_PROFILE: engineProfile ? '1' : '0',
          PERPETUAL_SWAP_OPERATION_SESSION: `runtime-comparison-${round}-${runtime}`, PERPETUAL_SWAP_ALLOW_NETWORK: '0', PERPETUAL_SWAP_SANDBOX: '1',
        }, 'common backend')
        const service = await backend.ready, configured = await shell(runtime)
        result.fixture = service.fixture; result.shell = configured.metadata
        result.executableSHA256 = createHash('sha256').update(await readFile(configured.executable)).digest('hex')
        const env = { RADAR_COMPARE_URL: new URL('/', service.url).href, RADAR_COMPARE_WIDTH: '1200', RADAR_COMPARE_HEIGHT: '760',
          RADAR_COMPARE_ELECTRON_PROFILE: join(trial, 'electron-profile'), ELECTRON_RUN_AS_NODE: undefined,
          RADAR_COMPARE_TRANSPORT: variant.transport, RADAR_COMPARE_SOCKET: service.socketPath, RADAR_COMPARE_NATIVE_TOKEN: service.nativeToken,
          RADAR_COMPARE_ENGINE_PROFILE_DIR: engineProfile && runtime === 'electron' ? join(trial, 'engine-profiles') : undefined,
          PERPETUAL_SWAP_SANDBOX: undefined, PERPETUAL_SWAP_OPERATION_DIR: undefined }
        app = runtime === 'tauri' ? await launchTauri(configured, env, trial) : launch(configured.executable, configured.args, env, runtime)
        if (app.bundlePath) result.bundlePath = app.bundlePath
        const native = await app.ready; app.runtimePid = native.pid; result.native = native
        await connected(service.url)
        const step = 900000
        const history = await post(service.url, 'request', { e2e: { action: 'readCandles', instrument: service.fixture.instIds[0], timeframe: '15m',
          from: Math.floor(service.fixture.asOf / step) * step - service.fixture.periods * step, through: Math.floor(service.fixture.asOf / step) * step - step } })
        const expected = buildIndicatorSeries(history, step)
        const ticks = smoke ? 3 : 60
        const expectedLive = Array.from({ length: ticks }, (_, index) => {
          const sequence = index + 1, seed = resourceCandle(0, '15m', service.fixture.periods, service.fixture.periods, service.fixture.asOf), close = seed.close + sequence * .001
          return projectIndicatorCandle(expected.state, { ...seed, close, high: Math.max(seed.high, close), volume: 100 + sequence, baseVolume: 100 + sequence, quoteVolume: close * (100 + sequence), confirmed: false })
        })
        const oracle = JSON.stringify({ bars: expected.bars, live: expectedLive })
        const oracleSHA256 = createHash('sha256').update(oracle).digest('hex')
        if (!report.oracleSHA256) { report.oracleSHA256 = oracleSHA256; await writeFile(join(directory, 'oracle.json'), oracle) }
        else if (report.oracleSHA256 !== oracleSHA256) throw new Error('The full correctness oracle differs across variants.')
        result.prepared = await post(service.url, 'control', { action: 'prepare', fixture: service.fixture, expectedBars: expected.bars })
        let quiet = 0
        for (let tries = 0; tries < 720 && quiet < 3; tries++) {
          const state = await post(service.url, 'probe', { action: 'preparedDiagnostics' })
          quiet = state.tasks.length || state.queue.length || state.seeds.length ? 0 : quiet + 1
          await pause(250)
        }
        if (quiet < 3) throw new Error('Initial chart preparation did not settle before measurement.')
        result.prepared = await post(service.url, 'control', { action: 'prepare', fixture: service.fixture })
        result.startupMetrics = await post(service.url, 'metrics', {})
        result.canonicalDataHash = createHash('sha256').update(JSON.stringify({ ...result.prepared.chart, svgPaths: undefined })).digest('hex')
        report.canonicalDataHash ??= result.canonicalDataHash
        if (result.canonicalDataHash !== report.canonicalDataHash) throw new Error('Runtime input bars or canonical indicators differ; refusing an unequal comparison.')
        report.referencePaths ??= result.prepared.chart.svgPaths
        result.pathComparison = comparePaths(report.referencePaths, result.prepared.chart.svgPaths)
        if (!result.pathComparison.compatible) throw new Error(`Indicator SVG evidence differs: ${JSON.stringify(result.pathComparison)}`)
        if (result.prepared.visibility !== 'visible' || result.prepared.errors.length) throw new Error(`Invalid ${runtime} presentation or page errors: ${JSON.stringify(result.prepared)}`)
        for (const scenario of scenarios) {
          log(`Measuring ${runtime} ${scenario}, round ${round + 1}`)
          const samples = [], roots = [app.runtimePid, backend.child.pid]
          let sampler
          if (measurement) sampler = await measurement.startSampling({ rootPids: roots, intervalMS: 1000, samples,
            onSample: sample => {
              if (sample.frontmostIsRuntime) throw new Error('Comparison runtime became frontmost; aborting the trial.')
              if (runtime === 'tauri' && !sample.processes.some(process => process.webKitRoot && process.name.includes('WebContent'))) throw new Error('WebKit renderer is not attributed; resource comparison is unavailable.')
            } })
          let phase
          try {
            const running = post(service.url, 'control', { action: 'run', scenario, fixture: service.fixture,
              durationMS: scenario === 'realtime' ? (smoke ? 1000 : 30500) : durationMS, ticks, expectedLive })
            if (sampleStacks) {
              await pause(smoke ? 100 : 5000)
              const { snapshotProcessTree } = await import('./measurement/index.mjs')
              const { capture } = await import('./profiling/index.mjs')
              const snapshot = await snapshotProcessTree({ rootPids: [app.runtimePid], extraPids: [backend.child.pid] })
              result.stackProfiles ??= []
              result.stackProfiles.push(await capture({ snapshot, pids: snapshot.processes.filter(p => p.counters).map(p => p.pid),
                durationSeconds: smoke ? 1 : 5, intervalMS: 10, outputDirectory: join(trial, `stacks-${scenario}`) }))
            }
            phase = await running
          } finally { if (sampler) phase = { ...phase, resources: await sampler.stop() } }
          result.phases.push(phase)
          phase.transportMetrics = await post(service.url, 'metrics', {})
          if (!sampleStacks && scenario !== 'idle' && phase.rafCount / (phase.durationMS / 1000) < 50) throw new Error('Native refresh cadence fell below 50 RAF/s; discard this unequal active-page run.')
          if (engineProfile && runtime === 'electron') {
            let completed = false
            for (let attempt = 0; attempt < 100; attempt++) {
              try { completed = JSON.parse(await readFile(join(trial, 'engine-profiles', `${scenario}.complete.json`), 'utf8')).complete; if (completed) break } catch (error) { if (error.code !== 'ENOENT') throw error }
              await pause(100)
            }
            if (!completed) throw new Error('Engine profile did not finish without opening DevTools.')
          }
          if (phase.errors?.length || phase.failures?.length || phase.pendingInputs || phase.inputs?.some(input => input.error || input.status === 'committed' && !input.correct)
            || phase.inputCounts.planned !== phase.inputCounts.dispatched
            || phase.visibility?.some(state => state !== 'visible')
            || phase.load && (phase.load.state !== 'complete' || phase.load.failed || phase.load.plannedTicks !== ticks
              || phase.load.emitted !== ticks || phase.load.completed !== ticks || phase.load.pending !== 0
              || phase.deliveries?.length !== ticks || phase.deliveries.some(item => !['committed', 'coalesced', 'missed', 'missing'].includes(item.status)))) throw new Error(`Invalid ${runtime} ${scenario}: ${JSON.stringify({ errors: phase.errors, failures: phase.failures, pendingInputs: phase.pendingInputs, load: phase.load?.state, inputs: phase.inputs?.filter(input => input.error || !input.correct) })}`)
          await saveReport()
        }
        result.final = await post(service.url, 'probe', { action: 'scaleStop' })
        if (result.final.liveMismatches.length) throw new Error('The replay lost updates on one or more contracts.')
        if (scenarios.includes('realtime') && (result.final.ticks !== ticks || result.final.nativeUpdates !== ticks * count * service.fixture.timeframes.length)) throw new Error('The replay did not deliver the identical complete native-intake workload.')
        if (result.final.actualRows !== service.fixture.rowsSeeded) throw new Error('The source dataset cardinality changed across the measured trial.')
        await post(service.url, 'control', { action: 'drain' })
        result.outcome = 'passed'
      } catch (error) { result.outcome = 'failed'; result.error = error.stack; throw error }
      finally {
        // The page already drained before teardown; avoid trying to reconnect
        // a detached document while shutting down the backend.
        result.teardown = { runtime: await stop(app), backend: await stop(backend) }
        result.logs = { runtime: app?.logs(), backend: backend?.logs() }
        await saveReport()
        if (result.teardown.runtime.forced || result.teardown.backend.forced || result.teardown.backend.code !== 0) throw new Error(`Unclean comparison teardown: ${JSON.stringify(result.teardown)}`)
        if (variant.telemetry === 'off') result.recording = { disabledByControl: true, correctnessChecksRetained: true }
        else {
        const operations = await summarizeOperations(join(trial, 'operations'), {
          requireRoles: ['market-backend', 'market-reader', 'market-writer', 'prepared-chart', ...(variant.telemetry === 'full' ? ['renderer'] : [])],
          requireCategories: ['cpu', 'database', 'io', 'ipc', 'network'],
        })
        result.recording = { diagnostics: operations.diagnostics, coverage: operations.coverage }
        if (operationReportHasFailures(operations)) throw new Error(`Incomplete operation recording: ${JSON.stringify(operations.diagnostics)}`)
        }
      }
    }
    }
  }
  const endFingerprint = await fingerprint()
  if (endFingerprint.sha256 !== sourceFingerprint.sha256) throw new Error('Comparison code or frontend changed during measurement; discard the mixed-source run.')
  report.outcome = 'passed'
} catch (error) { report.outcome = 'failed'; report.error = error.stack; process.exitCode = 1; console.error(error.stack) }
finally {
  report.finishedAt = new Date().toISOString()
  report.machine.powerAtEnd = (await execute('pmset', ['-g', 'batt'])).stdout.trim()
  report.machine.thermalAtEnd = (await execute('pmset', ['-g', 'therm'])).stdout.trim()
  await saveReport(); log(`Report: ${join(directory, 'report.json')}`)
}
