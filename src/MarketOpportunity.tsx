import { memo, useId } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import type { OpportunityComponents, OpportunityResult } from "@/market-opportunity"

const componentLabels: [keyof OpportunityComponents, string, number][] = [
  ["trend", "Trend", 30], ["entry", "Entry", 30], ["participation", "Participation", 20], ["timing", "Timing", 20], ["penalty", "Heat penalty", 40],
]
const points = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })

export const MarketOpportunity = memo(function MarketOpportunity({ instId, opportunity }: { instId: string; opportunity: OpportunityResult }) {
  const titleId = useId(), descriptionId = useId()
  const { direction, setup, status, score, components, reasons } = opportunity
  const variant = status === "Candidate" ? "secondary" : status === "Overheated" ? "destructive" : "outline"
  return <Popover>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" className="h-auto min-h-7 flex-col gap-1 py-1" aria-label={`View ${instId} opportunity details: ${direction ?? "No direction"}, ${score === null ? "score unavailable" : `${score} out of 100`}, ${status}, ${setup ?? "No setup"}`} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <span className="flex items-center gap-1.5 tabular-nums">
          <span className={cn(direction === "Long" ? "text-positive" : direction === "Short" ? "text-destructive" : "text-muted-foreground")}>{direction ?? "—"}</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
          <span className={cn(score === null && "text-muted-foreground")}>{score ?? "—"}</span>
        </span>
        <span className="text-xs text-muted-foreground">{setup ?? "No setup"}</span>
        <Badge variant={variant}>{status}</Badge>
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-80" aria-labelledby={titleId} aria-describedby={descriptionId} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      <PopoverHeader>
        <PopoverTitle id={titleId}>{instId.replace(/-USDT-SWAP$/, "")} · Opportunity</PopoverTitle>
        <PopoverDescription id={descriptionId}>Live 1h indicators · {direction ?? "Direction unclear"} · {setup ?? "No setup"}. Scores may change before the hour closes.</PopoverDescription>
      </PopoverHeader>
      <div className="flex items-center justify-between gap-2">
        <Badge variant={variant}>{status}</Badge>
        <span className="font-medium tabular-nums">{score === null ? "—" : `${score} / 100`}</span>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 tabular-nums">
        {componentLabels.map(([key, label, maximum]) => <div key={key} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{components === null ? "—" : `${key === "penalty" && components[key] > 0 ? "−" : ""}${points.format(components[key])} / ${maximum}`}</dd>
        </div>)}
      </dl>
      <Separator />
      <ul aria-label="Opportunity reasons" className="flex list-disc flex-col gap-1 pl-4 text-xs">
        {reasons.map(reason => <li key={reason}>{reason}</li>)}
      </ul>
    </PopoverContent>
  </Popover>
})
