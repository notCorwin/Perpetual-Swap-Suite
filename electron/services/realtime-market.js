import { hookOperationMethods } from './operations.js'
import { recordedWebSocketFactory } from './network-operations.js'

// OKX business WebSocket: https://www.okx.com/docs-v5/en/#order-book-trading-market-data-ws-candlesticks-channel
// Port 8443 retires on 2026-10-31: https://www.okx.com/docs-v5/log_en/
export const OKX_BUSINESS_WEBSOCKET_URL = 'wss://ws.okx.com/ws/v5/business'

const channels = new Map([['5m', 'candle5m'], ['15m', 'candle15m'], ['1H', 'candle1H']])
const timeframes = new Map([...channels].map(([timeframe, channel]) => [channel, timeframe]))
const keyFor = ({ instId, timeframe }) => `${timeframe}:${instId}`
const hour = 3_600_000
const signature = raw => JSON.stringify(raw.slice(0, 8).map(Number))
const volumes = raw => raw.slice(5, 8).map(Number)
const copy = value => ({ ...value })

/**
 * A single business socket owns transport only; callers own parsing, durable
 * ingestion, gap repair and projections. Candle timestamps identify periods,
 * not the order of updates within a period. Equal-volume OHLC corrections use
 * receive order; a decrease in any cumulative volume rejects a forming update.
 */
export class RealtimeMarket {
  constructor(options) {
    for (const name of ['parseCandle', 'onForming', 'onConfirmed', 'onReconnect']) {
      if (typeof options?.[name] !== 'function') throw new TypeError(`${name} must be a function.`)
    }
    this.options = options
    this.url = options.url ?? OKX_BUSINESS_WEBSOCKET_URL
    this.factory = recordedWebSocketFactory(options.webSocketFactory ?? (url => new globalThis.WebSocket(url)), 'okx.business')
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimeout ?? globalThis.setTimeout
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout
    this.random = options.random ?? Math.random
    this.logger = options.logger ?? console
    this.baseDelay = this.positive('reconnectBaseMs', 1_000)
    this.maxDelay = Math.max(this.baseDelay, this.positive('reconnectMaxMs', 30_000))
    this.jitter = Math.min(1, Math.max(0, options.reconnectJitter ?? 0.2))
    this.heartbeatMs = Math.min(25_000, this.positive('heartbeatIntervalMs', 15_000))
    this.pongTimeoutMs = this.positive('pongTimeoutMs', 10_000)
    this.connectTimeoutMs = this.positive('connectTimeoutMs', 10_000)
    this.ackTimeoutMs = this.positive('subscriptionTimeoutMs', 15_000)
    this.closeTimeoutMs = this.positive('closeTimeoutMs', 5_000)
    this.confirmationCacheSize = Math.floor(this.positive('confirmationCacheSize', 512))
    this.state = { status: 'disconnected', updatedAt: null, error: '' }
    this.telemetry = { receivedEvents: 0, formingEvents: 0, confirmedEvents: 0, ignoredEvents: 0, rejectedEvents: 0, reconnects: 0, pendingEvents: 0, lastReceivedAt: null, lastDispatchLatencyMs: null, maxDispatchLatencyMs: 0, lastCallbackLatencyMs: null, maxCallbackLatencyMs: 0 }
    this.subscriptions = new Map()
    this.series = new Map()
    this.tasks = new Set()
    this.retirements = new Set()
    this.durableController = new AbortController()
    this.started = false
    this.closed = false
    this.hasOpened = false
    this.attempt = 0
    this.connection = null
    this.recoveryTail = Promise.resolve()
    this.retryTimer = null
    this.closePromise = null
  }

  positive(name, fallback) {
    const value = this.options[name] ?? fallback
    if (!Number.isFinite(value) || value < 1) throw new RangeError(`${name} must be positive.`)
    return value
  }

