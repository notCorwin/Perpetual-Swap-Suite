import { hookOperationMethods } from './operations.js'
// Native OKX public streams cover the entire eligible universe independently of
// chart selection. https://www.okx.com/docs-v5/en/#order-book-trading-market-data
import { recordedWebSocketFactory } from './network-operations.js'

export const OKX_PUBLIC_WEBSOCKET_URL = 'wss://ws.okx.com/ws/v5/public'
export const PUBLIC_MARKET_CONTRACTS_PER_CONNECTION = 25

const channels = ['tickers', 'open-interest', 'books', 'trades']
const keyFor = ({ instId, instType, channel }) => `${channel}:${channel === 'instruments' ? instType : instId}`
const hour = 3_600_000
const copy = value => ({ ...value })

/** Transport and incremental order-book reconstruction; consumers own projections. */
class PublicMarketConnection {
  constructor(options) {
    for (const name of ['onTicker', 'onOpenInterest', 'onBook', 'onTrades']) {
      if (typeof options?.[name] !== 'function') throw new TypeError(`${name} must be a function.`)
    }
    this.options = options
    this.url = options.url ?? OKX_PUBLIC_WEBSOCKET_URL
    this.factory = recordedWebSocketFactory(options.webSocketFactory ?? (url => new globalThis.WebSocket(url)), 'okx.public')
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
    this.state = { status: 'disconnected', updatedAt: null, error: '' }
    this.telemetry = { receivedEvents: 0, tickerEvents: 0, openInterestEvents: 0, bookEvents: 0, tradeEvents: 0, ignoredEvents: 0, rejectedEvents: 0, reconnects: 0, pendingEvents: 0, lastReceivedAt: null }
    this.subscriptions = new Map()
    this.instruments = new Set()
    this.books = new Map()
    this.tails = new Map()
    this.tasks = new Set()
    this.retirements = new Set()
    this.started = false
    this.closed = false
    this.hasOpened = false
    this.attempt = 0
    this.connection = null
    this.retryTimer = null
    this.closePromise = null
    this.recoveryTail = Promise.resolve()
    this.scheduledConnect = null
  }

  positive(name, fallback) {
    const value = this.options[name] ?? fallback
    if (!Number.isFinite(value) || value < 1) throw new RangeError(`${name} must be positive.`)
    return value
  }

  getState() { return copy(this.state) }
  getTelemetry() { return copy(this.telemetry) }

  setSubscriptions(instIds, { books = true } = {}) {
    if (this.closed) throw new Error('Realtime public market is closed.')
    if (typeof books !== 'boolean') throw new TypeError('Book subscription demand must be a boolean.')
    const instruments = new Set()
    const next = new Map()
    if (this.options.instrumentsControl) {
      const value = { channel: 'instruments', instType: 'SWAP' }, key = keyFor(value)
      next.set(key, this.subscriptions.get(key) ?? value)
    }
    for (const instId of instIds) {
      if (typeof instId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(instId)) throw new TypeError('Invalid public market subscription.')
      instruments.add(instId)
      for (const channel of channels) {
        if (channel === 'books' && !books) continue
        const value = { instId, channel }, key = keyFor(value)
        next.set(key, this.subscriptions.get(key) ?? value)
      }
    }
    const removed = [...this.subscriptions].filter(([key, value]) => next.get(key) !== value && value.channel !== 'instruments')
    this.instruments = instruments
    this.subscriptions = next
    if (this.connection) for (const [, value] of removed) {
      this.invalidateSubscription(this.connection, value)
      this.connection.bookRecoveries.delete(value.instId)
    }
    for (const instId of this.books.keys()) if (!next.has(`books:${instId}`)) this.books.delete(instId)
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
    if (this.closed) throw new Error('Realtime public market is closed.')
    if (this.started) return
    this.started = true
    if (this.subscriptions.size) this.connect()
  }

