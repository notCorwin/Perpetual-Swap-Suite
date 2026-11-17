#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { run } from './electron-delivery.mjs'
import { runSandbox } from './test-sandbox.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const execute = promisify(execFile)
const headRevision = async root => (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()

export async function runAcceptance({ app, revision, report: reportPath, output, reuseBuildManifest, root = projectRoot } = {},
  { packageApp = run, sandbox = runSandbox, readRevision = headRevision } = {}) {
  assert.ok(!app || !reuseBuildManifest, '--app and --reuse-build-manifest cannot be combined.')
  revision ??= await readRevision(root)
  assert.match(revision, /^[0-9a-f]{40}$/i, 'Acceptance requires a full expected Git revision.')
  const directory = resolve(root, output ?? join('artifacts', 'acceptance', `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '')}-${randomUUID().slice(0, 8)}`))
  reportPath = resolve(root, reportPath ?? join(directory, 'result.json'))
  const smokeReport = join(directory, 'smoke.json')
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), revision, ok: false,
    scope: 'Signed packaged artifact; deterministic native HTTP/WebSocket, workers, SQLite, IPC and hidden renderer. Live OKX and native visible GPU timing are separate checks.',
    artifactSelection: app ? 'explicit artifact; revision and signature validated by smoke, current workspace equivalence not asserted' : 'packaged from current workspace',
    rendererReuseManifest: reuseBuildManifest ? resolve(root, reuseBuildManifest) : null, smokeReport }
  await mkdir(directory, { recursive: true })
  try {
    if (!app) {
      assert.equal(revision, await readRevision(root), 'Automatic packaging targets HEAD; use --app to verify another revision.')
      await packageApp('bash', ['scripts/package-electron.sh', ...(reuseBuildManifest ? ['--reuse-build-manifest', reuseBuildManifest] : [])], { cwd: root })
    }
    report.app = resolve(root, app ?? join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Perpetual Swap Suite.app'))
    const result = await sandbox({ mode: 'command', args: [process.execPath, join(root, 'scripts/smoke-electron.mjs'),
      '--app', report.app, '--revision', revision, '--report', smokeReport, '--trace'],
    scenario: 'packaged-acceptance', output: join(directory, 'sandbox'), allowNetwork: false,
    requireCategories: ['cpu', 'network', 'database', 'io', 'ipc'],
    requireRoles: ['electron-main', 'renderer', 'market-backend', 'market-reader', 'market-writer', 'prepared-chart'] })
    report.sandboxDirectory = result.directory
    assert.equal(result.exitCode, 0, `Packaged acceptance failed; inspect ${result.directory}.`)
    const smoke = JSON.parse(await readFile(smokeReport, 'utf8'))
    assert.equal(smoke.ok, true, 'The packaged smoke did not report success.')
    assert.equal(smoke.revision, revision, 'The smoke report must identify the expected revision.')
    report.checks = smoke.checks
    report.verification = smoke.verification
    report.ok = true
    return report
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Packaged acceptance report: ${reportPath}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { app: { type: 'string' }, revision: { type: 'string' }, report: { type: 'string' },
      output: { type: 'string' }, 'reuse-build-manifest': { type: 'string' } } })
    await runAcceptance({ ...values, reuseBuildManifest: values['reuse-build-manifest'] })
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
}
