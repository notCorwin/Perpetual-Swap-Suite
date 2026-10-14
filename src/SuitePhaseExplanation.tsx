import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { TraceNode } from '@/FilterExplanation'
import { parseFilterConfig, type FilterTrace } from '@/rule-engine'
import { researchTime, type ResearchInputs } from '@/research-types'
import { requestSuite, SUITE_PHASES, type StrategyProfile, type SuiteReading } from '@/suite-types'
import { timeframeLabel, timeframeMilliseconds, type RadarTimeframe } from '@/timeframe'

export function SuitePhaseExplanation({ instrument,profile,inputs,timeframe='1H',onClose }: { instrument: string|null; profile: StrategyProfile; inputs: ResearchInputs; timeframe?: RadarTimeframe; onClose: () => void }) {
  const [at,setAt] = useState('confirmed'), [detail,setDetail] = useState<{key:string;confirmed?:SuiteReading;provisional?:SuiteReading;error?:string}>({key:''})
  const key = [instrument,profile.id,profile.revision,timeframe].join('|')
  useEffect(() => {
    if(!instrument)return
    let stopped=false
    void requestSuite({mode:'radar',action:'evaluate',instrument,timeframe}).then(value=>{if(!stopped)setDetail({key,confirmed:value.confirmed?.find(r=>r.instrument===instrument),provisional:value.provisional?.find(r=>r.instrument===instrument)})}).catch(cause=>{if(!stopped)setDetail({key,error:String(cause)})})
    return()=>{stopped=true}
  },[instrument,key,timeframe])
  const loading=detail.key!==key, error=loading?'':detail.error
  const reading=loading?undefined:at==='confirmed'?detail.confirmed:detail.provisional
  const configs=[{label:'Universe',json:profile.universeJSON,result:reading?.universe,traceJSON:reading?.universeTraceJSON},...SUITE_PHASES.map(p=>({label:p.label,json:profile.phaseRules[p.key],...reading?.phases[p.key]}))]
  const context={metrics:inputs.metrics,expressions:{},units:{},templates:inputs.templates}
  return <Dialog open={Boolean(instrument)} onOpenChange={open=>{if(!open)onClose()}}><DialogContent className="flex max-h-[calc(var(--market-list-layout-height)*0.9)] w-[min(calc(var(--market-list-layout-width)*0.9),80rem)] max-w-none scale-(--market-list-scale) flex-col sm:max-w-none"><DialogHeader><DialogTitle>{instrument} · Bullish Setup evidence</DialogTitle><DialogDescription>{profile.name} · r{reading?.revision ?? profile.revision} · {reading?researchTime(reading.hour+timeframeMilliseconds(timeframe)):`Loading ${timeframeLabel(timeframe)} decisions…`}</DialogDescription></DialogHeader>
    <ToggleGroup type="single" variant="outline" value={at} onValueChange={v=>{if(v)setAt(v)}} aria-label="Setup calculation point"><ToggleGroupItem value="confirmed">Confirmed close</ToggleGroupItem><ToggleGroupItem value="provisional">Provisional live</ToggleGroupItem></ToggleGroup>
    <p className="text-sm">{reading?.action} · {reading?.reason}</p>
    {error&&<Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">{loading?<Spinner aria-label="Loading phase explanations"/>:configs.map(c=><section key={c.label} className="flex flex-col gap-2"><h3 className="flex items-center gap-3 font-semibold">{c.label}<Badge variant="outline">{c.result==='true'?'True':c.result==='false'?'False':'Unknown'}</Badge></h3>{c.traceJSON?<TraceNode trace={JSON.parse(c.traceJSON) as FilterTrace} config={parseFilterConfig(c.json)} context={context}/>:<p className="text-sm text-muted-foreground">No calculated input is available.</p>}</section>)}</div>
  </DialogContent></Dialog>
}