  track(task) {
    this.tasks.add(task)
    task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  async whenIdle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]) }

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
    this.logger.error(`[RealtimePublicMarket] ${text}`, error ?? '')
    if (notify === true) this.setState({ error: text })
    else if (notify === false) this.state = { ...this.state, error: text }
    return text
  }

  connect() {
    if (this.closed || !this.started || !this.subscriptions.size || this.connection || this.scheduledConnect) return
    this.setState({ status: this.hasOpened || this.attempt ? 'reconnecting' : 'connecting' })
    let dispatched = false
    const request = this.options.scheduleConnect(() => {
      dispatched = true
      this.scheduledConnect = null
      this.openSocket()
    })
    this.scheduledConnect = dispatched ? null : request
  }

  openSocket() {
    if (this.closed || !this.subscriptions.size || this.connection) return
    let socket
    try { socket = this.factory(this.url) }
    catch (error) { this.scheduleReconnect(this.report('WebSocket connection failed.', error)); return }
    const connection = { socket, sent: new Map(), sessions: new Map(), pending: new Map(), unsubscribing: new Map(), bookRecoveries: new Map(), timers: new Map(), commands: [], commandId: 0, ingress: 0, controller: new AbortController(), ready: false, waitingForPong: false, retired: false, wasReconnect: this.hasOpened }
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
    if (socket.readyState === 1) this.opened(connection)
  }

  active(connection) { return this.connection === connection && !connection.retired && !this.closed }

  timer(connection, name, delay, callback) {
    this.clearConnectionTimer(connection, name)
    connection.timers.set(name, this.setTimer(() => { connection.timers.delete(name); callback() }, delay))
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
    this.books.clear()
    const priorRecovery = this.recoveryTail
    const priorCallbacks = [...this.tails.values()]
    connection.readyTask = this.track(Promise.resolve().then(async () => {
      if (connection.wasReconnect && this.options.onReconnect) {
        await priorRecovery
        await Promise.allSettled(priorCallbacks)
        const repaired = new Set()
        while (this.active(connection)) {
          const missing = [...this.instruments].filter(instId => !repaired.has(instId))
          if (!missing.length) break
          await this.options.onReconnect(missing, { signal: connection.controller.signal })
          missing.forEach(instId => repaired.add(instId))
        }
      }
      if (!this.active(connection)) return false
      connection.ready = true
      this.maybeLive(connection)
      return true
    }).catch(error => {
      if (this.active(connection)) this.lost(connection, 'Reconnect recovery failed.', error)
      else if (error?.name !== 'AbortError') this.report('Reconnect recovery failed.', error, 'log')
      return false
    }))
    this.recoveryTail = connection.readyTask
    this.flushSubscriptions(connection)
    this.armHeartbeat(connection)
  }

  flushSubscriptions(connection) {
    if (!this.active(connection) || !connection.opened || connection.socket.readyState !== 1) return
    this.clearConnectionTimer(connection, 'control')
    const due = value => value.channel !== 'books' || (connection.bookRecoveries.get(value.instId)?.retryAt ?? -Infinity) <= this.now()
    const removals = [...connection.sent].filter(([key, value]) => this.subscriptions.get(key) !== value || !connection.sessions.has(key))
    for (const [key, pending] of connection.unsubscribing) {
      if (pending.deadline === null && pending.retryAt <= this.now()) removals.push([key, pending.subscription])
    }
    // OKX: at most 480 control requests/hour and 64 KB/request. Four channels
    // per contract are batched across the entire universe, never polled in turn.
    for (const op of ['unsubscribe', 'subscribe']) {
      const entries = op === 'unsubscribe' ? removals
        : [...this.subscriptions].filter(([key, value]) => connection.sent.get(key) !== value && !connection.unsubscribing.has(key) && due(value))
      for (let index = 0; index < entries.length; index += 100) {
        const now = this.now()
        connection.commands = connection.commands.filter(time => time > now - hour)
        if (connection.commands.length >= 480) {
          this.timer(connection, 'control', Math.max(1, connection.commands[0] + hour - now), () => this.flushSubscriptions(connection))
          this.armAcknowledgement(connection)
          this.maybeLive(connection)
          return
        }
        const chunk = entries.slice(index, index + 100), id = String(++connection.commandId)
        for (const [key, value] of chunk) {
          const pending = { id, subscription: value, deadline: now + this.ackTimeoutMs }
          if (op === 'subscribe') {
            const controller = value.channel === 'books' ? new AbortController() : connection.controller
            connection.sessions.set(key, { controller, ingress: connection.ingress })
            connection.sent.set(key, value)
            connection.pending.set(key, pending)
          } else {
            pending.attempt = connection.unsubscribing.get(key)?.attempt ?? 0
            connection.sent.delete(key)
            connection.pending.delete(key)
            connection.unsubscribing.set(key, pending)
          }
        }
        try {
          connection.socket.send(JSON.stringify({ id, op, args: chunk.map(([, value]) => ({ ...value })) }))
          connection.commands.push(now)
        } catch (error) { this.lost(connection, 'WebSocket subscription failed.', error); return }
      }
    }
    const retries = [...connection.bookRecoveries].filter(([instId, recovery]) => {
      const key = `books:${instId}`
      return this.subscriptions.has(key) && !connection.sessions.has(key) && !connection.unsubscribing.has(key) && recovery.retryAt > this.now()
    }).map(([, recovery]) => recovery.retryAt)
    for (const pending of connection.unsubscribing.values()) if (pending.deadline === null && pending.retryAt > this.now()) retries.push(pending.retryAt)
    if (retries.length) this.timer(connection, 'control', Math.max(1, Math.min(...retries) - this.now()), () => this.flushSubscriptions(connection))
    this.armAcknowledgement(connection)
    this.maybeLive(connection)
  }

  armAcknowledgement(connection) {
    this.clearConnectionTimer(connection, 'ack')
    const pending = [...connection.pending.values(), ...connection.unsubscribing.values()].filter(value => value.deadline !== null)
    if (!pending.length) return
    const deadline = Math.min(...pending.map(value => value.deadline))
    this.timer(connection, 'ack', Math.max(1, deadline - this.now()), () => {
      const expired = pending.filter(value => value.deadline <= this.now())
      if (expired.some(value => value.subscription.channel !== 'books' && connection.pending.get(keyFor(value.subscription)) === value)) {
        this.lost(connection, 'Public market subscription acknowledgement timed out.')
        return
      }
      for (const value of expired) {
        const { instId } = value.subscription, key = keyFor(value.subscription)
        if (connection.unsubscribing.get(key) === value) {
          this.deferUnsubscription(value, `Public market unsubscribe acknowledgement timed out for ${key}.`)
        } else if (connection.pending.get(key) === value) this.recoverBook(connection, instId, `Order book subscribe acknowledgement timed out for ${instId}.`)
      }
      this.flushSubscriptions(connection)
    })
  }

  deferUnsubscription(pending, message) {
    pending.deadline = null
    const delay = Math.min(this.maxDelay, this.baseDelay * 2 ** Math.min(pending.attempt++, 30))
    pending.retryAt = this.now() + delay
    this.report(message)
  }

  invalidateSubscription(connection, subscription) {
    const key = keyFor(subscription), session = connection.sessions.get(key)
    connection.sessions.delete(key)
    connection.pending.delete(key)
    if (subscription.channel === 'books') this.books.delete(subscription.instId)
    try {
      const result = this.options.onUnsubscribed?.(subscription.instId, subscription.channel, { signal: session?.controller.signal ?? connection.controller.signal, receivedAt: this.now(), acknowledged: false })
      if (result?.then) this.track(Promise.resolve(result).catch(error => this.report('Unsubscription callback failed.', error)))
    } catch (error) { this.report('Unsubscription callback failed.', error) }
    if (subscription.channel === 'books') session?.controller.abort()
  }

  deferBookRecovery(connection, instId, message) {
    const previous = connection.bookRecoveries.get(instId)
    // Only a sustained healthy book resets backoff. ACKs and a snapshot followed
    // immediately by another corrupt update cannot create a tight retry loop.
    const stable = previous?.healthySince != null && this.now() - previous.healthySince >= this.maxDelay
    const attempt = !previous || stable ? 1 : previous.attempt + 1
    const delay = Math.min(this.maxDelay, this.baseDelay * 2 ** Math.min(attempt - 1, 30))
    connection.bookRecoveries.set(instId, { attempt, retryAt: this.now() + delay, healthySince: null })
    this.report(message)
  }

  recoverBook(connection, instId, message) {
    const key = `books:${instId}`, subscription = this.subscriptions.get(key)
    if (!this.active(connection) || !subscription || !connection.sessions.has(key)) return
    this.deferBookRecovery(connection, instId, message)
    this.invalidateSubscription(connection, subscription)
    this.flushSubscriptions(connection)
  }

  maybeLive(connection) {
    if (!this.active(connection)) return
    const live = connection.ready && !connection.pending.size && this.subscriptions.size > 0
      && [...this.subscriptions].every(([key, value]) => connection.sent.get(key) === value && connection.sessions.has(key))
    if (live) this.attempt = 0
    this.setState({ status: live ? 'live' : connection.wasReconnect ? 'reconnecting' : 'connecting', ...(live ? { error: '' } : {}) })
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
    const ingress = ++connection.ingress
    this.armHeartbeat(connection)
    const task = (connection.messageTail ?? Promise.resolve()).then(async () => {
      let text = data
      if (typeof data !== 'string') {
        if (data && typeof data.text === 'function') text = await data.text()
        else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) text = new TextDecoder().decode(data)
        else throw new TypeError('Unsupported WebSocket message data.')
      }
      if (this.active(connection)) this.consume(connection, text, receivedAt, ingress)
    }).catch(error => this.report('WebSocket message decoding failed.', error, this.active(connection) ? true : 'log'))
    connection.messageTail = task
    this.track(task)
  }

  consume(connection, text, receivedAt, ingress) {
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
      if (message.event === 'error' && message.id != null) {
        const errorKey = message.arg ? keyFor(message.arg) : null
        const pending = [...connection.pending.values(), ...connection.unsubscribing.values()].filter(value => value.id === message.id && value.deadline !== null
          && (errorKey === null || keyFor(value.subscription) === errorKey))
        if (!pending.length) return
        if (pending.every(value => value.subscription.channel === 'books' || connection.unsubscribing.get(keyFor(value.subscription)) === value)) {
          for (const value of pending) {
            const { instId } = value.subscription, key = keyFor(value.subscription)
            const detail = `OKX public market control failed for ${key} (${message.code ?? 'unknown'}): ${message.msg ?? 'No details.'}`
            if (connection.unsubscribing.get(key) === value) {
              this.deferUnsubscription(value, detail)
            } else this.recoverBook(connection, instId, detail)
          }
          this.flushSubscriptions(connection)
          return
        }
      }
      this.lost(connection, `OKX WebSocket ${message.event} (${message.code ?? 'unknown'}): ${message.msg ?? 'No details.'}`)
      return
    }
    const key = keyFor(message.arg ?? {})
    if (message.event === 'unsubscribe') {
      if (connection.unsubscribing.get(key)?.id !== message.id) return
      connection.unsubscribing.delete(key)
      this.flushSubscriptions(connection)
      return
    }
    const subscription = this.subscriptions.get(key)
    const session = connection.sessions.get(key)
    if (!subscription || connection.sent.get(key) !== subscription || !session) return
    if (message.event === 'subscribe') {
      if (connection.pending.get(key)?.id !== message.id) return
      connection.pending.delete(key)
      if (subscription.channel === 'instruments') {
        try {
          const result = this.options.onInstrumentsReady?.({ signal: connection.controller.signal, receivedAt })
          // A REST bootstrap can remain outstanding while deltas and market
          // events keep arriving. The consumer owns buffering during bootstrap.
          if (result?.then) this.track(Promise.resolve(result).catch(error => {
            if (this.active(connection)) this.report('Instruments readiness callback failed.', error)
            else if (error?.name !== 'AbortError') this.report('Instruments readiness callback failed.', error, 'log')
          }))
        } catch (error) { this.report('Instruments readiness callback failed.', error) }
      } else if (this.options.onSubscribed) {
        try {
          const result = this.options.onSubscribed(subscription.instId, subscription.channel, { signal: session.controller.signal, receivedAt, acknowledged: true })
          if (result?.then) this.track(Promise.resolve(result).catch(error => this.report('Subscription callback failed.', error)))
        } catch (error) { this.report('Subscription callback failed.', error) }
      }
      this.armAcknowledgement(connection)
      this.maybeLive(connection)
      return
    }
    if (message.event != null || ingress <= session.ingress) return
    // Book frames admitted before the ACK may belong to the retired wire
    // subscription. They can neither seed reconstruction nor fault a new book.
    if (subscription.channel === 'books') {
      if (connection.pending.has(key)) return
      if (!Array.isArray(message.data)) {
        this.telemetry.rejectedEvents++
        this.recoverBook(connection, subscription.instId, `Invalid OKX order book data for ${subscription.instId}.`)
        return
      }
    }
    if (Array.isArray(message.data)) this.enqueue(connection, subscription, session, message, receivedAt)
  }

  enqueue(connection, subscription, session, message, receivedAt) {
    this.telemetry.receivedEvents += message.data.length
    this.telemetry.lastReceivedAt = receivedAt
    this.telemetry.pendingEvents++
    const key = keyFor(subscription)
    const acknowledged = !connection.pending.has(key)
    const current = () => this.active(connection) && this.subscriptions.get(key) === subscription && connection.sessions.get(key) === session
    const task = (this.tails.get(key) ?? Promise.resolve()).then(async () => {
      if (!await connection.readyTask || !current()) return
      const context = { signal: session.controller.signal, receivedAt, acknowledged }
      const { instId, channel } = subscription
      if (channel === 'instruments') {
        await this.options.onInstruments(message.data, context)
      } else if (channel === 'trades') {
        await this.options.onTrades(instId, message.data, context)
        this.telemetry.tradeEvents += message.data.length
      } else for (const raw of message.data) {
        if (!current()) return
        if (channel === 'books') {
          const book = this.updateBook(connection, instId, message.action, raw)
          if (!book) continue
          await this.options.onBook(instId, book, context)
          this.telemetry.bookEvents++
        } else if (channel === 'tickers') {
          await this.options.onTicker(instId, raw, context)
          this.telemetry.tickerEvents++
        } else {
          await this.options.onOpenInterest(instId, raw, context)
          this.telemetry.openInterestEvents++
        }
      }
      this.setState({ updatedAt: Math.max(this.state.updatedAt ?? -Infinity, receivedAt), ...(this.state.status === 'live' ? { error: '' } : {}) })
    }).catch(error => this.report('Public market callback failed.', error, this.active(connection) ? true : 'log')).then(() => {
      this.telemetry.pendingEvents--
      if (this.tails.get(key) === task) this.tails.delete(key)
    })
    this.tails.set(key, task)
    this.track(task)
  }

  updateBook(connection, instId, action, raw) {
    const previous = this.books.get(instId)
    const seqId = raw?.seqId, prevSeqId = raw?.prevSeqId
    if (!['snapshot', 'update'].includes(action) || !Number.isSafeInteger(seqId) || seqId < 0 || typeof raw?.ts !== 'string' || !raw.ts.trim() || !Number.isFinite(Number(raw.ts)) || !Array.isArray(raw?.bids) || !Array.isArray(raw?.asks) || action === 'snapshot' && prevSeqId !== -1) {
      this.telemetry.rejectedEvents++
      this.recoverBook(connection, instId, `Invalid OKX order book for ${instId}.`)
      return null
    }
    if (action === 'update' && (!previous || !Number.isSafeInteger(prevSeqId) || prevSeqId !== previous.seqId || seqId < prevSeqId || seqId === prevSeqId && (raw.bids.length || raw.asks.length))) {
      this.telemetry.rejectedEvents++
      this.recoverBook(connection, instId, `Order book sequence gap or reset for ${instId}; requesting a fresh snapshot.`)
      return null
    }
    // A snapshot replaces every level. Incremental messages replace equal
    // prices, insert new ones, and remove a level when its size is zero.
    const book = action === 'snapshot' ? { bids: new Map(), asks: new Map(), seqId } : previous
    for (const side of ['bids', 'asks']) {
      let reorder = action === 'snapshot'
      for (const level of raw[side]) {
        const price = Number(level?.[0]), size = Number(level?.[1])
        if (!Array.isArray(level) || level.length < 2 || typeof level[0] !== 'string' || !level[0].trim() || typeof level[1] !== 'string' || !level[1].trim() || !Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) {
          this.telemetry.rejectedEvents++
          this.recoverBook(connection, instId, `Invalid OKX order book level for ${instId}.`)
          return null
        }
        if (size === 0) book[side].delete(price)
        else {
          // Map replacement/deletion preserves the established price order.
          // Only a new numeric price can change priority or exceed the depth.
          if (!book[side].has(price)) reorder = true
          // Published snapshots share resident levels. Install an immutable
          // copy so neither raw inputs nor a consumer can alter their values.
          book[side].set(price, Object.freeze([...level]))
        }
      }
      if (reorder) {
        const sorted = [...book[side]].sort((a, b) => side === 'bids' ? b[0] - a[0] : a[0] - b[0])
        book[side] = new Map(sorted.slice(0, 400))
      }
    }
    book.seqId = seqId
    this.books.set(instId, book)
    const recovery = connection.bookRecoveries.get(instId)
    if (recovery && recovery.healthySince === null) recovery.healthySince = this.now()
    return { bids: [...book.bids.values()], asks: [...book.asks.values()], ts: raw.ts, seqId }
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
    for (const session of connection.sessions.values()) session.controller.abort()
    connection.sessions.clear()
    if (this.options.instrumentsControl && this.options.onInstrumentsDisconnect) {
      try {
        const result = this.options.onInstrumentsDisconnect({ signal: connection.controller.signal, receivedAt: this.now() })
        if (result?.then) this.track(Promise.resolve(result).catch(error => this.report('Instruments disconnect callback failed.', error, 'log')))
      } catch (error) { this.report('Instruments disconnect callback failed.', error, 'log') }
    }
    if (this.options.onDisconnect) {
      try {
        const result = this.options.onDisconnect([...new Set([...connection.sent.values()].filter(value => value.channel !== 'instruments').map(value => value.instId))], { signal: connection.controller.signal })
        if (result?.then) this.track(Promise.resolve(result).catch(error => this.report('Disconnect callback failed.', error, 'log')))
      } catch (error) { this.report('Disconnect callback failed.', error, 'log') }
    }
    if (this.connection === connection) this.connection = null
    this.books.clear()
    for (const name of [...connection.timers.keys()]) this.clearConnectionTimer(connection, name)
    this.retirements.add(connection.done)
    connection.done.then(() => this.retirements.delete(connection.done))
    this.timer(connection, 'close', this.closeTimeoutMs, () => { this.report('WebSocket close handshake timed out.', undefined, 'log'); this.finishSocket(connection) })
    try {
      if (connection.socket.readyState === 3) this.finishSocket(connection)
      else connection.socket.close(1000, 'Realtime public market stopped.')
    } catch (error) { this.report('WebSocket shutdown failed.', error); this.finishSocket(connection) }
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
    this.closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.retirements])
      await this.whenIdle()
      this.books.clear()
      this.tails.clear()
    })
    this.closed = true
    if (this.scheduledConnect) this.scheduledConnect.cancelled = true
    this.cancelRetry()
    if (this.connection) this.retire(this.connection)
    this.setState({ status: 'disconnected' })
    return this.closePromise
  }
}

