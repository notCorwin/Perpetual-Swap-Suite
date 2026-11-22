import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const run = (program, args, options = {}) => spawnSync(program, args, { cwd: root, encoding: 'utf8', ...options })

test('comparison and build require an explicit output directory before creating files', () => {
  for (const script of ['run.mjs', 'build.mjs']) {
    const result = run(process.execPath, [`experiments/runtime-comparison/${script}`])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Specify --output <directory>/)
  }
  const environment = { ...process.env }
  delete environment.CARGO_TARGET_DIR
  const direct = run('sh', ['experiments/runtime-comparison/tauri/build.sh'], { env: environment })
  assert.notEqual(direct.status, 0)
  assert.match(direct.stderr, /Set CARGO_TARGET_DIR explicitly/)
})

test('Tauri build places its target and bundle in the chosen output', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'runtime-output-test-'))
  try {
    const bin = join(temporary, 'bin'), output = join(temporary, 'output')
    await mkdir(bin)
    await writeFile(join(bin, 'cargo'), '#!/bin/sh\nmkdir -p "$CARGO_TARGET_DIR/release"\nprintf binary > "$CARGO_TARGET_DIR/release/radar-tauri-compare"\n', { mode: 0o755 })
    await writeFile(join(bin, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const result = run(process.execPath, ['experiments/runtime-comparison/build.mjs', '--output', output], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(await readFile(join(output, 'tauri-target/release/radar-tauri-compare'), 'utf8'), 'binary')
    assert.equal(await readFile(join(output, 'Radar Tauri Comparison.app/Contents/MacOS/radar-tauri-compare'), 'utf8'), 'binary')
    assert.equal(resolve(output, 'Radar Tauri Comparison.app/Contents/MacOS/radar-tauri-compare'), JSON.parse(result.stdout.trim().split('\n').at(-1)).executable)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
