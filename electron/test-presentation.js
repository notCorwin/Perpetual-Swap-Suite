import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Window presentation is independent of fixture data and production security.
export function isHostedMacOSCI(environment = process.env) {
  return environment.GITHUB_ACTIONS === 'true'
    && environment.RUNNER_ENVIRONMENT === 'github-hosted'
    && environment.RUNNER_OS === 'macOS'
}

export function testPresentation(environment = process.env) {
  const mode = environment.PERPETUAL_SWAP_TEST_UI
  if (mode !== undefined && mode !== 'background' && mode !== 'foreground') {
    throw new Error('PERPETUAL_SWAP_TEST_UI must be background or foreground.')
  }
  if (mode === 'foreground') requireForegroundTests(environment)
  return mode ?? (environment.PERPETUAL_SWAP_E2E === '1' || environment.PERPETUAL_SWAP_SANDBOX === '1' ? 'background' : 'foreground')
}

export function requireForegroundTests(environment = process.env) {
  if (environment.PERPETUAL_SWAP_TEST_UI !== 'foreground' || !isHostedMacOSCI(environment)) {
    throw new Error('Native foreground tests are restricted to GitHub-hosted macOS CI. Local tests must keep their windows hidden; --foreground cannot enable them locally.')
  }
}

// This check is also run by the Node launch hook, BEFORE spawning Electron.
// Calling setActivationPolicy after launch alone leaves a Launch Services race.
export function assertBackgroundTestLaunch({ executable = process.execPath, environment = process.env, platform = process.platform } = {}) {
  if (testPresentation(environment) !== 'background' || platform !== 'darwin') return
  const fail = detail => { throw new Error(`Unsafe macOS test launch: ${detail}. Run through scripts/test-sandbox.mjs with a prepared background-only Electron bundle.`) }
  if (!environment.PERPETUAL_SWAP_USER_DATA) fail('an isolated test profile is required')
  if (!environment.PERPETUAL_SWAP_TEST_GUARD) fail('the pre-launch background guard is missing')
  let guard, actual, plist
  try {
    guard = JSON.parse(readFileSync(environment.PERPETUAL_SWAP_TEST_GUARD, 'utf8'))
    actual = realpathSync(executable)
    plist = readFileSync(join(dirname(dirname(actual)), 'Info.plist'), 'utf8')
  } catch { fail('the background guard or executable cannot be read') }
  if (guard.schemaVersion !== 1 || guard.presentation !== 'background-only-offscreen'
    || actual !== resolve(guard.executable ?? '') || !/^[a-f0-9]{64}$/.test(guard.sourceFingerprint ?? '')) fail('the executable is not the prepared test replica')
  if (!/<key>LSBackgroundOnly<\/key>\s*<true\s*\/>/.test(plist)) fail('LSBackgroundOnly must be true before process launch')
  if (!/<key>LSUIElement<\/key>\s*<false\s*\/>/.test(plist)) fail('LSUIElement must be false in the test replica')
  const profile = resolve(environment.PERPETUAL_SWAP_USER_DATA)
  if (environment.PERPETUAL_SWAP_PRODUCTION_USER_DATA && profile === resolve(environment.PERPETUAL_SWAP_PRODUCTION_USER_DATA)) fail('the production profile cannot be used')
}

export function testWindowOptions(background) {
  return {
    show: false,
    focusable: !background,
    frame: !background,
    webPreferences: { offscreen: background, backgroundThrottling: !background },
  }
}