/**
 * OKX recommends fewer than 30 deep-book channels per connection. Keep 25
 * contracts (100 native subscriptions) on each independently recovering socket.
 * A shared 500 ms connection gate respects the 3 connections/second IP limit
 * while leaving capacity for the business/candle transport.
 */
export class RealtimePublicMarket {
  constructor(options) {
    for (const name of ['onTicker', 'onOpenInterest', 'onBook', 'onTrades']) {
      if (typeof options?.[name] !== 'function') throw new TypeError(`${name} must be a function.`)
    }
    this.options = options
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimeout ?? globalThis.setTimeout
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout
    this.shards = []
    this.retiring = new Map()
    this.tasks = new Set()
    this.instruments = new Set()
    this.subscriptions = new Map()
    this.retiredTelemetry = { receivedEvents: 0, tickerEvents: 0, openInterestEvents: 0, bookEvents: 0, tradeEvents: 0, ignoredEvents: 0, rejectedEvents: 0, reconnects: 0, pendingEvents: 0, lastReceivedAt: null }
    this.state = { status: 'disconnected', updatedAt: null, error: '' }
    this.queue = []
    this.gateTimer = null
    this.lastConnectAt = -Infinity
    this.started = false
    this.closed = false
    this.closePromise = null
    this.changing = false
    this.controlShard = null
    if (typeof options.onInstruments === 'function') {
      this.controlShard = this.makeShard(true)
      this.controlShard.setSubscriptions([])
      this.subscriptions = new Map(this.controlShard.subscriptions)
    }
  }

