import type { ResearchJob } from './research-types'

export const researchTaskActive = (job: ResearchJob | null) => Boolean(job && ['planning', 'preparing', 'running'].includes(job.phase))

export function researchByteSize(bytes: number) {
  const value = Math.max(0, bytes), power = value > 0 ? Math.max(0, Math.min(4, Math.floor(Math.log10(value) / 3))) : 0
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value / 1000 ** power) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][power]
}

export function researchDuration(seconds?: number) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return 'Estimating…'
  const value = Math.ceil(seconds)
  if (value < 60) return value + 's'
  if (value < 3600) return Math.floor(value / 60) + 'm ' + value % 60 + 's'
  if (value < 86400) return Math.floor(value / 3600) + 'h ' + Math.floor(value % 3600 / 60) + 'm'
  return Math.floor(value / 86400) + 'd ' + Math.floor(value % 86400 / 3600) + 'h'
}

export function researchFilePercent(job: ResearchJob) {
  const source = job.preparation
  if (!source) return undefined
  if (source.stage === 'fetching' && source.fraction != null) return Math.max(0, Math.min(100, source.fraction * 100))
  if (source.stage === 'downloading' && source.totalBytes != null && source.totalBytes > 0) return Math.max(0, Math.min(100, source.receivedBytes / source.totalBytes * 100))
  return undefined
}

export function researchWaiting(job: ResearchJob, now: number) {
  const network = job.catalog?.waitingForResponse || ['connecting', 'downloading', 'fetching'].includes(job.preparation?.stage ?? '')
  if (!researchTaskActive(job) || !network) return ''
  const elapsed = Math.max(0, (now - (job.updatedAt ?? now)) / 1000)
  return elapsed >= 15 ? 'No data received for ' + researchDuration(elapsed) + '. Waiting for OKX; no error has been reported.' : ''
}
