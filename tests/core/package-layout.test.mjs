import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPackagedEntries, assertRuntimeImports } from '../../scripts/package-layout.mjs'

test('package rejects nested Electron build output and redundant frontend dependencies', () => {
  const renderer = ['/dist/index.html', '/dist/assets/App-123.js', '/dist/assets/WorkspaceSettings-123.js', '/electron/main.js']
  assert.doesNotThrow(() => assertPackagedEntries(renderer))
  for (const unexpected of ['/dist/mac-arm64/Electron.app/Contents/MacOS/Electron', '/node_modules/react/index.js']) {
    assert.throws(() => assertPackagedEntries([...renderer, unexpected]), /Do not package/)
  }
  assert.throws(() => assertPackagedEntries(['/electron/main.js']), /renderer entry/)
})

test('external desktop imports require an explicit packaging decision', () => {
  assert.doesNotThrow(() => assertRuntimeImports("import { app } from 'electron'; import './worker.js'; const sqlite = await import('node:sqlite'); require('fs')", 'main.js'))
  for (const source of ["import db from 'some-database'", "await import('some-database')", "require('some-database')", 'require(computed)']) {
    assert.throws(() => assertRuntimeImports(source, 'main.js'), /packaging rule|dependencies must be explicit/)
  }
})
