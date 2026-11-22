import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { listPackage } from '@electron/asar'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintInputs, inspectApp, run, trashPath, withBuildCleanup } from './electron-delivery.mjs'

import { assertDesktopImports, assertPackagedEntries } from './package-layout.mjs'
import { verifyBuildReuseManifest } from './build-artifact-reuse.mjs'
import { buildRendererUnlocked } from './build-renderer.mjs'
import { withBuildLock } from './build-lock.mjs'
import { assertOutsideBuildSync } from './build-output-path.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
export async function preparePackagedRenderer({ root, reuseBuildManifest }, { verify = verifyBuildReuseManifest, execute = () => buildRendererUnlocked({ root }) } = {}) {
  if (reuseBuildManifest) return verify({ root, manifestPath: reuseBuildManifest })
  await execute()
}

export async function packageElectronUnlocked({ reuseBuildManifest } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS is required to package the desktop app.')
  if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`Unsupported macOS architecture: ${process.arch}`)
  if (reuseBuildManifest) assertOutsideBuildSync(root, resolve(root, reuseBuildManifest), 'Build reuse manifest')
  return withBuildCleanup(root, async () => {
    const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
    const dirty = Boolean((await execute('git', ['status', '--porcelain'], { cwd: root })).stdout.trim())
    await assertDesktopImports(join(root, 'electron'))
    await preparePackagedRenderer({ root, reuseBuildManifest })
    const metadata = { schemaVersion: 1, revision, dirty, builtAt: new Date().toISOString(), arch: process.arch }
    const temporary = await mkdtemp(join(tmpdir(), 'perpetual-swap-package-'))
    const metadataPath = join(temporary, 'build-revision.json')
    try {
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
      const inputFingerprint = await fingerprintInputs(root)
      await run(join(root, 'node_modules', '.bin', 'electron-builder'), [
        '--mac', '--dir', `--${process.arch}`, '--publish', 'never', '--config', 'scripts/electron-builder.config.cjs',
      ], { cwd: root, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', PERPETUAL_SWAP_BUILD_METADATA: metadataPath } })
      if (await fingerprintInputs(root) !== inputFingerprint) throw new Error('Packaging inputs changed while building the app. Finish edits and package again.')
      const app = join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Perpetual Swap Suite.app')
      const entries = listPackage(join(app, 'Contents/Resources/app.asar'))
      assertPackagedEntries(entries)
      await run('codesign', ['--force', '--deep', '--sign', '-', app])
      await inspectApp(app, revision)
      console.log(JSON.stringify({ app, ...metadata }))
    } finally {
      await trashPath(temporary)
    }
  })
}

export async function packageElectron(options = {}) {
  return withBuildLock(root, () => packageElectronUnlocked(options))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'reuse-build-manifest': { type: 'string' } } })
  await packageElectron({ reuseBuildManifest: values['reuse-build-manifest'] })
}
