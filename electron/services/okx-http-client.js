import { abortable } from './market-helpers.js'

const OKX_ORIGIN = 'https://www.okx.com/api/v5'
const RETRY_DELAYS = [1_000]
const REQUEST_PRIORITY = { background: 0, chartWarm: 0, prefetch: 1, statistics: 2, continuity: 2, foreground: 3, repair: 3, prepared: 3, interactive: 4 }
const REQUEST_LANE_INTERVALS = Object.freeze({ candles: 100, oi: 200, taker: 400, books: 50, instruments: 100, tickers: 100, openInterest: 100, market: 80 })
const instrumentRateLimit = name => name === 'oi' || name === 'taker'
const MAX_HTTP_REQUESTS = 24

const requestLaneFor = path => {
  if (path.includes('/rubik/stat/taker-volume-contract')) return 'taker'
  if (path.includes('/rubik/stat/contracts/open-interest-history')) return 'oi'
  if (path === '/market/books') return 'books'
  if (path === '/public/instruments') return 'instruments'
  if (path === '/market/tickers' || path === '/market/ticker') return 'tickers'
  if (path === '/public/open-interest') return 'openInterest'
  return path.includes('/market/candles') || path.includes('/market/history-candles') ? 'candles' : 'market'
}

class RetryAfterError extends Error {
  constructor(path, retryAfter, lane) {
    super(`OKX ${path} is rate limited.`)
    this.retryAfter = retryAfter
    this.lane = lane
  }
}

class RequestTimeoutError extends Error {
  constructor(path, timeout) {
    super(`OKX ${path} timed out after ${Math.ceil(timeout / 1_000)} seconds.`)
    this.name = 'RequestTimeoutError'
  }
}

const retryAfterDelay = value => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(RETRY_DELAYS[0], seconds * 1_000)
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(RETRY_DELAYS[0], timestamp - Date.now()) : undefined
}

const requestPriority = priority => REQUEST_PRIORITY[priority] ?? REQUEST_PRIORITY.foreground

function requestURL(path, parameters = {}) {
  const query = new URLSearchParams(Object.entries(parameters).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]))
  return `${OKX_ORIGIN}${path}?${query}`
}

class RequestHeap {
  constructor(compare) { this.compare = compare; this.items = []; this.positions = new Map() }
  peek() { return this.items[0] }
  swap(a, b) { const values = this.items, value = values[a]; values[a] = values[b]; values[b] = value; this.positions.set(values[a], a); this.positions.set(values[b], b) }
  up(index) { while (index) { const parent = (index - 1) >>> 1; if (this.compare(this.items[parent], this.items[index]) <= 0) break; this.swap(parent, index); index = parent } return index }
  down(index) { for (;;) { const left = index * 2 + 1, right = left + 1; let best = index; if (left < this.items.length && this.compare(this.items[left], this.items[best]) < 0) best = left; if (right < this.items.length && this.compare(this.items[right], this.items[best]) < 0) best = right; if (best === index) break; this.swap(index, best); index = best } }
  set(value) { let index = this.positions.get(value); if (index === undefined) { index = this.items.length; this.items.push(value); this.positions.set(value, index) } this.down(this.up(index)) }
  delete(value) { const index = this.positions.get(value); if (index === undefined) return false; const last = this.items.pop(); this.positions.delete(value); if (index < this.items.length) { this.items[index] = last; this.positions.set(last, index); this.down(this.up(index)) } return true }
}

