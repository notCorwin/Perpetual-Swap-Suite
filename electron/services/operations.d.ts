export type OperationCategory = 'cpu' | 'gpu' | 'network' | 'database' | 'io' | 'ipc'
export type OperationAttributes = Record<string, string | number | boolean | null>
export type OperationContext = { traceId?: string; parentId?: string; scenarioId?: string }
export type OperationSpec = { category: OperationCategory; name: string; resource?: string; attributes?: OperationAttributes }
export type ObservedOperation = OperationSpec & { startedAt: number; durationMS: number; status: 'ok' | 'error' | 'cancelled'; cpuTimeMS?: number }
export type OperationEvent = ObservedOperation & { schemaVersion: 2; phase: 'end'; sessionId: string; executionId: string; id: string; sequence: number; traceId: string; parentId?: string; scenarioId?: string }
export type OperationJournalEvent = Omit<OperationEvent, 'phase' | 'status'> & { phase: 'start' | 'end'; status: 'running' | ObservedOperation['status'] }
export type OperationSpan = { context: OperationContext; run<T>(operation: () => T): T; end(result?: { status?: ObservedOperation['status']; attributes?: OperationAttributes; cpuTimeMS?: number }): void }
export function configureOperationContext(value: { sessionId?: string; executionId?: string; scenarioId?: string }, clock?: () => number): void
export function configureOperationPropagation(value: { get(): OperationContext | undefined; run<T>(context: OperationContext, operation: () => T): T }): void
export function getOperationContext(): OperationContext
export function runWithOperationContext<T>(context: OperationContext | undefined, operation: () => T): T
export function withOperationSuppressed<T>(operation: () => T): T
export function isOperationSuppressed(): boolean
export function hasOperationRecording(): boolean
export function readOperationCPUTime(): number | undefined
export function attachOperationSink(sink: (event: OperationEvent) => void): () => void
export function attachOperationJournalSink(sink: (event: OperationJournalEvent) => void): () => void
export function recordOperation(event: ObservedOperation): void
export function beginOperation(specification: OperationSpec): OperationSpan
export function finishActiveOperations(reason?: string): void
export function measureOperation<T>(specification: OperationSpec, operation: () => T): T
export function hookOperationMethods(target: object, specifications: Record<string, OperationSpec | ((...args: any[]) => OperationSpec)>): void
export function registerOperationImportSource(executionId: string, sessionId: string): void
export function importOperationEvents(events: OperationJournalEvent[]): { accepted: number; duplicates: number; rejected: number; lastSequence: number }