  scheduleConnect(callback) {
    const request = { callback, cancelled: false }
    this.queue.push(request)
    this.flushConnections()
    return request
  }

  flushConnections() {
    if (this.closed || this.gateTimer !== null) return
    this.queue = this.queue.filter(request => !request.cancelled)
    if (!this.queue.length) return
    const delay = Math.max(0, this.lastConnectAt + 500 - this.now())
    if (delay > 0) {
      this.gateTimer = this.setTimer(() => { this.gateTimer = null; this.flushConnections() }, delay)
      return
    }
    const request = this.queue.shift()
    this.lastConnectAt = this.now()
    request.callback()
    this.flushConnections()
  }

  makeShard(instrumentsControl = false) {
    const market = new PublicMarketConnection({ ...this.options, instrumentsControl, scheduleConnect: callback => this.scheduleConnect(callback), onState: () => this.publishState() })
    this.shards.push(market)
    return market
  }

  setSubscriptions(instIds, { books = true } = {}) {
    if (this.closed) throw new Error('Realtime public market is closed.')
    if (typeof books !== 'boolean') throw new TypeError('Book subscription demand must be a boolean.')
    const next = new Set(instIds)
    for (const instId of next) if (typeof instId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(instId)) throw new TypeError('Invalid public market subscription.')
    this.changing = true
    this.instruments = next
    const assigned = new Set()
    const allocations = this.shards.map(market => {
      const ids = [...market.instruments].filter(instId => next.has(instId))
      ids.forEach(instId => assigned.add(instId))
      return { market, ids }
    })
    for (const instId of next) {
      if (assigned.has(instId)) continue
      let allocation = allocations.find(value => value.ids.length < PUBLIC_MARKET_CONTRACTS_PER_CONNECTION)
      if (!allocation) { allocation = { market: this.makeShard(), ids: [] }; allocations.push(allocation) }
      allocation.ids.push(instId)
    }
    for (const { market, ids } of allocations) {
      market.setSubscriptions(ids, { books })
      if (!ids.length && market !== this.controlShard) {
        this.shards = this.shards.filter(value => value !== market)
        const closing = market.close().then(() => {
          this.addTelemetry(this.retiredTelemetry, market.getTelemetry())
          this.retiring.delete(market)
        })
        this.retiring.set(market, closing)
      } else if (this.started) market.start()
    }
    this.subscriptions = new Map(this.shards.flatMap(market => [...market.subscriptions]))
    this.changing = false
    this.publishState()
  }

