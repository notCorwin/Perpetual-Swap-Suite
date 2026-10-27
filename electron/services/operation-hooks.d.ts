export type OperationHookCapability = { api: string; enabled: boolean; scope: string; reason?: string }
export function installOperationHooks(): string[]
export function getInstalledOperationHooks(): string[]
export function getOperationHookCapabilities(): OperationHookCapability[]
export function installElectronOperationHooks(electron: { app: Pick<Electron.App, 'isReady'>; net: Electron.Net; session: typeof import('electron').session }): OperationHookCapability[]
export function withOperationHookSuppressed<T>(domain: 'network' | 'io' | 'cpu' | 'database', operation: () => T): T
export function isOperationHookSuppressed(domain: 'network' | 'io' | 'cpu' | 'database'): boolean
