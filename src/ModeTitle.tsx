import { memo } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { modeTitle, type SuiteMode } from '@/suite-types'

export const ModeTitle = memo(function ModeTitle({ mode, onSwitch, pending = false }: { mode: SuiteMode; onSwitch: () => void; pending?: boolean }) {
  return <h1><Button type="button" variant="ghost" onClick={onSwitch} disabled={pending} aria-busy={pending} aria-label={modeTitle(mode)} title={'Switch to '+modeTitle(mode === 'radar' ? 'research' : 'radar')} data-mode-switch={mode}>
    <span className="text-base font-semibold tracking-tight" translate="no">{modeTitle(mode)}</span>
    {pending ? <Spinner data-icon="inline-end" aria-hidden="true" /> : <ArrowLeftRight data-icon="inline-end" aria-hidden="true" />}
  </Button></h1>
})
