import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, withBuildCleanup } from './electron-delivery.mjs'
import { withBuildLock } from './build-lock.mjs'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

export async function buildRendererUnlocked({ root = projectRoot, execute = run } = {}) {
  return withBuildCleanup(root, async () => {
    const bin = name => join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name)
    await execute(bin('tsc'), ['-b'], { cwd: root })
    await execute(bin('vite'), ['build'], { cwd: root })
  })
}

export async function buildRenderer(options = {}) {
  return withBuildLock(options.root ?? projectRoot, () => buildRendererUnlocked(options))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRenderer()
