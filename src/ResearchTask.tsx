import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import type { ResearchJob } from '@/research-types'
import { researchByteSize, researchDuration, researchFilePercent, researchPlanningDescription, researchPlanningStage, researchProgressLabel, researchTaskActive, researchWaiting } from '@/research-task'
import { researchTime } from '@/research-types'

const stages: Record<string, string> = { checking: 'Checking local cache', connecting: 'Connecting to OKX', downloading: 'Downloading archive', fetching: 'Fetching history pages', verifying: 'Verifying downloaded data', importing: 'Importing downloaded data', prepared: 'Source prepared', freezing: 'Freezing dataset' }
const phases: Record<string, string> = { planning: 'Planning', planned: 'Data plan ready', preparing: 'Preparing data', running: 'Running study', ready: 'Data ready', completed: 'Study completed', failed: 'Failed', paused: 'Paused', cancelled: 'Cancelled' }

export function ResearchTask({ active, job, error, pending, onPause, onCancel, onResume }: {
  active: boolean; job: ResearchJob | null; error: string; pending: boolean
  onPause: () => void; onCancel: () => void; onResume: () => void
}) {
  const [now, setNow] = useState(Date.now), [dismissed, setDismissed] = useState('')
  const working = researchTaskActive(job), key = [job?.id, job?.phase, error].join(':')
  useEffect(() => {
    if (!active || !working) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active,working])
  if (!active || !job && !error || dismissed === key) return null
  const source = job?.preparation, percent = job ? researchFilePercent(job) : undefined
  const waiting = job ? researchWaiting(job, now) : ''
  const downloading = working && source?.stage === 'downloading', fetching = working && source?.stage === 'fetching'
  return createPortal(<aside data-research-task className="fixed bottom-0 left-0 z-40 w-(--market-list-layout-width) origin-bottom-left p-4 [transform:scale(var(--market-list-scale,1))] tabular-nums">
    <Alert variant={error ? 'task-error' : 'task'} role="region" aria-label="Research task">
      <AlertTitle className="flex items-center gap-3">
        {working && <Spinner aria-hidden="true" />}
        <span role="status" aria-live="polite">{error ? 'Research needs attention' : phases[job?.phase ?? ''] ?? 'Research'}</span>
        {source && (working || ['failed', 'paused'].includes(job?.phase ?? '')) && <Badge variant="outline">{stages[source.stage] ?? source.stage}</Badge>}
        {job && (job.planning || job.catalog) && <Badge variant="outline">{researchPlanningStage(job)}</Badge>}
        <span className="flex-1" />
        {working ? <><Button variant="outline" size="sm" disabled={pending} onClick={onPause}><Pause data-icon="inline-start" aria-hidden="true" />Pause</Button><Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}><X data-icon="inline-start" aria-hidden="true" />Cancel</Button></> : <>
          {job?.resultID && ['failed', 'paused'].includes(job.phase) && <Button variant="outline" size="sm" disabled={pending} onClick={onResume}><Play data-icon="inline-start" aria-hidden="true" />Resume</Button>}
          <Button variant="ghost" size="icon-sm" onClick={() => setDismissed(key)} aria-label="Dismiss research status"><X aria-hidden="true" /></Button>
        </>}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {job?.message && <p className="truncate" title={job.message}>{source?.instrument ? source.instrument + ' · ' : ''}{job.message}</p>}
        {error && <p role="alert" className="max-h-24 overflow-y-auto wrap-anywhere">{error}</p>}
        {job?.planning?.from != null && job.planning.through != null && <p className="text-xs">Current range: {researchTime(job.planning.from)} → {researchTime(job.planning.through)}</p>}
        {!working && job && job.total > 0 && <p>{researchProgressLabel(job)}: {job.completed.toLocaleString('en-US')} / {job.total.toLocaleString('en-US')}{source?.stage === 'downloading' ? ' · ' + researchByteSize(source.receivedBytes) + (source.totalBytes == null ? ' received' : ' / ' + researchByteSize(source.totalBytes)) : ''}</p>}
        {working && job && <>
          <div className="flex items-center justify-between gap-4"><span>{job.total > 0 ? <>{researchProgressLabel(job)}: {job.completed.toLocaleString('en-US')} / {job.total.toLocaleString('en-US')} · {Math.min(100, job.completed / job.total * 100).toFixed(1)}%</> : 'Preparing task details…'}</span><span>Elapsed {researchDuration(Math.max(0, (now - (job.startedAt ?? now)) / 1000))}</span></div>
          <Progress aria-label="Research task progress" value={job.total ? job.completed / job.total * 100 : undefined} />
          {job.phase === 'planning' && <>
            <p>{researchPlanningDescription(job)}</p>
            {(job.catalog || job.planning) && <p title="Estimated from completed work in the current stage. Later planning stages have their own estimates.">{job.catalog ? 'Estimated catalog time remaining' : job.planning?.stage === 'coverage' ? 'Estimated check time remaining' : 'Estimated stage time remaining'}: {(job.catalog?.remainingSeconds ?? job.planning?.remainingSeconds) == null ? 'Estimating from completed checks…' : 'About ' + researchDuration(job.catalog?.remainingSeconds ?? job.planning?.remainingSeconds)}</p>}
          </>}
          {(downloading || fetching) && <>
            <div className="flex items-center justify-between gap-4"><span>{fetching ? source.pages.toLocaleString('en-US') + ' history pages · ' : ''}{researchByteSize(source.receivedBytes)}{source.totalBytes == null ? ' · Size unknown' : ' / ' + researchByteSize(source.totalBytes)}{percent == null ? '' : ' · ' + percent.toFixed(1) + '%'}</span><span>{downloading && (source.bytesPerSecond ? researchByteSize(source.bytesPerSecond) + '/s' : 'Measuring speed…')}</span></div>
            <Progress aria-label={fetching ? 'History range progress' : 'Current file download progress'} value={percent} />
          </>}
          {job.phase === 'preparing' && <div className="flex items-center gap-6"><span title="Estimated from completed sources. Download and import times may vary.">Estimated time to ready: {source?.remainingSeconds == null ? 'Estimating…' : 'About ' + researchDuration(source.remainingSeconds)}</span>{downloading && <span>File remaining: {source.fileRemainingSeconds == null ? 'Estimating…' : 'About ' + researchDuration(source.fileRemainingSeconds)}</span>}</div>}
          {waiting && <p role="status" aria-live="polite">{waiting}</p>}
        </>}
        <p>Completed data stays on disk.{working ? ' Pause or quit to save a checkpoint.' : job?.phase === 'failed' || job?.phase === 'paused' ? ' Resume to retry from the saved checkpoint.' : ''}</p>
      </AlertDescription>
    </Alert>
  </aside>, document.body)
}
