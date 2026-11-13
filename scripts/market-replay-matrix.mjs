#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const report = { schemaVersion: 1, outcome: 'running', runtime: { node: process.version, executable: process.execPath,
  platform: process.platform, arch: process.arch }, scenarios: [] }
const reportPath = join(directory, 'matrix.json')
for (const scenario of scenarios) {
  const args = ['scripts/test-sandbox.mjs', 'command', ...(scenario.desktop ? ['--desktop'] : []), '--', process.execPath, ...scenario.command]
  const startedAt = new Date().toISOString()
  const path = join(directory, `${scenario.name}.json`)
  await rm(path, { force: true })
  let exit
  try {
    exit = await new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, args, { stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
  } catch (error) { exit = { code: null, signal: null, error: error.message } }
  let result
  try { result = JSON.parse(await readFile(path, 'utf8')) } catch { result = null }
  const passed = exit.code === 0 && result && result.outcome !== 'failed' && result.partial !== true
  report.scenarios.push({ name: scenario.name, path, startedAt, endedAt: new Date().toISOString(), exit, passed: Boolean(passed) })
  if (!passed) { report.outcome = 'failed'; break }
}
if (report.outcome !== 'failed') report.outcome = 'passed'
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
if (report.outcome !== 'passed') process.exitCode = 1
