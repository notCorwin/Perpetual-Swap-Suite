import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Copy, Send, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Spinner } from '@/components/ui/spinner'
import { AnalysisSettingsButton } from '@/AnalysisSettings'
import { chartAnalysis } from '@/analysis-service'
import { ANALYSIS_PROMPTS, type AnalysisSession } from '@/chart-analysis'

const MessageResponse = lazy(() => import('@/components/ai-elements/message').then(module => ({ default: module.MessageResponse })))
const captureTime = (value: number) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function ChartAnalysisPanel({ instId, timeframe = '15m', session, ready, onNew, onClose }: { instId: string; timeframe?: string; session: AnalysisSession | null; ready: boolean; onNew: () => void; onClose: () => void }) {
  const busy = session?.phase === 'capturing' || session?.phase === 'streaming'
  const canRetry = Boolean(session?.turns.at(-1) && ['error', 'stopped'].includes(session.turns.at(-1)!.status))
  const [copyState, setCopyState] = useState<{ id: string; error: string } | null>(null)
  const [composing, setComposing] = useState(false)
  const retryAttempt = useRef(0)
  const onNewRef = useRef(onNew)
  useEffect(() => { onNewRef.current = onNew }, [onNew])
  useEffect(() => { retryAttempt.current = 0 }, [instId])
  useEffect(() => {
    if (session?.phase !== 'error') { if (session?.phase === 'ready') retryAttempt.current = 0; return }
    if (!session.turns.length && !ready) return
    const attempt = ++retryAttempt.current
    const timer = window.setTimeout(() => {
      if (session.turns.length) void chartAnalysis.retry(instId)
      else onNewRef.current()
    }, Math.min(30_000, 2_000 * 2 ** Math.min(attempt - 1, 4)))
    return () => window.clearTimeout(timer)
  }, [instId, ready, session?.phase, session?.error, session?.turns.length])
  const copy = async (id: string, text: string) => {
    try {
      const result = await window.radarDesktop.request({ copyText: text })
      if (!result.ok) throw new Error('Could not copy analysis.')
      setCopyState({ id, error: '' })
    } catch (cause) { setCopyState({ id, error: cause instanceof Error ? cause.message : 'Could not copy analysis.' }) }
  }
  const send = () => {
    if (busy || !session?.image) return
    if (session.draft.trim()) void chartAnalysis.send(instId, session.draft)
    else if (canRetry) void chartAnalysis.retry(instId)
  }
  return <aside className="flex min-h-0 w-(--analysis-panel-width) shrink-0 flex-col border-l bg-card" aria-label="Chart analysis">
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
      <h2 className="min-w-0 flex-1 truncate font-semibold">{instId.replace(/-SWAP$/, '')} · {timeframe}</h2>
      {session && <Badge variant="outline">{ANALYSIS_PROMPTS[session.direction].label}</Badge>}
      <AnalysisSettingsButton />
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close analysis"><X /></Button>
    </div>
    <div className="flex shrink-0 flex-col gap-2 border-b p-3">
      {session?.capturedAt ? <p className="truncate text-xs text-muted-foreground" title={`${session.model} · Captured ${captureTime(session.capturedAt)} · ${session.rangeLabel}`}>Snapshot · {session.rangeLabel}</p> : null}
      <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={busy || !ready} onClick={onNew}>{session?.image ? 'New analysis' : 'Analyze chart'}</Button>{busy && <Button variant="ghost" size="sm" onClick={() => chartAnalysis.stop(instId)}><Square data-icon="inline-start" />Stop</Button>}</div>
    </div>
    {session?.error && <Alert variant="destructive"><AlertDescription>{session.error} Automatically retrying.</AlertDescription></Alert>}
    {copyState?.error && <Alert variant="destructive"><AlertDescription>{copyState.error}</AlertDescription></Alert>}
    <div className="min-h-0 flex-1">
      <MessageScrollerProvider key={instId} autoScroll>
        <MessageScroller role="log" aria-label="Analysis conversation">
          <MessageScrollerViewport><MessageScrollerContent className="p-3">
            {!session?.turns.length && (session?.phase === 'capturing' || session?.phase === 'stopped') && <Empty><EmptyHeader><EmptyTitle>{session.phase === 'capturing' ? 'Preparing chart…' : 'Analysis stopped'}</EmptyTitle></EmptyHeader></Empty>}
            {session?.turns.map(turn => <Fragment key={turn.id}>
              <MessageScrollerItem messageId={`${turn.id}-user`} scrollAnchor><Message align="end"><MessageContent><Bubble variant="secondary" align="end"><BubbleContent><p lang="en" className="whitespace-pre-wrap select-text">{turn.question}</p></BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem>
              <MessageScrollerItem messageId={`${turn.id}-assistant`}><Message><MessageContent>
                {turn.text && <div data-analysis-answer lang="en"><Suspense fallback={<p className="whitespace-pre-wrap">{turn.text}</p>}><MessageResponse isAnimating={turn.status === 'streaming'} controls={false}>{turn.text}</MessageResponse></Suspense></div>}
                {turn.status === 'streaming' && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />{turn.text ? 'Generating…' : 'Analyzing chart…'}</p>}
                <MessageFooter>{turn.status !== 'complete' && turn.status !== 'streaming' && <Badge variant="outline">{turn.status === 'stopped' ? 'Stopped' : 'Failed'}</Badge>}{turn.text && <Button variant="ghost" size="xs" aria-label="Copy analysis" onClick={() => void copy(turn.id, turn.text)}><Copy data-icon="inline-start" />{copyState?.id === turn.id && !copyState.error ? 'Copied' : 'Copy'}</Button>}</MessageFooter>
              </MessageContent></Message></MessageScrollerItem>
            </Fragment>)}
          </MessageScrollerContent></MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
    <form className="shrink-0 border-t p-3" onSubmit={event => { event.preventDefault(); send() }}>
      <InputGroup>
        <InputGroupTextarea name="analysis-question" aria-label="Ask a follow-up" placeholder={canRetry ? 'Retry the stopped response or ask something new…' : 'Ask about this snapshot…'} value={session?.draft ?? ''} disabled={!session?.image || busy} onChange={event => chartAnalysis.draft(instId, event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send() }
        }} />
        <InputGroupAddon align="block-end" className="justify-end"><InputGroupButton type="submit" variant="outline" aria-label="Send follow-up" disabled={busy || !session?.image || (!session.draft.trim() && !canRetry)}><Send /></InputGroupButton></InputGroupAddon>
      </InputGroup>
    </form>
  </aside>
}
