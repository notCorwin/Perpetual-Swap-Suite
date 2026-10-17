import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { _electron } from 'playwright'

const { values } = parseArgs({ options: { app: { type: 'string' }, report: { type: 'string' } } })
if (!values.app) throw new Error('Usage: node scripts/benchmark-startup.mjs --app PATH [--report PATH]')
const app = resolve(values.app)
const revision = JSON.parse(await readFile(join(app, 'Contents/Resources/build-revision.json'), 'utf8')).revision
const samples = []
for (let index = 0; index < 3; index++) {
  const userData = await mkdtemp(join(tmpdir(), 'perp-startup-benchmark-'))
  let electron
  let timer
  try {
    const started = performance.now()
    electron = await _electron.launch({ executablePath: join(app, 'Contents/MacOS/Perpetual Swap Suite'),
      args: ['--disable-gpu'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined,
        PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_E2E_LIVE_REFRESH: '0', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForFunction(() => document.querySelector('#root')?.children.length > 0)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const readyMS = performance.now() - started
    const metrics = await electron.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({ type, workingSetKB: memory.workingSetSize })))
    samples.push({ readyMS: Number(readyMS.toFixed(2)), workingSetMB: Number((metrics.reduce((sum, item) => sum + item.workingSetKB, 0) / 1024).toFixed(2)), processes: metrics })
  } finally {
    const child = electron?.process()
    try {
      if (electron) await Promise.race([electron.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup benchmark shutdown timed out.')), 20_000) })])
    } finally {
      clearTimeout(timer)
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
      await rm(userData, { recursive: true, force: true })
    }
    if (child) assert.equal(child.exitCode, 0)
  }
}
const median = field => [...samples].sort((a, b) => a[field] - b[field])[1][field]
const report = { app, revision, observedAt: new Date().toISOString(), mode: 'isolated fresh process; OS filesystem cache uncontrolled; no market fixture or AI requests',
  medianReadyMS: median('readyMS'), medianWorkingSetMB: median('workingSetMB'), samples }
if (values.report) await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
