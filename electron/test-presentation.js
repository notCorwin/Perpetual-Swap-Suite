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
