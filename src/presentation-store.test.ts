import assert from 'node:assert/strict'
import test from 'node:test'
import type { PresentationUpdate } from './desktop-contract.ts'

test('presentation barriers suspend callbacks and animations, then publish the snapshot before releasing work', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let receive!: (value: PresentationUpdate) => void
  const events: string[] = []
  const animation = { playState: 'running', pause() { events.push('pause'); this.playState = 'paused' }, play() { events.push('play'); this.playState = 'running' } }
  const target = new EventTarget()
  target.addEventListener('radar-gateway-stream', () => events.push('gateway'))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(target, {
    radarDesktop: { subscribePresentation(listener: typeof receive) { receive = listener; listener({ epoch: 0, active: true, startedAt: 0 }); return () => {} } },
  }) })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getAnimations: () => [animation], documentElement: { toggleAttribute: (_name: string, idle: boolean) => { events.push(idle ? 'idle' : 'active') } },
  } })
  try {
    const presentation = await import('./presentation-store.ts')
    presentation.subscribePresentationTransition(value => { if (value.snapshot) events.push('snapshot') })
    presentation.subscribePresentation(() => { if (presentation.getPresentation().active) events.push('subscriber') })
    events.length = 0
    receive({ epoch: 1, active: false, startedAt: 1 })
    let released = false
    const waiting = presentation.waitForPresentation().then(() => { released = true; events.push('waiter') })
    await Promise.resolve()
    assert.equal(released, false)
    assert.deepEqual(events, ['pause', 'idle'])
    const snapshot = { gateway: [{ id: 'g', type: 'end' }] } as unknown as NonNullable<PresentationUpdate['snapshot']>
    receive({ epoch: 2, active: false, startedAt: 2 })
    receive({ epoch: 2, active: true, startedAt: 2, snapshot })
    await waiting
    assert.equal(presentation.getPresentation().snapshot, undefined, 'The one-shot resume payload must be released.')
    assert.deepEqual(events, ['pause', 'idle', 'idle', 'active', 'play', 'snapshot', 'subscriber', 'gateway', 'waiter'])
    receive({ epoch: 1, active: false, startedAt: 1 })
    assert.equal(presentation.getPresentation().epoch, 2)
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document')
  }
})
