import type { ResearchJob } from './research-types'

export const researchTaskActive = (job: ResearchJob | null) => Boolean(job && ['planning', 'preparing', 'running'].includes(job.phase))

const planningStages: Record<string, string> = { registry: 'Reading instrument metadata', localImport: 'Inspecting recorded Radar history', missing: 'Checking local data gaps', sources: 'Planning download ranges', cache: 'Checking cached files', coverage: 'Checking local input coverage', saving: 'Saving data plan' }
export function researchPlanningStage(job: ResearchJob) {
  return job.catalog ? 'Checking archive catalog' : job.planning ? planningStages[job.planning.stage] ?? 'Planning data' : 'Starting planning'
}
export function researchProgressLabel(job: ResearchJob) {
  if (job.catalog) return 'Catalog pages checked'
  if (job.planning) return ({ hours: 'Hourly inputs checked', ranges: 'Local ranges checked', instruments: 'Instruments checked', sources: 'Source files checked', steps: 'Steps completed' } as Record<string, string>)[job.planning.unit] ?? 'Checks completed'
  return job.phase === 'preparing' || job.preparation ? 'Sources prepared' : 'Work completed'
}
export function researchPlanningDescription(job: ResearchJob) {
  if (job.catalog) return 'Reading published archive catalogs; file downloads start after Prepare Data.'
  switch (job.planning?.stage) {
    case 'coverage': return 'Checking cached hours and missing intervals for each input type. This stage reads local data; file downloads start after Prepare Data.'
    case 'localImport': return 'Inspecting and reusing recorded Radar history; file downloads start after Prepare Data.'
    case 'missing': return 'Finding local data gaps to select archive requests; file downloads start after Prepare Data.'
    case 'sources': return 'Selecting archive files and API ranges for missing data; file downloads start after Prepare Data.'
    case 'cache': return 'Checking which source files are already on disk; file downloads start after Prepare Data.'
    case 'saving': return 'Saving the data plan and retaining local inputs. Review it before Prepare Data.'
    default: return 'Reading verified instrument metadata from the local cache or OKX; file downloads start after Prepare Data.'
  }
}

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
  if (!researchTaskActive(job)) return ''
  const retryAt = job.catalog?.retryAt ?? job.preparation?.retryAt ?? job.planning?.retryAt
  if (retryAt != null) return retryAt > now ? 'OKX rate limit. Retrying automatically in ' + researchDuration((retryAt - now) / 1000) + '; completed data stays on disk.' : 'Retrying the current request automatically after the OKX rate limit.'
  const elapsed = Math.max(0, (now - (job.updatedAt ?? now)) / 1000)
  if (!network) return job.planning && elapsed >= 15 ? 'Last check progress update was ' + researchDuration(elapsed) + ' ago. No error has been reported.' : ''
  return elapsed >= 15 ? 'No data received for ' + researchDuration(elapsed) + '. Waiting for OKX; no error has been reported.' : ''
}
