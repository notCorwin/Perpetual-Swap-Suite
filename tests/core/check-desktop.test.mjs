import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkDesktopFiles } from '../../scripts/check-desktop.mjs'

test('desktop checks parse all execution boundaries without executing their source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-desktop-check-'))
  try {
    await mkdir(join(root, 'electron/services'), { recursive: true })
    await mkdir(join(root, 'scripts'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const sources = {
      'electron/main.js': 'import "a-module-that-is-not-installed"; throw new Error("Must not execute")',
      'electron/preload.cjs': 'module.exports = function () { return 1 }',
      'electron/services/worker.mjs': 'export const work = async () => 1',
      'scripts/fixture.ts': 'type Count = number; export const count: Count = 1',
    }
    for (const [file, source] of Object.entries(sources)) await writeFile(join(root, file), source)
    const valid = checkDesktopFiles(root)
    assert.deepEqual(valid.checkedFiles.sort(), Object.keys(sources).sort())
    assert.deepEqual(valid.errors, [])

    for (const file of Object.keys(sources)) await writeFile(join(root, file), 'function broken( {')
    const invalid = checkDesktopFiles(root)
    assert.deepEqual(invalid.errors.map(error => error.file).sort(), Object.keys(sources).sort())
    assert.ok(invalid.errors.every(error => error.message.includes('SyntaxError')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