// The score is linear in waiting time for 25 seconds, then constant. Within a
// priority, the oldest unsaturated request wins; saturated ties use admission
// order. Index only one candidate per bucket so a rate limit moves a bucket,
// not all its requests, between the ready and waiting indexes.
class RequestQueue {
  constructor(lane) {
    this.lane = lane; this.size = 0; this.sequence = 0; this.groups = new Map(); this.lastNow = -Infinity
    const young = (a, b) => a.young.peek().enqueuedAt - b.young.peek().enqueuedAt || a.young.peek().sequence - b.young.peek().sequence
    const mature = (a, b) => a.mature.peek().sequence - b.mature.peek().sequence
    const order = (a, b) => a.order.peek().sequence - b.order.peek().sequence
    const waiting = (a, b) => a.deadline - b.deadline || a.order.peek().sequence - b.order.peek().sequence
    this.young = Array.from({ length: 5 }, () => new RequestHeap(young))
    this.mature = Array.from({ length: 5 }, () => new RequestHeap(mature))
    this.order = Array.from({ length: 5 }, () => new RequestHeap(order))
    this.waiting = Array.from({ length: 5 }, () => new RequestHeap(waiting))
  }
  group(bucket, rank) {
    let groups = this.groups.get(bucket)
    if (!groups) { groups = new Map(); this.groups.set(bucket, groups) }
    let group = groups.get(rank)
    if (!group) {
      group = { bucket, rank, deadline: 0, young: new RequestHeap((a, b) => a.enqueuedAt - b.enqueuedAt || a.sequence - b.sequence),
        mature: new RequestHeap((a, b) => a.sequence - b.sequence), order: new RequestHeap((a, b) => a.sequence - b.sequence) }
      groups.set(rank, group)
    }
    return group
  }
  refresh(group, now) {
    const rank = group.rank
    this.young[rank].delete(group); this.mature[rank].delete(group); this.order[rank].delete(group); this.waiting[rank].delete(group)
    if (!group.order.peek()) {
      const groups = this.groups.get(group.bucket); groups.delete(rank); if (!groups.size) this.groups.delete(group.bucket)
      return
    }
    group.deadline = Math.max(group.bucket.nextAt, group.bucket.rateLimitedUntil)
    if (group.deadline > now) { this.waiting[rank].set(group); return }
    while (group.young.peek() && group.young.peek().enqueuedAt <= now - 25_000) {
      const request = group.young.peek(); group.young.delete(request); request.mature = true; group.mature.set(request)
    }
    if (group.young.peek()) this.young[rank].set(group)
    if (group.mature.peek()) this.mature[rank].set(group)
    this.order[rank].set(group)
  }
  prepare(now) {
    if (now < this.lastNow) {
      for (const groups of this.groups.values()) for (const group of groups.values()) {
        for (const request of [...group.mature.items]) if (request.enqueuedAt > now - 25_000) {
          group.mature.delete(request); request.mature = false; group.young.set(request)
        }
        this.refresh(group, now)
      }
    }
    this.lastNow = now
    for (let rank = 0; rank < 5; rank++) {
      while (this.waiting[rank].peek()?.deadline <= now) this.refresh(this.waiting[rank].peek(), now)
      while (this.young[rank].peek()?.young.peek().enqueuedAt <= now - 25_000) this.refresh(this.young[rank].peek(), now)
    }
  }
  add(request) {
    if (request.queueGroup) return this
    const now = Date.now(); this.prepare(now)
    request.enqueuedAt ??= now; request.sequence = ++this.sequence
    const rank = requestPriority(request.priority), group = this.group(request.bucket ?? this.lane, rank)
    request.queueGroup = group; request.mature = false; group.young.set(request); group.order.set(request); this.size++
    this.refresh(group, now)
    return this
  }
  delete(request) {
    const group = request.queueGroup
    if (!group) return false
    if (request.mature) group.mature.delete(request); else group.young.delete(request)
    group.order.delete(request); request.queueGroup = null; this.size--
    this.refresh(group, Date.now())
    return true
  }
  clear() { for (const groups of [...this.groups.values()]) for (const group of [...groups.values()]) for (const request of [...group.order.items]) this.delete(request) }
  has(request) { return Boolean(request.queueGroup) }
  reprioritize(request) {
    const group = request.queueGroup
    if (!group || requestPriority(request.priority) === group.rank) return
    const sequence = request.sequence, enqueuedAt = request.enqueuedAt
    this.delete(request); this.add(request); request.sequence = sequence; request.enqueuedAt = enqueuedAt
    const next = request.queueGroup
    next.order.set(request); (request.mature ? next.mature : next.young).set(request); this.refresh(next, Date.now())
  }
  bucketChanged(bucket) { const now = Date.now(); this.prepare(now); for (const group of this.groups.get(bucket)?.values() ?? []) this.refresh(group, now) }
  pick(allowMaintenance, now, fairness) {
    this.prepare(now)
    let selected = null, score = -Infinity
    for (let rank = allowMaintenance ? 0 : 3; rank < 5; rank++) {
      if (fairness && rank > 1) break
      const request = fairness ? this.order[rank].peek()?.order.peek() : this.mature[rank].peek()?.mature.peek() ?? this.young[rank].peek()?.young.peek()
      if (!request) continue
      const value = rank + Math.min(5, (now - request.enqueuedAt) / 5_000)
      if (!selected || (fairness ? request.sequence < selected.sequence : value > score || value === score && request.sequence < selected.sequence)) { selected = request; score = value }
    }
    return selected
  }
  delay(allowMaintenance, now) {
    this.prepare(now)
    let earliest = Infinity
    for (let rank = allowMaintenance ? 0 : 3; rank < 5; rank++) earliest = Math.min(earliest, this.waiting[rank].peek()?.deadline ?? Infinity)
    return earliest - now
  }
}

