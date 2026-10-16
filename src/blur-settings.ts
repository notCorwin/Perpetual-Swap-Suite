import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type BlurSettings = { windowBlurRadius: number; floatingBlurRadius: number }
type BlurKey = keyof BlurSettings
const keys: BlurKey[] = ['windowBlurRadius', 'floatingBlurRadius']
const token = (name: string) => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
export const blurRadiusLimit = () => token('--blur-radius-max')
export const initialBlurSettings = (saved?: Partial<BlurSettings>): BlurSettings => ({
  windowBlurRadius: saved?.windowBlurRadius ?? token('--window-blur'),
  floatingBlurRadius: saved?.floatingBlurRadius ?? token('--floating-blur'),
})

export async function withSettingsDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Saving timed out.')), 8000)
    })])
  } finally { clearTimeout(timer) }
}

// Keep preview/edit state outside the popover so closing it cannot lose a save.
export function useBlurSettings(initial: () => BlurSettings, save: (request: Partial<BlurSettings>) => Promise<BlurSettings>, previewWindow: (radius: number | null) => Promise<unknown>) {
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<Partial<Record<BlurKey, string>>>({})
  const [pending, setPending] = useState<Partial<Record<BlurKey, boolean>>>({})
  const draft = useRef(values), dirty = useRef(new Set<BlurKey>())
  const versions = useRef({ windowBlurRadius: 0, floatingBlurRadius: 0 })
  const queue = useRef<Partial<Record<BlurKey, Promise<void>>>>({})
  const saving = useRef<Partial<Record<BlurKey, number>>>({})
  const retryTimers = useRef<Partial<Record<BlurKey, ReturnType<typeof setTimeout>>>>({})
  const retryAttempts = useRef<Partial<Record<BlurKey, number>>>({})
  useEffect(() => () => { for (const timer of Object.values(retryTimers.current)) clearTimeout(timer) }, [])
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--floating-blur', `${values.floatingBlurRadius}px`)
    document.documentElement.dataset.floatingBlur = String(values.floatingBlurRadius > 0)
  }, [values.floatingBlurRadius])
  const synchronize = (saved: BlurSettings) => {
    const next = { ...draft.current }
    for (const key of keys) if (!dirty.current.has(key)) next[key] = saved[key]
    draft.current = next
    setValues(current => keys.every(key => current[key] === next[key]) ? current : next)
  }
  const change = (key: BlurKey, value: number) => {
    if (draft.current[key] === value) return
    const version = ++versions.current[key]
    dirty.current.add(key)
    if (retryTimers.current[key]) clearTimeout(retryTimers.current[key])
    delete retryTimers.current[key]; delete retryAttempts.current[key]
    draft.current = { ...draft.current, [key]: value }
    setValues(draft.current); setErrors(current => ({ ...current, [key]: undefined }))
    if (key === 'windowBlurRadius') void previewWindow(value).catch(cause => {
      if (version === versions.current[key]) setErrors(current => ({ ...current, [key]: String(cause) }))
    })
  }
  const commit = (key: BlurKey, nextValue?: number) => {
    // Radix keyboard commits arrive before its onValueChange callback.
    if (nextValue !== undefined) change(key, nextValue)
    if (!dirty.current.has(key)) return
    const value = draft.current[key], version = versions.current[key]
    if (saving.current[key] === version) return
    saving.current[key] = version
    setPending(current => ({ ...current, [key]: true }))
    // Serialize writes for each slider while allowing immediate local previews.
    queue.current[key] = (queue.current[key] ?? Promise.resolve()).then(async () => {
      try {
        if (version !== versions.current[key]) return
        const saved = await save({ [key]: value })
        if (version !== versions.current[key]) return
        dirty.current.delete(key)
        if (retryTimers.current[key]) clearTimeout(retryTimers.current[key])
        delete retryTimers.current[key]; delete retryAttempts.current[key]
        draft.current = { ...draft.current, [key]: saved[key] }
        setValues(draft.current)
        if (key === 'windowBlurRadius') await previewWindow(null)
        setErrors(current => ({ ...current, [key]: undefined }))
      } catch (cause) {
        if (version === versions.current[key]) {
          dirty.current.add(key)
          setErrors(current => ({ ...current, [key]: cause instanceof Error ? cause.message : 'Cannot save blur.' }))
          const attempt = (retryAttempts.current[key] ?? 0) + 1
          retryAttempts.current[key] = attempt
          retryTimers.current[key] = setTimeout(() => {
            delete retryTimers.current[key]
            if (version === versions.current[key]) commit(key)
          }, Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5)))
        }
      } finally {
        if (saving.current[key] === version) {
          delete saving.current[key]
          setPending(current => ({ ...current, [key]: false }))
        }
      }
    })
  }
  return { values, errors, pending, change, commit, synchronize, commitAll: () => keys.forEach(key => commit(key)) }
}

