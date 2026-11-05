import type { OperationBridgeHooks } from '../../src/desktop-contract.ts'

// Keep the desktop bridge's request and notification paths active, without
// configuring an operation context, journal sink, timer, or observer.
let nextRequestId = 0

export async function initializeOperationTelemetry(): Promise<() => Promise<void>> {
  const hooks: OperationBridgeHooks = {
    beginRequest() { return { id: `comparison-off:${++nextRequestId}`, context: {} } },
    endRequest() {},
    receive(channel, detail, _context, decode) {
      window.dispatchEvent(new CustomEvent(channel.replace(':', '-'), { detail: decode ? decode(detail) : detail }))
    },
    async flush() {},
  }
  await window.radarDesktop.initializeOperations(hooks)
  return async () => {}
}