  start() {
    if (this.closed) throw new Error('Realtime public market is closed.')
    if (this.started) return
    this.started = true
    this.changing = true
    for (const market of this.shards) market.start()
    this.changing = false
    this.publishState()
  }

  getState() { return copy(this.state) }

  addTelemetry(total, value) {
    for (const key of Object.keys(total)) {
      if (key === 'lastReceivedAt') total[key] = value[key] === null ? total[key] : Math.max(total[key] ?? -Infinity, value[key])
      else total[key] += value[key]
    }
    return total
  }

  getTelemetry() {
    const total = copy(this.retiredTelemetry)
    for (const market of [...this.shards, ...this.retiring.keys()]) this.addTelemetry(total, market.getTelemetry())
    return total
  }

  publishState() {
    if (this.changing) return
    const states = this.shards.map(market => market.getState())
    const status = this.closed || !states.length ? 'disconnected'
      : states.every(state => state.status === 'live') ? 'live'
        : states.some(state => state.status === 'reconnecting') ? 'reconnecting'
          : states.some(state => state.status === 'connecting') ? 'connecting' : 'disconnected'
    const updated = states.map(state => state.updatedAt).filter(value => value !== null)
    const next = { status, updatedAt: updated.length ? Math.max(this.state.updatedAt ?? -Infinity, ...updated) : this.state.updatedAt, error: states.find(state => state.error)?.error ?? '' }
    if (Object.keys(next).every(key => Object.is(next[key], this.state[key]))) return
    this.state = next
    try {
      const result = this.options.onState?.(copy(next))
      if (result?.then) {
        const task = Promise.resolve(result).catch(error => this.reportStateError(error))
        this.tasks.add(task)
        task.then(() => this.tasks.delete(task))
      }
    } catch (error) { this.reportStateError(error) }
  }

