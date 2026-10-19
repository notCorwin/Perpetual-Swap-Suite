export type OperationCategory = 'cpu' | 'gpu' | 'network' | 'database'
export type OperationAttributes = Record<string, string | number | boolean | null>
export type OperationSpec = { category: OperationCategory; name: string; resource?: string; attributes?: OperationAttributes }
export type ObservedOperation = OperationSpec & { startedAt: number; durationMS: number; status: 'ok' | 'error' | 'cancelled'; cpuTimeMS?: number }
export type OperationEvent = ObservedOperation & { schemaVersion: 1; sessionId: string; executionId: string; id: string }
export function configureOperationContext(value: { sessionId?: string; executionId?: string }, clock?: () => number): void
export function attachOperationSink(sink: (event: OperationEvent) => void): () => void
export function recordOperation(event: ObservedOperation): void
export function beginOperation(specification: OperationSpec): { end(result?: { status?: ObservedOperation['status']; attributes?: OperationAttributes }): void }
export function finishActiveOperations(reason?: string): void
export function measureOperation<T>(specification: OperationSpec, operation: () => T): T
