import type { HistoryDownload as PublishedHistoryDownload } from '../../src/desktop-contract.ts'
import type { HistorySync, HistoryTask } from './history-sync.js'

/** checked = available + empty + unavailable; all slots belong to exactly one
 * of those categories, failed, or pending. Only available contains numeric data.
 * Reports checkpoint a finite run; empty observations never start renewal work. */
export type HistoryDownloadReport = Omit<PublishedHistoryDownload, 'revision' | 'serviceSession'>
export type HistoryDownloadInstrument = { instId: string; listTime?: string | number }
export type HistoryDownloadOptions = {
  sync: HistorySync
  metadata: {
    getHistoryDownload(): HistoryDownloadReport | null
    saveHistoryDownload(report: HistoryDownloadReport): unknown
  }
  onChange?(report: HistoryDownloadReport): void
  now?(): number
  chunkSlots?: number
  concurrency?: number
}
export function emptyHistoryDownload(): HistoryDownloadReport
export class HistoryDownload {
  constructor(options: HistoryDownloadOptions)
  snapshot(): HistoryDownloadReport
  /** Freeze the qualified instrument set and all native completed-slot bounds. An active start is idempotent. */
  start(instruments: HistoryDownloadInstrument[]): HistoryDownloadReport
  /** Accept durable progress snapshots from the shared HistorySync owner. */
  observe(task: HistoryTask): void
  cancel(): Promise<HistoryDownloadReport>
  close(): Promise<void>
}
