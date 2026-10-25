import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testPresentation, requireForegroundTests } from '../../electron/test-presentation.js'
import { sandboxCommands } from '../../scripts/test-sandbox.mjs'
import { foregroundPaintWindow } from '../../scripts/chart-acceptance.mjs'

const hostedMac = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', PERPETUAL_SWAP_TEST_UI: 'foreground' }

test('test windows default to background independently of production fixture access', () => {
  assert.equal(testPresentation({}), 'foreground')
  assert.equal(testPresentation({ PERPETUAL_SWAP_E2E: '1' }), 'background')
  assert.equal(testPresentation({ PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_E2E: '0' }), 'background')
  assert.equal(testPresentation({ PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_E2E: '0' }), 'background')
  assert.throws(() => testPresentation({ PERPETUAL_SWAP_TEST_UI: 'foreground', PERPETUAL_SWAP_E2E: '1' }), /restricted to GitHub-hosted macOS CI/)
  assert.equal(testPresentation({ ...hostedMac, PERPETUAL_SWAP_E2E: '1' }), 'foreground')
  assert.throws(() => testPresentation({ PERPETUAL_SWAP_TEST_UI: 'invalid' }), /must be background or foreground/)
})

test('ordinary test commands exclude native foreground acceptance and the explicit suite retains it', async () => {
  for (const mode of ['e2e', 'all']) {
    const commands = await sandboxCommands(mode)
    const files = commands.flat()
    assert.ok(files.includes('tests/e2e/desktop-security.e2e.mjs'))
    assert.ok(files.includes('tests/e2e/operation-recording.e2e.mjs'))
    assert.equal(files.includes('tests/e2e/graphics.gpu.mjs'), mode === 'all')
    assert.ok(files.every(file => !file.endsWith('.foreground.mjs')))
  }
  const commands = await sandboxCommands('foreground')
  assert.deepEqual(commands.at(-1).filter(file => file.endsWith('.mjs') && file.startsWith('tests/')), [
    'tests/e2e/chart-paint.foreground.mjs',
    'tests/e2e/instrument-navigation.foreground.mjs',
  ])
})

test('native foreground measurement is limited to a dedicated hosted macOS CI runner', async () => {
  for (const environment of [{}, { PERPETUAL_SWAP_TEST_UI: 'background' }, { PERPETUAL_SWAP_TEST_UI: 'foreground' },
    { ...hostedMac, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...hostedMac, RUNNER_OS: 'Linux' }, { ...hostedMac, GITHUB_ACTIONS: 'false' }]) {
    assert.throws(() => requireForegroundTests(environment), /restricted to GitHub-hosted macOS CI/)
  }
  assert.doesNotThrow(() => requireForegroundTests(hostedMac))
  const previous = process.env.PERPETUAL_SWAP_TEST_UI
  process.env.PERPETUAL_SWAP_TEST_UI = 'background'
  try {
    await assert.rejects(foregroundPaintWindow({ evaluate() { assert.fail('A background test must never attempt native show/focus.') } }), /restricted to GitHub-hosted macOS CI/)
  } finally {
    if (previous === undefined) delete process.env.PERPETUAL_SWAP_TEST_UI
    else process.env.PERPETUAL_SWAP_TEST_UI = previous
  }
})

test('local foreground commands fail before building, launching Electron, or creating a sandbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-no-foreground-'))
  const environment = { ...process.env, PERPETUAL_SWAP_TEST_UI: 'foreground' }
  for (const key of ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS']) delete environment[key]
  const runner = fileURLToPath(new URL('../../scripts/test-sandbox.mjs', import.meta.url))
  try {
    for (const args of [['foreground'], ['command', '--foreground', '--', process.execPath, '-e', 'process.exit(99)']]) {
      const separator = args.indexOf('--')
      const flags = ['--output', directory]
      const command = separator < 0 ? [...args, ...flags] : [...args.slice(0, separator), ...flags, ...args.slice(separator)]
      const result = spawnSync(process.execPath, [runner, ...command], { env: environment, encoding: 'utf8', timeout: 10_000 })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /restricted to GitHub-hosted macOS CI/)
      assert.doesNotMatch(result.stdout, /Sandbox:|vite|Electron/)
      assert.deepEqual(await readdir(directory), [], 'A rejected local request cannot start test work.')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
