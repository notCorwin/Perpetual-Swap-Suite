import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { ScrollArea } from '@base-ui/react/scroll-area'
import { Switch } from '@base-ui/react/switch'
import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatCompact, formatPercent, formatPrice } from '../lib/format'
import type { MarketSummary } from '../types'

type Props = {
  markets: MarketSummary[]
  selected: string | null
  onSelect(instrument: string): void
}

export function MarketSidebar({ markets, selected, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [eligibleOnly, setEligibleOnly] = useState(true)
  const visible = useMemo(() => markets.filter(market => {
    if (eligibleOnly && !market.eligible) return false
    return market.instrument.id.toLowerCase().includes(query.trim().toLowerCase())
  }), [eligibleOnly, markets, query])

  return <aside className="market-sidebar panel-edge">
    <div className="sidebar-heading">
      <div><span className="section-kicker">MARKET</span><h2>Contracts</h2></div>
      <span className="count-badge">{visible.length}</span>
    </div>
    <label className="search-field">
      <Search size={13} aria-hidden="true" />
      <Input aria-label="Search contracts" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <label className="filter-switch">
      <Switch.Root checked={eligibleOnly} onCheckedChange={setEligibleOnly} className="switch-root">
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      <span>Eligible only</span>
    </label>
    <div className="market-column-labels"><span>Contract</span><span>24h / Volume</span></div>
    <ScrollArea.Root className="scroll-root">
      <ScrollArea.Viewport className="scroll-viewport">
        <ScrollArea.Content className="market-list">
          {visible.map(market => {
            const positive = (market.change24hPercent ?? 0) >= 0
            return <Button
              key={market.instrument.id}
              className="market-row"
              data-selected={selected === market.instrument.id || undefined}
              onClick={() => onSelect(market.instrument.id)}
            >
              <span className="market-symbol-block">
                <span className="market-symbol">{market.instrument.baseCurrency}<small>PERP</small></span>
                <span className="market-price">{formatPrice(market.last)}</span>
              </span>
              <span className="market-numbers">
                <span className={positive ? 'positive' : 'negative'}>{positive ? '▲' : '▼'} {formatPercent(Math.abs(market.change24hPercent ?? 0), false)}</span>
                <span>{formatCompact(market.volume24hUSDT)}</span>
              </span>
              {!market.eligible && <span className="eligibility-mark" title={market.missingRequirements.join(', ')}>!</span>}
            </Button>
          })}
          {!visible.length && <div className="empty-list">No contracts match the current filter.</div>}
        </ScrollArea.Content>
      </ScrollArea.Viewport>
      <ScrollArea.Scrollbar className="scrollbar"><ScrollArea.Thumb className="scroll-thumb" /></ScrollArea.Scrollbar>
    </ScrollArea.Root>
  </aside>
}
