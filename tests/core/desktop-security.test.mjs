import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createDesktopSecurity, isAllowedExternalURL } from '../../electron/desktop-security.js'

const rendererFile = '/Applications/Perpetual Swap Suite.app/Contents/Resources/app.asar/dist/index.html'
const rendererURL = pathToFileURL(rendererFile).href

function host(url) {
  const mainFrame = { url }
  const webContents = { mainFrame, isDestroyed: () => false, getURL: () => mainFrame.url }
  const window = { webContents, isDestroyed: () => false }
  return { window, event: { sender: webContents, senderFrame: mainFrame } }
}

test('packaged renderer trust requires its exact file path, with only fragment navigation permitted', () => {
  const security = createDesktopSecurity({ rendererFile })
  assert.equal(security.isTrustedURL(rendererURL), true)
  assert.equal(security.isAllowedNavigation(`${rendererURL}#chart`), true)
  for (const url of [
    pathToFileURL('/Applications/Other.app/Contents/Resources/app.asar/dist/index.html').href,
    `${rendererURL}/evil.html`, `${rendererURL}?other=1`, rendererURL.replace('/dist/', '/dist-other/'),
    'file://remote/Applications/Perpetual%20Swap%20Suite.app/Contents/Resources/app.asar/dist/index.html',
    'https://example.com', 'about:blank', 'javascript:alert(1)', 'data:text/html,hello', 'blob:https://example.com/id',
    null, {}, ` ${rendererURL}`, `${rendererURL}\n`,
  ]) {
    assert.equal(security.isTrustedURL(url), false, String(url))
    assert.equal(security.isAllowedNavigation(url), false, String(url))
  }
})

test('development renderer configuration must be loopback and navigation stays at its exact origin', () => {
  for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://[::1]:5173']) {
    const security = createDesktopSecurity({ rendererURL: `${origin}/`, rendererFile })
    assert.equal(security.isTrustedURL(`${origin}/chart?focus=BTC#latest`), true)
    assert.equal(security.isTrustedURL('https://example.com'), false)
  }
  const security = createDesktopSecurity({ rendererURL: 'http://127.0.0.1:5173', rendererFile })
  for (const url of [
    'http://127.0.0.1:5174', 'https://127.0.0.1:5173', 'http://localhost:5173',
    'http://127.0.0.1.evil.example:5173', 'http://localhost.evil.example:5173',
    'http://127.0.0.1:5173@evil.example', 'http://user@127.0.0.1:5173', rendererURL,
  ]) assert.equal(security.isTrustedURL(url), false, url)
  for (const url of ['https://example.com', 'http://0.0.0.0:5173', 'http://127.0.0.2:5173', 'http://localhost.evil.example', 'http://user@localhost:5173', 'file:///tmp/index.html', 'not-a-url', '']) {
    assert.throws(() => createDesktopSecurity({ rendererURL: url, rendererFile }))
  }
  assert.throws(() => createDesktopSecurity({ rendererFile: 'dist/index.html' }))
  assert.throws(() => createDesktopSecurity())
})

test('only the allowed main window main frame may issue desktop requests', () => {
  const security = createDesktopSecurity({ rendererFile })
  const { window, event } = host(rendererURL)
  assert.equal(security.isTrustedSender(event, window), true)
  assert.doesNotThrow(() => security.assertTrustedSender(event, window))
  for (const invalidEvent of [
    null, {}, { ...event, sender: host(rendererURL).window.webContents },
    { ...event, senderFrame: { url: rendererURL, parent: event.senderFrame } },
    { ...event, senderFrame: { url: rendererURL, parent: null } },
    { ...event, senderFrame: null },
  ]) {
    assert.equal(security.isTrustedSender(invalidEvent, window), false)
    assert.throws(() => security.assertTrustedSender(invalidEvent, window), /main frame/)
  }
  assert.equal(security.isTrustedSender(event, { ...window, isDestroyed: () => true }), false)
  window.webContents.isDestroyed = () => true
  assert.equal(security.isTrustedSender(event, window), false)
  window.webContents.isDestroyed = () => false
  event.senderFrame.url = 'https://example.com'
  assert.equal(security.isTrustedSender(event, window), false)
  event.senderFrame.url = rendererURL
  window.webContents.getURL = () => 'https://example.com'
  assert.equal(security.isTrustedSender(event, window), false)
})

test('external navigation only accepts web and email links without unsafe protocols or credentials', () => {
  for (const url of ['https://www.okx.com/help', 'http://example.com/path?query=1#top', 'mailto:support@example.com', 'mailto:support@example.com?subject=Chart%20question']) {
    assert.equal(isAllowedExternalURL(url), true, url)
  }
  for (const url of [
    'javascript:alert(1)', 'file:///tmp/data', 'data:text/html,hello', 'ftp://example.com', 'tel:1234',
    'shell:open', 'https://user:password@example.com', 'mailto:', 'mailto://example.com',
    'mailto:user@example.com%0d%0aBcc:other@example.com', 'https://example.com\n',
    ' https://example.com', 'not-a-url', '', null, {},
  ]) assert.equal(isAllowedExternalURL(url), false, String(url))
  assert.equal(createDesktopSecurity({ rendererFile }).isAllowedExternalURL('https://example.com'), true)
})
