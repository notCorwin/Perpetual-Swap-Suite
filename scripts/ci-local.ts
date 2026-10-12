import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { availableParallelism } from 'node:os'

const root = resolve(import.meta.dirname, '..')
const logs = join(root, '.build', 'ci')
mkdirSync(logs, { recursive: true })
rmSync(join(logs, 'timings.json'), { force: true })
const started = performance.now(), running = new Set<ChildProcess>()
const timings: Record<string, number> = {}
const environment = { ...process.env, CI: '1', RADAR_UI_TESTS: '1', RADAR_VISUAL_TESTS: '1', RADAR_SERVICE_TESTS: '1' }
let stopped = false

function stop() {
  if (stopped) return
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
    // Millisecond-level network admission assertions need their own process,
    // free of other suites' URLSession callbacks and heavy WebKit rendering.
    const paced = units.filter(id => id.includes('.ResearchRequestTests/'))
    if (!paced.length) throw new Error('The research network quota suite is missing')
    const pacedTask = execute('research-network-pacing', paced)
    pacedTask.catch(() => {})
    const benchmark = ui.filter(id => id.includes('testCategoricalMenusAndTypedRuleEditingStayResponsive'))
    if (benchmark.length !== 1) throw new Error('The isolated menu benchmark is missing')
    const pixels = ui.filter(id => id.includes('testAllSurfaceFamiliesAndChartCapture'))
    if (pixels.length !== 1) throw new Error('The native pixel suite is missing')
    // Keep each test class together, but overlap independent business suites.
    // Reuse observed test durations when available: updater/lifecycle waits
    // otherwise make a single unit-test process the critical path.
    const durationFile = join(logs, 'test-durations.json')
    const durations = new Map<string, number>(existsSync(durationFile) ? Object.entries(JSON.parse(readFileSync(durationFile, 'utf8'))) : [])
    for (const file of readdirSync(logs).filter(name => name.endsWith('.log')).sort()) {
      for (const match of readFileSync(join(logs, file), 'utf8').matchAll(/Test Case '-\[PerpetualRadarTests\.([^ ]+) ([^\]]+)\]' passed \(([\d.]+) seconds\)/g)) {
        durations.set(`PerpetualRadarTests.${match[1]}/${match[2]}`, Number(match[3]))
      }
    }
    // Retain successful observations even if a later run is interrupted and
    // its per-stage logs contain only the next test's start message.
    writeFileSync(durationFile, JSON.stringify(Object.fromEntries(durations), null, 2) + '\n')
    const classes = new Map<string, string[]>()
    for (const id of units.filter(id => !paced.includes(id))) {
      const name = id.split('/')[0], group = classes.get(name) ?? []
      group.push(id); classes.set(name, group)
    }
    const cost = (ids: string[]) => ids.reduce((seconds, id) => seconds + Math.max(0.02, durations.get(id) ?? 0.1), 0)
    const unitShards = [1, 2].map(index => ({ name: `native-unit-tests-${index}`, ids: [] as string[], seconds: 0 }))
    for (const group of [...classes.values()].sort((a, b) => cost(b) - cost(a))) {
      const shard = unitShards.reduce((a, b) => a.seconds <= b.seconds ? a : b)
      shard.ids.push(...group); shard.seconds += cost(group)
    }
    await Promise.all([web, ...checks])
    await run('app-package', 'scripts/build-app.sh', ['--prebuilt'])
    // Business tests do not share the menu benchmark's WebView. Start their
    // independent processes now rather than leaving every CPU idle during it.
    const unitTasks = unitShards.filter(shard => shard.ids.length).map(shard => execute(shard.name, shard.ids))
    // Attach rejection handlers before awaiting the benchmark; the shared
    // result handling below still propagates every unit-test failure.
    Promise.all(unitTasks).catch(() => {})
    await Promise.all([execute('webkit-responsiveness', benchmark), pacedTask])
    // Start long scenarios first. One shared pool bounds native processes,
    // including the packaged apps, instead of oversubscribing WindowServer.
    // Every discovered test is assigned once, including newly added cases.
    const priority = ['testResearchPrepareRun', 'testVisualFunctionCoverage', 'testDraggingConditions', 'testBullishSetupEditing', 'testBullishSetupRadar', 'testGlassTint', 'testBTCMarketContext', 'testNativeTypedRule']
    const weight = (id: string) => { const rank = priority.findIndex(name => id.includes(name)); return rank < 0 ? priority.length : rank }
    const initialCosts: [string, number][] = [['testResearchPrepareRun', 45], ['testVisualFunctionCoverage', 25], ['testDraggingConditions', 20], ['.MonitorServiceTests/testPackaged', 20]]
    const taskCost = (ids: string[]) => ids.reduce((seconds, id) => seconds + (durations.get(id) ?? initialCosts.find(([name]) => id.includes(name))?.[1] ?? 5), 0)
    const orderedUI = ui.filter(id => !benchmark.includes(id) && !pixels.includes(id)).sort((a, b) => taskCost([b]) - taskCost([a]) || weight(a) - weight(b))
    const uiTask = (id: string) => ({ name: `webkit-${id.split('/')[1]}`, ids: [id] })
    const serviceTasks = services.map((id, index) => ({ name: `packaged-lifecycle-${index + 1}`, ids: [id] }))
    const firstServices = serviceTasks.filter(task => task.ids[0].includes('testPackaged') && !task.ids[0].includes('testPackagedLaunch')).sort((a, b) => taskCost(b.ids) - taskCost(a.ids))
    const queue = [
      ...serviceTasks.filter(task => !firstServices.includes(task)),
      ...orderedUI.slice(2).map(uiTask),
    ].sort((a, b) => taskCost(b.ids) - taskCost(a.ids))
    const drain = async () => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        await execute(task.name, task.ids)
      }
    }
    // Start the long lifecycle scenarios in the first wave too: their real
    // recovery deadlines must overlap capture, not start after it finishes.
    // Keep subsequent test launches behind capture to bound WindowServer load.
    const captured = execute('webkit-native-pixels', pixels)
    const first = [...firstServices, ...orderedUI.slice(0, 2).map(uiTask)]
    const nativeSlots = Math.max(6, Math.min(8, availableParallelism()))
    await Promise.all([
      captured,
      ...unitTasks.map(async task => { await task; await captured; await drain() }),
      ...first.map(async task => { await execute(task.name, task.ids); await captured; await drain() }),
      ...Array.from({ length: nativeSlots - first.length - unitTasks.length }, async () => { await captured; await drain() }),
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
