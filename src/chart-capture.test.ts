import assert from 'node:assert/strict'
import test from 'node:test'
import { captureStableChart } from './chart-capture.ts'

test('a chart change while pixels are in flight rejects the capture', async () => {
  let release!: (image: string) => void
  let revision = 1
  const captured = revision
  const promise = captureStableChart(() => new Promise<string>(resolve => { release = resolve }), () => revision === captured)
  revision++
  release('pixels from a different chart')
  await assert.rejects(promise, /changed during capture/)
})
