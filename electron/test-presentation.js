// Window presentation is independent of fixture data and production security.
export function testPresentation(environment = process.env) {
  const mode = environment.PERPETUAL_SWAP_TEST_UI
  if (mode !== undefined && mode !== 'background' && mode !== 'foreground') {
    throw new Error('PERPETUAL_SWAP_TEST_UI must be background or foreground.')
  }
  return mode ?? (environment.PERPETUAL_SWAP_E2E === '1' || environment.PERPETUAL_SWAP_SANDBOX === '1' ? 'background' : 'foreground')
}

export function requireForegroundTests(environment = process.env) {
  if (environment.PERPETUAL_SWAP_TEST_UI !== 'foreground') {
    throw new Error('Native paint acceptance requires a visible, focused window. Use npm run test:foreground or sandbox command --foreground explicitly.')
  }
}
