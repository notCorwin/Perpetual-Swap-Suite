import { join, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { run, withBuildCleanup } from './electron-delivery.mjs'
import { withBuildLock } from './build-lock.mjs'
import { captureBuildInputs, writeBuildReuseManifest } from './build-artifact-reuse.mjs'
import { assertOutsideBuildSync } from './build-output-path.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export async function buildRendererUnlocked({ root = projectRoot, execute = run } = {}) {
  const manifestPath = process.env.PERPETUAL_SWAP_BUILD_RESULT_MANIFEST
  if (manifestPath) assertOutsideBuildSync(root, resolve(root, manifestPath), 'Build result manifest')
  return withBuildCleanup(root, async () => {
    if (manifestPath && await lstat(resolve(root, manifestPath)).catch(error => { if (error.code === 'ENOENT') return null; throw error })) {
      throw new Error('The build result manifest path already exists; choose an unused path.')
    }
    const before = manifestPath ? await captureBuildInputs({ root, manifestPath }) : null
    const bin = name => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
    await execute(bin('tsc'), ['-b'], { cwd: root })
    await execute(bin('vite'), ['build'], { cwd: root })
    if (manifestPath) await writeBuildReuseManifest({ root, manifestPath, expectedBuildKey: before.key })
  })
}

export async function buildRenderer(options = {}) {
  return withBuildLock(options.root ?? projectRoot, () => buildRendererUnlocked(options))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRenderer()
