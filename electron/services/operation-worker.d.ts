import type { Worker } from 'node:worker_threads'

/** Flush a worker's operation journal before terminating its native lifetime. */
export function stopOperationWorker(worker: Worker, resource: string, timeoutMS?: number): Promise<void>
