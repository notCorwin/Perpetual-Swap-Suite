import { DeadlineIndex } from './deadline-index.js'
import {
  FIVE_MINUTES, OBSERVATION_TTL, TICKER_BOOTSTRAP_MS, LIST_REMOVAL_DELAY_MS,
  liquidityConfigKey, requiredLiquiditySources, closedBoundary, abortable, number,
} from './market-helpers.js'

export const marketDeadlineMethods = {
  sourceError(source, error) {
    const owned = this.errorOwner && this.error === this.errorOwner.message
    if (error) {
      if (typeof error === 'object') this.handledSourceErrors.add(error)
      this.sourceErrors.set(source, { error, message: error instanceof Error ? error.message : String(error) })
    }
    else this.sourceErrors.delete(source)
    if (error || owned || !this.error) {
      this.errorOwner = [...this.sourceErrors.values()].at(-1) ?? null
      this.error = this.errorOwner?.message ?? ''
    }
    this.touchList()
  },

  clearTickerFault(instId) {
    let changed = this.tickerFaults.delete(instId)
    if (this.tickerFaults.has('*') && this.candidateIDs && [...this.candidateIDs].every(id => this.observationExpiry(this.tickerCache?.values.get(id), 'ticker', id) > Date.now())) changed = this.tickerFaults.delete('*') || changed
    if (!changed) return
    const error = [...this.tickerFaults.values()].at(-1)
    this.sourceError('tickers', error)
  },

  tickerSubscribed(instId, { signal, receivedAt }) {
    const subscription = this.publicRealtime.subscriptions.get(`tickers:${instId}`)
    if (!subscription || signal.aborted || !this.candidateIDs?.has(instId)) return
    this.markMarketDeadlineDirty(instId)
    this.cancelTickerRecovery(instId)
    this.tickerSubscriptions.set(instId, { signal, receivedAt, subscription, observation: null, faulted: false })
    this.capTickerAssessment(instId)
    this.tickerRecoveries.set(instId, { signal, subscription, retryAt: receivedAt + TICKER_BOOTSTRAP_MS, attempts: 0, task: null, controller: null })
    this.scheduleMarketDeadline()
  },

  tickerDisconnected(ids, { signal }) {
    for (const instId of ids) {
      const session = this.tickerSubscriptions.get(instId)
      if (!session || session.signal !== signal && !session.signal.aborted) continue
      this.markMarketDeadlineDirty(instId)
      this.tickerSubscriptions.delete(instId)
      this.cancelTickerRecovery(instId)
      this.capTickerAssessment(instId)
      this.queueStreamQualification(instId)
    }
    this.scheduleMarketDeadline()
  },

  capTickerAssessment(instId, tickerUpdate = false, tickerRecovery = false) {
    if (!this.prefs().liquidity.spread.enabled) return
    const now = Date.now(), assessed = this.catalogChecks.get(instId), published = this.catalog.get(instId)
    let changed = false
    for (const record of new Set([assessed, published])) {
      if (!record?.observations?.ticker) continue
      const expiry = this.observationExpiry(record.observations.ticker, 'ticker', instId)
      if (expiry >= record.expiresAt && expiry > now) continue
      const next = { ...record, expiresAt: Math.min(record.expiresAt, expiry),
        ...(expiry <= now ? { status: 'unknown', result: { ...record.result, eligible: false } } : {}) }
      if (record === assessed) this.catalogChecks.set(instId, next)
      if (record === published) this.catalog.set(instId, next)
      changed = true
    }
    if (changed) {
      // Source proof changes eligibility, never the desired collection universe.
      // In particular an unsubscribe callback must not re-enter subscriptions.
      if (this.catalog.has(instId) && !this.validCatalogEntry(this.catalog.get(instId), now)) {
        this.bufferListRemoval(published, now)
        this.catalog.delete(instId); this.catalogRevision++
        this.updateListedUniverse(now)
      }
      this.touchList()
    }
    if (tickerUpdate && !tickerRecovery) this.scheduleTickerDeadline(instId)
    else this.scheduleMarketDeadline()
  },

  cancelTickerRecovery(instId) {
    const recovery = this.tickerRecoveries.get(instId)
    this.tickerRecoveries.delete(instId)
    recovery?.controller?.abort()
  },

  tickerFault(instId, error) {
    const session = this.tickerSubscriptions.get(instId)
    if (!session || session.signal.aborted) return
    this.markMarketDeadlineDirty(instId)
    session.faulted = true
    this.tickerFaults.set(instId, error); this.sourceError('tickers', error)
    this.capTickerAssessment(instId)
    if (!this.tickerRecoveries.has(instId)) this.tickerRecoveries.set(instId, { signal: session.signal, subscription: session.subscription, retryAt: Date.now(), attempts: 0, task: null, controller: null })
    this.queueStreamQualification(instId)
    this.scheduleMarketDeadline()
  },

  async repairTicker(instId, recovery, priority = 'foreground') {
    if (recovery.task) return recovery.task
    if (this.closing || recovery.signal.aborted || !this.candidateIDs?.has(instId) || this.tickerRecoveries.get(instId) !== recovery) return
    if (this.publicRealtime.started && this.publicRealtime.subscriptions.has(`tickers:${instId}`)) {
      // A missing or invalid native source is repaired at its subscription.
      // ACK deadlines and the transport control budget own recovery cadence.
      // REST cannot certify that source or turn its failure into polling.
      recovery.retryAt = Infinity
      this.tickerFaults.set(instId, new Error(`Waiting for native ticker recovery for ${instId}.`))
      this.sourceError('tickers', this.tickerFaults.get(instId))
      this.publicRealtime.recoverSubscription(instId, 'tickers')
      return
    }
    const controller = new AbortController()
    recovery.controller = controller
    const signal = AbortSignal.any([recovery.signal, controller.signal, this.shutdownController.signal])
    const task = (async () => {
      try {
        const values = await this.get('/market/ticker', { instId }, signal, priority)
        signal.throwIfAborted()
        if (this.tickerRecoveries.get(instId) !== recovery || recovery.subscription !== this.publicRealtime.subscriptions.get(`tickers:${instId}`)) return
        const value = values?.find(value => value?.instId === instId)
        if (!this.validTicker(value)) throw new Error(`Missing or invalid ticker observation for ${instId}.`)
        const observations = this.observations.get(instId) ?? {}, previous = this.tickerCache?.values.get(instId)
        const timestamp = number(value.ts)
        if (previous?.sourceTimestamp != null && timestamp != null && timestamp < previous.sourceTimestamp) throw new Error(`Ticker recovery returned an older observation for ${instId}.`)
        const observedAt = Date.now(), observation = { value, source: 'rest', sourceTimestamp: timestamp, observedAt, expiresAt: observedAt + OBSERVATION_TTL }
        this.markMarketDeadlineDirty(instId)
        observations.ticker = observation; this.observations.set(instId, observations)
        this.tickerCache ??= { values: new Map(), observedAt: 0 }
        this.tickerCache.values.set(instId, observation)
        if (this.tickerSubscriptions.get(instId)?.signal === recovery.signal) {
          // HTTP supplies a bounded fallback, not proof that this native
          // channel recovered. Its actual expiry owns the next scoped repair.
          recovery.retryAt = observation.expiresAt; recovery.attempts = 0
        } else this.tickerRecoveries.delete(instId)
        this.clearTickerFault(instId)
        this.queueStreamQualification(instId)
      } catch (error) {
        if (signal.aborted || this.closing || this.tickerRecoveries.get(instId) !== recovery) return
        recovery.attempts++
        recovery.retryAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(recovery.attempts - 1, 5))
        this.tickerFaults.set(instId, error); this.sourceError('tickers', error)
      } finally {
        recovery.task = null; recovery.controller = null
        this.scheduleMarketDeadline()
      }
    })()
    recovery.task = task
    return task
  },

  async tickerObservation(instId, signal, priority) {
    const value = this.tickerCache?.values.get(instId)
    if (this.observationExpiry(value, 'ticker', instId) > Date.now()) return value
    // Active subscriptions own their native bootstrap deadline. One missing
    // contract cannot initiate another whole-universe HTTP snapshot.
    if (this.publicRealtime.started && this.publicRealtime.subscriptions.has(`tickers:${instId}`) && !this.tickerRecoveries.get(instId)?.task) throw new Error(`Waiting for native ticker data for ${instId}.`)
    let recovery = this.tickerRecoveries.get(instId)
    if (!recovery) {
      recovery = { signal: this.tickerSubscriptions.get(instId)?.signal ?? this.shutdownController.signal,
        subscription: this.publicRealtime.subscriptions.get(`tickers:${instId}`), retryAt: Date.now(), attempts: 0, task: null, controller: null }
      this.tickerRecoveries.set(instId, recovery)
    }
    if (recovery.attempts && recovery.retryAt > Date.now()) throw this.tickerFaults.get(instId) ?? new Error(`Ticker recovery is waiting for retry for ${instId}.`)
    await abortable(this.repairTicker(instId, recovery, priority), signal)
    const observation = this.tickerCache?.values.get(instId)
    if (this.observationExpiry(observation, 'ticker', instId) <= Date.now()) throw this.tickerFaults.get(instId) ?? new Error(`Missing ticker observation for ${instId}.`)
    return observation
  },

  // A bounded REST snapshot can periodically reassess an unqualified book
  // without maintaining a high-volume book stream or churning WS subscriptions.
  bookSampleInterval(record, config) {
    const checks = record?.result?.checks ?? []
    const depth = checks.find(check => check.key === 'depth')
    const slip = checks.find(check => check.key === 'slippage')
    const distances = []
    if (config.depth.enabled && depth?.status !== 'verified' && Number.isFinite(depth?.value) && depth.value >= 0 && config.depth.minUSDT > 0)
      distances.push(Math.max(0, 1 - depth.value / config.depth.minUSDT))
    if (config.slippage.enabled && slip?.status === 'failed' && Number.isFinite(slip.value) && config.slippage.maxPercent > 0)
      distances.push(Math.max(0, slip.value / config.slippage.maxPercent - 1))
    if (!distances.length) return null
    const distance = Math.max(...distances)
    return distance < 0.1 ? 30_000 : distance < 0.5 ? 60_000 : distance < 1 ? 120_000 : 300_000
  },

  scheduleBookSamples() {
    if (this.bookSampleTimer) clearTimeout(this.bookSampleTimer)
    this.bookSampleTimer = null
    if (this.closing || this.disposed) return
    const next = Math.min(...[...this.bookSamples.values()].filter(value => !value.pending).map(value => value.next))
    if (!Number.isFinite(next)) return
    this.bookSampleTimer = setTimeout(() => {
      this.bookSampleTimer = null
      for (const [id, sample] of this.bookSamples) if (!sample.pending && sample.next <= Date.now()) this.sampleBook(id, sample)
      this.scheduleBookSamples()
    }, Math.max(1, next - Date.now()))
    this.bookSampleTimer.unref?.()
  },

  sampleBook(instId, sample) {
    const instrument = this.instruments.get(instId), config = this.prefs().liquidity, configKey = liquidityConfigKey(config)
    if (!instrument || !this.candidateIDs?.has(instId) || sample.configKey !== configKey) {
      this.bookSamples.delete(instId); this.sourceError?.(`${instId}:book`, null); this.scheduleSubscriptions(); return
    }
    // Wait until retirement has completed, including transport reconciliation.
    if (this.publicRealtime?.subscriptions.has(`books:${instId}`)) {
      sample.next = Date.now() + 1_000
      return
    }
    sample.pending = true
    // Do not renew a sample from the 90-second shared snapshot cache.
    this.books.expire(instId)
    const task = this.books.observe(instId, this.shutdownController.signal, 'background').then(observation => {
      if (this.closing || this.bookSamples.get(instId) !== sample || !this.currentCandidate(instrument, configKey, this.shutdownController.signal)) return
      this.sourceError(`${instId}:book`, null)
      this.acceptObservation(instId, 'book', observation)
      const input = this.liquidityInput(instrument, config, this.observations.get(instId))
      const result = this.evaluateLiquidity(input)
      const interval = this.bookSampleInterval({ result }, config)
      const complete = ['depth', 'slippage'].every(key => !config[key].enabled || result.checks.some(check => check.key === key && check.status === 'verified'))
      if (complete) this.bookSamples.delete(instId)
      else sample.next = Date.now() + (interval ?? 30_000)
      this.publishStreamRecords([this.observedCandidate(instrument, config, configKey, this.observations.get(instId), {}, Date.now(), result)])
      if (complete) this.scheduleSubscriptions()
    }).catch(error => {
      if (!this.closing && this.bookSamples.get(instId) === sample) {
        sample.next = Date.now() + 30_000
        this.sourceError(`${instId}:book`, error)
      }
    }).finally(() => { sample.pending = false; this.scheduleBookSamples() })
    this.track(task)
  },

  markMarketDeadlineDirty(instId) {
    this.marketDeadlineDirty.set(instId, ++this.marketDeadlineRevision)
    this.subscriptionDirty.add(instId)
  },

  deadlineForInstrument(instId, now, configKey, required, continuousMetadata) {
    const entry = this.catalog.get(instId), values = [entry?.expiresAt, this.catalogEntryExpiry(entry, now)]
    if (!continuousMetadata || !this.candidateIDs?.has(instId)) values.push(this.instrumentObservations.get(instId)?.expiresAt)
    const observations = this.observations.get(instId) ?? {}
    const assessed = this.catalogChecks.get(instId)?.observations ?? {}
    for (const key of required) values.push(this.observationExpiry(observations[key], key, instId), this.observationExpiry(assessed[key], key, instId),
      this.qualificationExpiry(observations[key], key, instId, configKey, now), this.qualificationExpiry(assessed[key], key, instId, configKey, now))
    const future = values.filter(value => Number.isSafeInteger(value) && value > now && value < Number.MAX_SAFE_INTEGER)
    return future.length ? Math.min(...future) : undefined
  },

  deadlineState(now, configKey, ids, continuousMetadata) {
    const realtime = this.realtime, connection = realtime?.connection
    return { now, configKey, ids, boundary: closedBoundary('5m', now), candidates: this.candidateIDs,
      candidateCount: this.candidateIDs?.size, catalog: this.catalog, catalogSize: this.catalog.size,
      checks: this.catalogChecks, checkCount: this.catalogChecks.size, stream: this.instrumentStream, continuousMetadata,
      historicalAssessments: this.historicalAssessments,
      realtime, connection, subscriptions: realtime?.subscriptions, connectionOpened: connection?.opened,
      connectionRetired: connection?.retired, socketState: connection?.socket?.readyState,
      pendingSubscriptions: connection?.pending?.size, sentSubscriptions: connection?.sent?.size,
      tickerRecoveries: this.tickerRecoveries.size, sourceRecoveries: this.sourceRecoveries.size,
      candleWaits: this.candleWaits.size, listRemovals: this.listRemovals.size, bookRetirements: this.bookRetirements.size }
  },

  scheduleTickerDeadline(instId) {
    if (this.closing || this.disposed || this.processingMarketDeadline) return
    const now = Date.now()
    // Once due, the existing callback owns its captured set of deadlines.
    if (this.marketDeadlineTimer && this.marketDeadlineAt <= now) return
    const previous = this.marketDeadlineState
    if (!previous || !previous.indexUsable || !this.marketDeadlineTimer || now < previous.now) return this.scheduleMarketDeadline()
    const config = this.prefs().liquidity, configKey = liquidityConfigKey(config)
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted
    const realtime = this.realtime, connection = realtime?.connection
    if (previous.configKey !== configKey || previous.boundary !== closedBoundary('5m', now)
      || previous.candidates !== this.candidateIDs || previous.candidateCount !== this.candidateIDs?.size
      || previous.catalog !== this.catalog || previous.catalogSize !== this.catalog.size
      || previous.checks !== this.catalogChecks || previous.checkCount !== this.catalogChecks.size
      || previous.stream !== this.instrumentStream || previous.continuousMetadata !== continuousMetadata
      || previous.historicalAssessments !== this.historicalAssessments
      || previous.realtime !== realtime || previous.connection !== connection || previous.subscriptions !== realtime?.subscriptions
      || previous.connectionOpened !== connection?.opened || previous.connectionRetired !== connection?.retired
      || previous.socketState !== connection?.socket?.readyState || previous.pendingSubscriptions !== connection?.pending?.size
      || previous.sentSubscriptions !== connection?.sent?.size
      || previous.tickerRecoveries !== this.tickerRecoveries.size || previous.sourceRecoveries !== this.sourceRecoveries.size
      || previous.candleWaits !== this.candleWaits.size || previous.listRemovals !== this.listRemovals.size
      || previous.bookRetirements !== this.bookRetirements.size) return this.scheduleMarketDeadline()
    const dirtyRevision = this.marketDeadlineRevision, dirty = new Map(this.marketDeadlineDirty)
    if (!dirty.has(instId)) dirty.set(instId, undefined)
    const changes = [], required = requiredLiquiditySources(config)
    for (const [id, revision] of dirty) {
      const member = this.catalogChecks.has(id) || this.catalog.has(id)
      if (previous.ids.has(id) !== member) return this.scheduleMarketDeadline()
      const next = member ? this.deadlineForInstrument(id, now, configKey, required, continuousMetadata) : undefined
      const entry = this.catalog.get(id), expiry = entry && this.catalogEntryExpiry(entry, now)
      const removal = entry && expiry <= now && expiry + LIST_REMOVAL_DELAY_MS > now ? expiry + LIST_REMOVAL_DELAY_MS : undefined
      if (removal !== undefined && (!Number.isSafeInteger(removal) || removal < 0)) return this.scheduleMarketDeadline()
      changes.push({ id, revision, next, removal })
    }
    // A synchronous observer can mutate a source during deadline calculation.
    if (this.marketDeadlineRevision !== dirtyRevision || changes.some(({ id, revision }) => this.marketDeadlineDirty.get(id) !== revision)) return this.scheduleMarketDeadline()
    for (const { id, revision, next, removal } of changes) {
      if (next === undefined) { this.marketDeadlines.delete(id); this.marketDeadlineIndex.delete(id) }
      else { this.marketDeadlines.set(id, next); this.marketDeadlineIndex.set(id, next) }
      if (removal === undefined) this.marketRemovalIndex.delete(id); else this.marketRemovalIndex.set(id, removal)
      if (this.marketDeadlineDirty.get(id) === revision) this.marketDeadlineDirty.delete(id)
    }
    previous.now = now
    const earliest = Math.min(previous.ids.size ? previous.boundary + FIVE_MINUTES : Infinity,
      this.marketDeadlineIndex.peek()?.deadline ?? Infinity, this.marketRemovalIndex.peek()?.deadline ?? Infinity, previous.pendingDeadline)
    if (earliest !== this.marketDeadlineAt) {
      clearTimeout(this.marketDeadlineTimer)
      this.marketDeadlineAt = Number.isFinite(earliest) ? earliest : null
      this.marketDeadlineTimer = this.marketDeadlineAt === null ? null : setTimeout(() => this.processMarketDeadline(), Math.min(2_147_483_647, Math.max(1, earliest - now)))
      this.marketDeadlineTimer?.unref?.()
    }
  },

  scheduleMarketDeadline() {
    if (this.closing || this.disposed || this.processingMarketDeadline) return
    for (const recovery of this.sourceRecoveries.values()) if (!this.requiredRecoveryCurrent(recovery)) this.cancelRequiredRecovery(recovery.key)
    const now = Date.now()
    // A due callback owns the captured deadlines even if another observation
    // arrives before the timer gets its event-loop turn.
    if (this.marketDeadlineTimer && this.marketDeadlineAt <= now) return
    const dirty = new Map(this.marketDeadlineDirty)
    const config = this.prefs().liquidity, configKey = liquidityConfigKey(config), required = requiredLiquiditySources(config)
    const ids = new Set([...this.catalogChecks.keys(), ...this.catalog.keys()]), deadlines = new Map()
    const indexedRemovals = []
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted
    for (const instId of ids) {
      const deadline = this.deadlineForInstrument(instId, now, configKey, required, continuousMetadata)
      if (deadline !== undefined) deadlines.set(instId, deadline)
    }
    this.marketDeadlines = deadlines
    this.marketDeadlineState = this.deadlineState(now, configKey, ids, continuousMetadata)
    for (const [id, revision] of dirty) if (this.marketDeadlineDirty.get(id) === revision) this.marketDeadlineDirty.delete(id)
    const boundary = ids.size ? closedBoundary('5m', now) + FIVE_MINUTES : Infinity
    const tickerRetries = [...this.tickerRecoveries].filter(([id, value]) => this.candidateIDs?.has(id) && !value.signal.aborted && !value.task).map(([, value]) => value.retryAt)
    const sourceRetries = [...this.sourceRecoveries.values()].filter(value => !value.task).map(value => value.retryAt)
    const candleDeadlines = [...this.candleWaits.values()].map(wait => wait.deadline)
    const removalDeadlines = [...this.listRemovals.values()].map(removal => removal.removeAt)
    removalDeadlines.push(...this.bookRetirements.values())
    let indexUsable = true
    for (const [instId, entry] of this.catalog) {
      const expiry = this.catalogEntryExpiry(entry, now)
      if (expiry <= now && expiry + LIST_REMOVAL_DELAY_MS > now) {
        const removal = expiry + LIST_REMOVAL_DELAY_MS
        removalDeadlines.push(removal)
        if (Number.isSafeInteger(removal) && removal >= 0) indexedRemovals.push([instId, removal])
        else indexUsable = false
      }
    }
    this.marketDeadlineIndex = new DeadlineIndex(deadlines)
    this.marketRemovalIndex = new DeadlineIndex(indexedRemovals)
    this.marketDeadlineState.indexUsable = indexUsable
    // Pending work is reconciled whenever its owning state changes. Its
    // earliest deadline is independent of ticker lease updates.
    const pendingDeadline = Math.min(...tickerRetries, ...sourceRetries, ...candleDeadlines,
      ...[...this.listRemovals.values()].map(removal => removal.removeAt), ...this.bookRetirements.values())
    this.marketDeadlineState.pendingDeadline = pendingDeadline
    const next = Math.min(boundary, ...deadlines.values(), ...removalDeadlines, pendingDeadline)
    if (this.marketDeadlineAt === next) return
    if (this.marketDeadlineTimer) clearTimeout(this.marketDeadlineTimer)
    this.marketDeadlineTimer = null
    this.marketDeadlineAt = Number.isFinite(next) ? next : null
    if (this.marketDeadlineAt === null) return
    this.marketDeadlineTimer = setTimeout(() => this.processMarketDeadline(), Math.min(2_147_483_647, Math.max(1, next - now)))
    this.marketDeadlineTimer.unref?.()
  },

  processMarketDeadline() {
    if (this.marketDeadlineTimer) clearTimeout(this.marketDeadlineTimer)
    this.marketDeadlineTimer = null; this.marketDeadlineAt = null
    if (this.closing || this.disposed) return
    this.processingMarketDeadline = true
    try {
      this.checkCandleWaits()
      const now = Date.now(), asOf = closedBoundary('5m', now)
      // A deadline may disappear and later return. Catalog order, rather than
      // the Map's reinsertion order, determines processing of tied deadlines.
      const due = new Set()
      for (const instId of this.marketDeadlineState?.ids ?? this.marketDeadlines.keys()) if (this.marketDeadlines.get(instId) <= now) due.add(instId)
      if (asOf !== this.marketBoundary) {
        this.marketBoundary = asOf
        this.touchList()
        for (const instId of this.catalogChecks.keys()) this.scheduleQualification(instId)
      }
      // A worker can still own an earlier immutable observation. Its published
      // lease expires independently of newer raw source observations.
      this.pruneCatalog()
      let removed = false
      for (const [instId, removal] of this.listRemovals) if (removal.removeAt <= now) { this.listRemovals.delete(instId); removed = true }
      if (removed) { this.touchList(); this.updateListedUniverse(now) }
      for (const instId of due) {
        const record = this.catalogChecks.get(instId)
        if (record && !this.validCatalogEntry(record, now)) this.catalogChecks.set(instId, { ...record, status: 'unknown', result: { ...record.result, eligible: false }, expiresAt: now })
        this.streamQualifications.add(instId)
        this.scheduleQualification(instId)
        this.recoverRequiredSources(instId)
      }
      if (due.size) { this.flushStreamQualifications(); this.touchList() }
      for (const instId of due) {
        const ticker = this.tickerCache?.values.get(instId), session = this.tickerSubscriptions.get(instId)
        if (this.prefs().liquidity.spread.enabled && session && !session.signal.aborted && this.observationExpiry(ticker, 'ticker', instId) <= now && !this.tickerRecoveries.has(instId)) {
          this.tickerRecoveries.set(instId, { signal: session.signal, subscription: session.subscription, retryAt: now, attempts: 0, task: null, controller: null })
        }
      }
      for (const [instId, recovery] of this.tickerRecoveries) if (!recovery.task && recovery.retryAt <= now) this.track(this.repairTicker(instId, recovery))
      for (const recovery of this.sourceRecoveries.values()) if (!recovery.task && recovery.retryAt <= now) this.track(this.repairRequiredSource(recovery))
      if ([...this.bookRetirements.values()].some(deadline => deadline <= now)) this.scheduleSubscriptions()
    } finally {
      this.processingMarketDeadline = false
      this.scheduleMarketDeadline()
    }
  },

  recoverRequiredSources(instId) {
    if (!this.autoRefresh || this.closing || !this.candidateIDs?.has(instId)) return
    const config = this.prefs().liquidity, observations = this.observations.get(instId) ?? {}
    if (this.cheapLiquidity(this.liquidityInput(this.instruments.get(instId), config, observations)).status === 'failed') {
      for (const source of ['book', 'openInterest', 'turnover', 'hourly']) this.cancelRequiredRecovery(`${instId}:${source}`)
      return
    }
    const awaitingInterest = config.openInterest.enabled && !this.observation(observations, 'openInterest')
    const awaitingTicker = config.spread.enabled && !this.observation(observations, 'ticker')
    for (const source of ['book', 'openInterest', 'turnover', 'hourly']) {
      const enabled = source === 'book' ? config.depth.enabled || config.slippage.enabled
        : source === 'openInterest' ? config.openInterest.enabled : source === 'turnover' ? config.volume24h.enabled : config.volumeStability.enabled
      const key = `${instId}:${source}`
      if (source === 'book' && this.publicRealtime?.started && !this.publicRealtime.subscriptions.has(`books:${instId}`)) { this.cancelRequiredRecovery(key); continue }
      // Recovery obeys the same cheap-source gate as discovery. Native ticks
      // arriving while bulk OI is pending cannot fan out historical work.
      if (!enabled || source !== 'openInterest' && (awaitingInterest || awaitingTicker) || this.observation(observations, source)) { this.cancelRequiredRecovery(key); continue }
      if (!this.sourceRecoveries.has(key)) this.sourceRecoveries.set(key, { key, instId, source, attempts: 0,
        retryAt: Math.max(Date.now(), source === 'openInterest' ? this.openInterest.retryAt : source === 'book' && this.publicRealtime?.started ? this.nativeBookDeadlines.get(instId) ?? 0 : 0), task: null, controller: new AbortController() })
    }
    this.scheduleMarketDeadline()
  },

  requiredRecoveryCurrent(recovery) {
    if (!this.candidateIDs?.has(recovery.instId)) return false
    const config = this.prefs().liquidity
    const enabled = recovery.source === 'book' ? config.depth.enabled || config.slippage.enabled
      : recovery.source === 'openInterest' ? config.openInterest.enabled : recovery.source === 'turnover' ? config.volume24h.enabled : config.volumeStability.enabled
    return enabled && !this.observation(this.observations.get(recovery.instId) ?? {}, recovery.source)
  },

  cancelRequiredRecovery(key) {
    const recovery = this.sourceRecoveries.get(key)
    if (!recovery) return
    this.sourceRecoveries.delete(key)
    recovery.controller?.abort()
    this.sourceError(key, null)
  },

  async repairRequiredSource(recovery) {
    if (recovery.task || this.closing || this.sourceRecoveries.get(recovery.key) !== recovery) return
    if (!this.requiredRecoveryCurrent(recovery)) { this.cancelRequiredRecovery(recovery.key); return }
    if (recovery.source === 'book' && this.publicRealtime?.started) {
      this.publicRealtime.recoverSubscription(recovery.instId, 'books')
      recovery.retryAt = Date.now() + 30_000
      return
    }
    const requestedAt = Date.now(), signal = AbortSignal.any([this.shutdownController.signal, recovery.controller.signal])
    const task = (async () => {
      try {
        if (recovery.source === 'turnover' || recovery.source === 'hourly') {
          const observations = this.observations.get(recovery.instId) ?? {}
          this.markMarketDeadlineDirty(recovery.instId)
          this.observations.set(recovery.instId, observations)
          await this.observeHistoricalSource(recovery.instId, recovery.source, observations, signal, true,
            () => !this.closing && this.sourceRecoveries.get(recovery.key) === recovery && this.requiredRecoveryCurrent(recovery), recovery)
          if (signal.aborted || this.sourceRecoveries.get(recovery.key) !== recovery) return
          if (!this.requiredRecoveryCurrent(recovery) && !this.observation(this.observations.get(recovery.instId) ?? {}, recovery.source)) { this.cancelRequiredRecovery(recovery.key); return }
          if (!this.observation(this.observations.get(recovery.instId) ?? {}, recovery.source)) throw new Error(`The completed ${recovery.source} range is not available.`)
          this.cancelRequiredRecovery(recovery.key)
          // Source availability is independent of the other qualification
          // criteria, including a known spread rejection or an in-flight check.
          this.queueStreamQualification(recovery.instId)
          return
        }
        const observation = recovery.source === 'book'
          ? await this.bookObservation(recovery.instId, signal, 'continuity')
          : (await this.openInterest.observe(signal, 'continuity')).get(recovery.instId)
        if (!observation) throw new Error(`Missing ${recovery.source} observation for ${recovery.instId}.`)
        if (this.closing || signal.aborted || this.sourceRecoveries.get(recovery.key) !== recovery) return
        const observations = this.observations.get(recovery.instId) ?? {}
        const previous = observations[recovery.source]
        const previousTimestamp = number(previous?.sourceTimestamp ?? previous?.value?.ts)
        const sourceTimestamp = number(observation.sourceTimestamp ?? observation.value?.ts)
        if (previousTimestamp !== null && sourceTimestamp !== null && sourceTimestamp < previousTimestamp) throw new Error(`${recovery.source} recovery returned an older observation for ${recovery.instId}.`)
        if (!previous || previous.observedAt < requestedAt) {
          this.markMarketDeadlineDirty(recovery.instId)
          observations[recovery.source] = { ...observation, sourceTimestamp }
        }
        this.observations.set(recovery.instId, observations)
        this.sourceRecoveries.delete(recovery.key)
        this.sourceError(recovery.key, null)
        this.queueStreamQualification(recovery.instId)
      } catch (error) {
        if (!signal.aborted && this.sourceRecoveries.get(recovery.key) === recovery) {
          recovery.retryAt = Math.max(Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(5, recovery.attempts++)),
            recovery.source === 'openInterest' ? this.openInterest.retryAt : 0)
          this.sourceError(recovery.key, error)
        }
      }
    })().finally(() => { recovery.task = null; this.scheduleMarketDeadline() })
    recovery.task = task
    return task
  },
}