export function createRequestLanes() {
  return new Map(Object.entries(REQUEST_LANE_INTERVALS).map(([name, interval]) => {
    const lane = { name, interval, task: null, running: false, active: new Map(), buckets: new Map(), wake: null, nextAt: 0, rateLimitedUntil: 0,
      ...(instrumentRateLimit(name) ? { concurrency: 8 } : {}) }
    lane.queue = new RequestQueue(lane)
    return [name, lane]
  }))
}

export const okxHttpMethods = {
  requestLane(name) {
    const lane = this.requestLanes.get(name)
    if (!lane) throw new Error(`Unknown OKX request lane: ${name}`)
    return lane
  },

  requestBucket(lane, parameters) {
    if (!instrumentRateLimit(lane.name)) return lane
    // Both statistics endpoints meter IP + instrument, across all periods.
    const key = String(parameters?.instId ?? '')
    let bucket = lane.buckets.get(key)
    if (!bucket) {
      const now = Date.now()
      lane.bucketCursor ??= lane.buckets.entries()
      for (let count = 0; count < 4; count++) {
        const entry = lane.bucketCursor.next()
        if (entry.done) { lane.bucketCursor = null; break }
        const [id, value] = entry.value
        if (!value.pending && Math.max(value.nextAt, value.rateLimitedUntil) <= now) lane.buckets.delete(id)
      }
      bucket = { nextAt: 0, rateLimitedUntil: 0, pending: 0 }
      lane.buckets.set(key, bucket)
    }
    return bucket
  },

  wakeRequestQueues() { for (const lane of this.requestLanes.values()) lane.wake?.() },

  nextQueuedRequest(lane, allowMaintenance = true) {
    // Reserve service for interactive work while ageing maintenance instead
    // of starving an archive behind an endless stream of closes.
    const now = Date.now()
    let next = lane.queue.pick(allowMaintenance, now, false)
    if (!next) return null
    lane.served = (lane.served ?? 0) + 1
    if (lane.served % 8 === 0) {
      const background = lane.queue.pick(allowMaintenance, now, true)
      if (background) next = background
    }
    lane.queue.delete(next)
    return next
  },

  cleanupRequest(request) {
    if (request.cleaned) return
    request.cleaned = true
    this.shutdownController.signal.removeEventListener('abort', request.abort)
    request.requestSignal?.removeEventListener('abort', request.abort)
    request.controller.signal.removeEventListener('abort', request.onAbort)
    request.unsubscribePriority?.()
    this.abortControllers.delete(request.controller)
    if (request.bucket !== this.requestLane(request.lane)) request.bucket.pending -= 1
  },

  rejectQueuedRequest(request) {
    const lane = this.requestLane(request.lane)
    if (!lane.queue.delete(request)) return
    request.reject(request.controller.signal.reason ?? new Error('The request was aborted.'))
    this.cleanupRequest(request)
    lane.wake?.()
  },

  waitRequestLane(lane, delay) {
    return new Promise(resolve => {
      let timer
      const finish = () => {
        clearTimeout(timer)
        if (lane.wake === finish) lane.wake = null
        resolve()
      }
      lane.wake = finish
      if (delay !== undefined) timer = setTimeout(finish, delay)
    })
  },

  async performRequest(lane, request) {
    const startedAt = performance.now()
    try {
      if (this.disposed || request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('Market service is closed.')
      const timeout = setTimeout(() => request.controller.abort(new RequestTimeoutError(request.path, this.requestTimeout)), this.requestTimeout)
      timeout.unref?.()
      try {
        const data = await abortable(Promise.resolve().then(async () => {
          // A request can be preempted after its lane delay but before the
          // microtask that starts fetch. Do not let that race create a
          // network call which no active viewport can consume.
          if (request.controller.signal.aborted) throw request.controller.signal.reason ?? new Error('The request was aborted.')
          const url = requestURL(request.path, request.parameters), signal = request.controller.signal
          const response = await this.fetcher(url, { headers: { Accept: 'application/json' }, signal })
          if (signal.aborted) throw signal.reason ?? new Error('The request was aborted.')
          const serverDelay = retryAfterDelay(response.headers?.get('retry-after'))
          if (response.status === 429) {
            // Statistics cooling belongs to this instrument's bucket;
            // unrelated instruments retain their own published allowance.
            request.bucket.rateLimitedUntil = Math.max(request.bucket.rateLimitedUntil, Date.now() + (serverDelay ?? RETRY_DELAYS[0]))
            lane.queue.bucketChanged(request.bucket)
            if (!instrumentRateLimit(lane.name)) lane.concurrency = Math.max(2, Math.floor((lane.concurrency ?? 4) / 2))
            throw new RetryAfterError(request.path, serverDelay, lane.name)
          }
          if (!response.ok) {
            const error = new Error(`OKX ${request.path} failed (${response.status}).`)
            if (serverDelay !== undefined) {
              error.retryAfter = serverDelay
              request.bucket.rateLimitedUntil = Math.max(request.bucket.rateLimitedUntil, Date.now() + serverDelay)
              lane.queue.bucketChanged(request.bucket)
            }
            throw error
          }
          const payload = await response.json()
          if (signal.aborted) throw signal.reason ?? new Error('The request was aborted.')
          if (String(payload.code) === '50011') {
            request.bucket.rateLimitedUntil = Math.max(request.bucket.rateLimitedUntil, Date.now() + (serverDelay ?? RETRY_DELAYS[0]))
            lane.queue.bucketChanged(request.bucket)
            throw new RetryAfterError(request.path, serverDelay, lane.name)
          }
          if (payload.code && payload.code !== '0') throw new Error(`OKX ${request.path}: ${payload.msg || payload.code}`)
          const data = payload.data
          if (!Array.isArray(data)) throw new TypeError(`OKX ${request.path} response needs a data array.`)
          return data
        }), request.controller.signal)
        lane.latencyMS = lane.latencyMS === undefined ? performance.now() - startedAt : lane.latencyMS * 0.8 + (performance.now() - startedAt) * 0.2
        lane.completed = (lane.completed ?? 0) + 1
        if (lane.interval > 0) {
          if (!instrumentRateLimit(lane.name)) lane.concurrency = Math.max(2, Math.min(lane.name === 'books' ? 16 : 8, Math.ceil(lane.latencyMS / lane.interval) + 1))
          if (this.history?.sync.maxConcurrentPerSource.has(lane.name)) {
            this.history.sync.maxConcurrentPerSource.set(lane.name, lane.concurrency)
            this.history.sync.maxConcurrentTasks = Math.min(24, [...this.history.sync.maxConcurrentPerSource.values()].reduce((sum, count) => sum + count, 0))
          }
        }
        request.resolve(data)
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) { request.reject(error) }
    finally { this.cleanupRequest(request) }
  },

  async drainRequestLane(name) {
    const lane = this.requestLane(name)
    if (lane.running) return lane.task
    lane.running = true
    const task = (async () => {
      while (lane.queue.size || lane.active.size) {
        const limit = lane.concurrency ?? (name === 'books' ? 16 : 4)
        const maintenanceActive = [...lane.active.values()].filter(request => requestPriority(request.priority) < 3).length
        const globalMaintenance = [...this.activeRequests].filter(request => requestPriority(request.priority) < 3).length
        const allowMaintenance = maintenanceActive < Math.max(1, limit - 1) && globalMaintenance < MAX_HTTP_REQUESTS - 2
        const now = Date.now()
        const ready = lane.queue.pick(allowMaintenance, now, false)
        const delay = ready ? 0 : lane.queue.delay(allowMaintenance, now)
        const canStart = lane.active.size < limit && this.activeRequests.size < MAX_HTTP_REQUESTS && (ready || Number.isFinite(delay))
        if (!canStart) { await this.waitRequestLane(lane); continue }
        if (!ready) {
          await this.waitRequestLane(lane, Math.min(2_147_483_647, Math.max(1, delay))); continue
        }
        // Choose at admission time so newly queued chart/qualification work
        // passes downloads that were waiting for the endpoint's rate budget.
        const request = this.nextQueuedRequest(lane, allowMaintenance)
        if (!request) { await this.waitRequestLane(lane, 1); continue }
        request.bucket.nextAt = Date.now() + lane.interval
        lane.queue.bucketChanged(request.bucket)
        this.activeRequests.add(request)
        const active = this.performRequest(lane, request).finally(() => {
          lane.active.delete(active)
          this.activeRequests.delete(request)
          this.wakeRequestQueues()
        })
        lane.active.set(active, request)
      }
    })().finally(() => {
      lane.running = false
      if (lane.task === task) lane.task = null
      if (lane.queue.size) void this.drainRequestLane(name)
    })
    lane.task = task
    return task
  },

  drainRequestQueues() {
    return Promise.all([...this.requestLanes.keys()].map(name => this.drainRequestLane(name)))
  },

  get(path, parameters, requestSignal, priority = 'foreground', { getPriority, subscribePriority } = {}) {
    if (this.disposed) return Promise.reject(new Error('Market service is closed.'))
    if (requestSignal?.aborted) return Promise.reject(requestSignal.reason ?? Object.assign(new Error('The request was aborted.'), { name: 'AbortError' }))
    if (getPriority && typeof subscribePriority !== 'function') throw new TypeError('Dynamic request priorities require change notifications.')
    const lane = requestLaneFor(path)
    // Independent endpoint budgets reserve capacity for chart and Verify
    // requests. At most one download occupies a lane's concurrent slots.
    const controller = new AbortController()
    const abort = () => controller.abort(requestSignal?.aborted ? requestSignal.reason : this.shutdownController.signal.reason)
    this.shutdownController.signal.addEventListener('abort', abort, { once: true })
    requestSignal?.addEventListener('abort', abort, { once: true })
    this.abortControllers.add(controller)
    let resolveRequest, rejectRequest
    const result = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject })
    const queue = this.requestLane(lane)
    const bucket = this.requestBucket(queue, parameters)
    if (bucket !== queue) bucket.pending += 1
    const request = { path, parameters, requestSignal, get priority() { return getPriority?.() ?? priority }, lane, bucket, controller, abort, enqueuedAt: Date.now(), resolve: resolveRequest, reject: rejectRequest, cleaned: false, onAbort: null }
    request.onAbort = () => this.rejectQueuedRequest(request)
    controller.signal.addEventListener('abort', request.onAbort, { once: true })
    if (subscribePriority) {
      try {
        const unsubscribe = subscribePriority(() => { queue.queue.reprioritize(request); this.wakeRequestQueues() })
        if (typeof unsubscribe !== 'function') throw new TypeError('Priority subscriptions must return an unsubscribe function.')
        request.unsubscribePriority = unsubscribe
      } catch (error) { this.cleanupRequest(request); throw error }
    }
    if (controller.signal.aborted) {
      request.reject(controller.signal.reason ?? new Error('The request was aborted.'))
      this.cleanupRequest(request)
    }
    else {
      queue.queue.add(request)
      queue.wake?.()
      void this.drainRequestLane(lane)
    }
    return result
  },
}
