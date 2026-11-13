#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Each scenario gets a fresh network-disabled sandbox and runs serially.
const directory = resolve(process.argv[2] ?? '.build/market-replay-matrix')
await mkdir(directory, { recursive: true })
const scenarios = [
  { name: 'branches', desktop: false, command: ['scripts/market-branch-resources.mjs', join(directory, 'branches.json')] },
  { name: 'steady', desktop: true, command: ['scripts/market-traffic-benchmark.mjs', '--fixed-rounds', '--wait-ready', '--resources', '--duration-seconds', '30', '--output', join(directory, 'steady.json')] },
  { name: 'chart', desktop: true, command: ['scripts/chart-scroll-performance.mjs', '--output', join(directory, 'chart.json')] },
  { name: 'presentation', desktop: true, command: ['scripts/app-idle-benchmark.mjs', '--ticks', '10', '--report', join(directory, 'presentation.json')] },
]
const report = { schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(), outcome: 'running', runtime: { node: process.version, executable: process.execPath,
  platform: process.platform, arch: process.arch }, scenarios: scenarios.map(({ name }) => ({ name, status: 'pending', passed: false })) }
const reportPath = join(directory, 'matrix.json')
const persist = async () => {
  const temporary = `${reportPath}.${report.runId}.tmp`
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, reportPath)
}
await persist()
for (const scenario of scenarios) {
  const args = ['scripts/test-sandbox.mjs', 'command', ...(scenario.desktop ? ['--desktop'] : []), '--', process.execPath, ...scenario.command]
  const startedAt = new Date().toISOString()
  const path = join(directory, `${scenario.name}.json`)
  const entry = report.scenarios.find(item => item.name === scenario.name)
  Object.assign(entry, { path, startedAt, status: 'running' })
  await persist()
  let exit
  try {
    await rm(path, { force: true })
    exit = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
  } catch (error) { exit = { code: null, signal: null, error: error.message } }
  let result
  try { result = JSON.parse(await readFile(path, 'utf8')) } catch { result = null }
  const passed = exit.code === 0 && result && (result.outcome == null || result.outcome === 'passed') && result.partial !== true
  Object.assign(entry, { endedAt: new Date().toISOString(), exit, status: passed ? 'passed' : 'failed', passed: Boolean(passed) })
  if (!passed) report.outcome = 'failed'
  await persist()
  if (!passed) break
}
if (report.outcome !== 'failed') report.outcome = 'passed'
report.endedAt = new Date().toISOString()
await persist()
if (report.outcome !== 'passed') process.exitCode = 1
