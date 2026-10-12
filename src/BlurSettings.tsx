import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Slider } from '@/components/ui/slider'
import { blurRadiusLimit, type useBlurSettings } from '@/blur-settings'

export function BlurControls({ settings, windowDisabled }: { settings: ReturnType<typeof useBlurSettings>; windowDisabled: boolean }) {
  const [maximum] = useState(blurRadiusLimit)
  return (['windowBlurRadius', 'floatingBlurRadius'] as const).map(key => {
    const windowBlur = key === 'windowBlurRadius', id = windowBlur ? 'window-blur' : 'floating-blur'
    const disabled = windowBlur && windowDisabled
    return <Field key={key} data-disabled={disabled} data-invalid={Boolean(settings.errors[key])}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel id={`${id}-label`} htmlFor={id}>{windowBlur ? 'Window blur' : 'Popover blur'}</FieldLabel>
        <output htmlFor={id}>{settings.values[key]} px</output>
      </div>
      <Slider id={id} min={0} max={maximum} step={1} value={[settings.values[key]]} disabled={disabled}
        aria-labelledby={`${id}-label`} aria-describedby={`${id}-description`} onValueChange={([value]) => settings.change(key, value)} onValueCommit={([value]) => settings.commit(key, value)} />
      <FieldDescription id={`${id}-description`}>{windowBlur ? 'Blurs the desktop behind the window. Requires a translucent frosted background.' : 'Blurs app content behind menus, dialogs, and task overlays. Higher values soften more detail.'}</FieldDescription>
      {settings.pending[key] && <FieldDescription role="status">Saving…</FieldDescription>}
      {settings.errors[key] && <><FieldError role="alert">{settings.errors[key]}</FieldError><Button variant="outline" size="sm" onClick={() => settings.commit(key)}>Retry saving</Button></>}
    </Field>
  })
}
