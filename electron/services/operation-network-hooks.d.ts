import type { OperationHookCapability } from './operation-hooks.js'
type NetworkIntegration = {
  captureScope(): unknown
  resumeScope<T>(scope: unknown, operation: () => T): T
  restoreEmitterContexts(target: unknown): void
  restoreEventTargetContexts(target: unknown): void
  decorateResponse(response: unknown, state: unknown): void
  suppressed(): boolean
  withNetwork<T>(operation: () => T): T
}
export function installNativeNetworkHooks(integration: NetworkIntegration): unknown[]
export function getNativeNetworkHookCapabilities(): OperationHookCapability[]
export function installElectronNetworkHooks(electron: { app: Pick<Electron.App, 'isReady'>; net: Electron.Net; session: typeof import('electron').session }, integration: NetworkIntegration): unknown[]
