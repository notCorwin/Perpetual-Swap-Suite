import { memo, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { researchSize, researchTime, type DataManifest, type DataPlan, type ResearchCoverage, type ResearchSource } from '@/research-types'

const PAGE_SIZE = 50
const integer = (value: number) => value.toLocaleString('en-US')

// Archive preparation can produce thousands of provenance warnings. Keep every
// warning accessible without laying out the entire archive history on each click.
export const ResearchWarnings = memo(function ResearchWarnings({ warnings }: { warnings: string[] }) {
  const [page, setPage] = useState(0)
  if (!warnings.length) return null
  return <section aria-label="Data warnings" className="flex flex-col gap-2">
    <h3 className="font-semibold">Data warnings ({integer(warnings.length)})</h3>
    <DataPagination count={warnings.length} page={page} onPageChange={setPage} label="warnings" />
    {warnings.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((warning, index) => <Alert key={page * PAGE_SIZE + index} variant="warning"><AlertDescription>{warning}</AlertDescription></Alert>)}
  </section>
})

function DataPagination({ count, page, onPageChange, label, context = label }: { count: number; page: number; onPageChange: (page: number) => void; label: string; context?: string }) {
  if (count <= PAGE_SIZE) return null
  const last = Math.ceil(count / PAGE_SIZE) - 1
  return <nav aria-label={`${context} pages`} className="flex items-center gap-2">
    <Button variant="outline" size="sm" disabled={page === 0} aria-label={`First ${context}`} onClick={() => onPageChange(0)}>First</Button>
    <Button variant="outline" size="sm" disabled={page === 0} aria-label={`Previous ${context}`} onClick={() => onPageChange(page - 1)}>Previous {label}</Button>
    <span className="text-xs text-muted-foreground">{integer(page * PAGE_SIZE + 1)}–{integer(Math.min((page + 1) * PAGE_SIZE, count))} of {integer(count)}</span>
    <Button variant="outline" size="sm" disabled={page >= last} aria-label={`Next ${context}`} onClick={() => onPageChange(page + 1)}>Next {label}</Button>
    <Button variant="outline" size="sm" disabled={page >= last} aria-label={`Last ${context}`} onClick={() => onPageChange(last)}>Last</Button>
  </nav>
}

export const ResearchSources = memo(function ResearchSources({ sources, page, onPageChange }: { sources: ResearchSource[]; page: number; onPageChange: (page: number) => void }) {
  return <>
    <Table aria-label="Planned data sources"><TableHeader><TableRow>{['Instrument / source', 'Input', 'From', 'Through', 'Size', 'Cache'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{sources.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(source => <TableRow key={source.id}>
        <TableCell><div>{source.instrument}</div><div className="text-xs text-muted-foreground">{source.filename}</div></TableCell>
        <TableCell><div>{source.kind}</div><div className="text-xs text-muted-foreground">{source.archive ? 'Published archive' : 'Requested REST range'}</div></TableCell>
        <TableCell>{researchTime(source.from)}</TableCell><TableCell>{researchTime(source.through)}</TableCell>
        <TableCell>{source.sizeBytes == null ? 'Varies' : researchSize(source.sizeBytes)}</TableCell><TableCell>{source.cached ? 'Raw file cached' : 'Download required'}</TableCell>
      </TableRow>)}</TableBody>
    </Table>
    <DataPagination count={sources.length} page={page} onPageChange={onPageChange} label="sources" />
  </>
})

const CoverageGaps = memo(function CoverageGaps({ row }: { row: ResearchCoverage }) {
  const [open, setOpen] = useState(false), [page, setPage] = useState(0)
  if (!row.gaps.length) return 'Complete'
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger asChild><Button variant="ghost" size="sm" aria-label={`Missing intervals for ${row.instrument} ${row.kind}`}>
      <ChevronRight data-icon="inline-start" className={open ? 'rotate-90' : undefined} aria-hidden="true" />{integer(row.gaps.length)} gaps
    </Button></CollapsibleTrigger>
    <CollapsibleContent>
      {open && <div className="flex flex-col gap-1" aria-label={`Missing intervals for ${row.instrument} ${row.kind}`}>
        {row.gaps.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(gap => <p key={gap.from} className="text-xs">{researchTime(gap.from)} → {researchTime(gap.through)}</p>)}
        <DataPagination count={row.gaps.length} page={page} onPageChange={setPage} label="gaps" context={`gaps for ${row.instrument} ${row.kind}`} />
      </div>}
    </CollapsibleContent>
  </Collapsible>
})

// A plan can contain years of source ranges and fragmented coverage for every
// contract. Keep closed details out of the render tree and bound each visible
// page, including nested gaps. Stable data also avoids rebuilding these tables
// on job polling or workspace changes.
export const ResearchInputDetails = memo(function ResearchInputDetails({ data, frozen }: { data: DataPlan | DataManifest; frozen: boolean }) {
  const [coverageOpen, setCoverageOpen] = useState(false), [coveragePage, setCoveragePage] = useState(0)
  const [catalogOpen, setCatalogOpen] = useState(false), [catalogPage, setCatalogPage] = useState(0)
  const { instruments, references } = useMemo(() => {
    const targets = new Set(data.instruments.map(instrument => instrument.id))
    const referenceInstruments = data.referenceInstruments ?? []
    return { instruments: [...data.instruments, ...referenceInstruments.filter(instrument => !targets.has(instrument.id))], references: new Set(referenceInstruments.map(instrument => instrument.id)) }
  }, [data])
  return <>
    <Collapsible open={coverageOpen} onOpenChange={setCoverageOpen}>
      <CollapsibleTrigger asChild><Button variant="ghost">
        <ChevronRight data-icon="inline-start" className={coverageOpen ? 'rotate-90' : undefined} aria-hidden="true" />{frozen ? 'Frozen' : 'Local'} input coverage and data gaps
      </Button></CollapsibleTrigger>
      <CollapsibleContent>
        {coverageOpen && <>
          <p className="my-2 text-xs text-muted-foreground">Recorded turnover is supplemented from complete 24h base-volume history. Funding coverage records inspected intervals, including intervals without a settlement.</p>
          <Table aria-label="Frozen input coverage"><TableHeader><TableRow>{['Instrument', 'Input', 'Available / expected', 'First', 'Last', 'Missing intervals'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{data.coverage.slice(coveragePage * PAGE_SIZE, (coveragePage + 1) * PAGE_SIZE).map(row => <TableRow key={row.instrument + ':' + row.kind}>
              <TableCell>{row.instrument}{references.has(row.instrument) && <Badge variant="outline" className="ml-2">Reference</Badge>}</TableCell>
              <TableCell>{row.kind}</TableCell><TableCell>{integer(row.available)} / {integer(row.expected)}</TableCell>
              <TableCell>{row.first == null ? '—' : researchTime(row.first)}</TableCell><TableCell>{row.last == null ? '—' : researchTime(row.last)}</TableCell>
              <TableCell><CoverageGaps row={row} /></TableCell>
            </TableRow>)}</TableBody>
          </Table>
          <DataPagination count={data.coverage.length} page={coveragePage} onPageChange={setCoveragePage} label="coverage" />
        </>}
      </CollapsibleContent>
    </Collapsible>
    <Collapsible open={catalogOpen} onOpenChange={setCatalogOpen}>
      <CollapsibleTrigger asChild><Button variant="ghost">
        <ChevronRight data-icon="inline-start" className={catalogOpen ? 'rotate-90' : undefined} aria-hidden="true" />Historical instrument eligibility and sources
      </Button></CollapsibleTrigger>
      <CollapsibleContent>
        {catalogOpen && <>
          <Table aria-label="Historical instrument catalog"><TableHeader><TableRow>{['Instrument', 'Listed (UTC)', 'Delisted (UTC)', 'Contract base value', 'Metadata evidence'].map(label => <TableHead key={label}>{label}</TableHead>)}</TableRow></TableHeader>
            <TableBody>{instruments.slice(catalogPage * PAGE_SIZE, (catalogPage + 1) * PAGE_SIZE).map(instrument => <TableRow key={instrument.id}>
              <TableCell>{instrument.id}</TableCell><TableCell>{instrument.listedAt == null ? 'Unknown' : researchTime(instrument.listedAt)}</TableCell><TableCell>{instrument.delistedAt == null ? '—' : researchTime(instrument.delistedAt)}</TableCell>
              <TableCell>{instrument.contractValue ?? 'Unknown'}</TableCell><TableCell className="max-w-80 break-all text-xs">{instrument.source}<div className="text-muted-foreground">Captured {researchTime(instrument.observedAt)}</div></TableCell>
            </TableRow>)}</TableBody>
          </Table>
          <DataPagination count={instruments.length} page={catalogPage} onPageChange={setCatalogPage} label="instruments" />
        </>}
      </CollapsibleContent>
    </Collapsible>
  </>
})
