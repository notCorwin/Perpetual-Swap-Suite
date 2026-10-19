import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testPresentation, requireForegroundTests } from '../../electron/test-presentation.js'
import { sandboxCommands } from '../../scripts/test-sandbox.mjs'
import { foregroundPaintWindow } from '../../scripts/chart-acceptance.mjs'

test('test windows default to background independently of production fixture access', () => {
  assert.equal(testPresentation({}), 'foreground')
  assert.equal(testPresentation({ PERPETUAL_SWAP_E2E: '1' }), 'background')
  assert.equal(testPresentation({ PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_E2E: '0' }), 'background')
  assert.equal(testPresentation({ PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_E2E: '0' }), 'background')
  assert.equal(testPresentation({ PERPETUAL_SWAP_TEST_UI: 'foreground', PERPETUAL_SWAP_E2E: '1' }), 'foreground')
  assert.throws(() => testPresentation({ PERPETUAL_SWAP_TEST_UI: 'invalid' }), /must be background or foreground/)
})

test('ordinary test commands exclude native foreground acceptance and the explicit suite retains it', async () => {
  for (const mode of ['e2e', 'all']) {
    const commands = await sandboxCommands(mode)
    const files = commands.at(-1)
    assert.ok(files.includes('tests/e2e/desktop-security.e2e.mjs'))
    assert.ok(files.includes('tests/e2e/operation-recording.e2e.mjs'))
    assert.ok(files.every(file => !file.endsWith('.foreground.mjs')))
  }
  const commands = await sandboxCommands('foreground')
  assert.deepEqual(commands.at(-1).filter(file => file.endsWith('.mjs') && file.startsWith('tests/')), ['tests/e2e/chart-paint.foreground.mjs'])
})

test('native foreground measurement rejects before touching Electron without explicit opt-in', async () => {
  assert.throws(() => requireForegroundTests({}), /--foreground explicitly/)
  assert.throws(() => requireForegroundTests({ PERPETUAL_SWAP_TEST_UI: 'background' }), /--foreground explicitly/)
  assert.doesNotThrow(() => requireForegroundTests({ PERPETUAL_SWAP_TEST_UI: 'foreground' }))
  const previous = process.env.PERPETUAL_SWAP_TEST_UI
  process.env.PERPETUAL_SWAP_TEST_UI = 'background'
  try {
    await assert.rejects(foregroundPaintWindow({ evaluate() { assert.fail('A background test must never attempt native show/focus.') } }), /--foreground explicitly/)
  } finally {
    if (previous === undefined) delete process.env.PERPETUAL_SWAP_TEST_UI
    else process.env.PERPETUAL_SWAP_TEST_UI = previous
  }
})
