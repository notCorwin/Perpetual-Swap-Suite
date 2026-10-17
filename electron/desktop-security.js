import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function parseURL(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return null
  }
  try { return new URL(value) } catch { return null }
}

/** Only user-facing web links and email links may leave the application. */
export function isAllowedExternalURL(value) {
  const url = parseURL(value)
  if (!url || url.username || url.password) return false
  if (url.protocol === 'http:' || url.protocol === 'https:') return Boolean(url.hostname)
  return url.protocol === 'mailto:' && !url.host && Boolean(url.pathname) && !/%0[ad]/i.test(url.pathname)
}

/** Bind trust to this window's main frame and its configured renderer. */
export function createDesktopSecurity({ rendererURL, rendererFile } = {}) {
  let trusted
  if (rendererURL !== undefined) {
    trusted = parseURL(rendererURL)
    if (!trusted || !['http:', 'https:'].includes(trusted.protocol) || !LOOPBACK_HOSTS.has(trusted.hostname)
      || trusted.username || trusted.password) throw new Error('The development renderer URL must use an exact loopback HTTP origin.')
  } else {
    if (typeof rendererFile !== 'string' || !isAbsolute(rendererFile)) throw new Error('An absolute renderer file path is required.')
    trusted = pathToFileURL(rendererFile)
  }

  function isTrustedURL(value) {
    const url = parseURL(value)
    if (!url || url.username || url.password || url.protocol !== trusted.protocol) return false
    if (trusted.protocol !== 'file:') return url.origin === trusted.origin
    return url.host === trusted.host && url.pathname === trusted.pathname && !url.search
  }

  function isTrustedSender(event, mainWindow) {
    if (!mainWindow || typeof mainWindow.isDestroyed !== 'function' || mainWindow.isDestroyed()) return false
    const contents = mainWindow.webContents
    if (!contents || typeof contents.isDestroyed !== 'function' || contents.isDestroyed() || event?.sender !== contents) return false
    const frame = event.senderFrame
    return Boolean(frame && frame === contents.mainFrame && isTrustedURL(frame.url)
      && typeof contents.getURL === 'function' && isTrustedURL(contents.getURL()))
  }

  function assertTrustedSender(event, mainWindow) {
    if (!isTrustedSender(event, mainWindow)) throw new Error('Desktop requests are restricted to the application main frame.')
  }

  return Object.freeze({ isTrustedURL, isAllowedNavigation: isTrustedURL, isTrustedSender, assertTrustedSender, isAllowedExternalURL })
}
