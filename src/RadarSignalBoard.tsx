import { memo, useMemo, useState } from 'react'
import { ArrowUpRight, FlaskConical, ScanSearch } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { researchTime } from '@/research-types'
import { phaseMatches, signalIsUnknown, signalMatches, type RadarSignal } from '@/radar-signals'
import type { NativeMarketRow } from '@/rule-engine'
import type { StrategyProfile } from '@/suite-types'
import { timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

const price = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 })
const turnover = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

type SignalChartAction = (instrument: string, order: string[]) => void

function SignalLane({ signals, markets, timeframe, onChart, onExplain, onBrowseCharts }: { signals: RadarSignal[]; markets: Map<string, NativeMarketRow>; timeframe: RadarTimeframe; onChart: SignalChartAction; onExplain: (instrument: string) => void; onBrowseCharts: () => void }) {
  const [page, setPage] = useState(0)
  const label = 'Bullish Setup'
  const { matching, order, confirmed, forming } = useMemo(() => {
    const matching = signals.filter(signalMatches).sort((a, b) => Number(phaseMatches(b.confirmed)) - Number(phaseMatches(a.confirmed)) || (markets.get(b.instrument)?.turnover24hUSDT ?? 0) - (markets.get(a.instrument)?.turnover24hUSDT ?? 0) || a.instrument.localeCompare(b.instrument))
    const [confirmed, forming] = matching.reduce(([confirmed, forming], signal) => [confirmed + Number(phaseMatches(signal.confirmed)), forming + Number(phaseMatches(signal.provisional))], [0, 0])
    return { matching, order: matching.map(signal => signal.instrument), confirmed, forming }
  }, [markets, signals])
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / 25) - 1))
  return <section aria-label={label + ' signals'} className="flex min-w-0 flex-col rounded-lg border" data-signal-lane="bullishSetup">
    <header className="flex items-start gap-3 border-b p-4">
      <div className="mt-0.5 text-positive"><ArrowUpRight aria-hidden="true" /></div>
      <div className="flex min-w-0 flex-1 flex-col gap-1"><h2 className="font-semibold">Strategy BUY signals</h2><p className="text-xs text-muted-foreground">{confirmed} confirmed BUY · {forming} forming BUY</p></div>
      <Badge variant="positive" aria-label={matching.length + ' ' + label + ' contracts'}>{matching.length}</Badge>
    </header>
    {matching.length ? <>
      <Table aria-label={label + ' contracts'}><TableHeader><TableRow><TableHead>Contract / market</TableHead><TableHead>Signal / decision</TableHead><TableHead className="text-right">Evidence</TableHead></TableRow></TableHeader><TableBody>{matching.slice(currentPage * 25, currentPage * 25 + 25).map(signal => {
        const market = markets.get(signal.instrument)
        return <TableRow key={signal.instrument} data-signal-instrument={signal.instrument}>
          <TableCell><Button variant="link" onClick={() => onChart(signal.instrument, order)} aria-label={'View ' + signal.instrument + ' chart'}>{signal.instrument.replace(/-USDT-SWAP$/, '')}</Button><p className="text-xs" title={`Latest traded price; strategy indicators use ${timeframeLabel(timeframe)} candles`}>{(market?.lastPrice ?? market?.price) == null ? '—' : price.format((market?.lastPrice ?? market?.price)!)} USDT</p><p className="text-xs text-muted-foreground">{market?.turnover24hUSDT == null ? 'Est. turnover —' : turnover.format(market.turnover24hUSDT) + ' USDT / 24h (est.)'}</p></TableCell>
          <TableCell><div className="flex flex-col items-start gap-1">{(['confirmed', 'provisional'] as const).map(source => {
            const reading = signal[source]
            return phaseMatches(reading) && reading && <div key={source} className="flex flex-col items-start gap-1"><Badge variant={source === 'confirmed' ? 'positive' : 'outline'} title={researchTime(reading.hour + (source === 'confirmed' ? timeframeMilliseconds(timeframe) : 0))}>{source === 'confirmed' ? 'BUY · Confirmed close' : `FORMING BUY · Live ${timeframeLabel(timeframe)}`}</Badge><span className="text-xs" title={reading.reason}>{reading.action}</span></div>
          })}</div></TableCell>
          <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => onExplain(signal.instrument)} aria-label={'Explain ' + signal.instrument + ' Bullish Setup'}><ScanSearch data-icon="inline-start" aria-hidden="true" />Explain</Button></TableCell>
        </TableRow>
      })}</TableBody></Table>
      {matching.length > 25 && <div className="flex items-center justify-between gap-2 border-t p-3"><Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label={'Previous ' + label + ' contracts'}>Previous</Button><span className="text-xs text-muted-foreground">{currentPage * 25 + 1}–{Math.min(matching.length, (currentPage + 1) * 25)} / {matching.length}</span><Button variant="ghost" size="sm" disabled={(currentPage + 1) * 25 >= matching.length} onClick={() => setPage(currentPage + 1)} aria-label={'Next ' + label + ' contracts'}>Next</Button></div>}
    </> : <Empty><EmptyHeader><EmptyTitle>No BUY signals right now</EmptyTitle><EmptyDescription>The active strategy has no confirmed or forming matches on the current {timeframeLabel(timeframe)} candle. Historical BUY entries are shown on each market chart, including windows with zero entries.</EmptyDescription></EmptyHeader><EmptyContent><Button variant="outline" onClick={onBrowseCharts}>Browse all market charts</Button></EmptyContent></Empty>}
  </section>
}

export const RadarSignalBoard = memo(function RadarSignalBoard({ profile, signals, rows, timeframe, paused, recovering, onChart, onExplain, onResearch, onBrowseCharts }: { profile: StrategyProfile; signals: RadarSignal[]; rows: NativeMarketRow[]; timeframe: RadarTimeframe; paused?: boolean; recovering?: boolean; onChart: SignalChartAction; onExplain: (instrument: string) => void; onResearch: () => void; onBrowseCharts: () => void }) {
  const markets = useMemo(() => new Map(rows.map(row => [row.instId, row])), [rows])
  const unknown = useMemo(() => signals.reduce((count, signal) => count + Number(signalIsUnknown(signal)), 0), [signals])
  return <section aria-label="Bullish Setup radar" className="flex flex-col gap-4 p-4" data-signal-board>
    <div className="flex items-center gap-3"><div className="flex min-w-0 flex-1 flex-col gap-1"><h2 className="font-semibold">Bullish Setup Radar</h2><p className="text-xs text-muted-foreground">{profile.name} · r{profile.revision} · {timeframeLabel(timeframe)}</p></div><Button variant="outline" onClick={onResearch}><FlaskConical data-icon="inline-start" aria-hidden="true" />Test strategy</Button></div>
    {paused && <Alert variant="warning"><AlertDescription>Monitoring is paused. Resume in Settings to collect new signals.</AlertDescription></Alert>}
    {!paused && recovering && <Alert variant="warning"><AlertDescription>Monitoring is reconnecting. New signals will resume automatically.</AlertDescription></Alert>}
    {(unknown > 0 || !signals.length) && <p role="status" className="text-xs text-muted-foreground">{!signals.length ? 'Waiting for strategy inputs. ' : ''}{unknown > 0 ? unknown + ' contracts have Unknown setup inputs. Inspect All markets for missing data.' : ''}</p>}
    <SignalLane key={`${profile.id}:${timeframe}`} signals={signals} markets={markets} timeframe={timeframe} onChart={onChart} onExplain={onExplain} onBrowseCharts={onBrowseCharts} />
  </section>
})
