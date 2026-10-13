import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function RockerSwitch({ leftLabel, rightLabel, checked, onCheckedChange, className, size = 'default', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  leftLabel: string
  rightLabel: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  size?: 'default' | 'sm'
}) {
  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    data-slot="rocker-switch"
    data-surface="control"
    data-state={checked ? 'right' : 'left'}
    onClick={() => onCheckedChange(!checked)}
    className={cn('relative grid shrink-0 grid-cols-2 overflow-hidden rounded-(--control-radius) border border-input bg-control p-0.5 text-[length:var(--control-font-size)] font-medium text-muted-foreground outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50', size === 'sm' ? 'h-(--control-height-sm)' : 'h-(--control-height)', className)}
    {...props}
  >
    <span aria-hidden="true" data-surface="control" className={cn('absolute inset-y-0.5 left-0.5 w-[calc(50%_-_2px)] rounded-[calc(var(--control-radius)-2px)] border border-selection-border bg-selection transition-transform', checked && 'translate-x-[calc(100%+2px)]')} />
    <span className={cn('relative z-10 flex h-full items-center justify-center px-2.5 whitespace-nowrap', !checked && 'text-foreground')}>{leftLabel}</span>
    <span className={cn('relative z-10 flex h-full items-center justify-center px-2.5 whitespace-nowrap', checked && 'text-foreground')}>{rightLabel}</span>
  </button>
}
