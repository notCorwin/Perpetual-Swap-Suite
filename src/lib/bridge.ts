import { mockSnapshot } from '../mock-data'
import type { AppSettings, ValidationReport, WorkspaceSnapshot } from '../types'

type NativeBridge = { postMessage(request: Record<string, unknown>): Promise<unknown> }

declare global {
  interface Window {
    webkit?: { messageHandlers: { suite: NativeBridge } }
  }
}

export async function requestSnapshot(request: Record<string, unknown>): Promise<WorkspaceSnapshot> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) {
    await Promise.resolve()
    if (request.method === 'settings' && request.settings) return { ...mockSnapshot, settings: request.settings as AppSettings }
    if (request.instrument) return { ...mockSnapshot, selectedInstrument: request.instrument as string }
    return mockSnapshot
  }
  return await bridge.postMessage(request) as WorkspaceSnapshot
}

export async function validateData(): Promise<ValidationReport> {
  const bridge = window.webkit?.messageHandlers.suite
  if (!bridge) return { checkedFiles: 6, invalidFiles: [], duplicateCandles: 0, checkedAt: Date.now() }
  return await bridge.postMessage({ method: 'validate' }) as ValidationReport
}
