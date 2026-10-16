import { useEffect, useMemo, useState } from "react"
import { Check, CircleHelp, ScanSearch, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FieldError } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { FilterReadings, type ReadingContext } from "@/FilterReadings"
import { ruleSentence } from "@/filter-builder"
import { findRule, parseFilterConfig, previewResponseIsCurrent, newRuleID, type FilterConfigV2, type FilterTrace, type FilterTruth, type NativeMarketRow } from "@/rule-engine"
import { timeframeLabel, type RadarTimeframe } from '@/timeframe'

function Truth({ value }: { value: FilterTruth | undefined }) {
  const Icon = value === "true" ? Check : value === "false" ? X : CircleHelp
  return <Badge variant="outline" className={cn(value === "true" ? "text-positive" : value === "false" ? "text-destructive" : "text-muted-foreground")}><Icon aria-hidden="true" />{value === "true" ? "True" : value === "false" ? "False" : "Unknown"}</Badge>
}

export function TraceNode({ trace, config, context }: { trace: FilterTrace; config: FilterConfigV2 | null; context: ReadingContext }) {
  const [limit, setLimit] = useState(50)
  const node = config ? findRule(config.root, trace.id) : null
  return <details open className="rounded-lg border p-3">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm"><Truth value={trace.result} /><span className="min-w-0 flex-1 break-words font-medium">{node ? node.name || ruleSentence(node, context.metrics, context.expressions, context.templates) : trace.label}</span><time className="shrink-0 text-xs text-muted-foreground" dateTime={new Date(trace.hour).toISOString()}>{new Date(trace.hour).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></summary>
    <div className="mt-2 flex flex-col gap-2">
      <FilterReadings readings={trace.readings} readingSources={trace.readingSources} {...context} />
      {trace.reason && <p className="text-xs text-muted-foreground">{trace.reason}</p>}
      {trace.eventHours.length > 0 && <p className="text-xs text-muted-foreground">Event path: {trace.eventHours.map(hour => new Date(hour).toLocaleString("en-US")).join(" → ")}</p>}
      {trace.children.length > 0 && <div className="ml-2 flex flex-col gap-2 border-l pl-3">{trace.children.slice(0, limit).map((child, index) => <TraceNode key={`${child.id}:${child.hour}:${index}`} trace={child} config={config} context={context} />)}{trace.children.length > limit && <Button type="button" variant="outline" size="sm" onClick={() => setLimit(limit + 50)}>Show more hourly decisions</Button>}</div>}
    </div>
  </details>
}

type Props = ReadingContext & { atClose?: boolean; strategyID?: string; timeframe?: RadarTimeframe; open: boolean; onOpenChange: (open: boolean) => void; instId: string | null; onSelect: (id: string) => void; rows: NativeMarketRow[]; results: Record<string, FilterTruth>; filtersJSON: string | null; revision: number }
export function FilterExplanation({ open, onOpenChange, instId, onSelect, rows, results, filtersJSON, revision, metrics, expressions, units, templates, atClose, strategyID, timeframe = '1H' }: Props) {
  const [search, setSearch] = useState(''), [limit, setLimit] = useState(50)
  const config = useMemo(() => filtersJSON ? parseFilterConfig(filtersJSON) : null, [filtersJSON])
  const searched = rows.filter(row => row.instId.toLowerCase().includes(search.trim().toLowerCase()))
  const context = { metrics, expressions, units, templates }
  const id = instId ?? rows[0]?.instId
  const key = `${id ?? ""}|${filtersJSON ?? ""}|${atClose}|${strategyID ?? ""}|${timeframe}`
  const [detail, setDetail] = useState<{ key: string; revision: number; trace: FilterTrace | null; error: string } | null>(null)
  const trace = detail?.key === key ? detail.trace : null
  const error = detail?.key === key && detail.revision >= revision ? detail.error : ""
  const loading = open && Boolean(id && filtersJSON) && (detail?.key !== key || detail.revision < revision)
  useEffect(() => {
    if (!open || !id || !filtersJSON) return
    let stopped = false
    const token = newRuleID()
    void window.webkit.messageHandlers.radar.postMessage({ explainMarketFilters: { instId: id, filtersJSON, token, atClose, strategyID, timeframe } }).then(response => {
      if (!stopped && response.instId === id && previewResponseIsCurrent(response, token, revision)) setDetail({ key, revision: response.revision, trace: response.trace, error: "" })
    }).catch(cause => { if (!stopped) setDetail(previous => ({ key, revision, trace: previous?.key === key ? previous.trace : null, error: cause instanceof Error ? cause.message : "Cannot explain this contract." })) })
    return () => { stopped = true }
  }, [open, id, filtersJSON, revision, key, atClose, strategyID, timeframe])
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="flex h-[min(calc(var(--market-list-layout-height)*0.85),60rem)] w-[min(calc(var(--market-list-layout-width)*0.92),84rem)] max-w-none scale-(--market-list-scale) flex-col gap-3 sm:max-w-none">
    <DialogHeader><DialogTitle>Market rule explanations</DialogTitle><DialogDescription>Inspect matching, unmatched, and unknown markets using the current valid preview. Times use your local time zone.</DialogDescription></DialogHeader>
    <div className="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)] gap-4">
      <Command className="border" shouldFilter={false}><CommandInput placeholder="Search all contracts…" value={search} onValueChange={value => { setSearch(value); setLimit(50) }} /><CommandList className="max-h-none"><CommandEmpty>No contracts found.</CommandEmpty>{searched.slice(0, limit).map(row => <CommandItem key={row.instId} value={row.instId} onSelect={() => onSelect(row.instId)} data-current={id === row.instId}><span className="flex-1">{row.instId.replace(/-USDT-SWAP$/, "")}</span><Truth value={results[row.instId]} /></CommandItem>)}{searched.length > limit && <Button type="button" variant="ghost" className="w-full" onClick={() => setLimit(limit + 50)}>Show more contracts</Button>}</CommandList></Command>
      <section aria-label="Rule decision details" className="min-h-0 overflow-y-auto">
        <div className="mb-3 flex items-center gap-2"><ScanSearch className="size-4" aria-hidden="true" /><span className="font-medium">{id ?? "Waiting for markets"}</span><Truth value={trace?.result ?? (id ? results[id] : undefined)} /><Button variant="ghost" size="sm" className="ml-auto" onClick={() => onOpenChange(false)}>Done</Button></div>
        {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner aria-hidden="true" />Explaining {timeframeLabel(timeframe)} rules…</p>}
        {error && <FieldError role="alert">{error}</FieldError>}
        {trace && <TraceNode trace={trace} config={config} context={context} />}
      </section>
    </div>
  </DialogContent></Dialog>
}
