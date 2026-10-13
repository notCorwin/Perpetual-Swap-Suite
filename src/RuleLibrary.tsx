import { useMemo, useState } from 'react'
import { Plus, Star } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { FieldDescription } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { conditionLibrary, type LibraryItem } from '@/filter-builder'
import type { ExpressionTemplate } from '@/filter-expression'
import type { FilterLibraryPreferences, FilterMetric } from '@/rule-engine'

type Props = { metrics: FilterMetric[]; templates: ExpressionTemplate[]; preferences: FilterLibraryPreferences; onPreferences: (next: FilterLibraryPreferences) => void; onAdd: (item: LibraryItem) => void; open: boolean; onOpenChange: (open: boolean) => void; label?: string }
export function RuleLibrary({ metrics, templates, preferences, onPreferences, onAdd, open, onOpenChange, label = 'Add condition' }: Props) {
  const [query, setQuery] = useState(''), [section, setSection] = useState('all'), [limit, setLimit] = useState(50)
  const [active, setActive] = useState('preset:oi')
  const items = useMemo(() => conditionLibrary(metrics, templates), [metrics, templates])
  const { filtered, groups } = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const favorites = new Set(preferences.favorites), recent = new Map(preferences.recent.map((id, index) => [id, index]))
    const filtered = items.filter(item => {
      const text = `${item.label} ${item.group} ${item.description} ${item.keywords.join(' ')}`.toLowerCase()
      const inSection = section === 'all' || section === 'favorites' && favorites.has(item.id) || section === 'recent' && recent.has(item.id) || section === 'ready' && item.id.startsWith('preset:') || section === 'indicators' && (item.metric || item.template?.group === 'Parameterized indicators') || section === 'values' && item.group === 'Value blocks' || section === 'logic' && ['Logic & time', 'Comparisons & availability'].includes(item.group)
      return inSection && words.every(word => text.includes(word))
    }).sort((a, b) => section === 'recent' ? (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity) : 0)
    const groups = new Map<string, LibraryItem[]>()
    for (const item of filtered.slice(0, limit)) groups.set(item.group, [...(groups.get(item.group) ?? []), item])
    return { filtered, groups }
  }, [items, limit, preferences.favorites, preferences.recent, query, section])
  const visibleCount = [...groups.values()].reduce((count, values) => count + values.length, 0), chosen = items.find(item => item.id === active)
  const add = (item: LibraryItem) => { onAdd(item); onOpenChange(false); onPreferences({ ...preferences, recent: [item.id, ...preferences.recent.filter(id => id !== item.id)].slice(0, 12) }) }
  return <Popover open={open} onOpenChange={next => { onOpenChange(next); if (next) { setQuery(''); setLimit(50); setActive('preset:oi') } }}>
    <PopoverTrigger asChild><Button type="button" variant="outline" aria-label={label}><Plus data-icon="inline-start" aria-hidden="true" />{label}</Button></PopoverTrigger>
    <PopoverContent data-rule-library className="w-[44rem] p-0" align="start">
      <Command shouldFilter={false} value={active} onValueChange={setActive}>
        <CommandInput aria-label="Find a condition" placeholder="Find an intent or indicator: OI, candle body, volume, retest…" value={query} onValueChange={next => { setQuery(next); setLimit(50) }} />
        <div className="border-b p-2"><ToggleGroup type="single" variant="outline" size="sm" value={section} spacing={0} onValueChange={value => { if (value) { setSection(value); setLimit(50) } }} aria-label="Condition library category">
          {[['all', 'All'], ['ready', 'Ready to use'], ['indicators', 'Indicators'], ['values', 'Value blocks'], ['logic', 'Logic & time'], ['favorites', 'Favorites'], ['recent', 'Recent']].map(([id, text]) => <ToggleGroupItem key={id} value={id}>{text}</ToggleGroupItem>)}
        </ToggleGroup></div>
        <CommandList className="max-h-80"><CommandEmpty>{section === 'favorites' ? 'No favorites yet. Select an item and choose Favorite below.' : section === 'recent' ? 'Your recently added conditions appear here.' : 'No matching conditions. Try another indicator name or use All.'}</CommandEmpty>
          {[...groups].map(([group, values]) => <CommandGroup key={group} heading={group}>{values.map(item => <CommandItem key={item.id} value={item.id} data-library-id={item.id} onSelect={() => add(item)}>
            <div className="min-w-0 flex-1"><span className="flex items-center gap-2">{item.label}{preferences.favorites.includes(item.id) && <Star aria-label="Favorite" />}</span><span className="block text-xs text-muted-foreground">{item.description}</span></div>{item.unit && <Badge variant="outline">{item.unit}</Badge>}
          </CommandItem>)}</CommandGroup>)}
        </CommandList>
        <div className="flex items-center gap-3 border-t p-3"><FieldDescription className="min-w-0 flex-1">{filtered.length} matching entries · search covers the complete library</FieldDescription>{visibleCount < filtered.length && <Button type="button" variant="ghost" size="sm" onClick={() => setLimit(n => n + 50)}>Show more</Button>}
          {chosen && <Button type="button" variant="outline" size="sm" aria-label={`Favorite ${chosen.label}`} aria-pressed={preferences.favorites.includes(chosen.id)} onClick={() => onPreferences({ ...preferences, favorites: preferences.favorites.includes(chosen.id) ? preferences.favorites.filter(id => id !== chosen.id) : [...preferences.favorites, chosen.id].slice(-100) })}><Star data-icon="inline-start" aria-hidden="true" />{preferences.favorites.includes(chosen.id) ? 'Unfavorite' : 'Favorite'}</Button>}
        </div>
      </Command>
    </PopoverContent>
  </Popover>
}
