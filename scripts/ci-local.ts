import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = resolve(import.meta.dirname, '..')
const logs = join(root, '.build', 'ci')
mkdirSync(logs, { recursive: true })
rmSync(join(logs, 'timings.json'), { force: true })
const started = performance.now(), running = new Set<ChildProcess>()
const timings: Record<string, number> = {}
const environment = { ...process.env, CI: '1', RADAR_UI_TESTS: '1', RADAR_VISUAL_TESTS: '1', RADAR_SERVICE_TESTS: '1' }
let stopped = false

function stop() {
  stopped = true
  const groups = [...running].flatMap(child => child.pid ? [child.pid] : [])
  for (const pid of groups) { try { process.kill(-pid, 'SIGTERM') } catch { /* Already exited. */ } }
  setTimeout(() => {
    for (const pid of groups) { try { process.kill(-pid, 'SIGKILL') } catch { /* Already exited. */ } }
  }, 500).unref()
}

async function run(name: string, command: string, args: string[]): Promise<string> {
  if (stopped) throw new Error('CI cancelled')
  const start = performance.now(), path = join(logs, `${name}.log`), log = openSync(path, 'w')
  const child = spawn(command, args, { cwd: root, env: environment, detached: true, stdio: ['ignore', log, log] })
  running.add(child)
  try {
    await new Promise<void>((accept, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`${name} failed (${signal ?? code}). See ${path}`)))
    })
    timings[name] = (performance.now() - start) / 1000
    console.log(`✓ ${name}: ${timings[name].toFixed(2)}s`)
    return readFileSync(path, 'utf8')
  } finally { running.delete(child); closeSync(log) }
}

const deadline = setTimeout(() => {
  console.error('Local CI reached its execution deadline. The 60-second budget includes process cleanup; every check is mandatory.')
  stop()
  process.exitCode = 1
}, 59_000) // Reserve time for process cleanup and npm's startup/shutdown.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop)

try {
  const web = run('web-build', 'npm', ['run', 'build'])
  const native = run('native-build', 'scripts/build-native.sh', ['--build-tests'])
  const icons = run('icon-assets', 'scripts/build-icons.sh', [])
  const checks = [icons, run('static-checks', 'npm', ['run', 'lint']), run('web-tests', process.execPath, ['--experimental-strip-types', '--test', ...readdirSync(join(root, 'src')).filter(name => name.endsWith('.test.ts')).map(name => `src/${name}`)])]
  const tests = native.then(async () => {
    const listed = await run('test-discovery', 'swift', ['test', 'list', '-c', 'release', '--skip-build'])
    const identifiers = listed.split('\n').map(line => line.trim()).filter(line => line.startsWith('PerpetualRadarTests.') && line.includes('/'))
    if (!identifiers.length || new Set(identifiers).size !== identifiers.length) throw new Error('Native test discovery returned no tests or duplicate identifiers')
    const ui = identifiers.filter(id => id.includes('.RuleEditorUITests/'))
    const services = identifiers.filter(id => id.includes('.MonitorServiceTests/'))
    const units = identifiers.filter(id => !ui.includes(id) && !services.includes(id))
    if (!ui.length || !services.length || !units.length) throw new Error('A required native test family is missing')
    console.log(`Native checks: ${units.length} business/window tests, ${services.length} lifecycle tests, ${ui.length} WebKit tests.`)
    const execute = async (name: string, ids: string[]) => {
      const output = await run(name, 'scripts/test-native.sh', ['--xctest', '-XCTest', ids.join(',')])
      const summaries = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures/g)]
      if (Number(summaries.at(-1)?.[1]) !== ids.length || /Test Case .* skipped|with [1-9]\d* tests? skipped/.test(output)) {
        throw new Error(`${name} did not execute every assigned test without skips`)
      }
    }
    const benchmark = ui.filter(id => id.includes('testCategoricalMenusAndTypedRuleEditingStayResponsive'))
    if (benchmark.length !== 1) throw new Error('The isolated menu benchmark is missing')
    const pixels = ui.filter(id => id.includes('testAllSurfaceFamiliesAndChartCapture'))
    if (pixels.length !== 1) throw new Error('The native pixel suite is missing')
    await Promise.all([web, ...checks])
    await run('app-package', 'scripts/build-app.sh', ['--prebuilt'])
    await execute('webkit-responsiveness', benchmark)
    // Start long scenarios first. One shared pool bounds native processes,
    // including the packaged apps, instead of oversubscribing WindowServer.
    // Every discovered test is assigned once, including newly added cases.
    const priority = ['testSuitePhaseEditing', 'testResearchPrepareRun', 'testVisualFunctionCoverage', 'testDraggingConditions', 'testDualDirection', 'testGlassTint', 'testBTCMarketContext', 'testNativeTypedRule']
    const weight = (id: string) => { const rank = priority.findIndex(name => id.includes(name)); return rank < 0 ? priority.length : rank }
    const orderedUI = ui.filter(id => !benchmark.includes(id) && !pixels.includes(id)).sort((a, b) => weight(a) - weight(b))
    const uiTask = (id: string) => ({ name: `webkit-${id.split('/')[1]}`, ids: [id] })
    const queue = [
      ...services.map((id, index) => ({ name: `packaged-lifecycle-${index + 1}`, ids: [id] })),
      ...orderedUI.slice(3).map(uiTask),
    ]
    const drain = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        await execute(task.name, task.ids)
      }
    }
    // Start long-lived WebViews together. Do not start further WebKit tests or
    // lifecycle apps while ScreenCaptureKit is capturing the first wave.
    const captured = execute('webkit-native-pixels', pixels)
    const first = [{ name: 'native-unit-tests', ids: units }, ...orderedUI.slice(0, 3).map(uiTask)]
    await Promise.all([
      captured,
      ...first.map(async task => { await execute(task.name, task.ids); await captured; await drain() }),
      ...Array.from({ length: 2 }, async () => { await captured; await drain() }),
    ])
  })
  // Attach all rejection handlers immediately, including the dependent stages.
  await Promise.all([...checks, web, tests])
  const elapsed = (performance.now() - started) / 1000
  if (stopped || elapsed >= 60) throw new Error(`Local CI took ${elapsed.toFixed(2)}s; required <60s`)
  writeFileSync(join(logs, 'timings.json'), JSON.stringify({ elapsed, stages: timings }, null, 2) + '\n')
  console.log(`Local CI passed in ${elapsed.toFixed(2)}s (budget: <60s).`)
} catch (error) {
  stop()
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally { clearTimeout(deadline) }
