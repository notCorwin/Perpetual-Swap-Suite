import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
export class MarketBackend extends EventEmitter {
  constructor(options: { userData: string; testMode: boolean; e2eLiveRefresh?: boolean })
  readonly ready: Promise<void>
  readonly worker: Worker
  request<T = any>(request: unknown): Promise<T>
  credentials(): Promise<string>
  probe<T = any>(request: unknown): Promise<T>
  dispose(): Promise<void>
}
