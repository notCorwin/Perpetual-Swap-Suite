import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron } from 'playwright'
import { readDesignLengths } from '../../src/design-lengths.ts'

test('shared spacing resolves calc lengths in the hidden renderer without changing layout density', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'perp-spacing-'))
  let electron
  try {
    electron = await _electron.launch({ args: ['.', '--headless', '--disable-gpu'], cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PERPETUAL_SWAP_E2E: '1', PERPETUAL_SWAP_USER_DATA: userData } })
    const page = await electron.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const result = await page.evaluate(async reader => {
      await document.fonts.ready
      const read = (0, eval)(`(${reader})`)
      const before = document.documentElement.children.length
      const defaults = { '--space-4': 901, '--chart-legend-gap': 902, '--space-annotation-label': 903 }
      const normal = read(defaults)
      document.documentElement.style.setProperty('--space-unit', '6px')
      const doubled = read(defaults)
      document.documentElement.style.removeProperty('--space-unit')
      const box = document.createElement('div')
      box.className = 'flex gap-4 px-4'
      document.body.append(box)
      const style = getComputedStyle(box)
      const density = { gap: style.gap, padding: style.paddingLeft }
      box.remove()
      return { normal, doubled, density, leftoverNodes: document.documentElement.children.length - before }
    }, readDesignLengths.toString())
    assert.deepEqual(result.normal, { '--space-4': 12, '--chart-legend-gap': 16, '--space-annotation-label': 26 })
    assert.deepEqual(result.doubled, { '--space-4': 24, '--chart-legend-gap': 32, '--space-annotation-label': 52 })
    assert.deepEqual(result.density, { gap: '12px', padding: '12px' })
    assert.equal(result.leftoverNodes, 0)
    await page.evaluate(() => { location.hash = '#/settings/liquidity' })
    await page.locator('#slippageNotional').waitFor()
    const alignment = await page.evaluate(() => {
      const threshold = document.getElementById('threshold-slippage').closest('[data-slot="input-group"]')
      const amount = document.getElementById('slippageNotional')
      const a = threshold.getBoundingClientRect(), b = amount.getBoundingClientRect()
      return { delta: Math.abs(a.left - b.left), width: a.width, amountWidth: b.width, height: a.height,
        controlHeight: amount.getBoundingClientRect().height }
    })
    assert.ok(alignment.delta < 1, `Dependent controls must share their parent grid column: ${JSON.stringify(alignment)}`)
    assert.equal(alignment.width, alignment.amountWidth)
    assert.ok(alignment.height >= 24 && alignment.controlHeight >= 24)
    await page.evaluate(() => { location.hash = '#/settings/data' })
    await page.getByText('Data integrity', { exact: true }).waitFor()
    const legendGap = await page.getByText('Data integrity', { exact: true }).evaluate(legend => {
      const next = legend.nextElementSibling
      return next.getBoundingClientRect().top - legend.getBoundingClientRect().bottom + parseFloat(getComputedStyle(legend).paddingBottom)
    })
    assert.ok(legendGap >= 6, 'Native fieldset legends must keep container-owned separation.')
    const markdown = await page.evaluate(() => {
      const container = document.createElement('div')
      container.className = 'analysis-markdown flex flex-col gap-4'
      container.innerHTML = '<p>Paragraph</p><div data-streamdown="code-block" class="my-4"><pre><code>code</code></pre></div><hr class="my-6"><ul><li>Nested<ul><li>Item</li></ul></li></ul>'
      container.dataset.analysisAnswer = ''
      document.body.append(container)
      const result = { gap: getComputedStyle(container).gap, margins: [...container.children].map(child => getComputedStyle(child).marginBlock),
        nestedGap: getComputedStyle(container.querySelector('ul ul')).gap }
      container.remove()
      return result
    })
    assert.equal(markdown.gap, '12px')
    assert.deepEqual(markdown.margins, ['0px', '0px', '0px', '0px'])
    assert.equal(markdown.nestedGap, '6px')
  } finally {
    await electron?.close()
    await rm(userData, { recursive: true, force: true })
  }
})
