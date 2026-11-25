import { eligibleInstrument } from './liquidity.js'
import { compareRanking } from './ranking.js'
import { signedRelativeChange } from './market-metrics.js'
import {
  FIVE_MINUTES, CHART_TIMEFRAMES, OBSERVATION_TTL, LIST_REMOVAL_DELAY_MS,
  liquidityConfigKey, requiredLiquiditySources, closedBoundary, abortable, sharedWait, number,
} from './market-helpers.js'

export const marketCatalogMethods = {
  validCatalogEntry(entry, now = Date.now()) {
    return Boolean(entry?.instrument?.instId && entry.ticker && entry.result?.eligible && entry.status === 'verified'
      && entry.configKey === this.catalogCriteriaKey() && Number.isSafeInteger(entry.expiresAt) && this.catalogEntryExpiry(entry, now) > now)
  },

  catalogEntryExpiry(entry, now = Date.now()) {
    if (!entry || entry.expiresAt > now) return entry?.expiresAt ?? 0
    const instId = entry.instrument.instId, observations = entry.observations ?? {}
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted && this.candidateIDs?.has(instId)
    const metadataExpiry = continuousMetadata ? Number.MAX_SAFE_INTEGER : entry.instrumentObservation?.expiresAt ?? 0
    const required = requiredLiquiditySources(this.prefs().liquidity)
    const originalExpiry = Math.min(metadataExpiry, ...required.map(key => this.observationExpiry(observations[key], key, instId)))
    // Only a source's ordinary close can enter rollover. Explicit revocation
    // of an assessment must never be replaced by a longer source lease.
    if (entry.expiresAt !== originalExpiry) return entry.expiresAt
    return Math.min(metadataExpiry, ...required.map(key => this.qualificationExpiry(observations[key], key, instId, entry.configKey, now)))
  },

  readCatalog() {
    const entries = this.metadata.listCatalogEntries()
    for (const entry of entries) {
      // Live metadata continuity belongs to one socket session. A checkpoint
      // can restore only its original bounded REST/metadata observation lease.
      if (entry.instrumentObservation) entry.expiresAt = Math.min(entry.expiresAt, entry.instrumentObservation.expiresAt)
      if (this.prefs().liquidity.spread.enabled) entry.expiresAt = Math.min(entry.expiresAt, entry.observations?.ticker?.expiresAt ?? 0)
      if (entry.instrument?.instId) {
        this.instruments.set(entry.instrument.instId, entry.instrument)
        if (entry.instrumentObservation) { this.markMarketDeadlineDirty(entry.instrument.instId); this.instrumentObservations.set(entry.instrument.instId, entry.instrumentObservation) }
      }
      if (entry.observations) { this.markMarketDeadlineDirty(entry.instrumentID); this.observations.set(entry.instrumentID, entry.observations) }
      if (entry.configKey === this.catalogCriteriaKey()) {
        this.catalogChecks.set(entry.instrumentID, entry)
        if (entry.status === 'verified' || entry.renewalTarget === true) this.renewalTargets.set(entry.instrumentID, entry.instrument)
      }
    }
    const valid = entries.filter(entry => this.validCatalogEntry(entry))
    if (!valid.length) return false
    this.catalogSource = 'cache'
    this.catalogUpdatedAt = Math.max(...valid.map(entry => entry.observedAt))
    this.replaceCatalog(valid)
    return true
  },

  async restoreCatalog() { await this.ready; return this.readCatalog() },

  async persistCatalog(entries, savedAt = Date.now()) {
    await this.ready
    for (const entry of entries) this.metadata.putCatalogEntry(this.catalogRecord(entry, savedAt))
  },

  catalogRecord(entry, timestamp = Date.now()) {
    const configKey = entry.configKey ?? this.catalogCriteriaKey()
    return { ...entry, instrumentID: entry.instrument.instId, schemaVersion: 1,
      status: entry.status ?? (entry.result?.eligible ? 'verified' : 'failed'),
      observedAt: entry.observedAt ?? timestamp, expiresAt: entry.expiresAt ?? timestamp + OBSERVATION_TTL,
      preferencesRevision: entry.preferencesRevision ?? this.metadata?.getSettings().revision ?? 0, configKey }
  },

  replaceCatalog(entries) {
    if (this.disposed) return false
    const previous = this.catalog
    const next = new Map(entries.map(entry => { const record = this.catalogRecord(entry); return [record.instrument.instId, record] }))
    const now = Date.now()
    for (const instId of next.keys()) this.listRemovals.delete(instId)
    for (const [instId, entry] of previous) if (!next.has(instId) && !this.listRemovals.has(instId)) {
      // A late deadline callback must not restart the delay at its arrival time.
      this.bufferListRemoval(entry, now)
    }
    const changed = next.size !== previous.size || [...next.keys()].some(instId => !previous.has(instId))
      || JSON.stringify([...next]) !== JSON.stringify([...previous])
    this.catalog = next
    for (const entry of next.values()) this.instruments.set(entry.instrument.instId, entry.instrument)
    if (changed) { this.catalogRevision += 1; this.touchList() }
    this.updateListedUniverse(now)
    for (const instId of next.keys()) if (!previous.has(instId)) this.ensureListHourPrefix(instId)
    this.updateSubscriptions()
    this.scheduleMarketDeadline()
    return changed
  },

  pruneCatalog() {
    const valid = [...this.catalog.values()].filter(entry => this.validCatalogEntry(entry))
    if (valid.length !== this.catalog.size) this.replaceCatalog(valid)
  },

  bufferListRemoval(entry, now = Date.now(), expiry = entry ? this.catalogEntryExpiry(entry, now) : 0) {
    const removedAt = Math.min(now, expiry)
    if (!entry || removedAt + LIST_REMOVAL_DELAY_MS <= now) return
    const instId = entry.instrument.instId
    if (!this.listRemovals.has(instId)) this.listRemovals.set(instId, { entry, removeAt: removedAt + LIST_REMOVAL_DELAY_MS })
  },

  listedCatalogEntries(now = Date.now()) {
    const entries = new Map()
    for (const [instId, entry] of this.catalog) {
      const expiry = this.catalogEntryExpiry(entry, now)
      // Projection reads can run before the due maintenance callback. Apply the
      // same known expiry without mutating state or admitting background work.
      if (this.validCatalogEntry(entry, now) || expiry <= now && now < expiry + LIST_REMOVAL_DELAY_MS) entries.set(instId, entry)
    }
    for (const [instId, removal] of this.listRemovals) if (!entries.has(instId) && now < removal.removeAt) entries.set(instId, removal.entry)
    return entries
  },

  updateListedUniverse(now = Date.now()) {
    const ids = new Set(this.listedCatalogEntries(now).keys())
    if (ids.size === this.listedUniverse.size && [...ids].every(id => this.listedUniverse.has(id))) return
    this.listedUniverse = ids
    for (const instId of this.listPrefixAttempts.keys()) if (!ids.has(instId)) this.listPrefixAttempts.delete(instId)
    this.preparedCharts.setUniverse([...ids])
    this.scheduleListQuoteExpiry()
    this.scheduleSubscriptions()
  },

  /** Reuse one canonical projection until its market facts or freshness proof change. */
  canonicalMarketList(now = Date.now()) {
    const lookback = 60, configKey = this.catalogCriteriaKey()
    const asOf5m = closedBoundary('5m', now), asOf15m = closedBoundary('15m', now), asOf1H = closedBoundary('1H', now)
    const cached = this.canonicalList
    if (cached?.revision === this.revision && cached.lookback === lookback && cached.configKey === configKey
      && now >= cached.observedAt && now < cached.expiresAt) return cached
    const entries = [...this.listedCatalogEntries(now).values()]
    let qualifiedCount = 0
    for (const entry of this.catalog.values()) if (this.validCatalogEntry(entry, now)) qualifiedCount++
    const liveChange = (instId, timeframe, asOf) => {
      const key = `${instId}:${timeframe}`
      const live = this.liveCandles.get(key), observedAt = this.liveReceivedAt.get(key)
      const current = live?.timestamp === asOf && Number.isFinite(observedAt) && observedAt <= now
        && now < observedAt + 30_000 && this.priceStreaming(instId, timeframe)
      const change = current ? signedRelativeChange(live.close, live.open) : null
      return { change, asOf: change === null ? null : observedAt }
    }
    const projected = entries.map(entry => {
      const instId = entry.instrument.instId
      const change5m = liveChange(instId, '5m', asOf5m)
      const change15m = liveChange(instId, '15m', asOf15m)
      const change1H = liveChange(instId, '1H', asOf1H)
      // A metadata reassessment may have no ticker dependency. Quote display
      // still owns the last shared market observation, independently of filters.
      const ticker = this.observations.get(instId)?.ticker?.value ?? this.tickerCache?.values.get(instId)?.value ?? entry.ticker
      const instrument = this.instruments.get(instId) ?? entry.instrument
      return { instId, tickSz: typeof instrument.tickSz === 'string' ? instrument.tickSz : null,
        lastPrice: number(ticker.last), turnover24hUSDT: number(this.catalogChecks.get(instId)?.result.turnover ?? entry.result.turnover),
        change5m: change5m.change, change5mAsOf: change5m.asOf,
        change15m: change15m.change, change15mAsOf: change15m.asOf,
        rankingChange: change1H.change, rankingAsOf: change1H.asOf }
    })
    const previousOrder = this.canonicalOrdering, byId = new Map(projected.map(row => [row.instId, row]))
    let sameRanking = previousOrder?.keys.size === byId.size, sameTurnover = sameRanking
    if (sameRanking) for (const row of projected) {
      const key = previousOrder.keys.get(row.instId)
      if (!key || !Object.is(key.rankingChange, row.rankingChange)) sameRanking = false
      if (!key || !Object.is(key.turnover24hUSDT, row.turnover24hUSDT)) sameTurnover = false
    }
    const rows = sameRanking ? previousOrder.ranking.map(id => byId.get(id))
      : projected.toSorted(compareRanking)
    const turnoverOrder = sameTurnover ? previousOrder.turnover.slice()
      : [...projected]
        .sort((left, right) => (right.turnover24hUSDT ?? -Infinity) - (left.turnover24hUSDT ?? -Infinity) || (left.instId < right.instId ? -1 : left.instId > right.instId ? 1 : 0))
        .map(row => row.instId)
    this.canonicalOrdering = { keys: new Map(projected.map(row => [row.instId, { rankingChange: row.rankingChange, turnover24hUSDT: row.turnover24hUSDT }])),
      ranking: sameRanking ? previousOrder.ranking : rows.map(row => row.instId), turnover: sameTurnover ? previousOrder.turnover : turnoverOrder.slice() }
    let expiresAt = asOf5m + FIVE_MINUTES
    for (const row of projected) {
      if (row.change5mAsOf !== null) expiresAt = Math.min(expiresAt, row.change5mAsOf + 30_000)
      if (row.change15mAsOf !== null) expiresAt = Math.min(expiresAt, row.change15mAsOf + 30_000)
      if (row.rankingAsOf !== null) expiresAt = Math.min(expiresAt, row.rankingAsOf + 30_000)
    }
    for (const entry of entries) {
      const expiry = this.catalogEntryExpiry(entry, now)
      expiresAt = Math.min(expiresAt, this.listRemovals.get(entry.instrument.instId)?.removeAt ?? (expiry > now ? expiry : expiry + LIST_REMOVAL_DELAY_MS))
    }
    this.canonicalList = { revision: this.revision, lookback, configKey, observedAt: now, qualifiedCount,
      current: qualifiedCount === this.catalog.size && [...this.listRemovals.values()].every(removal => removal.removeAt > now),
      expiresAt, rows, turnoverOrder }
    return this.canonicalList
  },

  /** Observational read: never admits source, history, or indicator work. */
  listRowsFor(now = Date.now()) { return this.canonicalMarketList(now).rows },

  async catalogInstruments(configKey, signal, reuse) {
    // Normal startup obtains its baseline after the subscription ack. REST
    // remains available when the control stream cannot establish itself.
    if (!this.instrumentSnapshotReady) await this.waitForInstrumentSubscription(signal)
    const stream = this.instrumentStream
    if (stream && !stream.signal.aborted) {
      await abortable(stream.task, signal)
      if (this.instrumentStream === stream && stream.synchronized && !stream.signal.aborted) return [...this.candidateIDs].map(id => this.instruments.get(id))
      throw new Error('The instruments stream has not synchronized its authoritative snapshot.')
    }
    if (reuse && this.instrumentSnapshotReady && Date.now() - this.instrumentSnapshotObservedAt < OBSERVATION_TTL) return [...this.candidateIDs].map(id => this.instruments.get(id))
    return this.discoverInstruments(configKey, signal, 'foreground')
  },

  async discoverInstruments(configKey, signal, priority) {
    try {
      signal.throwIfAborted()
      if (!this.instrumentTask) {
        const version = this.instrumentEventVersion
        const entry = { controller: new AbortController(), waiters: new Set(), settled: false, task: null, version }
        this.instrumentTask = entry
        entry.task = Promise.resolve().then(() => this.get('/public/instruments', { instType: 'SWAP' }, entry.controller.signal, priority))
          .finally(() => { entry.settled = true; if (this.instrumentTask === entry) this.instrumentTask = null })
      }
      const acquisition = this.instrumentTask
      const instruments = await sharedWait(acquisition, signal, (entry, reason) => {
        if (this.instrumentTask === entry) this.instrumentTask = null
        this.track(entry.task)
        entry.controller.abort(reason)
      })
      signal.throwIfAborted()
      if (!Array.isArray(instruments) || !instruments.length) throw new Error('OKX returned no swap instruments; market verification is unavailable.')
      const definitions = new Map(instruments.map(value => [value.instId, value]))
      // A REST cache may be older than a delta received during this acquisition.
      for (const [instId, delta] of this.instrumentDeltas) if (this.instrumentStream && !this.instrumentStream.signal.aborted || delta.version > acquisition.version) {
        definitions.set(instId, { ...(definitions.get(instId) ?? {}), ...delta.value })
      }
      if (![...definitions.values()].some(eligibleInstrument)) throw new Error('No supported swap instrument metadata could be verified. Retrying automatically.')
      this.instrumentSnapshotReady = true
      this.instrumentSnapshotObservedAt = Date.now()
      const candidates = this.installInstruments(definitions)
      this.sourceError('instruments', null)
      return candidates
    } catch (error) {
      if (!signal.aborted) this.sourceError('instruments', error)
      throw error
    }
  },

  installInstruments(definitions, observedIDs) {
    this.instrumentDefinitions = definitions
    const candidates = [...definitions.values()].filter(value => eligibleInstrument(value) && !this.instrumentRetirements.has(value.instId)).map(value => value.ctMult === '' ? { ...value, ctMult: '1' } : value)
    const nextIDs = new Set(candidates.map(value => value.instId))
    const removedIDs = [...(this.candidateIDs ?? [])].filter(id => !nextIDs.has(id))
    for (const instId of removedIDs) {
      const task = this.history.removeTargets([instId]).then(() => {
        if (this.instrumentRetirements.get(instId) !== task) return
        this.instrumentRetirements.delete(instId)
        if (this.closing || this.disposed || !eligibleInstrument(this.instrumentDefinitions.get(instId))) return
        this.installInstruments(this.instrumentDefinitions, new Set([instId]))
        this.queueStreamQualification(instId); this.touchList()
        if (this.autoRefresh) this.track(this.refresh({ reuse: true }))
      })
      this.instrumentRetirements.set(instId, task)
      this.track(task)
    }
    this.liveStatistics.remove(removedIDs)
    this.candleDerivations.remove(removedIDs)
    this.realtime.removeInstruments(removedIDs)
    for (const instId of removedIDs) {
      this.instrumentGenerations.set(instId, (this.instrumentGenerations.get(instId) ?? 0) + 1)
      // Invalidate in-flight latest reads even before this series has ever
      // received a forming candle. Re-listing retains the newer source epoch.
      for (const timeframe of CHART_TIMEFRAMES) {
        const key = `${instId}:${timeframe}`
        this.liveSourceRevisions.set(key, (this.liveSourceRevisions.get(key) ?? 0) + 1)
        this.liveReceivedAt.delete(key)
        this.liquidityHistoryRevisions.delete(key)
      }
      for (const recovery of this.sourceRecoveries.values()) if (recovery.instId === instId) this.cancelRequiredRecovery(recovery.key)
      this.tickerSubscriptions.delete(instId)
      this.cancelTickerRecovery(instId)
      this.clearTickerFault(instId)
      this.sourceError(`${instId}:book`, null)
      this.markMarketDeadlineDirty(instId)
      this.instruments.delete(instId)
      this.observations.delete(instId)
      this.historicalWindows.delete(instId)
      this.nativeBookDeadlines.delete(instId)
      this.bookGenerations.delete(instId)
      this.dataRevisions.delete(instId)
      this.listPrefixAttempts.delete(instId)
      this.bookRetirements.delete(instId)
      this.books.invalidate(instId)
      this.markMarketDeadlineDirty(instId)
      this.instrumentObservations.delete(instId)
      this.tickerCache?.values.delete(instId)
    }
    this.candidateIDs = nextIDs
    this.clearTickerFault()
    for (const instId of this.renewalTargets.keys()) if (!nextIDs.has(instId)) this.renewalTargets.delete(instId)
    for (const instId of this.catalogChecks.keys()) if (!nextIDs.has(instId)) this.catalogChecks.delete(instId)
    for (const instrument of candidates) {
      const previous = this.instruments.get(instrument.instId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(instrument)) {
        this.instrumentGenerations.set(instrument.instId, (this.instrumentGenerations.get(instrument.instId) ?? 0) + 1)
        const observations = this.observations.get(instrument.instId)
        if (observations) { this.markMarketDeadlineDirty(instrument.instId); delete observations.book }
        this.books.invalidate(instrument.instId)
      }
      this.instruments.set(instrument.instId, instrument)
      if (!observedIDs || observedIDs.has(instrument.instId)) {
        this.markMarketDeadlineDirty(instrument.instId)
        this.instrumentObservations.set(instrument.instId, { observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_TTL })
      }
      if (this.renewalTargets.has(instrument.instId)) this.renewalTargets.set(instrument.instId, instrument)
    }
    this.updateSubscriptions()
    for (const key of this.liveCandles.keys()) if (!nextIDs.has(key.slice(0, key.lastIndexOf(':')))) {
      this.liveCandles.delete(key); this.liveCandleSources.delete(key)
    }
    const configKey = this.catalogCriteriaKey(), signal = this.shutdownController.signal
    this.replaceCatalog([...this.catalog.values()].filter(entry => this.currentCandidate(entry.instrument, configKey, signal) && this.validCatalogEntry(entry)))
    return candidates
  },

  receiveInstruments(records, context) {
    if (this.closing || this.disposed || context.signal.aborted || this.instrumentStream?.signal !== context.signal) return
    const definitions = new Map(this.instrumentDefinitions), changed = []
    for (const value of records) {
      if (typeof value?.instId !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+-SWAP$/.test(value.instId)) continue
      const patch = { ...(this.instrumentDeltas.get(value.instId)?.value ?? {}), ...value }
      const merged = { ...(definitions.get(value.instId) ?? {}), ...patch }
      definitions.set(value.instId, merged)
      this.instrumentDeltas.set(value.instId, { version: ++this.instrumentEventVersion, value: patch })
      changed.push(value.instId)
    }
    if (!changed.length) return
    // An incremental message cannot define the complete initial universe.
    // Keep it buffered until the first authoritative REST snapshot arrives.
    if (!this.instrumentSnapshotReady) return
    this.installInstruments(definitions, new Set(changed))
    for (const instId of changed) this.queueStreamQualification(instId)
    this.touchList()
  },

  async synchronizeInstruments(context) {
    if (this.closing || context.signal.aborted) return
    if (this.instrumentRetryTimer) clearTimeout(this.instrumentRetryTimer)
    this.instrumentRetryTimer = null
    const stream = { signal: context.signal, synchronized: false, delay: 1_000, task: null }
    this.instrumentStream = stream
    this.instrumentDeltas.clear()
    const synchronize = async () => {
      try {
        // Start the authoritative snapshot after acknowledgement. This closes
        // the gap before subscription; deltas received during HTTP are merged.
        await this.instrumentTask?.task.catch(() => undefined)
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        const signal = AbortSignal.any([stream.signal, this.shutdownController.signal])
        await this.discoverInstruments(this.catalogCriteriaKey(), signal, 'foreground')
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        stream.synchronized = true
        this.verifyCatalog()
        // Startup refresh already owns qualification and its priority order.
        // Reconnection reuses that coordinator instead of admitting a second
        // exchange-wide scan before the shared ticker snapshot has arrived.
        if (!this.refreshing) this.track(this.refresh({ reuse: true }))
        this.sourceError('instruments', null)
      } catch (error) {
        if (this.closing || stream.signal.aborted || this.instrumentStream !== stream) return
        this.sourceError('instruments', error)
        this.instrumentRetryTimer = setTimeout(() => { this.instrumentRetryTimer = null; stream.task = synchronize(); this.track(stream.task) }, stream.delay)
        stream.delay = Math.min(30_000, stream.delay * 2)
        this.instrumentRetryTimer.unref?.()
      }
    }
    stream.task = synchronize()
    for (const finish of this.instrumentSubscriptionWaiters) finish()
    return stream.task
  },

  instrumentStreamDisconnected(context) {
    for (const finish of this.instrumentSubscriptionWaiters) finish()
    if (this.instrumentStream?.signal !== context.signal) return
    this.instrumentStream = null
    this.instrumentDeltas.clear()
    if (this.instrumentRetryTimer) clearTimeout(this.instrumentRetryTimer)
    this.instrumentRetryTimer = null
    if (!this.closing && !this.disposed) { this.verifyCatalog(); this.touchList() }
  },

  async renewCatalog() {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.renewing) return this.renewing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = liquidityConfigKey(config)
    this.renewalController = controller
    this.catalogControllers.add(controller)
    this.renewalStartedAt = Date.now()
    let collecting = false
    this.renewing = (async () => {
      // Renewal must verify current contract units and trading state as well
      // as prices. An outage cannot keep extending old instrument metadata.
      await Promise.all([
        this.discoverInstruments(configKey, controller.signal, 'foreground'),
        this.tickerObservations(controller.signal, 'foreground'),
      ])
      if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
      this.verifyCatalog()
      // An explicit renewal does not wait for historical windows before
      // admitting independent candidates.
      const checks = [...this.renewalTargets.values()].map(
        instrument => this.checkCandidate(instrument, config, configKey, controller.signal, 'foreground'))
      collecting = true
      this.track(Promise.allSettled(checks).finally(() => this.catalogControllers.delete(controller)))
      this.sourceError('refresh', null)
    })()
      .catch(error => {
        if (!controller.signal.aborted && !(error && typeof error === 'object' && this.handledSourceErrors.has(error))) this.sourceError('refresh', error)
      })
      .finally(() => {
        if (!collecting) this.catalogControllers.delete(controller)
        this.renewing = null
        if (this.renewalController === controller) this.renewalController = null
        this.touchList()
      })
    this.touchList()
    return this.renewing
  },

  async refresh({ reuse = false } = {}) {
    await this.ready
    if (this.closing || this.disposed) return
    if (this.refreshing) return this.refreshing
    const controller = new AbortController(), config = this.prefs().liquidity, configKey = liquidityConfigKey(config)
    this.refreshController = controller
    this.catalogControllers.add(controller)
    // Cached checks are already scheduled for the full refresh, even while
    // discovery and the shared ticker request have yet to admit each check.
    const admission = { configKey, ids: new Set([...this.catalogChecks].filter(([, record]) => !reuse || record.status === 'unknown' || record.status === 'verified' && !this.validCatalogEntry(record)).map(([id]) => id)) }
    this.refreshAdmission = admission
    const startedAt = Date.now()
    this.refreshStartedAt = startedAt
    this.refreshing = (async () => {
      try {
        this.verifyCatalog()
        const [candidates] = await Promise.all([
          this.catalogInstruments(configKey, controller.signal, reuse),
          ...(!reuse || !this.tickerFaults.size ? [this.tickerObservations(controller.signal, 'foreground', !reuse)] : []),
        ])
        if (controller.signal.aborted || this.catalogCriteriaKey() !== configKey) return
        this.verifyCatalog()
        // Previously qualified contracts get checked first, independently of
        // their position in the exchange's instrument response.
        candidates.sort((a, b) => Number(this.renewalTargets.has(b.instId)) - Number(this.renewalTargets.has(a.instId)))
        // A successful check publishes independently; the first row does not wait for the full exchange scan.
        const checks = candidates.filter(instrument => !reuse || this.catalogChecks.get(instrument.instId)?.status === 'unknown')
          .map(instrument => this.checkCandidate(instrument, config, configKey, controller.signal, 'foreground'))
        if (this.refreshAdmission === admission) this.refreshAdmission = null
        await Promise.all(checks)
        if (!controller.signal.aborted && this.catalogCriteriaKey() === configKey) {
          this.lastRefreshAt = startedAt
          this.sourceError('refresh', null)
        }
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed && !(error && typeof error === 'object' && this.handledSourceErrors.has(error))) this.sourceError('refresh', error)
      } finally {
        if (this.refreshAdmission === admission) this.refreshAdmission = null
        this.catalogControllers.delete(controller)
        this.pruneCatalog()
        if (this.refreshController === controller) this.refreshController = null
        this.refreshing = null
        this.touchList()
      }
    })()
    this.touchList()
    return this.refreshing
  },

  async snapshot({ sinceRevision, serviceSession } = {}) {
    await this.ready
    return this.currentSnapshot({ sinceRevision, serviceSession })
  },

  // Caller must await ready. A resume barrier captures every component and
  // posts its response in this same turn, before attaching live subscribers.
  currentSnapshot({ sinceRevision, serviceSession } = {}) {
    const previousList = this.canonicalList
    const { rows, turnoverOrder, qualifiedCount, current: listCurrent } = this.canonicalMarketList()
    const configKey = this.catalogCriteriaKey()
    const pendingIDs = new Set([...this.pendingCandidates.values()].filter(value => value.configKey === configKey).map(value => value.instId))
    if (this.refreshAdmission?.configKey === configKey) for (const instId of this.refreshAdmission.ids) pendingIDs.add(instId)
    for (const recovery of this.sourceRecoveries.values()) pendingIDs.add(recovery.instId)
    for (const instId of this.tickerRecoveries.keys()) pendingIDs.add(instId)
    // A live notification can reach IPC before an already-due deadline gets
    // its event-loop turn. Count that admitted work without starting it here.
    if (this.autoRefresh && this.marketDeadlineTimer) {
      const now = Date.now()
      for (const [instId, deadline] of this.marketDeadlines) if (deadline <= now) pendingIDs.add(instId)
    }
    const pending = pendingIDs.size
    const catalogProgress = { total: this.candidateIDs?.size ?? this.catalogChecks.size, completed: this.catalogChecks.size, pending, verified: 0, failed: 0, unknown: 0 }
    let unavailableContracts = 0
    for (const record of this.catalogChecks.values()) {
      const status = record.status === 'verified' && !this.validCatalogEntry(record) ? 'unknown' : record.status
      catalogProgress[status] += 1
      if (status === 'unknown' && !pendingIDs.has(record.instrumentID)) unavailableContracts += 1
    }
    // A native close expires the old rolling window before its final candle
    // arrives. Active revalidation is pending work, not a source failure.
    const unavailable = !qualifiedCount && unavailableContracts > 0
      ? `Market verification is unavailable for ${unavailableContracts} contracts because required observations are missing or expired.${pending > 0 || this.refreshing || this.renewing ? ' Acquiring current observations.' : ''}` : ''
    const status = { error: this.error || unavailable, loading: this.refreshing !== null || this.renewing !== null || pending > 0,
      catalogProgress,
      updatedAt: this.listUpdatedAt ?? this.catalogUpdatedAt,
      catalogSource: this.catalogSource, realtimeState: this.realtimeState() }
    const metadata = { ...status, revision: this.revision, serviceSession: this.serviceSession }
    // A source or retirement deadline can reach IPC before its callback. Never
    // hide a changed projection or ranking boundary behind a version hit.
    const current = this.marketBoundary === closedBoundary('5m') && listCurrent && previousList === this.canonicalList
    if (current && serviceSession === this.serviceSession && sinceRevision === this.revision) return { ...metadata, unchanged: true }
    return { ...metadata, rows, turnoverOrder }
  },
}
