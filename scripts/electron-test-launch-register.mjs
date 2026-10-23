import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { realpathSync } from 'node:fs'
import { assertBackgroundTestLaunch, testPresentation } from '../electron/test-presentation.js'

export function assertTestSpawn(executable, options = {}, platform = process.platform) {
  const environment = options.env ?? process.env
  if (platform !== 'darwin') return
  // Electron's embedded Node mode never initializes the application/window
  // lifecycle. Core CPU/worker measurements use it without creating a UI.
  if (environment.ELECTRON_RUN_AS_NODE === '1') return
  let path = String(executable)
  try { path = realpathSync(path) } catch { /* Missing binaries fail normally. */ }
  if (/\.app\/Contents\/MacOS\//.test(path)) {
    testPresentation(environment) // Reject a local foreground override, too.
    if (environment.PERPETUAL_SWAP_TEST_UI !== 'foreground') {
      assertBackgroundTestLaunch({ executable: path, platform, environment: { ...environment, PERPETUAL_SWAP_TEST_UI: 'background' } })
    }
  }
}

// Playwright launches through child_process.spawn. Install in Node before any
// tests import it; explicit executablePath cannot bypass the prepared bundle.
export function installTestLaunchGuard(target = childProcess, platform = process.platform) {
  const spawn = target.spawn
  target.spawn = function (executable, args, options) {
    assertTestSpawn(executable, Array.isArray(args) ? options : args, platform)
    return spawn.apply(this, arguments)
  }
}

if (process.env.PERPETUAL_SWAP_SANDBOX === '1') {
  installTestLaunchGuard()
  syncBuiltinESMExports()
}
