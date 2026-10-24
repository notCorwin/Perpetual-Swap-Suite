import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadRendererModules } from '../../scripts/operation-overhead-modules.mjs'

test('the actual benchmark serves and fingerprints the chart runtime dependencies', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const { modules, hashes } = await loadRendererModules(root)
  assert.ok(modules.has('/src/rsi-crossings.ts'), 'Chart geometry must load its crossing calculator in the benchmark.')
  assert.ok(modules.has('/electron/services/operations.js'))
  assert.equal(modules.has('/src/chart-data.ts'), false, 'Erased type imports do not create browser requests.')
  const source = await readFile(join(root, 'src/rsi-crossings.ts'), 'utf8')
  assert.equal(hashes['src/rsi-crossings.ts'], createHash('sha256').update(source).digest('hex'))
})

test('new transitive imports load automatically and invalidate fingerprints through cycles and re-exports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'renderer-module-graph-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all([
    writeFile(join(root, 'entry.ts'), "import type { Unused } from './missing-types.ts'; export { value } from './value.js'; export * from './cycle.js'"),
    writeFile(join(root, 'value.js'), 'export const value = 1'),
    writeFile(join(root, 'cycle.js'), "import './entry.ts'; export const lazy = () => import('./value.js')"),
  ])
  const first = await loadRendererModules(root, ['entry.ts'])
  assert.deepEqual([...first.modules.keys()].sort(), ['/cycle.js', '/entry.ts', '/value.js'])
  await writeFile(join(root, 'value.js'), "import './added.js'; export const value = 2")
  await writeFile(join(root, 'added.js'), 'export const added = true')
  const next = await loadRendererModules(root, ['entry.ts'])
  assert.ok(next.modules.has('/added.js'), 'The entrypoint list does not need changes when a dependency adds an import.')
  assert.ok(next.hashes['added.js'])
  assert.notEqual(next.hashes['value.js'], first.hashes['value.js'])
  assert.equal(next.hashes['entry.ts'], first.hashes['entry.ts'])
})