  reportStateError(error) { (this.options.logger ?? console).error('[RealtimePublicMarket] Connection state callback failed.', error) }

  async whenIdle() {
    while (true) {
      await Promise.all([...this.shards].map(market => market.whenIdle()))
      await Promise.allSettled([...this.retiring.values(), ...this.tasks])
      if (!this.tasks.size && !this.retiring.size && this.shards.every(market => !market.tasks.size)) return
    }
  }

  close() {
    if (this.closePromise) return this.closePromise
    const closing = []
    this.closePromise = Promise.resolve().then(async () => {
      await Promise.all(closing)
      await this.whenIdle()
    })
    this.closed = true
    if (this.gateTimer !== null) this.clearTimer(this.gateTimer)
    this.gateTimer = null
    this.queue = []
    for (const market of this.shards) closing.push(market.close())
    this.publishState()
    return this.closePromise
  }
}

hookOperationMethods(PublicMarketConnection.prototype, {
  consume: { category: 'cpu', name: 'market.websocket.decode', attributes: { stream: 'okx.public' } },
  updateBook: (_connection, instId, _action, raw) => ({ category: 'cpu', name: 'market.book.reconstruct', resource: instId,
    attributes: { bidLevels: raw?.bids?.length ?? 0, askLevels: raw?.asks?.length ?? 0 } }),
})
