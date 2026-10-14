import { memo } from 'react'
import { Badge } from '@/components/ui/badge'
import { SUITE_PHASES, type SuiteReading } from '@/suite-types'
import { researchTime } from '@/research-types'
import { timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

export const SuitePhaseBadges = memo(function SuitePhaseBadges({ confirmed, provisional, timeframe = '1H' }: { confirmed?: SuiteReading; provisional?: SuiteReading; timeframe?: RadarTimeframe }) {
  const confirmedPhases = SUITE_PHASES.filter(p => confirmed?.phases[p.key]?.result === 'true')
  const formingPhases = SUITE_PHASES.filter(p => provisional?.phases[p.key]?.result === 'true')
  return <div className="flex flex-col items-start gap-1" aria-label={`${timeframeLabel(timeframe)} Bullish Setup signals`}>
    {confirmedPhases.map(p => <Badge key={p.key} variant="positive" title={researchTime((confirmed?.hour ?? 0)+timeframeMilliseconds(timeframe))}>BUY · {p.label} · Confirmed</Badge>)}
    {formingPhases.map(p => <Badge key={p.key} variant="outline">FORMING BUY · {p.label} · Provisional</Badge>)}
    {!confirmedPhases.length && !formingPhases.length && <span className="text-xs text-muted-foreground">{!confirmed ? 'No active strategy' : Object.values(confirmed.phases).some(p => p?.result === 'unknown') ? 'Unknown inputs' : 'No setup match'}</span>}
  </div>
})
