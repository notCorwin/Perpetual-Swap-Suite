import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintInputs, inspectApp, run } from './electron-delivery.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
if (process.platform !== 'darwin') throw new Error('macOS is required to package the desktop app.')
if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`Unsupported macOS architecture: ${process.arch}`)
if (process.argv.length > 2) throw new Error('Usage: scripts/package-electron.sh')
const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
const dirty = Boolean((await execute('git', ['status', '--porcelain'], { cwd: root })).stdout.trim())
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== revision) throw new Error('The checkout revision differs from GITHUB_SHA.')
await run('npm', ['run', 'build'], { cwd: root })
const metadata = { schemaVersion: 1, revision, dirty, builtAt: new Date().toISOString(), arch: process.arch }
const metadataPath = join(root, '.build', 'build-revision.json')
await mkdir(dirname(metadataPath), { recursive: true })
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
const inputFingerprint = await fingerprintInputs(root)
await run(join(root, 'node_modules', '.bin', 'electron-builder'), [
  '--mac', '--dir', `--${process.arch}`, '--publish', 'never', '--config', 'scripts/electron-builder.config.cjs',
], { cwd: root, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } })
if (await fingerprintInputs(root) !== inputFingerprint) throw new Error('Packaging inputs changed while building the app. Finish edits and package again.')
const app = join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Perpetual Swap Suite.app')
await run('codesign', ['--force', '--deep', '--sign', '-', app])
await inspectApp(app, revision)
console.log(JSON.stringify({ app, ...metadata }))
