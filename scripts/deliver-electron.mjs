import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify, parseArgs } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installApp, quitInstalledApp, run } from './electron-delivery.mjs'
import { smokeElectron } from './smoke-electron.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const execute = promisify(execFile)
if (process.platform !== 'darwin') throw new Error('macOS is required to install the desktop app.')
// Delivery always leaves the user's production profile and desktop unlaunched.
// The explicit flag lets automation declare that requirement clearly.
parseArgs({ options: { 'no-launch': { type: 'boolean', default: true } } })

await run('bash', ['scripts/package-electron.sh'], { cwd: root })
const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const candidate = join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Perpetual Swap Suite.app')
const destination = '/Applications/Perpetual Swap Suite.app'
const report = await installApp({
  candidate, destination, revision,
  beforeReplace: quitInstalledApp,
  verify: async (app, expected, context) => {
    if (context.stage === 'candidate') return smokeElectron({ app, revision: expected, report: join(root, '.build', 'package-smoke.json') })
    assert.equal(context.artifact.identity, context.candidateArtifact.identity, 'The installed signed artifact must match the candidate whose guarded replica passed smoke.')
    const result = { ...context.candidateVerification, app, installed: destination, finishedAt: new Date().toISOString(),
      verification: { kind: 'signed-artifact-identity', installedApp: destination, identity: context.artifact.identity,
        candidateApp: candidate, candidateSmoke: context.candidateVerification.verification,
        productionAppLaunched: false, productionProfileTested: false, nativeVisiblePaint: false },
      checks: [...context.candidateVerification.checks, 'installed signature, revision, and signed artifact identity; production app not launched'] }
    await writeFile(join(root, '.build', 'installed-smoke.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  },
})
console.log(JSON.stringify({ installed: destination, ...report }, null, 2))
