import { useCallback, useRef, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import type { PresentationUpdate } from './desktop-contract.ts'

let current: PresentationUpdate = { epoch: 0, active: true, startedAt: 0 }
let pendingSnapshot: PresentationUpdate['snapshot']
const listeners = new Set<() => void>()
const transitions = new Set<(update: PresentationUpdate) => void>()
const waiters = new Set<() => void>()
let pausedAnimations: Animation[] = []

// Snapshot consumers run before subscribers are released, so no external-store
// reader can render a mix of old and new market, chart and job state.
window.radarDesktop.subscribePresentation(update => {
  if (update.epoch < current.epoch) return
  const { snapshot, ...state } = update
  current = state
  // A transition can arrive before App mounts. Retain only until the first
  // mounted transition consumer receives it, never throughout active use.
  pendingSnapshot = transitions.size ? undefined : snapshot
  if (!update.active) {
    for (const animation of document.getAnimations?.() ?? []) {
      if (animation.playState === 'running') { animation.pause(); pausedAnimations.push(animation) }
    }
  }
  document.documentElement.toggleAttribute('data-presentation-idle', !update.active)
  if (update.active) {
    for (const animation of pausedAnimations) if (animation.playState === 'paused') animation.play()
    pausedAnimations = []
  }
  // Commit the barrier as one React update before a later activation message
  // can suspend the renderer again or an incremental notification can arrive.
  try {
    flushSync(() => {
      for (const transition of transitions) transition(update)
      for (const listener of listeners) listener()
    })
  } finally {
    if (update.active) {
      for (const waiter of waiters) waiter()
      waiters.clear()
    }
  }
})

export const getPresentation = () => current
export const subscribePresentation = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const subscribePresentationTransition = (listener: (update: PresentationUpdate) => void) => {
  transitions.add(listener)
  const snapshot = pendingSnapshot
  pendingSnapshot = undefined
  listener(snapshot ? { ...current, snapshot } : current)
  return () => { transitions.delete(listener) }
}
export const usePresentation = () => useSyncExternalStore(subscribePresentation, getPresentation)
export const waitForPresentation = () => current.active ? Promise.resolve() : new Promise<void>(resolve => { waiters.add(resolve) })

/** Keep background stores running, but expose their last presented value while idle. */
export function usePresentedStore<T>(subscribe: (listener: () => void) => () => void, get: () => T): T {
  const presented = useRef<{ initialized: boolean; value: T }>({ initialized: false, value: undefined as T })
  const getSnapshot = useCallback(() => {
    if (!presented.current.initialized || current.active) {
      presented.current = { initialized: true, value: get() }
    }
    return presented.current.value
  }, [get])
  const subscribeSnapshot = useCallback((notify: () => void) => {
    const stopSource = subscribe(() => { if (current.active) notify() })
    const stopPresentation = subscribePresentation(() => { if (current.active) notify() })
    return () => { stopSource(); stopPresentation() }
  }, [subscribe])
  return useSyncExternalStore(subscribeSnapshot, getSnapshot)
}
