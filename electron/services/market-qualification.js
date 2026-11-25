import { evaluateLiquidity, quoteTurnover24h } from './liquidity.js'
import { StreamLiquidityEvaluator } from './stream-liquidity.js'
import {
  LIQUIDITY_SOURCE_CRITERIA, OBSERVATION_TTL, TICKER_BOOTSTRAP_MS,
  CANDLE_DELIVERY_MS, CATALOG_RENEW_INTERVAL, liquidityConfigKey,
  requiredLiquiditySources, closedBoundary, abortable, sharedWait,
  number, timeframeMilliseconds,
} from './market-helpers.js'

export const marketQualificationMethods = {
  receivePublicObservation(instId, key, value, { receivedAt = Date.now(), signal, acknowledged } = {}) {
    if (this.closing || this.disposed || signal?.aborted || !this.candidateIDs?.has(instId)) return
    const observations = this.observations.get(instId) ?? {}
    const tickerRecovery = key === 'ticker' && (this.tickerRecoveries.has(instId) || this.sourceRecoveries.has(`${instId}:ticker`))
    const sourceTimestamp = number(value?.ts)
    const previous = observations[key]
    if (previous?.sourceTimestamp != null && sourceTimestamp != null && sourceTimestamp < previous.sourceTimestamp) return
    if (key === 'ticker' && !(number(value?.last) > 0)) {
      if (this.tickerSubscriptions.get(instId)?.signal === signal) this.tickerFault(instId, new Error(`Invalid native ticker for ${instId}.`))
      return
    }
    if (key === 'openInterest' && (number(value?.oiUsd) === null || number(value?.oiUsd) < 0)) return
    this.markMarketDeadlineDirty(instId)
    observations[key] = { value, source: 'websocket', sourceTimestamp, observedAt: receivedAt, expiresAt: receivedAt + OBSERVATION_TTL }
    this.observations.set(instId, observations)
    if (key === 'book') { this.books.invalidate(instId); this.nativeBookDeadlines.delete(instId) }
    this.cancelRequiredRecovery(`${instId}:${key}`)
    if (key === 'ticker') {
      const session = this.tickerSubscriptions.get(instId)
      if (acknowledged !== false && session && session.signal === signal && !signal.aborted && receivedAt >= session.receivedAt && session.subscription === this.publicRealtime.subscriptions.get(`tickers:${instId}`)) {
        if (this.validTicker(value)) {
          session.observation = observations.ticker; session.faulted = false
          this.tickerNativeObservations.set(observations.ticker, { instId, session })
          this.cancelTickerRecovery(instId)
        } else this.tickerFault(instId, new Error(`Invalid native bid/ask for ${instId}.`))
      }
      this.capTickerAssessment(instId, true, tickerRecovery)
      this.tickerCache ??= { values: new Map(), observedAt: 0 }
      this.tickerCache.values.set(instId, observations.ticker)
      if (this.validTicker(value)) this.clearTickerFault(instId)
      const entry = this.catalog.get(instId)
      if (entry) entry.ticker = value
      // Publish the current trade price without waiting for qualification or history.
      if (entry || this.listRemovals.has(instId)) { this.listUpdatedAt = receivedAt; this.touchList() }
    }
    this.queueStreamQualification(instId, key)
  },

  validTicker(value) {
    return number(value?.last) > 0 && number(value?.bidPx) > 0 && number(value?.askPx) > 0 && number(value.askPx) >= number(value.bidPx)
  },

  queueStreamQualification(instId, source) {
    if (this.closing || this.disposed) return
    if (source && LIQUIDITY_SOURCE_CRITERIA[source]) {
      // Keep collecting the observation and publishing trade prices. Reuse an
      // assessment when this source is absent from its enabled dependencies.
      const config = this.preferences().liquidity, record = this.catalogChecks.get(instId)
      if (record && record.instrument === this.instruments.get(instId) && record.configKey === liquidityConfigKey(config)
        && LIQUIDITY_SOURCE_CRITERIA[source].every(key => config[key].enabled === false)) return
    }
    this.streamQualifications.add(instId)
    if (this.streamQualificationTimer) return
    this.streamQualificationTimer = setTimeout(() => this.flushStreamQualifications(), 100)
    this.streamQualificationTimer.unref?.()
  },

  flushStreamQualifications() {
    if (this.streamQualificationTimer) clearTimeout(this.streamQualificationTimer)
    this.streamQualificationTimer = null
    const ids = [...this.streamQualifications]; this.streamQualifications.clear()
    if (this.closing || this.disposed) return
    const config = this.prefs().liquidity, configKey = liquidityConfigKey(config), now = Date.now()
    const records = []
    for (const instId of ids) {
      const instrument = this.instruments.get(instId)
      if (!instrument || !this.candidateIDs?.has(instId)) continue
      const observations = { ...(this.observations.get(instId) ?? {}) }
      const instrumentObservation = this.instrumentObservations.get(instId)
      const input = this.liquidityInput(instrument, config, observations, now)
      const cheap = input.book && (config.depth.enabled || config.slippage.enabled) ? this.cheapLiquidity(input) : null
      if (cheap && cheap.status !== 'failed') {
        // Keep at most one pending calculation per instrument. A new book
        // replaces pending observations instead of growing the worker backlog.
        if (this.streamEvaluations.has(instId)) continue
        this.streamLiquidity ??= new StreamLiquidityEvaluator()
        const capturedSources = Object.entries(LIQUIDITY_SOURCE_CRITERIA).filter(([, criteria]) => criteria.some(key => config[key].enabled)).map(([source]) => source)
        const bookGeneration = this.bookGenerations.get(instId) ?? 0
        const task = this.streamLiquidity.evaluate(input).then(result => {
          if (this.closing || !this.currentCandidate(instrument, configKey, this.shutdownController.signal)
            || this.instrumentObservations.get(instId) !== instrumentObservation) return
          if (capturedSources.includes('book') && (this.bookGenerations.get(instId) ?? 0) !== bookGeneration) return
          const current = this.observations.get(instId) ?? {}, now = Date.now()
          if (capturedSources.some(source => current[source] !== observations[source])) return
          const currentInput = this.liquidityInput(instrument, config, current, now)
          const expiredSource = capturedSources.some(key => observations[key] && !this.qualificationObservation(observations, key, instId, configKey, now))
          const record = expiredSource || this.cheapLiquidity(currentInput).status === 'failed'
            ? this.observedCandidate(instrument, config, configKey, current, {}, now, this.evaluateLiquidity({ ...currentInput, book: null }))
            : this.observedCandidate(instrument, config, configKey, observations, {}, now, result)
          record.ticker = current.ticker?.value ?? record.ticker
          this.publishStreamRecords([record])
          this.sourceError('liquidity', null)
        }).catch(error => {
          if (!this.closing) this.sourceError('liquidity', new Error(`Live liquidity calculation failed: ${error.message}`))
        }).finally(() => {
          this.streamEvaluations.delete(instId)
          const current = this.observations.get(instId) ?? {}
          if (this.instrumentObservations.get(instId) !== instrumentObservation || capturedSources.some(key => current[key] !== observations[key])) this.queueStreamQualification(instId)
        })
        this.streamEvaluations.set(instId, task)
        this.track(task)
      } else records.push(this.observedCandidate(instrument, config, configKey, observations, {}, now, undefined, cheap))
    }
    this.publishStreamRecords(records)
    if (ids.length) this.scheduleTickerDeadline(ids[0]); else this.scheduleMarketDeadline()
  },

  publishStreamRecords(records) {
    if (!records.length || this.closing || this.disposed) return
    let membershipChanged = false
    for (const record of records) {
      const instrument = record.instrument, instId = instrument.instId
      this.markMarketDeadlineDirty(instId)
      this.catalogChecks.set(instId, record)
      const existing = this.catalog.has(instId)
      if (record.status === 'verified') {
        this.listRemovals.delete(instId)
        this.renewalTargets.set(instId, instrument)
        membershipChanged ||= !existing
      } else {
        if (record.status === 'failed') this.renewalTargets.delete(instId)
        membershipChanged ||= existing
      }
      if (record.status !== 'verified') this.recoverRequiredSources(instId)
    }
    this.catalogSource = 'live'; this.catalogUpdatedAt = Date.now()
    // Durable catalog checkpoints belong to discovery/renewal. High-frequency
    // ticks update memory; membership alone controls the prepared-chart universe.
    const next = membershipChanged ? new Map(this.catalog) : this.catalog
    for (const record of records) {
      if (record.status === 'verified') next.set(record.instrument.instId, record)
      else next.delete(record.instrument.instId)
    }
    if (membershipChanged) this.replaceCatalog([...next.values()])
    this.scheduleSubscriptions(records.map(record => record.instrument.instId))
    this.touchList()
    this.scheduleTickerDeadline(records[0].instrument.instId)
  },

  observationExpiry(observation, key, instId) {
    if (key === 'ticker' && observation?.source === 'websocket') {
      const proof = this.tickerNativeObservations.get(observation), session = proof?.session
      const id = instId ?? proof?.instId
      if (session && id === proof.instId && !session.faulted && !session.signal.aborted && session.observation === observation
        && this.tickerSubscriptions.get(id) === session && this.candidateIDs?.has(id)
        && this.publicRealtime?.subscriptions.get(`tickers:${id}`) === session.subscription) return Number.MAX_SAFE_INTEGER
    }
    return observation?.expiresAt ?? 0
  },

  observation(entry, key, now = Date.now()) {
    const value = entry[key]
    return value && Number.isSafeInteger(value.observedAt) && this.observationExpiry(value, key) > now ? value : null
  },

  rememberHistoricalAssessment(record, now = Date.now(), validated = false) {
    if (record.status !== 'verified' || !record.result.eligible || record.expiresAt <= now
      || !this.currentCandidate(record.instrument, record.configKey, this.shutdownController.signal)) return
    for (const [key, timeframe] of [['turnover', '5m'], ['hourly', '1H']]) {
      const observation = record.observations?.[key]
      if (!observation || observation.value.asOf !== closedBoundary(timeframe, now) || observation.expiresAt <= now) continue
      if (validated) this.historicalValidations.add(observation)
      if (!this.historicalValidations.has(observation) || this.historicalAssessments.has(observation)
        || !this.realtime?.isSubscribed(record.instrumentID, '5m')) continue
      this.historicalAssessments.set(observation, { instId: record.instrumentID, key, configKey: record.configKey,
        instrumentGeneration: this.instrumentGenerations.get(record.instrumentID) ?? 0, connection: this.realtime.connection,
        subscription: this.realtime.subscriptions.get(`5m:${record.instrumentID}`) })
      this.markMarketDeadlineDirty(record.instrumentID)
    }
  },

  qualificationExpiry(observation, key, instId, configKey, now = Date.now()) {
    const expiry = this.observationExpiry(observation, key, instId)
    if (expiry > now || !observation || key !== 'turnover' && key !== 'hourly') return expiry
    const proof = this.historicalAssessments.get(observation), timeframe = key === 'turnover' ? '5m' : '1H'
    const boundary = closedBoundary(timeframe, now), deadline = boundary + CANDLE_DELIVERY_MS
    // Runtime authority belongs to the exact validated window and continuous
    // subscription. Neither a checkpoint, reconnect, tick nor refresh renews it.
    return proof?.instId === instId && proof.key === key && proof.configKey === configKey
      && proof.instrumentGeneration === (this.instrumentGenerations.get(instId) ?? 0) && proof.connection === this.realtime?.connection
      && proof.subscription && proof.subscription === this.realtime.subscriptions.get(`5m:${instId}`)
      && this.realtime.isSubscribed(instId, '5m') && observation.expiresAt === boundary
      && observation.value.asOf === boundary - timeframeMilliseconds(timeframe) ? deadline : expiry
  },

  qualificationObservation(observations, key, instId, configKey, now = Date.now(), evidence) {
    const observation = observations[key]
    if (!observation || !Number.isSafeInteger(observation.observedAt)) return null
    const expiry = this.qualificationExpiry(observation, key, instId, configKey, now)
    if (expiry <= now) return null
    if (key === 'turnover' || key === 'hourly') {
      const timeframe = key === 'turnover' ? '5m' : '1H', boundary = closedBoundary(timeframe, now)
      if (observation.value.asOf !== boundary
        && !(observation.value.asOf === boundary - timeframeMilliseconds(timeframe) && observation.expiresAt === boundary)) return null
    }
    if (evidence) {
      if (typeof expiry === 'number' || typeof expiry === 'string') {
        const numeric = Number(expiry), deadline = Math.ceil(numeric)
        if (Number.isFinite(numeric)) evidence.deadline = Math.min(evidence.deadline, Number.isSafeInteger(deadline) && deadline >= 0 ? deadline : now)
      } else if (expiry !== undefined && expiry !== null) evidence.deadline = Math.min(evidence.deadline, now)
    }
    return observation
  },

  invalidateLiquidityHistory(instId, rows, timeframe) {
    for (const frame of ['5m', '1H']) if (rows ? rows.some(row => row.timeframe === frame) : timeframe === frame) {
      const key = `${instId}:${frame}`
      this.liquidityHistoryRevisions.set(key, this.liquidityHistoryRevision(instId, frame) + 1)
      const window = this.historicalWindows.get(key)
      if (!rows) this.historicalWindows.delete(key)
      else if (window) {
        for (const row of rows) if (row.timeframe === frame) window.rows.set(row.timestamp, row)
        const step = timeframeMilliseconds(frame), through = closedBoundary(frame) - step
        const from = through - (frame === '5m' ? 288 : 24) * step
        for (const timestamp of window.rows.keys()) if (timestamp < from || timestamp > through) window.rows.delete(timestamp)
        window.revision = this.liquidityHistoryRevision(instId, frame)
        window.storeRevision = this.store.candlePriceRevision(instId, frame)
      }
    }
    const observations = this.observations.get(instId)
    if (!observations) return
    const record = this.catalogChecks.get(instId), published = this.catalog.get(instId)
    const now = Date.now(), publishedExpiry = this.catalogEntryExpiry(published, now)
    const recordObservations = { ...record?.observations }
    let recordChanged = false, recordInvalidated = false, publishedInvalidated = false
    for (const [key, frame, count] of [['turnover', '5m', 288], ['hourly', '1H', 24]]) {
      const step = timeframeMilliseconds(frame)
      for (const observation of new Set([observations[key], record?.observations?.[key], published?.observations?.[key]])) {
        const value = observation?.value
        const inputs = this.historicalInputs.get(observation)
        // A concurrent reader may already have calculated and published the
        // committed quote amounts. Invalidate changed inputs, not that result.
        if (!value || !(rows ? rows.some(row => row.timeframe === frame && row.timestamp >= value.asOf - count * step && row.timestamp < value.asOf
          && (!inputs?.has(row.timestamp) || !Object.is(inputs.get(row.timestamp), row.quoteVolume))) : timeframe === frame)) continue
        this.historicalAssessments.delete(observation)
        this.historicalValidations.delete(observation)
        this.markMarketDeadlineDirty(instId)
        if (observations[key] === observation) delete observations[key]
        const enabled = this.prefs().liquidity[key === 'turnover' ? 'volume24h' : 'volumeStability'].enabled
        if (record?.observations?.[key] === observation) {
          delete recordObservations[key]; recordChanged = true; recordInvalidated ||= enabled
        }
        if (published?.observations?.[key] === observation) publishedInvalidated ||= enabled
      }
    }
    if (recordChanged && record) {
      if (recordInvalidated) {
        record.status = 'unknown'; record.result = { ...record.result, eligible: false }; record.expiresAt = Math.min(record.expiresAt, now)
      }
      record.observations = recordObservations
      this.metadata.putCatalogEntry(record)
    }
    if (publishedInvalidated) {
      const entry = published
      this.bufferListRemoval(entry, now, publishedExpiry)
      if (entry) { entry.status = 'unknown'; entry.result = { ...entry.result, eligible: false }; entry.expiresAt = Math.min(publishedExpiry, now) }
      this.touchList()
      this.scheduleMarketDeadline()
    }
  },

  liquidityHistoryRevision(instId, timeframe) { return this.liquidityHistoryRevisions.get(`${instId}:${timeframe}`) ?? 0 },

  scheduleQualification(instId, timeframe) {
    if (!this.autoRefresh || this.closing || this.disposed || !this.catalogChecks.has(instId)) return
    const config = this.prefs().liquidity
    if (!config.volume24h.enabled && !config.volumeStability.enabled) return
    if (timeframe && !(timeframe === '5m' && config.volume24h.enabled || timeframe === '1H' && config.volumeStability.enabled)) return
    this.qualificationQueue.add(instId)
    if (this.qualificationImmediate) return
    // Coalesce durable writes, then read committed windows outside their write
    // locks. Every contract is admitted together; none waits for another source.
    this.qualificationImmediate = setImmediate(() => {
      this.qualificationImmediate = null
      const ids = [...this.qualificationQueue]; this.qualificationQueue.clear()
      const config = this.prefs().liquidity, key = liquidityConfigKey(config)
      this.track(Promise.allSettled(ids.map(id => {
        const instrument = this.instruments.get(id)
        return instrument && this.checkCandidate(instrument, config, key, this.shutdownController.signal, 'foreground', { localOnly: true })
      })))
    })
  },

  async bookObservation(instId, signal, priority) {
    try {
      const observation = await this.books.observe(instId, signal, priority, this.observation(this.observations.get(instId) ?? {}, 'book'))
      return { ...observation, source: observation.source ?? 'rest', sourceTimestamp: number(observation.value.ts) }
    } catch (error) {
      signal.throwIfAborted()
      // A native snapshot can retire an obsolete REST acquisition while its
      // consumers still need the now-current book.
      const current = this.observation(this.observations.get(instId) ?? {}, 'book')
      if (current) return current
      throw error
    }
  },

  bookUnsubscribed(instId) {
    const now = Date.now(), published = this.catalog.get(instId), publishedExpiry = this.catalogEntryExpiry(published, now)
    this.markMarketDeadlineDirty(instId)
    this.bookGenerations.set(instId, (this.bookGenerations.get(instId) ?? 0) + 1)
    this.books.invalidate(instId)
    this.nativeBookDeadlines.delete(instId)
    const observations = this.observations.get(instId)
    if (observations) delete observations.book
    const { depth, slippage } = this.prefs().liquidity
    if (this.closing || !depth.enabled && !slippage.enabled) return
    const record = this.catalogChecks.get(instId)
    if (record) {
      record.status = 'unknown'; record.expiresAt = Math.min(record.expiresAt, now)
      record.result = { ...record.result, eligible: false }
      record.observations = { ...observations }
    }
    this.bufferListRemoval(published, now, publishedExpiry)
    if (published) { published.status = 'unknown'; published.result = { ...published.result, eligible: false }; published.expiresAt = Math.min(publishedExpiry, now) }
    // Unsubscribe callbacks run inside the transport's membership update.
    // Requalification must not re-enter subscription reconciliation.
    this.queueStreamQualification(instId, 'book')
    this.touchList()
    this.scheduleMarketDeadline()
  },

  acceptObservation(instId, key, observation) {
    const observations = this.observations.get(instId) ?? {}, previous = observations[key]
    const timestamp = number(observation.sourceTimestamp ?? observation.value?.ts)
    const previousTimestamp = number(previous?.sourceTimestamp ?? previous?.value?.ts)
    if (timestamp !== null && previousTimestamp !== null && timestamp < previousTimestamp) throw new Error(`${key} returned an older observation for ${instId}.`)
    if (!previous || previous.observedAt < observation.observedAt || timestamp !== null && previousTimestamp !== null && timestamp > previousTimestamp) {
      this.markMarketDeadlineDirty(instId)
      observations[key] = { ...observation, sourceTimestamp: timestamp }
    }
    this.observations.set(instId, observations)
    const recovery = this.sourceRecoveries.get(`${instId}:${key}`)
    if (recovery && this.observation(observations, key)) {
      this.cancelRequiredRecovery(recovery.key)
      this.scheduleMarketDeadline()
    }
    return observations[key]
  },

  liquidityInput(instrument, config, observations, now = Date.now()) {
    const configKey = liquidityConfigKey(config)
    const fresh = key => this.qualificationObservation(observations, key, instrument.instId, configKey, now)
    const turnover = fresh('turnover')?.value, hourly = fresh('hourly')?.value
    // The hourly validator must use the actual retained window's boundary.
    // Live sources and each historical observation retain their own timestamps.
    const asOf = hourly?.asOf ?? closedBoundary('5m', now)
    return { instrument, ticker: fresh('ticker')?.value ?? null, book: fresh('book')?.value ?? null,
      openInterest: fresh('openInterest')?.value ?? null, hourlyCandles: hourly?.rows ?? [],
      turnover24hUSDT: turnover?.turnover ?? null, asOf, config }
  },

  cheapLiquidity(input) {
    const { config } = input
    return this.evaluateLiquidity({ ...input, book: null, config: { ...config, depth: { ...config.depth, enabled: false }, slippage: { ...config.slippage, enabled: false } } })
  },

  observedCandidate(instrument, config, configKey, observations, errors = {}, now = Date.now(), evaluatedResult, cheapResult) {
    let assessed = observations, input = this.liquidityInput(instrument, config, observations, now)
    if (!evaluatedResult && input.book && (config.depth.enabled || config.slippage.enabled) && (cheapResult ?? this.cheapLiquidity(input)).status === 'failed') input.book = null
    let result = evaluatedResult ?? this.evaluateLiquidity(input)
    const required = requiredLiquiditySources(config)
    const historical = required.filter(key => key === 'turnover' || key === 'hourly')
    const historicalPending = historical.some(key => observations[key]?.value.asOf !== closedBoundary(key === 'turnover' ? '5m' : '1H', now))
    const previous = this.catalog.get(instrument.instId)
    const retained = historicalPending && this.validCatalogEntry(previous, now)
      && historical.every(key => this.qualificationObservation(previous.observations, key, instrument.instId, configKey, now))
    if (result.status === 'verified' && retained && historical.some(key => observations[key] !== previous.observations[key])) {
      // Source and derived writes can finish separately at an hourly close. Publish
      // the complete historical tuple together, while still checking fresh
      // live evidence and immediately applying any newly proven failure.
      assessed = { ...observations, ...Object.fromEntries(historical.map(key => [key, previous.observations[key]])) }
      input = this.liquidityInput(instrument, config, assessed, now)
      result = this.evaluateLiquidity(input)
    }
    const fresh = key => this.qualificationObservation(assessed, key, instrument.instId, configKey, now)
    const instrumentObservation = this.instrumentObservations.get(instrument.instId)
    const continuousMetadata = this.instrumentStream?.synchronized && !this.instrumentStream.signal.aborted && this.candidateIDs?.has(instrument.instId)
    const metadataFresh = continuousMetadata || instrumentObservation?.expiresAt > now
    const validObservations = required.map(fresh)
    const complete = metadataFresh && validObservations.every(Boolean) && (!historicalPending || retained)
    const status = !metadataFresh ? 'unknown' : result.status === 'verified' && complete ? 'verified' : result.status === 'failed' ? 'failed' : 'unknown'
    const leases = complete ? [continuousMetadata ? { observedAt: instrumentObservation?.observedAt ?? now, expiresAt: Number.MAX_SAFE_INTEGER } : instrumentObservation,
      ...required.map((key, index) => ({ observedAt: validObservations[index].observedAt, expiresAt: this.observationExpiry(validObservations[index], key, instrument.instId) }))] : []
    const observedAt = leases.length ? Math.min(...leases.map(value => value.observedAt)) : now
    const expiresAt = status === 'verified' ? Math.max(observedAt, Math.min(...leases.map(value => value.expiresAt))) : Math.max(observedAt, now)
    const record = this.catalogRecord({ instrument, ...(instrumentObservation ? { instrumentObservation } : {}),
      ticker: fresh('ticker')?.value ?? {}, result: { ...result, eligible: status === 'verified' },
      status, configKey, observations: { ...assessed }, observationErrors: errors,
      preferencesRevision: this.catalogChecks.get(instrument.instId)?.preferencesRevision ?? 0,
      renewalTarget: status === 'verified' || status === 'unknown' && this.renewalTargets.has(instrument.instId),
      observedAt, expiresAt }, now)
    this.rememberHistoricalAssessment(record, now, true)
    return record
  },

  // Qualification is a local calculation. Source acquisition can be pending
  // without making a threshold edit wait for the exchange or a history job.
  verifyCatalog() {
    const config = this.prefs().liquidity, configKey = liquidityConfigKey(config), now = Date.now(), verified = []
    for (const instrument of this.instruments.values()) {
      if (this.candidateIDs && !this.candidateIDs.has(instrument.instId)) continue
      const observations = { ...(this.observations.get(instrument.instId) ?? {}) }
      const ticker = this.tickerCache?.values.get(instrument.instId)
      if (this.observationExpiry(ticker, 'ticker', instrument.instId) > now) observations.ticker = ticker
      const record = this.observedCandidate(instrument, config, configKey, observations, {}, now)
      this.catalogChecks.set(instrument.instId, record)
      if (record.status === 'verified') { verified.push(record); this.renewalTargets.set(instrument.instId, instrument) }
      else if (record.status === 'failed') this.renewalTargets.delete(instrument.instId)
    }
    const checks = [...this.catalogChecks.values()]
    if (checks.some(record => record.status !== 'unknown') && this.catalogSource === 'none') this.catalogSource = 'cache'
    this.replaceCatalog(verified)
    this.touchList()
  },

  async tickerObservations(signal, priority = 'background', force = false) {
    signal?.throwIfAborted()
    if (this.candidateIDs?.size && [...this.candidateIDs].every(id => {
      const observation = this.tickerCache?.values.get(id)
      return observation?.source === 'websocket' && this.observationExpiry(observation, 'ticker', id) > Date.now()
    })) return this.tickerCache.values
    if (!force && this.tickerCache && Date.now() - this.tickerCache.observedAt < CATALOG_RENEW_INTERVAL) return this.tickerCache.values
    let pending = this.tickerTask
    if (!pending) {
      const initial = new Map(this.tickerCache?.values ?? [])
      pending = { controller: new AbortController(), waiters: new Set(), settled: false, task: null }
      this.tickerTask = pending
      pending.task = Promise.resolve().then(() => this.get('/market/tickers', { instType: 'SWAP' }, pending.controller.signal, priority)).then(values => {
        pending.controller.signal.throwIfAborted()
        if (!Array.isArray(values) || !values.length) throw new Error('OKX returned no swap tickers.')
        const observedAt = Date.now()
        const observations = new Map(values.map(value => [value.instId, { value, observedAt, expiresAt: observedAt + OBSERVATION_TTL }]))
        for (const [id, observation] of this.tickerCache?.values ?? []) {
          if (this.observationExpiry(observation, 'ticker', id) <= observedAt) continue
          const previousTimestamp = observation.sourceTimestamp ?? number(observation.value?.ts)
          const incomingTimestamp = number(observations.get(id)?.value?.ts)
          if (observation.source === 'websocket'
            || previousTimestamp != null && incomingTimestamp != null && previousTimestamp > incomingTimestamp
            || observation !== initial.get(id) && (previousTimestamp == null || incomingTimestamp == null || previousTimestamp >= incomingTimestamp)) observations.set(id, observation)
        }
        if (this.tickerTask === pending && !this.disposed) {
          this.tickerCache = { values: observations, observedAt }
          for (const [id, value] of observations) if (this.validTicker(value.value)) this.clearTickerFault(id)
        }
        return observations
      }).catch(error => {
        if (this.tickerTask === pending && !pending.controller.signal.aborted) {
          if (error && typeof error === 'object') this.handledSourceErrors.add(error)
          for (const id of this.candidateIDs ?? this.instruments.keys()) if (this.observationExpiry(this.tickerCache?.values.get(id), 'ticker', id) <= Date.now()) this.tickerFaults.set(id, error)
          if (!this.candidateIDs && !this.instruments.size) this.tickerFaults.set('*', error)
          if (this.tickerFaults.size) this.sourceError('tickers', error)
        }
        throw error
      }).finally(() => {
        pending.settled = true
        if (this.tickerTask === pending) this.tickerTask = null
      })
    }
    return new Promise((resolve, reject) => {
      const waiter = {}
      const finish = (complete, value) => {
        if (!pending.waiters.delete(waiter)) return
        signal?.removeEventListener('abort', onAbort)
        complete(value)
        if (!pending.settled && !pending.waiters.size && this.tickerTask === pending) {
          this.tickerTask = null
          pending.controller.abort(signal?.reason)
        }
      }
      const onAbort = () => finish(reject, signal.reason)
      pending.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.task.then(value => finish(resolve, value), error => finish(reject, error))
      if (signal?.aborted) onAbort()
    })
  },

  async checkCandidate(instrument, config, configKey, signal, priority = 'foreground', options = {}) {
    signal?.throwIfAborted()
    const key = `${configKey}:${JSON.stringify(instrument)}:${options.localOnly ? 'local' : 'remote'}`
    let entry = this.candidateAcquisitions.get(key)
    const remove = current => {
      if (this.candidateAcquisitions.get(key) !== current) return
      this.candidateAcquisitions.delete(key); this.candidateTasks.delete(key); this.pendingCandidates.delete(key); this.touchList()
    }
    if (!entry) {
      entry = { controller: new AbortController(), waiters: new Set(), settled: false, task: null }
      this.candidateAcquisitions.set(key, entry)
      this.pendingCandidates.set(key, { instId: instrument.instId, configKey })
      this.touchList()
      const current = entry
      entry.task = Promise.resolve().then(() => this.evaluateCandidate(instrument, config, configKey, current.controller.signal, priority, options))
        .finally(() => { current.settled = true; remove(current) })
      this.candidateTasks.set(key, entry.task)
    }
    return sharedWait(entry, signal, (current, reason) => {
      remove(current); this.track(current.task); current.controller.abort(reason)
    })
  },

  readQualificationCandles(query, signal) {
    return new Promise((resolve, reject) => {
      const request = { query, signal, resolve, reject }
      const abort = () => {
        const index = this.qualificationReadQueue.indexOf(request)
        if (index >= 0) this.qualificationReadQueue.splice(index, 1)
        reject(signal.reason)
      }
      if (signal.aborted) { abort(); return }
      request.abort = abort
      signal.addEventListener('abort', abort, { once: true })
      this.qualificationReadQueue.push(request)
      this.drainQualificationReads()
    })
  },

  drainQualificationReads() {
    // Wake only the next reader, rather than every waiting contract after
    // every completion. Network acquisition never occupies these four slots.
    while (this.qualificationReads.size < 4 && this.qualificationReadQueue.length) {
      const request = this.qualificationReadQueue.shift()
      request.signal.removeEventListener('abort', request.abort)
      const pending = Promise.resolve().then(() => {
        request.signal.throwIfAborted()
        return this.store.candles(request.query, 'foreground')
      }).then(request.resolve, request.reject).finally(() => {
        this.qualificationReads.delete(pending)
        this.drainQualificationReads()
      })
      this.qualificationReads.add(pending)
    }
  },

  async observeHistoricalSource(instId, key, observations, signal, acquire, current, ownerRecovery = null) {
    const timeframe = key === 'turnover' ? '5m' : '1H', count = key === 'turnover' ? 288 : 24, step = timeframeMilliseconds(timeframe)
    const calculate = (rows, end, from) => {
      if (key === 'turnover') {
        const turnover = quoteTurnover24h(rows, end)
        if (turnover === null) throw new Error('The completed 24-hour quote-volume range is incomplete.')
        return { turnover }
      }
      if (rows.length !== 24 || rows.some((row, index) => row.timestamp !== from + index * step || !row.confirmed || number(row.quoteVolume) === null)) throw new Error('Incomplete hourly source range.')
      return { rows }
    }
    const retireCompetingRecovery = () => {
      const recovery = this.sourceRecoveries.get(`${instId}:${key}`)
      if (recovery && recovery !== ownerRecovery) {
        this.cancelRequiredRecovery(recovery.key)
        this.scheduleMarketDeadline()
      }
    }
    while (current()) {
      signal.throwIfAborted()
      const end = closedBoundary(timeframe), from = end - count * step, through = end - step
      const cached = this.observation(observations, key)
      if (cached?.value.asOf === end) { retireCompetingRecovery(); return cached }
      const retained = this.historicalWindows.get(`${instId}:${timeframe}`)
      if (retained?.revision === this.liquidityHistoryRevision(instId, timeframe)
        && retained.storeRevision === this.store.candlePriceRevision(instId, timeframe)) {
        const missing = []
        for (let timestamp = from; timestamp <= through; timestamp += step) if (!retained.rows.has(timestamp)) missing.push(timestamp)
        // An intact rolling window needs only its subscribed final. Do not
        // rescan all historical rows or enqueue a repair just to await it.
        if (missing.length === 1 && missing[0] === through && await this.awaitRealtimeCandle({ instrument: instId, timeframe, from: through, through, signal })) {
          const mutation = this.candleMutations.get(instId)
          if (mutation) await abortable(mutation, signal)
          if (!this.historicalWindows.get(`${instId}:${timeframe}`)?.rows.has(through)) this.historicalWindows.delete(`${instId}:${timeframe}`)
          continue
        }
      }
      let revision = this.liquidityHistoryRevision(instId, timeframe), rows, value
      const read = () => {
        const windowKey = `${instId}:${timeframe}`, window = this.historicalWindows.get(windowKey)
        const storeRevision = this.store.candlePriceRevision(instId, timeframe)
        if (window?.revision === revision && window.storeRevision === storeRevision) {
          const rows = [...window.rows.values()].filter(row => row.timestamp >= from && row.timestamp <= through).sort((a, b) => a.timestamp - b.timestamp)
          try { return Promise.resolve({ rows, value: calculate(rows, end, from) }) }
          catch { /* A missing completed slot still needs durable local/source repair. */ }
        }
        const identity = `${instId}:${key}:${end}:${revision}`
        let task = this.historicalSourceReads.get(identity)
        if (!task) {
          task = this.readQualificationCandles({ instrument: instId, timeframe, from, through }, this.shutdownController.signal)
            .then(rows => {
              const value = calculate(rows, end, from)
              if (revision === this.liquidityHistoryRevision(instId, timeframe) && storeRevision === this.store.candlePriceRevision(instId, timeframe)) this.historicalWindows.set(windowKey, { rows: new Map(rows.map(row => [row.timestamp, row])), revision, storeRevision })
              return { rows, value }
            })
            .finally(() => { if (this.historicalSourceReads.get(identity) === task) this.historicalSourceReads.delete(identity) })
          this.historicalSourceReads.set(identity, task)
          this.track(task)
        }
        // One caller retiring cannot cancel another caller's canonical read.
        return abortable(task, signal)
      }
      try {
        ;({ rows, value } = await read())
        while (revision !== this.liquidityHistoryRevision(instId, timeframe)) {
          signal.throwIfAborted(); revision = this.liquidityHistoryRevision(instId, timeframe)
          ;({ rows, value } = await read())
        }
      } catch {
        signal.throwIfAborted()
        value = undefined
        if (revision !== this.liquidityHistoryRevision(instId, timeframe)) continue
        if (!acquire) throw new Error('The completed qualification window is not yet durable.')
        revision = this.liquidityHistoryRevision(instId, timeframe)
        rows = (await this.history.ensurePrices(instId, timeframe, from, through, 'continuity', signal)).rows
      }
      while (revision !== this.liquidityHistoryRevision(instId, timeframe)) {
        signal.throwIfAborted(); revision = this.liquidityHistoryRevision(instId, timeframe)
        ;({ rows, value } = await read())
      }
      signal.throwIfAborted()
      if (!current() || this.observations.get(instId) !== observations) return null
      if (end !== closedBoundary(timeframe)) continue
      value ??= calculate(rows, end, from)
      this.historicalWindows.set(`${instId}:${timeframe}`, { rows: new Map(rows.map(row => [row.timestamp, row])), revision, storeRevision: this.store.candlePriceRevision(instId, timeframe) })
      const observation = { value: { asOf: end, ...value }, observedAt: Date.now(), expiresAt: end + step }
      this.historicalInputs.set(observation, new Map(rows.map(row => [row.timestamp, row.quoteVolume])))
      this.markMarketDeadlineDirty(instId)
      observations[key] = observation
      if (this.observation(observations, key)) retireCompetingRecovery()
      return observation
    }
    return null
  },

  async evaluateCandidate(instrument, config, configKey, signal, priority, { localOnly = false } = {}) {
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const asOf = closedBoundary('5m')
    const instId = instrument.instId, observations = this.observations.get(instId) ?? {}
    // Keep in-flight historical facts in the same object that durable writes
    // invalidate. A correction during a live request cannot resurrect a copy.
    if (this.currentCandidate(instrument, configKey, signal)) { this.markMarketDeadlineDirty(instId); this.observations.set(instId, observations) }
    const errors = {}
    const ticker = this.tickerCache?.values.get(instId)
    if (this.observationExpiry(ticker, 'ticker', instId) > Date.now()) { this.markMarketDeadlineDirty(instId); observations.ticker = ticker }
    // Bulk spread observations can exclude a contract immediately. Never
    // download history or books to prove conditions that cannot admit it.
    const early = this.observedCandidate(instrument, config, configKey, { ticker: observations.ticker })
    if (early.status === 'failed') {
      return this.publishCandidate(instrument, config, configKey, signal, observations, errors)
    }
    const observeOpenInterest = async () => {
      try {
        let values = await this.openInterest.observe(signal, priority)
        if (values.values().next().value?.expiresAt <= Date.now()) values = await this.openInterest.observe(signal, priority)
        const observation = values.get(instId)
        if (!observation) throw new Error(`Missing open-interest observation for ${instId}.`)
        if (this.currentCandidate(instrument, configKey, signal)) this.acceptObservation(instId, 'openInterest', observation)
        delete errors.openInterest
      } catch (error) { errors.openInterest = error instanceof Error ? error.message : String(error) }
    }
    if (!localOnly && config.openInterest.enabled && !this.observation(observations, 'openInterest')) await observeOpenInterest()
    // An authoritative bulk rejection must not queue historical downloads or
    // local scans ahead of the contracts that can actually enter the list.
    if (this.cheapLiquidity(this.liquidityInput(instrument, config, observations)).status === 'failed') {
      return this.publishCandidate(instrument, config, configKey, signal, observations, errors)
    }
    const observeHistory = async key => {
      try { await this.observeHistoricalSource(instId, key, observations, signal, !localOnly, () => this.currentCandidate(instrument, configKey, signal)) }
      catch (error) { errors[key] = error instanceof Error ? error.message : String(error) }
    }
    const tasks = []
    if (config.volume24h.enabled && !(this.observation(observations, 'turnover')?.value.asOf === asOf)) tasks.push(observeHistory('turnover'))
    if (config.volumeStability.enabled && !(this.observation(observations, 'hourly')?.value.asOf === closedBoundary('1H', asOf))) tasks.push(observeHistory('hourly'))
    await Promise.all(tasks)
    // Fine-price acquisition may derive and correct an hourly window whose
    // independent read already finished. Reuse the final committed windows
    // before admission; a failed acquisition is not retried by this check.
    for (const [key, timeframe, rule] of [['turnover', '5m', 'volume24h'], ['hourly', '1H', 'volumeStability']]) {
      if (config[rule].enabled && !errors[key]
        && this.observation(observations, key)?.value.asOf !== closedBoundary(timeframe)) await observeHistory(key)
    }
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const historicalInput = this.liquidityInput(instrument, config, observations)
    const historicalResult = evaluateLiquidity({ instrument, config, asOf: historicalInput.asOf,
      turnover24hUSDT: historicalInput.turnover24hUSDT, hourlyCandles: historicalInput.hourlyCandles })
    // Historical repairs can take minutes. Obtain live liquidity only after
    // those repairs; acquire only a missing contract's bounded ticker fallback.
    // A known failing historical condition already excludes a contract; it
    // must not consume the live request budget needed by qualified contracts.
    const live = []
    if (!localOnly && historicalResult.status !== 'failed' && config.openInterest.enabled && !this.observation(observations, 'openInterest')) live.push(observeOpenInterest())
    if (!localOnly && historicalResult.status !== 'failed') live.push(this.tickerObservation(instId, signal, priority).then(value => {
      if (!value) throw new Error(`Missing ticker observation for ${instId}.`)
      if (this.currentCandidate(instrument, configKey, signal)) { this.markMarketDeadlineDirty(instId); observations.ticker = value }
    }).catch(error => { errors.ticker = error instanceof Error ? error.message : String(error) }))
    if (!localOnly && !this.publicRealtime?.started && historicalResult.status !== 'failed' && (config.depth.enabled || config.slippage.enabled) && !this.observation(observations, 'book')) live.push((async () => {
      try {
        const observation = await this.bookObservation(instId, signal, priority)
        if (this.currentCandidate(instrument, configKey, signal)) this.acceptObservation(instId, 'book', observation)
      } catch (error) { errors.book = error instanceof Error ? error.message : String(error) }
    })())
    await Promise.all(live)
    return this.publishCandidate(instrument, config, configKey, signal, observations, errors)
  },

  async publishCandidate(instrument, config, configKey, signal, observations, errors) {
    if (!this.currentCandidate(instrument, configKey, signal)) return
    const instId = instrument.instId
    this.markMarketDeadlineDirty(instId)
    this.observations.set(instId, observations)
    const now = Date.now()
    const record = this.observedCandidate(instrument, config, configKey, observations, errors, now)
    record.preferencesRevision = this.metadata.getSettings().revision
    const { status } = record
    if (status === 'unknown') this.recoverRequiredSources(instId)
    this.metadata.putCatalogEntry(record)
    this.catalogChecks.set(instId, record)
    this.scheduleSubscriptions()
    if (status === 'verified') this.renewalTargets.set(instId, instrument)
    else if (status === 'failed') this.renewalTargets.delete(instId)
    this.catalogPublications.set(instId, { record, signal })
    // A bulk snapshot completes many candidates in the same turn. Publish
    // them together instead of rebuilding every row and subscription N times.
    this.catalogPublicationTask ??= Promise.resolve().then(() => {
      this.catalogPublicationTask = null
      const records = [...this.catalogPublications.values()]; this.catalogPublications.clear()
      if (this.disposed) return
      const next = new Map(this.catalog)
      for (const { record, signal } of records) {
        if (this.catalogChecks.get(record.instrumentID) !== record || !this.currentCandidate(record.instrument, record.configKey, signal)) continue
        // The subscription ACK may have arrived between validation and this
        // deferred publication. Bind continuity once both facts are present.
        this.rememberHistoricalAssessment(record)
        if (this.validCatalogEntry(record)) next.set(record.instrumentID, record)
        else next.delete(record.instrumentID)
      }
      this.catalogSource = 'live'
      this.catalogUpdatedAt = Date.now()
      this.replaceCatalog([...next.values()])
      this.touchList()
    })
    await this.catalogPublicationTask
    if (this.catalogChecks.get(instId) !== record || !this.currentCandidate(instrument, configKey, signal)) return
  },

  currentCandidate(instrument, configKey, signal) {
    const current = this.instruments.get(instrument.instId)
    return !this.disposed && !signal.aborted && this.catalogCriteriaKey() === configKey
      && (!this.candidateIDs || this.candidateIDs.has(instrument.instId))
      && (!current || JSON.stringify(current) === JSON.stringify(instrument))
  },

  waitForInstrumentSubscription(signal) {
    if (this.instrumentStream || !this.publicRealtime.started || !this.publicRealtime.subscriptions.has('instruments:SWAP')) return Promise.resolve()
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal.reason) }
      const cleanup = () => {
        clearTimeout(timer)
        this.instrumentSubscriptionWaiters.delete(finish)
        signal.removeEventListener('abort', abort)
      }
      const timer = setTimeout(finish, TICKER_BOOTSTRAP_MS)
      this.instrumentSubscriptionWaiters.add(finish)
      signal.addEventListener('abort', abort, { once: true })
    })
  },
}
