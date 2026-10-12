import { Fragment, lazy, Suspense, useState } from 'react'
import { Copy, Send, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Spinner } from '@/components/ui/spinner'
import { AnalysisSettingsButton } from '@/AnalysisSettingsDialog'
import { chartAnalysis } from '@/analysis-service'
import type { AnalysisSession } from '@/chart-analysis'

const MessageResponse = lazy(() => import('@/components/ai-elements/message').then(module => ({ default: module.MessageResponse })))
const captureTime = (value: number) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export function ChartAnalysisPanel({ instId, session, ready, onNew, onClose }: { instId: string; session: AnalysisSession | null; ready: boolean; onNew: () => void; onClose: () => void }) {
  const busy = session?.phase === 'capturing' || session?.phase === 'streaming'
  const [copyState, setCopyState] = useState<{ id: string; error: string } | null>(null)
  const [composing, setComposing] = useState(false)
  const copy = async (id: string, text: string) => {
    try {
      const result = await window.webkit.messageHandlers.radar.postMessage({ copyText: text })
      if (!result.ok) throw new Error('Could not copy analysis.')
      setCopyState({ id, error: '' })
    } catch (cause) { setCopyState({ id, error: cause instanceof Error ? cause.message : 'Could not copy analysis.' }) }
  }
  const send = () => { if (!busy && session?.image && session.draft.trim()) void chartAnalysis.send(instId, session.draft) }
  return <aside data-surface="panel" className="flex min-h-0 w-(--analysis-panel-width) shrink-0 flex-col border-l bg-card" aria-label="Chart analysis">
    <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
      <h2 className="flex-1 font-semibold">Analysis</h2>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close analysis"><X /></Button>
    </div>
    <div className="flex shrink-0 flex-col gap-2 border-b p-3">
      <p className="font-medium">{instId.replace(/-SWAP$/, '')} · 1h</p>
      <p className="break-all text-xs text-muted-foreground">{session?.model ?? 'Vercel AI Gateway'}</p>
      {session?.capturedAt ? <div className="flex flex-col gap-1 text-xs text-muted-foreground"><p>Captured {captureTime(session.capturedAt)}</p><p>{session.rangeLabel}</p><p>Follow-ups use this snapshot.</p></div> : null}
      <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={busy || !ready} onClick={onNew}>{session?.image ? 'New analysis' : 'Analyze chart'}</Button><AnalysisSettingsButton />{busy && <Button variant="ghost" size="sm" onClick={() => chartAnalysis.stop(instId)}><Square data-icon="inline-start" />Stop</Button>}</div>
    </div>
    {session?.error && <Alert variant="destructive"><AlertDescription>{session.error}<Button variant="outline" size="sm" disabled={!session.turns.length && !ready} onClick={() => { if (session.turns.length) void chartAnalysis.retry(instId); else onNew() }}>Retry</Button></AlertDescription></Alert>}
    {copyState?.error && <Alert variant="destructive"><AlertDescription>{copyState.error}</AlertDescription></Alert>}
    <div className="min-h-0 flex-1">
      <MessageScrollerProvider key={instId} autoScroll>
        <MessageScroller role="log" aria-label="Analysis conversation">
          <MessageScrollerViewport><MessageScrollerContent className="p-3">
            {!session?.turns.length && <Empty><EmptyHeader><EmptyTitle>{session?.phase === 'capturing' ? 'Preparing chart…' : session?.phase === 'stopped' ? 'Analysis stopped' : 'Analyze this chart'}</EmptyTitle><EmptyDescription>{session?.phase === 'capturing' ? 'Capturing the visible chart for the model.' : 'Start an analysis, then ask follow-up questions about the same snapshot.'}</EmptyDescription></EmptyHeader></Empty>}
            {session?.turns.map(turn => <Fragment key={turn.id}>
              <MessageScrollerItem messageId={`${turn.id}-user`} scrollAnchor><Message align="end"><MessageContent><Bubble variant="secondary" align="end"><BubbleContent><p lang="zh-CN" className="whitespace-pre-wrap select-text">{turn.question}</p></BubbleContent></Bubble></MessageContent></Message></MessageScrollerItem>
              <MessageScrollerItem messageId={`${turn.id}-assistant`}><Message><MessageContent>
                {turn.text && <div data-analysis-answer lang="zh-CN"><Suspense fallback={<p className="whitespace-pre-wrap">{turn.text}</p>}><MessageResponse isAnimating={turn.status === 'streaming'} controls={false}>{turn.text}</MessageResponse></Suspense></div>}
                {turn.status === 'streaming' && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />{turn.text ? 'Generating…' : 'Analyzing chart…'}</p>}
                <MessageFooter>{turn.status !== 'complete' && turn.status !== 'streaming' && <Badge variant="outline">{turn.status === 'stopped' ? 'Stopped' : 'Failed'}</Badge>}{turn.text && <Button variant="ghost" size="xs" aria-label="Copy analysis" onClick={() => void copy(turn.id, turn.text)}><Copy data-icon="inline-start" />{copyState?.id === turn.id && !copyState.error ? 'Copied' : 'Copy'}</Button>}{turn === session.turns.at(-1) && turn.status === 'stopped' && <Button variant="ghost" size="xs" onClick={() => void chartAnalysis.retry(instId)}>Retry</Button>}</MessageFooter>
              </MessageContent></Message></MessageScrollerItem>
            </Fragment>)}
          </MessageScrollerContent></MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
    <form className="shrink-0 border-t p-3" onSubmit={event => { event.preventDefault(); send() }}>
      <InputGroup>
        <InputGroupTextarea aria-label="Ask a follow-up" placeholder="Ask about this snapshot…" value={session?.draft ?? ''} disabled={!session?.image || busy} onChange={event => chartAnalysis.draft(instId, event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !composing && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); send() }
        }} />
        <InputGroupAddon align="block-end"><span className="flex-1 text-xs text-muted-foreground">Shift+Enter for a new line</span><InputGroupButton type="submit" variant="outline" aria-label="Send follow-up" disabled={busy || !session?.image || !session.draft.trim()}><Send /></InputGroupButton></InputGroupAddon>
      </InputGroup>
    </form>
  </aside>
}