  getState() { return copy(this.state) }
  getTelemetry() { return copy(this.telemetry) }
  getProgress(instId, timeframe) {
    const series = this.series.get(keyFor({ instId, timeframe }))
    const timestamp = value => Number.isFinite(value) ? value : null
    return { receivedThrough: timestamp(series?.latestTimestamp), confirmedThrough: timestamp(series?.confirmedThrough),
      committedThrough: timestamp(series?.committedThrough), pendingConfirmations: series?.pendingConfirmations.size ?? 0 }
  }
  isSubscribed(instId, timeframe) {
    const connection = this.connection, key = keyFor({ instId, timeframe })
    const subscription = this.subscriptions.get(key)
    return Boolean(connection && this.active(connection) && connection.opened && connection.socket.readyState === 1
      && subscription && connection.sent.get(key) === subscription && !connection.pending.has(key))
  }
  getForming(instId, timeframe) {
    const candle = this.series.get(keyFor({ instId, timeframe }))?.forming?.candle
    return candle ? copy(candle) : null
  }

  setSubscriptions(values) {
    if (this.closed) throw new Error('Realtime market is closed.')
    const next = new Map()
    for (const value of values) {
      if (!channels.has(value?.timeframe) || typeof value.instId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value.instId)) throw new TypeError('Invalid candle subscription.')
      const key = keyFor(value)
      next.set(key, this.subscriptions.get(key) ?? { instId: value.instId, timeframe: value.timeframe })
    }
    this.subscriptions = next
    for (const [key, series] of this.series) if (!next.has(key)) {
      series.forming = null
      this.cleanupSeries(key, series)
    }
    if (!next.size) {
      this.cancelRetry()
      if (this.connection) this.retire(this.connection)
      this.setState({ status: 'disconnected' })
    } else if (this.started) {
      if (this.connection) this.flushSubscriptions(this.connection)
      else if (this.retryTimer === null) this.connect()
    }
  }

  start() {
    if (this.closed) throw new Error('Realtime market is closed.')
    if (this.started) return
    this.started = true
    if (this.subscriptions.size) this.connect()
  }

  track(task) {
    this.tasks.add(task)
    // Every tracked task has its own error policy. Both branches remove it
    // without creating an unhandled rejected promise from finally().
    task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  async whenIdle() {
    // Synchronous socket operations may enqueue their acknowledgements as
    // microtasks. Include decoding admitted by those operations in this drain.
    await Promise.resolve()
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
  }

  setState(patch) {
    const next = { ...this.state, ...patch }
    if (Object.keys(next).every(key => Object.is(next[key], this.state[key]))) return
    this.state = next
    if (!this.options.onState) return
    try {
      const result = this.options.onState(copy(next))
      if (result?.then) this.track(Promise.resolve(result).catch(error => this.report('Connection state callback failed.', error, false)))
    } catch (error) { this.report('Connection state callback failed.', error, false) }
  }

  report(message, error, notify = true) {
    const detail = error instanceof Error ? error.message : error == null ? '' : String(error)
    const text = detail ? `${message} ${detail}` : message
    this.logger.error(`[RealtimeMarket] ${text}`, error ?? '')
    if (notify === true) this.setState({ error: text })
    else if (notify === false) this.state = { ...this.state, error: text }
    return text
  }

  connect() {
    if (this.closed || !this.started || !this.subscriptions.size || this.connection) return
    this.setState({ status: this.hasOpened || this.attempt ? 'reconnecting' : 'connecting' })
    if (this.closed || !this.subscriptions.size || this.connection) return
    let socket
    try { socket = this.factory(this.url) }
    catch (error) { this.scheduleReconnect(this.report('WebSocket connection failed.', error)); return }
    const connection = { socket, sent: new Map(), pending: new Map(), timers: new Map(), commands: [], commandId: 0, controller: new AbortController(), ready: false, waitingForPong: false, retired: false, wasReconnect: this.hasOpened }
    this.connection = connection
    connection.done = new Promise(resolve => { connection.resolveDone = resolve })
    connection.listeners = {
      open: () => this.opened(connection),
      message: event => this.message(connection, event.data),
      error: event => { if (this.active(connection)) this.lost(connection, 'WebSocket transport failed.', event.error ?? event.message) },
      close: event => {
        if (this.active(connection)) this.lost(connection, `WebSocket closed (${event.code ?? 1006}${event.reason ? `: ${event.reason}` : ''}).`)
        this.finishSocket(connection)
      },
    }
    for (const [type, listener] of Object.entries(connection.listeners)) socket.addEventListener(type, listener)
    this.timer(connection, 'connect', this.connectTimeoutMs, () => this.lost(connection, 'WebSocket connection timed out.'))
    // Injected factories may return an already-open socket.
    if (socket.readyState === 1) this.opened(connection)
  }

  active(connection) { return this.connection === connection && !connection.retired && !this.closed }

  timer(connection, name, delay, callback) {
    this.clearConnectionTimer(connection, name)
    connection.timers.set(name, this.setTimer(() => {
      connection.timers.delete(name)
      callback()
    }, delay))
  }

  clearConnectionTimer(connection, name) {
    if (connection.timers.has(name)) this.clearTimer(connection.timers.get(name))
    connection.timers.delete(name)
  }

  opened(connection) {
    if (!this.active(connection) || connection.opened) return
    connection.opened = true
    this.hasOpened = true
    if (connection.wasReconnect) this.telemetry.reconnects++
    this.clearConnectionTimer(connection, 'connect')
    // Live delivery has only its own series' accepted-callback barrier. A
    // missing historical range must never hold every instrument's next tick.
    // The consumer coordinates historical and live durable mutations.
    connection.ready = true
    connection.repaired = new Set()
    connection.recoveryAttempt = 0
    connection.recoveryError = ''
    if (connection.wasReconnect) this.recover(connection)
    this.flushSubscriptions(connection)
    this.armHeartbeat(connection)
  }

  recover(connection) {
    if (!this.active(connection) || connection.recoveryTask) return
    const previous = this.recoveryTail
    const task = Promise.resolve(previous).then(async () => {
      // Cancellation does not prove the previous consumer has finished its
      // durable work. Serialize repairs without delaying live callbacks.
      while (this.active(connection)) {
        const missing = [...this.subscriptions.values()].filter(value => !connection.repaired.has(value))
        if (!missing.length) break
        await this.options.onReconnect(missing.map(copy), { signal: connection.controller.signal })
        missing.forEach(value => connection.repaired.add(value))
      }
      if (!this.active(connection)) return
      connection.recoveryAttempt = 0
      connection.recoveryError = ''
      this.maybeLive(connection)
    }).catch(error => {
      if (this.active(connection)) {
        connection.recoveryError = this.report('Reconnect gap repair failed.', error)
        const delay = Math.min(this.maxDelay, this.baseDelay * 2 ** Math.min(connection.recoveryAttempt++, 30))
        if (this.active(connection)) this.timer(connection, 'recovery', delay, () => this.recover(connection))
      } else if (error?.name !== 'AbortError') this.report('Reconnect gap repair failed.', error, 'log')
    }).finally(() => { connection.recoveryTask = null })
    connection.recoveryTask = this.track(task)
    this.recoveryTail = task
  }

  flushSubscriptions(connection) {
    if (!this.active(connection) || !connection.opened || connection.socket.readyState !== 1) return
    this.clearConnectionTimer(connection, 'control')
    const removals = [...connection.sent].filter(([key, value]) => this.subscriptions.get(key) !== value)
    const additions = [...this.subscriptions].filter(([key, value]) => connection.sent.get(key) !== value)
    // OKX permits 480 subscribe/unsubscribe/login requests per connection/hour,
    // with at most 64 KB per request. 100 short ASCII arguments stay below it.
    for (const [op, entries] of [['unsubscribe', removals], ['subscribe', additions]]) {
      for (let index = 0; index < entries.length; index += 100) {
        const now = this.now()
        connection.commands = connection.commands.filter(time => time > now - hour)
        if (connection.commands.length >= 480) {
          this.timer(connection, 'control', Math.max(1, connection.commands[0] + hour - now), () => this.flushSubscriptions(connection))
          this.armAcknowledgement(connection)
          this.maybeLive(connection)
          return
        }
        const chunk = entries.slice(index, index + 100)
        const id = String(++connection.commandId)
        for (const [key, value] of chunk) {
          if (op === 'subscribe') { connection.sent.set(key, value); connection.pending.set(key, { id, deadline: now + this.ackTimeoutMs }) }
          else { connection.sent.delete(key); connection.pending.delete(key) }
        }
        try {
          connection.socket.send(JSON.stringify({ id, op, args: chunk.map(([, value]) => ({ channel: channels.get(value.timeframe), instId: value.instId })) }))
          connection.commands.push(now)
        } catch (error) { this.lost(connection, 'WebSocket subscription failed.', error); return }
      }
    }
    this.armAcknowledgement(connection)
    this.maybeLive(connection)
  }

  armAcknowledgement(connection) {
    this.clearConnectionTimer(connection, 'ack')
    if (!connection.pending.size) return
    const deadline = Math.min(...[...connection.pending.values()].map(value => value.deadline))
    this.timer(connection, 'ack', Math.max(1, deadline - this.now()), () => this.lost(connection, 'Candle subscription acknowledgement timed out.'))
  }

  maybeLive(connection) {
    if (!this.active(connection)) return
    const live = connection.ready && !connection.pending.size && this.subscriptions.size > 0
      && [...this.subscriptions].every(([key, value]) => connection.sent.get(key) === value)
    if (live) this.attempt = 0
    this.setState({ status: live ? 'live' : connection.wasReconnect ? 'reconnecting' : 'connecting', ...(live ? { error: connection.recoveryError } : {}) })
  }

  armHeartbeat(connection) {
    if (!this.active(connection) || connection.waitingForPong) return
    this.timer(connection, 'heartbeat', this.heartbeatMs, () => {
      if (!this.active(connection)) return
      connection.waitingForPong = true
      this.timer(connection, 'pong', this.pongTimeoutMs, () => this.lost(connection, 'WebSocket pong timed out.'))
      try { connection.socket.send('ping') }
      catch (error) { this.lost(connection, 'WebSocket heartbeat failed.', error) }
    })
  }

  message(connection, data) {
    if (!this.active(connection)) return
    const receivedAt = this.now()
    this.armHeartbeat(connection)
    // Blob decoding is also part of the shutdown barrier. Native Node/Electron
    // sockets normally deliver text here, but binary frames are valid too.
    const task = (connection.messageTail ?? Promise.resolve()).then(async () => {
      let text = data
      if (typeof data !== 'string') {
        if (data && typeof data.text === 'function') text = await data.text()
        else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = new TextDecoder().decode(data)
        else throw new TypeError('Unsupported WebSocket message data.')
      }
      if (this.active(connection)) this.consume(connection, text, receivedAt)
    }).catch(error => this.report('WebSocket message decoding failed.', error, this.active(connection) ? true : 'log'))
    connection.messageTail = task
    this.track(task)
  }

  consume(connection, text, receivedAt) {
    if (text === 'pong') {
      connection.waitingForPong = false
      this.clearConnectionTimer(connection, 'pong')
      this.armHeartbeat(connection)
      return
    }
    let message
    try { message = JSON.parse(text) }
    catch (error) { this.report('Invalid WebSocket JSON.', error); return }
    if (!message || typeof message !== 'object') { this.report('Invalid WebSocket message.'); return }
    if (message.event === 'error' || message.event === 'notice') {
      this.lost(connection, `OKX WebSocket ${message.event} (${message.code ?? 'unknown'}): ${message.msg ?? 'No details.'}`)
      return
    }
    const timeframe = timeframes.get(message.arg?.channel)
    const subscription = timeframe && this.subscriptions.get(keyFor({ instId: message.arg?.instId, timeframe }))
    if (!subscription || connection.sent.get(keyFor(subscription)) !== subscription) return
    if (message.event === 'subscribe') {
      if (connection.pending.get(keyFor(subscription))?.id !== message.id) return
      connection.pending.delete(keyFor(subscription))
      this.armAcknowledgement(connection)
      this.maybeLive(connection)
      try {
        const result = this.options.onSubscribed?.(copy(subscription), { signal: connection.controller.signal, receivedAt })
        if (result?.then) this.track(Promise.resolve(result).catch(error => this.report('Candle subscription callback failed.', error)))
      } catch (error) { this.report('Candle subscription callback failed.', error) }
      return
    }
    if (!Array.isArray(message.data)) return
    for (const raw of message.data) this.enqueue(connection, subscription, raw, receivedAt)
  }

  enqueue(connection, subscription, raw, receivedAt) {
    this.telemetry.receivedEvents++
    this.telemetry.lastReceivedAt = receivedAt
    const key = keyFor(subscription)
    let series = this.series.get(key)
    if (!series) {
      series = { tail: Promise.resolve(), durableTail: Promise.resolve(), pending: 0, forming: null, latestTimestamp: -Infinity,
        confirmedThrough: -Infinity, committedThrough: -Infinity, confirmations: new Map(), pendingConfirmations: new Map() }
      this.series.set(key, series)
    }
    series.pending++
    this.telemetry.pendingEvents++
    const task = series.tail.then(async () => {
      // A confirmed event accepted before cancellation still needs durable
      // ingestion. Retired transports must not publish queued forming events.
      if (raw?.[8] !== '1' && (!this.active(connection) || this.subscriptions.get(key) !== subscription)) return
      await this.process(connection, series, subscription, raw, receivedAt)
    }).catch(error => this.report('Candle callback failed.', error, this.active(connection) ? true : 'log')).then(() => {
      series.pending--
      this.telemetry.pendingEvents--
      this.cleanupSeries(key, series)
    })
    series.tail = task
    this.track(task)
  }

  async process(connection, series, subscription, raw, receivedAt) {
    if (!Array.isArray(raw) || raw.length < 9 || !['0', '1'].includes(raw[8]) || raw.slice(0, 8).some(value => typeof value !== 'string' || !value.trim() || !Number.isFinite(Number(value))) || volumes(raw).some(value => value < 0)) {
      this.telemetry.rejectedEvents++
      this.report('Invalid OKX candle payload.')
      return
    }
    const candle = this.options.parseCandle(subscription.instId, subscription.timeframe, [...raw])
    if (!candle || candle.instrument !== subscription.instId || candle.timeframe !== subscription.timeframe || candle.timestamp !== Number(raw[0]) || candle.confirmed !== (raw[8] === '1')) {
      this.telemetry.rejectedEvents++
      this.report('Candle parser rejected the OKX event.')
      return
    }
    const fingerprint = signature(raw), cumulative = volumes(raw), timestamp = candle.timestamp
    if (candle.confirmed) {
      if (series.confirmations.has(fingerprint) || series.pendingConfirmations.has(fingerprint)) { this.telemetry.ignoredEvents++; return }
    } else {
      const previous = series.forming
      if (timestamp <= series.confirmedThrough || timestamp < series.latestTimestamp || previous?.published && previous.fingerprint === fingerprint || previous?.candle.timestamp === timestamp && cumulative.some((value, index) => value < previous.volumes[index])) {
        this.telemetry.ignoredEvents++
        return
      }
    }
    this.telemetry.lastDispatchLatencyMs = Math.max(0, this.now() - receivedAt)
    this.telemetry.maxDispatchLatencyMs = Math.max(this.telemetry.maxDispatchLatencyMs, this.telemetry.lastDispatchLatencyMs)
    series.latestTimestamp = Math.max(series.latestTimestamp, timestamp)
    const context = { signal: candle.confirmed ? this.durableController.signal : connection.controller.signal, receivedAt }
    if (candle.confirmed) {
      // Exchange confirmation and local durability are independent progress.
      // Preserve correction order without putting live delivery behind fsync.
      series.confirmedThrough = Math.max(series.confirmedThrough, timestamp)
      if (series.forming && series.forming.candle.timestamp <= timestamp) series.forming = null
      const durable = series.durableTail.then(() => this.options.onConfirmed(copy(candle), context)).then(() => {
        series.confirmations.set(fingerprint, true)
        while (series.confirmations.size > this.confirmationCacheSize) series.confirmations.delete(series.confirmations.keys().next().value)
        series.committedThrough = Math.max(series.committedThrough, timestamp)
        this.telemetry.confirmedEvents++
        this.setState({ updatedAt: Math.max(this.state.updatedAt ?? -Infinity, receivedAt), error: this.connection?.recoveryError ?? '' })
      }).catch(error => {
        // Failure never creates durable coverage; the same source revision can retry.
        this.report('Confirmed candle persistence failed.', error, this.active(connection) ? true : 'log')
      }).finally(() => { series.pendingConfirmations.delete(fingerprint) })
      series.pendingConfirmations.set(fingerprint, durable)
      series.durableTail = durable
      this.track(durable)
    } else {
      const forming = { candle: copy(candle), fingerprint, volumes: cumulative, published: false }
      series.forming = forming
      await this.options.onForming(copy(candle), context)
      forming.published = true
      this.telemetry.formingEvents++
    }
    this.telemetry.lastCallbackLatencyMs = Math.max(0, this.now() - receivedAt)
    this.telemetry.maxCallbackLatencyMs = Math.max(this.telemetry.maxCallbackLatencyMs, this.telemetry.lastCallbackLatencyMs)
    this.setState({ updatedAt: Math.max(this.state.updatedAt ?? -Infinity, receivedAt), ...(this.state.status === 'live' ? { error: this.connection?.recoveryError ?? '' } : {}) })
  }

  cleanupSeries(key, series) {
    // Preserve watermarks and bounded deduplication across universe changes;
    // resubscribing must not revive a period already durably confirmed.
    if (!this.subscriptions.has(key) && !series.pending) series.forming = null
  }

  lost(connection, message, error) {
    if (!this.active(connection)) return
    const text = this.report(message, error)
    this.retire(connection)
    this.scheduleReconnect(text)
  }

  scheduleReconnect(error) {
    if (this.closed || !this.started || !this.subscriptions.size) return
    this.cancelRetry()
    this.setState({ status: 'reconnecting', error })
    if (this.closed || !this.started || !this.subscriptions.size) return
    const base = Math.min(this.maxDelay, this.baseDelay * 2 ** Math.min(this.attempt++, 30))
    const delay = Math.max(1, Math.min(this.maxDelay, base * (1 + (this.random() * 2 - 1) * this.jitter)))
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.connect() }, delay)
  }

  cancelRetry() {
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer)
    this.retryTimer = null
  }

  retire(connection) {
    if (connection.retired) return
    connection.retired = true
    connection.controller.abort()
    if (this.connection === connection) this.connection = null
    for (const name of [...connection.timers.keys()]) this.clearConnectionTimer(connection, name)
    this.retirements.add(connection.done)
    connection.done.then(() => this.retirements.delete(connection.done))
    this.timer(connection, 'close', this.closeTimeoutMs, () => {
      this.report('WebSocket close handshake timed out.', undefined, 'log')
      this.finishSocket(connection)
    })
    try {
      if (connection.socket.readyState === 3) this.finishSocket(connection)
      else connection.socket.close(1000, 'Realtime market stopped.')
    } catch (error) {
      this.report('WebSocket shutdown failed.', error)
      this.finishSocket(connection)
    }
  }

  finishSocket(connection) {
    if (connection.finished) return
    connection.finished = true
    for (const name of [...connection.timers.keys()]) this.clearConnectionTimer(connection, name)
    for (const [type, listener] of Object.entries(connection.listeners)) connection.socket.removeEventListener(type, listener)
    connection.resolveDone()
  }

  close() {
    if (this.closePromise) return this.closePromise
    // Establish the barrier before invoking any observer that can call close().
    this.closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.retirements])
      await this.whenIdle()
      this.durableController.abort()
      this.series.clear()
    })
    this.closed = true
    this.cancelRetry()
    if (this.connection) this.retire(this.connection)
    this.setState({ status: 'disconnected' })
    return this.closePromise
  }
}

hookOperationMethods(RealtimeMarket.prototype, {
  consume: { category: 'cpu', name: 'market.websocket.decode', attributes: { stream: 'okx.business' } },
})
