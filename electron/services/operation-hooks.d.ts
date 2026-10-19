export function installOperationHooks(): string[]
export function withOperationHookSuppressed<T>(domain: 'network' | 'io' | 'cpu' | 'database', operation: () => T): T
export function isOperationHookSuppressed(domain: 'network' | 'io' | 'cpu' | 'database'): boolean
