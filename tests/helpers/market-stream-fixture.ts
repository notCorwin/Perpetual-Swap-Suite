import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { MarketStore } from '../../electron/services/market-store.js'
import { MarketService } from '../../electron/services/market-service.js'
import { DEFAULT_PREFERENCES } from '../../electron/services/metadata-store.js'
import type { RealtimeWebSocket } from '../../electron/services/realtime-market.js'

export const instrument = (symbol = 'BTC') => ({ instId: `${symbol}-USDT-SWAP`, instType: 'SWAP', instCategory: '1', settleCcy: 'USDT', ctType: 'linear', state: 'live', ctVal: '0.01', ctMult: '1', ctValCcy: symbol, ruleType: 'normal' })
export const response = (data: unknown) => new Response(JSON.stringify({ code: '0', data }), { headers: { 'Content-Type': 'application/json' } })
export const waitFor = async (condition: () => boolean, timeout = 3_000) => {
  const deadline = performance.now() + timeout
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for streamed market work.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
export const preferences = (...enabled: (keyof typeof DEFAULT_PREFERENCES.liquidity)[]) => {
  const config = structuredClone(DEFAULT_PREFERENCES)
  for (const rule of Object.values(config.liquidity)) rule.enabled = false
  for (const key of enabled) config.liquidity[key].enabled = true
  return config
}
export type Subscription = { channel: string; instId: string }
const subscriptionKey = ({ channel, instId }: Subscription) => `${channel}:${instId}`
class Socket extends EventTarget implements RealtimeWebSocket {
  readyState = 0
  subscriptions = new Map<string, Subscription>()
  sent: string[] = []
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })) }
  send(value: string) {
    assert.equal(this.readyState, 1)
    this.sent.push(value)
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    for (const arg of command.args as Subscription[]) {
      if (command.op === 'subscribe') this.subscriptions.set(subscriptionKey(arg), arg)
      else this.subscriptions.delete(subscriptionKey(arg))
      queueMicrotask(() => this.message({ id: command.id, event: command.op, arg }))
    }
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' })))
  }
}

export const marketStreamFixture = async (config: ReturnType<typeof preferences>, fetcher: typeof fetch, autoStart = true) => {
  const root = await mkdtemp(join(tmpdir(), 'perp-market-stream-'))
  const store = await MarketStore.open(root)
  const sockets = new Map<string, Socket[]>()
  const service = new MarketService(store, () => config, fetcher, false, {
    webSocketFactory: url => {
      const socket = new Socket(), values = sockets.get(url) ?? []
      values.push(socket); sockets.set(url, values)
      return socket
    },
  })
  // Keep chart source membership visible without admitting historical work.
  await service.ready
  service.preparedCharts.setUniverse = () => ({ frames: [] })
  for (const lane of service.requestLanes.values()) lane.interval = 0
  const start = () => { service.publicRealtime.start(); service.realtime.start() }
  if (autoStart) start()
  const idle = async () => {
    await Promise.all([service.publicRealtime.whenIdle(), service.realtime.whenIdle()])
    await setImmediate()
  }
  const open = async () => {
    for (const values of sockets.values()) for (const socket of values) if (socket.readyState === 0) socket.open()
    await idle()
  }
  const subscriptions = (url: string) => [...(sockets.get(url) ?? [])].filter(socket => socket.readyState !== 3).flatMap(socket => [...socket.subscriptions.keys()]).sort()
  const push = (url: string, instId: string, channel: string, data: unknown[], action?: string) => {
    const socket = sockets.get(url)?.find(value => value.readyState === 1 && value.subscriptions.has(subscriptionKey({ instId, channel })))
    assert.ok(socket, `Missing ${channel} subscription for ${instId}.`)
    socket.message({ arg: { instId, channel }, data, ...(action ? { action } : {}) })
  }
  const discover = () => service.discoverInstruments(service.catalogCriteriaKey(), new AbortController().signal, 'foreground')
  const close = async () => { await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) }
  return { service, store, sockets, idle, open, subscriptions, push, discover, close, start }
}
