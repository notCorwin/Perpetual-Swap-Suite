import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installApp, quitInstalledApp, run } from './electron-delivery.mjs'
import { smokeElectron } from './smoke-electron.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.platform !== 'darwin') throw new Error('macOS is required to install the desktop app.')
if (process.argv.length > 2) throw new Error('Usage: node scripts/deliver-electron.mjs')
await run('bash', ['scripts/package-electron.sh'], { cwd: root })
const revision = (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const candidate = join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Perpetual Swap Suite.app')
const report = await installApp({
  candidate, destination: '/Applications/Perpetual Swap Suite.app', revision,
  beforeReplace: quitInstalledApp,
  smoke: (app, expected) => smokeElectron({ app, revision: expected }),
})
console.log(JSON.stringify({ installed: '/Applications/Perpetual Swap Suite.app', ...report }, null, 2))
