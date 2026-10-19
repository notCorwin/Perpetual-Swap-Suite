// Deterministic application boundary, not an OS security sandbox. Fixtures may
// inject transports; actual fetch/WebSocket access is loopback-only by default.
export function assertSandboxURL(input) {
  if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_ALLOW_NETWORK === '1') return
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) {
    const error = new Error('External network is disabled in the operation sandbox. Use an injected fixture or explicitly enable live network.')
    error.code = 'SANDBOX_NETWORK_BLOCKED'
    throw error
  }
}

let installed = false
export function installSandboxNetworkBoundary() {
  if (installed || process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_ALLOW_NETWORK === '1') return
  installed = true
  const fetcher = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assertSandboxURL(input)
    // A permitted loopback response cannot redirect to an external service.
    return fetcher(input, { ...init, redirect: 'error' })
  }
  const Socket = globalThis.WebSocket
  if (Socket) globalThis.WebSocket = new Proxy(Socket, { construct(target, args) {
    assertSandboxURL(args[0]); return Reflect.construct(target, args, target)
  } })
}
