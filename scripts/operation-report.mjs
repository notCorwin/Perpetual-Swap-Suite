#!/usr/bin/env node
import { mkdir, opendir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isOperationJournal, operationJournalExecutionId, readOperationJournal } from '../electron/services/operation-journal.js'
import { graphicsCapabilities, graphicsAccelerationSupport } from '../electron/services/graphics-trace.js'

export const operationCategories = ['cpu', 'gpu', 'network', 'database', 'io', 'ipc']
export function operationRequirementKey(value) {
  const name = typeof value === 'string' ? value : value?.name
  const source = typeof value === 'string' ? undefined : value?.source
  if (typeof name !== 'string' || !name || name.length > 160 || source !== undefined && source !== 'native') throw new Error('Required operations need a name of at most 160 characters and an optional native source.')
  return JSON.stringify([name, source ?? null])
}
const statuses = new Set(['ok', 'error', 'cancelled'])
const lifecycleFields = ['traceId', 'parentId', 'sessionId', 'scenarioId', 'category', 'name', 'resource', 'startedAt']
const counters = ['calls', 'queryCount', 'rows', 'changes', 'bytes', 'sentBytes', 'receivedBytes']
const peaks = ['residentKB', 'cpuPercent']
const bucketLimits = Array.from({ length: 25 }, (_, index) => 2 ** (index - 4))
const aggregate = () => ({ count: 0, errors: 0, cancelled: 0, totalMS: 0, maxMS: 0, cpuTimeMS: 0,
  work: Object.fromEntries(counters.map(key => [key, 0])), peaks: Object.fromEntries(peaks.map(key => [key, null])),
  buckets: Array(bucketLimits.length + 1).fill(0) })
const label = value => typeof value === 'string' ? value.slice(0, 240) : ''
const substantive = event => !/^(diagnostics|runtime|operation-recording)\./.test(event.name)
function add(target, event) {
  target.count++; target.errors += Number(event.status === 'error'); target.cancelled += Number(event.status === 'cancelled')
  target.totalMS += event.durationMS; target.maxMS = Math.max(target.maxMS, event.durationMS)
  target.cpuTimeMS += Number.isFinite(event.cpuTimeMS) && event.cpuTimeMS >= 0 ? event.cpuTimeMS : 0
  for (const key of counters) if (Number.isFinite(event.attributes?.[key]) && event.attributes[key] >= 0) target.work[key] += event.attributes[key]
  for (const key of peaks) if (Number.isFinite(event.attributes?.[key]) && event.attributes[key] >= 0) target.peaks[key] = Math.max(target.peaks[key] ?? 0, event.attributes[key])
  const bucket = bucketLimits.findIndex(limit => event.durationMS <= limit)
  target.buckets[bucket < 0 ? bucketLimits.length : bucket]++
}
function finish(value) {
  let cumulative = 0, p95UpperBoundMS = null
  for (let index = 0; value.count && index < value.buckets.length; index++) {
    cumulative += value.buckets[index]
    if (cumulative >= value.count * .95) { p95UpperBoundMS = bucketLimits[index] ?? null; break }
  }
  const { buckets: _buckets, ...result } = value
  return { ...result, averageMS: value.count ? value.totalMS / value.count : 0, p95UpperBoundMS }
}
const recordingFile = path => isOperationJournal(path) || /\.(health\.json|participant\.json)$/.test(path) || /(?:chromium|graphics-check|metal)-[^/]+\.status\.json$/.test(path)
async function* traceFiles(path, depth = 0) {
  const info = await stat(path)
  if (info.isFile()) { if (recordingFile(path)) yield path; return }
  if (!info.isDirectory() || depth > 8) return
  if (depth === 0) {
    try { if ((await stat(join(path, 'operations'))).isDirectory()) { yield* traceFiles(join(path, 'operations'), 1); return } }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for await (const entry of await opendir(path)) {
    if (entry.isFile() && recordingFile(entry.name)) yield join(path, entry.name)
    else if (entry.isDirectory()) yield* traceFiles(join(path, entry.name), depth + 1)
  }
}
async function readMetadata(file, maxBytes) {
  if ((await stat(file)).size > maxBytes) throw new Error('Recording metadata exceeds the bounded size limit.')
  return JSON.parse(await readFile(file, 'utf8'))
}
async function artifactPath(owner, value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0') || isAbsolute(value)) throw new Error('Evidence path must be relative.')
  let container = dirname(owner), rootDirectory = container
  for (let depth = 0; depth < 8; depth++) {
    if (basename(container) === 'operations') { rootDirectory = dirname(container); break }
    const parent = dirname(container)
    if (parent === container) break
    container = parent
  }
  const root = await realpath(rootDirectory)
  const candidate = await realpath(resolve(dirname(owner), value)), within = relative(root, candidate)
  if (within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(within)) throw new Error('Evidence is outside its run.')
  if (!(await stat(candidate)).isFile()) throw new Error('Evidence is not a file.')
  return candidate
}
async function artifactDigest(file) {
  const digest = createHash('sha256'); let bytes = 0
  for await (const chunk of createReadStream(file)) {
    if ((bytes += chunk.length) > 32 * 1024 * 1024) throw new Error('Evidence exceeds its byte limit.')
    digest.update(chunk)
  }
  return digest.digest('hex')
}
async function validatePng(file) {
  const handle = await open(file, 'r'), header = Buffer.alloc(24)
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead !== 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR'
      || !header.readUInt32BE(16) || !header.readUInt32BE(20) || header.readUInt32BE(16) > 32768 || header.readUInt32BE(20) > 32768) throw new Error('Invalid PNG evidence.')
  } finally { await handle.close() }
}
function validEvent(event) {
  const native = ['gpu.native-task', 'gpu.metal-command-buffer'].includes(event?.name)
  const timing = event?.attributes
  return (!native || event.category === 'gpu' && event.durationMS === 0 && timing?.source === 'native'
    && ['service-clock', 'device-clock'].includes(timing.measurement) && typeof timing.clockDomain === 'string'
    && Number.isFinite(timing.nativeTimestampUS) && timing.nativeTimestampUS >= 0
    && Number.isFinite(timing.nativeDurationUS) && timing.nativeDurationUS >= 0
    && typeof timing.nativeEventId === 'string')
    && event?.schemaVersion === 2 && operationCategories.includes(event.category)
    && ['start', 'end'].includes(event.phase) && (event.phase === 'start' ? event.status === 'running' && event.durationMS === 0 : statuses.has(event.status))
    && ['id', 'sessionId', 'executionId', 'traceId', 'name'].every(key => typeof event[key] === 'string' && event[key].length > 0 && event[key].length <= 512)
    && Number.isSafeInteger(event.sequence) && event.sequence > 0 && Number.isFinite(event.startedAt) && Number.isFinite(event.durationMS) && event.durationMS >= 0
}

// Journal streaming, lifecycle tracking, metadata indexes and aggregate
// cardinality all have explicit bounds. A limit makes the report fail closed.
export async function summarizeOperations(path, { maxGroups = 256, maxLineBytes = 128 * 1024, slowestLimit = 20,
  maxFiles = 10_000, maxOpenOperations = 4096, allowEmpty = false, requireCategories = [], requireRoles = [], requireOperations = [], graphics } = {}) {
  for (const [name, value] of Object.entries({ maxGroups, maxLineBytes, maxFiles, maxOpenOperations })) if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  if (!Number.isInteger(slowestLimit) || slowestLimit < 0) throw new Error('slowestLimit must be a nonnegative integer.')
  if (requireCategories.some(category => !operationCategories.includes(category))) throw new Error('Unknown required operation category.')
  if (graphics && (!['auto', 'require-accelerated', 'require-hardware-timing'].includes(graphics.policy) || !['chromium', 'metal'].includes(graphics.provider))) throw new Error('Invalid graphics coverage policy.')
  const total = aggregate(), byCategory = Object.fromEntries(operationCategories.map(category => [category, aggregate()]))
  const groups = new Map(), operations = new Map(), overflow = Object.fromEntries(operationCategories.map(category => [category, aggregate()])),
    operationOverflow = Object.fromEntries(operationCategories.map(category => [category, aggregate()])), slowest = [], nativeTraces = [], abandoned = new Map()
  const healthRecords = new Map(), executions = new Map(), participants = new Map(), actualCategories = new Set()
  const missingOperations = new Map(requireOperations.map(value => [operationRequirementKey(value), value]))
  let journalRecords = 0, substantiveOperations = 0, visitedFiles = 0, abandonedOverflow = 0
  const storage = { storedBytes: 0, decodedBytes: 0, compressedFiles: 0, plainFiles: 0 }
  const graphicsChecks = [], metalProviders = [], nativeTiming = new Map(), nativeCounts = new Map(), nativeEvidence = new Map()
  let nativeIdentities = 0
  const diagnostics = { files: 0, lines: 0, malformed: 0, oversized: 0, unterminated: 0, incomplete: 0, groupedOverflow: 0,
    recorderHealthFiles: 0, persistenceFailures: 0, journalReadFailures: 0, pendingRecords: 0, undurableRecords: 0, sourceFailures: 0, omittedRecords: 0, activeOperations: 0,
    unclosedExecutions: 0, recorderCountMismatches: 0, recorderByteMismatches: 0, missingRecords: 0,
    sequenceGaps: 0, duplicateSequences: 0, duplicateOperationIds: 0, unmatchedEnds: 0, unclosedOperations: 0, mismatchedLifecycles: 0,
    lifecycleLimitReached: 0, missingParticipantHealth: 0, missingParticipantJournals: 0, unclaimedParticipants: 0, missingParticipantRegistrations: 0,
    nativeGpuStatusFiles: 0, incompleteNativeGpuTraces: 0, graphicsCoverageFailures: 0, nativeTimingLimitReached: 0, emptyRecording: 0, missingRequiredCategories: 0, missingRequiredRoles: 0, missingRequiredOperations: 0,
    fileLimitReached: false, examples: [] }
  const problem = (kind, file, line, detail) => {
    diagnostics[kind]++
    if (diagnostics.examples.length < 20) diagnostics.examples.push({ kind, file, line, ...(detail ? { detail: label(detail) } : {}) })
  }
  const abandon = event => {
    const key = JSON.stringify([event.category, label(event.name), label(event.resource)])
    let group = abandoned.get(key)
    if (!group && abandoned.size < maxGroups) { group = { category: event.category, name: label(event.name), resource: label(event.resource), count: 0 }; abandoned.set(key, group) }
    if (group) group.count++; else abandonedOverflow++
  }
  const completed = event => {
    add(total, event); add(byCategory[event.category], event)
    const timing = event.attributes
    if (event.category === 'gpu' && timing?.source === 'native' && ['gpu.native-task', 'gpu.metal-command-buffer'].includes(event.name)) {
      const key = JSON.stringify([event.executionId, event.name])
      nativeCounts.set(key, (nativeCounts.get(key) ?? 0) + 1)
      const pattern = event.name === 'gpu.native-task' ? /^([a-f0-9]{64}):(\d+)$/ : /^metal:([1-9]\d*):([1-9]\d*)$/
      const identity = pattern.exec(timing.nativeEventId)
      let proof = nativeEvidence.get(key)
      if (!proof) { proof = { ids: new Set(), digests: new Set(), clocks: new Set(), pids: new Set(), sessions: new Set(),
        timing: { count: 0, firstTimestampUS: null, lastTimestampUS: null, minDurationUS: null, maxDurationUS: null }, perPidTiming: new Map(), nativeErrors: 0 }; nativeEvidence.set(key, proof) }
      if (!identity || proof.ids.has(timing.nativeEventId)) problem('graphicsCoverageFailures', event.executionId, 0, 'Invalid or duplicated native event identity')
      else if (++nativeIdentities > 250_000) problem('nativeTimingLimitReached', event.executionId, 0, 'Native event identity limit exceeded')
      else {
        proof.ids.add(timing.nativeEventId); proof.clocks.add(timing.clockDomain); proof.pids.add(timing.processId); proof.sessions.add(event.sessionId)
        if (event.name === 'gpu.native-task') proof.digests.add(identity[1])
        else if (!Number.isSafeInteger(timing.processId) || timing.processId < 1 || Number(identity[1]) !== timing.processId || Number(identity[2]) !== timing.sequence) problem('graphicsCoverageFailures', event.executionId, 0, 'Metal identity does not match its native process/sequence')
        else {
          if (timing.measurement !== 'device-clock' || timing.clockDomain !== 'METAL_HOST_MONOTONIC' || timing.nativeEventName !== 'MTLCommandBuffer') problem('graphicsCoverageFailures', event.executionId, 0, 'Metal observation is not a validated device-clock command buffer')
          proof.nativeErrors += Number(event.status !== 'ok' || timing.nativeStatus !== 4)
          if (!proof.perPidTiming.has(timing.processId) && proof.perPidTiming.size < 32) proof.perPidTiming.set(timing.processId,
            { count: 0, firstTimestampUS: null, lastTimestampUS: null, minDurationUS: null, maxDurationUS: null })
          const perPid = proof.perPidTiming.get(timing.processId)
          if (!perPid) problem('nativeTimingLimitReached', event.executionId, 0, 'Metal process timing cardinality exceeded')
          else if (event.status === 'ok' && timing.nativeTimestampUS > 0 && timing.nativeDurationUS > 0) {
            const end = timing.nativeTimestampUS + timing.nativeDurationUS
            if (!Number.isFinite(end)) problem('graphicsCoverageFailures', event.executionId, 0, 'Metal native timestamp range is invalid')
            else for (const aggregate of [proof.timing, perPid]) {
              aggregate.count++
              aggregate.firstTimestampUS = aggregate.firstTimestampUS === null ? timing.nativeTimestampUS : Math.min(aggregate.firstTimestampUS, timing.nativeTimestampUS)
              aggregate.lastTimestampUS = aggregate.lastTimestampUS === null ? end : Math.max(aggregate.lastTimestampUS, end)
              aggregate.minDurationUS = aggregate.minDurationUS === null ? timing.nativeDurationUS : Math.min(aggregate.minDurationUS, timing.nativeDurationUS)
              aggregate.maxDurationUS = aggregate.maxDurationUS === null ? timing.nativeDurationUS : Math.max(aggregate.maxDurationUS, timing.nativeDurationUS)
            }
          }
        }
      }
    }
    if (event.category === 'gpu' && timing?.source === 'native' && ['service-clock', 'device-clock'].includes(timing.measurement)
      && Number.isFinite(timing.nativeDurationUS) && timing.nativeDurationUS >= 0 && timing.reason !== 'gpu-clock-disjoint') {
      const key = JSON.stringify([timing.measurement, label(timing.clockDomain ?? 'unknown')])
      if (!nativeTiming.has(key) && nativeTiming.size < 32) nativeTiming.set(key, { measurement: timing.measurement, clockDomain: label(timing.clockDomain ?? 'unknown'), count: 0, errors: 0, zeroTimings: 0, totalMS: 0, maxMS: 0 })
      const group = nativeTiming.get(key)
      if (group) { const ms = timing.nativeDurationUS / 1000; group.count++; group.errors += Number(event.status !== 'ok'); group.zeroTimings += Number(ms === 0); group.totalMS += ms; group.maxMS = Math.max(group.maxMS, ms) }
      else problem('nativeTimingLimitReached', event.executionId, 0, 'Native timing clock cardinality exceeded')
    }
    if (substantive(event)) { substantiveOperations++; actualCategories.add(event.category) }
    if (event.status === 'ok' && event.attributes?.incomplete !== true && event.attributes?.interrupted !== true) {
      missingOperations.delete(JSON.stringify([event.name, null]))
      if (event.attributes?.source === 'native') missingOperations.delete(JSON.stringify([event.name, 'native']))
    }
    const name = label(event.name), resource = label(event.resource), key = JSON.stringify([event.category, name, resource])
    const operationKey = JSON.stringify([event.category, name])
    let operation = operations.get(operationKey)
    if (!operation && operations.size < 256) { operation = { category: event.category, name, ...aggregate() }; operations.set(operationKey, operation) }
    add(operation ?? operationOverflow[event.category], event)
    let group = groups.get(key)
    if (!group && groups.size < maxGroups) { group = { category: event.category, name, resource, ...aggregate() }; groups.set(key, group) }
    if (group) add(group, event); else { add(overflow[event.category], event); diagnostics.groupedOverflow++ }
    if (slowestLimit && (slowest.length < slowestLimit || event.durationMS > slowest.at(-1).durationMS)) {
      slowest.push({ id: label(event.id), traceId: label(event.traceId), ...(event.parentId ? { parentId: label(event.parentId) } : {}),
        sessionId: label(event.sessionId), executionId: label(event.executionId), scenarioId: label(event.scenarioId ?? event.attributes?.scenarioId),
        category: event.category, name, resource, startedAt: event.startedAt, durationMS: event.durationMS, status: event.status })
      slowest.sort((left, right) => right.durationMS - left.durationMS)
      if (slowest.length > slowestLimit) slowest.pop()
    }
  }
  for await (const file of traceFiles(resolve(path))) {
    if (visitedFiles++ >= maxFiles) { diagnostics.fileLimitReached = true; break }
    if (!isOperationJournal(file)) {
      try {
        const metadata = await readMetadata(file, maxLineBytes)
        if (file.endsWith('.participant.json')) {
          if (metadata.schemaVersion !== 2 || typeof metadata.id !== 'string' || !metadata.id || typeof metadata.role !== 'string' || !metadata.role) throw new Error('Invalid participant.')
          if (participants.has(metadata.id)) problem('malformed', file, 1, 'Duplicate participant registration')
          participants.set(metadata.id, { id: metadata.id, role: label(metadata.role), executionId: metadata.executionId, status: metadata.status, parentExecutionId: metadata.parentExecutionId, file })
        } else if (file.endsWith('.health.json')) {
          if (metadata.schemaVersion !== 2) throw new Error('Invalid health schema.')
          if (['recorded', 'recordedOperations', 'persisted', 'failed', 'pending', 'sourceFailures', 'omittedRecords', 'activeOperations'].some(key => !Number.isSafeInteger(metadata[key]) || metadata[key] < 0)
            || typeof metadata.closed !== 'boolean') throw new Error('Invalid recorder health counters.')
          if (metadata.hookCapabilities !== undefined && (!Array.isArray(metadata.hookCapabilities) || metadata.hookCapabilities.length > 512
            || metadata.hookCapabilities.some(value => !value || typeof value.api !== 'string' || !value.api || value.api.length > 240
              || typeof value.enabled !== 'boolean' || typeof value.scope !== 'string' || value.scope.length > 240
              || value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 240)))) throw new Error('Invalid native API capability inventory.')
          const executionId = metadata.executionId ?? basename(file, '.health.json')
          if (healthRecords.has(executionId)) problem('malformed', file, 1, 'Duplicate execution health')
          healthRecords.set(executionId, { executionId, file, participantId: metadata.participantId, role: label(metadata.role),
            recorded: metadata.recorded, recordedOperations: metadata.recordedOperations, persisted: metadata.persisted, durableRecords: metadata.durableRecords,
            journalBytes: metadata.journalBytes, uncompressedBytes: metadata.uncompressedBytes,
            failed: metadata.failed, pending: metadata.pending, closed: metadata.closed,
            sourceFailures: metadata.sourceFailures, omittedRecords: metadata.omittedRecords, activeOperations: metadata.activeOperations,
            durability: label(metadata.durability),
            hookCapabilities: Array.isArray(metadata.hookCapabilities) ? metadata.hookCapabilities.map(value => ({
              api: label(value.api), enabled: value.enabled === true, scope: label(value.scope), ...(value.reason ? { reason: label(value.reason) } : {}) })) : [],
            enabledHooks: Array.isArray(metadata.enabledHooks) ? metadata.enabledHooks.filter(value => typeof value === 'string').slice(0, 128).map(label) : [] })
          diagnostics.recorderHealthFiles++
        } else if (metadata.kind === 'graphics-check') {
          if (metadata.schemaVersion !== 1 || !['auto', 'require-accelerated', 'require-hardware-timing'].includes(metadata.policy)
            || !['chromium', 'metal'].includes(metadata.provider) || !['passed', 'unsupported'].includes(metadata.status)
            || typeof metadata.evidence?.statusFile !== 'string') throw new Error('Invalid graphics coverage decision.')
          if (graphicsChecks.length >= 128) throw new Error('Too many graphics coverage decisions.')
          graphicsChecks.push({ ...metadata, statusFile: await realpath(file) })
        } else if (metadata.kind === 'metal-capability') {
          if (metadata.schemaVersion !== 1 || metadata.provider !== 'metal-command-buffer' || metadata.clock !== 'metal-host-monotonic-seconds'
            || !Array.isArray(metadata.actualGpuPids) || !Array.isArray(metadata.processes) || !Array.isArray(metadata.issues)) throw new Error('Invalid Metal capability.')
          if (metalProviders.length >= 128) throw new Error('Too many Metal providers.')
          metalProviders.push({ ...metadata, statusFile: await realpath(file) })
        } else {
          diagnostics.nativeGpuStatusFiles++
          if (metadata.schemaVersion !== 2 || typeof metadata.requested !== 'boolean' || typeof metadata.enabled !== 'boolean'
            || typeof metadata.complete !== 'boolean' || !metadata.system || typeof metadata.system !== 'object') throw new Error('Invalid native GPU status.')
          if (metadata.error || metadata.enabled && !metadata.complete) problem('incompleteNativeGpuTraces', file, 1)
          let traceFile
          if (metadata.enabled && metadata.complete) {
            try { traceFile = await artifactPath(file, metadata.file) }
            catch { problem('incompleteNativeGpuTraces', file, 1, 'Completed native GPU trace file is absent') }
          }
          if (nativeTraces.length < 128) nativeTraces.push({ statusFile: await realpath(file), enabled: metadata.enabled === true, complete: metadata.complete === true,
            executionId: metadata.executionId, sessionId: metadata.sessionId,
            requested: metadata.requested === true, system: metadata.system, features: metadata.features, trace: metadata.trace,
            capabilities: metadata.schemaVersion === 2 ? graphicsCapabilities(metadata) : undefined,
            ...(typeof metadata.file === 'string' ? { traceFile: traceFile ?? metadata.file } : {}), ...(typeof metadata.error === 'string' ? { error: metadata.error } : {}),
            ...(Number.isFinite(metadata.bufferUsage?.percentage) ? { bufferUsed: metadata.bufferUsage.percentage } : {}) })
        }
      } catch { problem('malformed', file, 1) }
      continue
    }
    diagnostics.files++
    const storedBytes = (await stat(file)).size
    storage.storedBytes += storedBytes
    storage[file.endsWith('.gz') ? 'compressedFiles' : 'plainFiles']++
    const active = new Map(), recentlyEnded = new Set()
    let fileExecutionId = operationJournalExecutionId(basename(file)), rawCount = 0, endCount = 0, previousSequence = 0, decodedBytes = 0
    const consume = (buffer, line) => {
      diagnostics.lines++
      if (!buffer.length) return
      let event
      try { event = JSON.parse(buffer.toString('utf8')) } catch { problem('malformed', file, line); return }
      if (!validEvent(event)) { problem('malformed', file, line); return }
      journalRecords++; rawCount++
      if (rawCount === 1) fileExecutionId = event.executionId
      if (event.executionId !== fileExecutionId) problem('mismatchedLifecycles', file, line, 'Multiple execution IDs in one journal')
      if (event.sequence <= previousSequence) problem('duplicateSequences', file, line)
      else if (event.sequence > previousSequence + 1) diagnostics.sequenceGaps += event.sequence - previousSequence - 1
      previousSequence = Math.max(previousSequence, event.sequence)
      if (event.phase === 'start') {
        if (active.has(event.id) || recentlyEnded.has(event.id)) problem('duplicateOperationIds', file, line, event.name)
        else if (active.size >= maxOpenOperations) { problem('lifecycleLimitReached', file, line, event.name); abandon(event) }
        else active.set(event.id, Object.fromEntries(['id', ...lifecycleFields].map(key => [key, event[key]])))
        return
      }
      endCount++
      const start = active.get(event.id)
      if (!start) problem(recentlyEnded.has(event.id) ? 'duplicateOperationIds' : 'unmatchedEnds', file, line, event.name)
      else {
        if (lifecycleFields.some(key => start[key] !== event[key])) problem('mismatchedLifecycles', file, line, event.name)
        active.delete(event.id)
      }
      recentlyEnded.add(event.id)
      if (recentlyEnded.size > maxOpenOperations) recentlyEnded.delete(recentlyEnded.values().next().value)
      if (event.attributes?.incomplete === true || event.attributes?.interrupted === true) problem('incomplete', file, line, event.name)
      completed(event)
    }
    let pending = Buffer.alloc(0), oversized = false, line = 1
    try { for await (const chunk of readOperationJournal(file)) {
      decodedBytes += chunk.length; storage.decodedBytes += chunk.length
      let from = 0
      while (from < chunk.length) {
        const newline = chunk.indexOf(10, from), through = newline < 0 ? chunk.length : newline, piece = chunk.subarray(from, through)
        if (!oversized) {
          if (pending.length + piece.length > maxLineBytes) { problem('oversized', file, line); oversized = true; pending = Buffer.alloc(0) }
          else if (piece.length) pending = pending.length ? Buffer.concat([pending, piece]) : Buffer.from(piece)
        }
        if (newline < 0) break
        if (!oversized) consume(pending, line)
        pending = Buffer.alloc(0); oversized = false; line++; from = newline + 1
      }
    } } catch (error) { problem('journalReadFailures', file, line, error.code ?? error.name) }
    if (pending.length || oversized) { problem('unterminated', file, line); if (!oversized) consume(pending, line) }
    for (const event of active.values()) { problem('unclosedOperations', file, 0, event.name); abandon(event) }
    if (executions.has(fileExecutionId)) problem('malformed', file, 0, 'Multiple journals for one execution')
    executions.set(fileExecutionId, { rawCount, endCount, file, storedBytes, decodedBytes })
  }
  for (const [id, health] of healthRecords) {
    const execution = executions.get(id), actual = execution?.rawCount ?? 0
    diagnostics.persistenceFailures += Number.isFinite(health.failed) && health.failed > 0 ? health.failed : 0
    diagnostics.pendingRecords += Number.isFinite(health.pending) && health.pending > 0 ? health.pending : 0
    if (health.durableRecords !== undefined) {
      if (!Number.isSafeInteger(health.durableRecords) || health.durableRecords < 0 || health.durableRecords > health.persisted) problem('malformed', health.file, 0, 'Invalid durable record count')
      else diagnostics.undurableRecords += Math.max(0, actual - health.durableRecords)
    }
    for (const key of ['sourceFailures', 'omittedRecords', 'activeOperations']) diagnostics[key] += Number.isFinite(health[key]) && health[key] > 0 ? health[key] : 0
    if (health.closed !== true) problem('unclosedExecutions', health.file, 0)
    if (!execution) problem('missingParticipantJournals', health.file, 0)
    if (health.recorded !== actual || health.persisted !== actual || Number.isFinite(health.recordedOperations) && health.recordedOperations !== execution?.endCount) problem('recorderCountMismatches', health.file, 0)
    for (const [declared, measured] of [['journalBytes', 'storedBytes'], ['uncompressedBytes', 'decodedBytes']]) {
      if (health[declared] !== undefined && (!Number.isSafeInteger(health[declared]) || health[declared] < 0 || health[declared] !== execution?.[measured])) problem('recorderByteMismatches', health.file, 0, declared)
    }
    diagnostics.missingRecords += Number.isFinite(health.recorded) ? Math.max(0, health.recorded - actual) : 0
    if (health.participantId && !participants.has(health.participantId)) problem('missingParticipantRegistrations', health.file, 0)
  }
  for (const [id, execution] of executions) if (!healthRecords.has(id)) problem('unclosedExecutions', execution.file, 0, 'Missing recorder health')
  const roles = new Set(), participantCoverage = []
  for (const [id, participant] of participants) {
    const health = participant.executionId ? healthRecords.get(participant.executionId) : undefined
    const claimed = participant.status === 'ready' && typeof participant.executionId === 'string' && participant.executionId.length > 0
    if (!claimed) problem('unclaimedParticipants', participant.file, 0, participant.role)
    else if (!health || health.participantId !== id || health.role !== participant.role) problem('missingParticipantHealth', participant.file, 0, participant.role)
    if (claimed && !executions.has(participant.executionId)) problem('missingParticipantJournals', participant.file, 0, participant.role)
    const healthy = Boolean(health?.closed && health.failed === 0 && health.pending === 0 && !(health.sourceFailures > 0) && !(health.omittedRecords > 0) && !(health.activeOperations > 0))
    if (claimed && healthy && health.participantId === id && health.role === participant.role && executions.has(participant.executionId)) roles.add(participant.role)
    participantCoverage.push({ id, role: participant.role, executionId: participant.executionId ?? null,
      enabledHooks: Array.isArray(health?.enabledHooks) ? health.enabledHooks.filter(value => typeof value === 'string').slice(0, 128) : [],
      hookCapabilities: health?.hookCapabilities ?? [],
      durability: health?.durability ?? '', claimed,
      healthy })
  }
  const missingCategories = [...new Set(requireCategories)].filter(category => !actualCategories.has(category))
  const missingRoles = [...new Set(requireRoles)].filter(role => !roles.has(role))
  if (graphics && !graphicsChecks.length) problem('graphicsCoverageFailures', resolve(path), 0, 'Missing graphics capability decision')
  for (const decision of graphicsChecks) {
    let source, metal
    try {
      const sourceFile = await artifactPath(decision.statusFile, decision.evidence.statusFile)
      source = nativeTraces.find(value => resolve(value.statusFile) === sourceFile)
      if (decision.evidence.metalStatusFile) {
        const metalFile = await artifactPath(decision.statusFile, decision.evidence.metalStatusFile)
        metal = metalProviders.find(value => resolve(value.statusFile) === metalFile)
      }
    } catch { problem('graphicsCoverageFailures', decision.statusFile, 0, 'Missing or unsafe graphics capability evidence'); continue }
    const capabilities = source ? graphicsCapabilities(source, decision.provider === 'metal' ? metal : undefined) : undefined
    decision.validatedCapabilities = capabilities ?? null
    const invalid = detail => problem('graphicsCoverageFailures', decision.statusFile, 0, detail)
    if (graphics && (decision.policy !== graphics.policy || decision.provider !== graphics.provider)) invalid('Graphics decision does not match requested policy/provider')
    if (!source || !source.executionId || source.executionId !== decision.evidence.executionId || source.sessionId !== decision.evidence.sessionId) { invalid('Missing matching Chromium execution evidence'); continue }
    if (decision.status === 'unsupported') {
      if (decision.policy !== 'auto' || graphicsAccelerationSupport(source).state !== 'unsupported') invalid('Unverified unsupported graphics environment')
      continue
    }
    if (!capabilities.hardwareAcceleration || !capabilities.nativeTrace || !capabilities.nativeServiceTasks) invalid('Required accelerated native graphics work was not observed')
    try { if (!source.traceFile || await artifactDigest(source.traceFile) !== source.trace?.sha256) invalid('Native graphics trace differs from its cached digest') }
    catch { invalid('Native graphics trace is unreadable or oversized') }
    if (decision.policy === 'require-hardware-timing' && !capabilities.hardwareTiming) invalid('Complete hardware-clock timing was not observed')
    if (!Number.isSafeInteger(decision.evidence.nativeOperationCount) || decision.evidence.nativeOperationCount < 1
      || decision.evidence.nativeOperationCount !== (nativeCounts.get(JSON.stringify([source.executionId, 'gpu.native-task'])) ?? 0)
      || decision.evidence.nativeOperationCount !== source.trace?.completedTasks) invalid('Native graphics observations are absent from the owning journal')
    const chromiumProof = nativeEvidence.get(JSON.stringify([source.executionId, 'gpu.native-task']))
    if (!chromiumProof || chromiumProof.digests.size !== 1 || !chromiumProof.digests.has(source.trace?.sha256)
      || chromiumProof.clocks.size !== 1 || !chromiumProof.clocks.has(source.trace?.clockDomain)
      || chromiumProof.sessions.size !== 1 || !chromiumProof.sessions.has(source.sessionId)) invalid('Native journal identity or clock differs from its trace cache')
    const requiredRoles = ['electron-main', 'renderer', 'market-backend', 'market-reader', 'market-writer', 'prepared-chart']
    const ownedExecutions = new Set([source.executionId])
    for (let changed = true; changed;) {
      changed = false
      for (const participant of participants.values()) if (ownedExecutions.has(participant.parentExecutionId) && !ownedExecutions.has(participant.executionId)) {
        ownedExecutions.add(participant.executionId); changed = true
      }
    }
    const ownedRoles = new Set(participantCoverage.filter(value => value.healthy && value.claimed && ownedExecutions.has(value.executionId)).map(value => value.role))
    if (requiredRoles.some(role => !ownedRoles.has(role))) invalid('Accelerated graphics work did not retain every required application participant')
    if (!Array.isArray(decision.evidence.captureFiles) || decision.evidence.captureFiles.length !== 3) invalid('Missing real chart capture evidence')
    else {
      const captures = new Set()
      for (const capture of decision.evidence.captureFiles) {
      try { const file = await artifactPath(decision.statusFile, capture); if (captures.has(file)) throw new Error('Repeated capture'); captures.add(file); await validatePng(file) }
      catch { invalid('A chart capture file is absent') }
      }
    }
    if (decision.provider === 'metal') {
      if (!metal || !capabilities.hardwareTiming) invalid('Missing complete Metal hardware timing evidence')
      if (!(nativeCounts.get(JSON.stringify([source.executionId, 'gpu.metal-command-buffer'])) > 0)) invalid('Metal completions are absent from the owning journal')
      if (metal) {
        if (nativeCounts.get(JSON.stringify([source.executionId, 'gpu.metal-command-buffer'])) !== metal.stats?.completions) invalid('Metal completion count differs from its owning journal')
        if (decision.evidence.metalOperationCount !== metal.stats?.completions) invalid('Metal decision count differs from its owning journal')
        const proof = nativeEvidence.get(JSON.stringify([source.executionId, 'gpu.metal-command-buffer']))
        if (!proof || proof.clocks.size !== 1 || !proof.clocks.has('METAL_HOST_MONOTONIC')
          || proof.sessions.size !== 1 || !proof.sessions.has(source.sessionId)
          || [...proof.pids].some(pid => !metal.actualGpuPids.includes(pid))) invalid('Metal journal provenance differs from its capability evidence')
        if (!proof || proof.nativeErrors !== metal.stats?.nativeErrors) invalid('Metal native error count differs from its owning journal')
        const sameTiming = (actual, declared) => ['count', 'firstTimestampUS', 'lastTimestampUS', 'minDurationUS', 'maxDurationUS']
          .every(field => actual?.[field] === declared?.[field])
        if (!proof || proof.timing.count !== metal.stats?.successfulDeviceTimings || !sameTiming(proof.timing, metal.timing)) invalid('Metal successful timing summary differs from its owning journal')
        for (const pid of metal.actualGpuPids ?? []) {
          const actual = proof?.perPidTiming.get(pid) ?? { count: 0, firstTimestampUS: null, lastTimestampUS: null, minDurationUS: null, maxDurationUS: null }
          const process = metal.processes?.find(value => value.pid === pid)
          if (!sameTiming(actual, process?.timing)) invalid('Metal process timing summary differs from its owning journal')
        }
        try { const file = await artifactPath(metal.statusFile, metal.dataFile); if (await artifactDigest(file) !== metal.dataSha256) invalid('Metal data differs from its capability digest') }
        catch { invalid('Metal raw timing evidence is absent') }
      }
    }
  }
  diagnostics.emptyRecording = Number(!allowEmpty && substantiveOperations === 0)
  diagnostics.missingRequiredCategories = missingCategories.length; diagnostics.missingRequiredRoles = missingRoles.length; diagnostics.missingRequiredOperations = missingOperations.size
  return { schemaVersion: 2, generatedAt: new Date().toISOString(), source: resolve(path), journalRecords,
    totals: finish(total), categories: operationCategories.map(category => ({ category, ...finish(byCategory[category]) })),
    operations: [...operations.values()].map(finish).concat(operationCategories.filter(category => operationOverflow[category].count)
      .map(category => ({ category, name: '[other operation names]', ...finish(operationOverflow[category]) }))).sort((left, right) => right.totalMS - left.totalMS),
    groups: [...groups.values()].map(finish).concat(operationCategories.filter(category => overflow[category].count)
      .map(category => ({ category, name: '[other operations]', resource: '', ...finish(overflow[category]) }))).sort((left, right) => right.totalMS - left.totalMS),
    abandonedOperations: [...abandoned.values()], abandonedOverflow, slowest, nativeTraces, nativeTiming: [...nativeTiming.values()],
    graphics: { requirement: graphics ?? null, checks: graphicsChecks, metalProviders }, diagnostics, storage,
    coverage: { allowEmpty, requireCategories, requireRoles, requireOperations, substantiveOperations, actualCategories: [...actualCategories].sort(), actualRoles: [...roles].sort(),
      missingCategories, missingRoles, missingOperations: [...missingOperations.values()], participants: participantCoverage, ...(graphics ? { graphics } : {}) },
    measurement: 'Elapsed times overlap across nested/concurrent boundaries and are not process wall time. Work counters are totals at each recorded boundary, not unique business facts. Database calls count hooked native API calls; queryCount counts exec/all/get/run/iterate execution batches, not parsed SQL statements. CPU time uses the current thread clock when supported. GPU submission/capture times and process peaks are not hardware kernel timings. p95UpperBoundMS uses exponential duration buckets. Raw traceId/parentId/scenarioId fields preserve correlation.' }
}

const ms = value => Number(value.toFixed(3)).toLocaleString('en-US')
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
export function operationReportMarkdown(report) {
  return ['# Expensive operations', '', `${report.totals.count.toLocaleString('en-US')} completed operations; ${report.journalRecords.toLocaleString('en-US')} lifecycle records; ${report.totals.errors} errors; ${report.totals.cancelled} cancelled.`, '',
    `Journal storage: ${report.storage.storedBytes.toLocaleString('en-US')} bytes stored; ${report.storage.decodedBytes.toLocaleString('en-US')} bytes decoded; ${report.storage.compressedFiles} compressed / ${report.storage.plainFiles} plain journals.`, '',
    '| Category | Operations | Errors | Cancelled | Total ms | Max ms |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.categories.map(value => `| ${value.category} | ${value.count} | ${value.errors} | ${value.cancelled} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    '## Highest cumulative operation costs', '', '| Category | Operation | Count | Total ms | Calls | Query batches | Rows | Changes | Bytes | Sent bytes | Received bytes |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.operations.slice(0, 30).map(value => `| ${value.category} | ${escape(value.name)} | ${value.count} | ${ms(value.totalMS)} | ${value.work.calls} | ${value.work.queryCount} | ${value.work.rows} | ${value.work.changes} | ${value.work.bytes} | ${value.work.sentBytes} | ${value.work.receivedBytes} |`), '',
    '## Resource details', '', '| Category | Operation | Resource | Count | Total ms | Max ms |', '| --- | --- | --- | ---: | ---: | ---: |',
    ...report.groups.slice(0, 30).map(value => `| ${value.category} | ${escape(value.name)} | ${escape(value.resource)} | ${value.count} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    `GPU/process peaks: ${report.totals.peaks.residentKB ?? 'unavailable'} resident KB; ${report.totals.peaks.cpuPercent ?? 'unavailable'} CPU %.`, '',
    '## Native graphics clocks', '', 'These durations use their named native clocks, overlap across tasks, and are separate from epoch wall spans and device utilization.', '',
    '| Measurement | Clock | Observations | Errors | Zero timings | Sum ms | Max ms |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.nativeTiming.map(value => `| ${escape(value.measurement)} | ${escape(value.clockDomain)} | ${value.count} | ${value.errors} | ${value.zeroTimings} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    ...report.graphics.checks.map(value => `Graphics ${escape(value.provider)} / ${escape(value.policy)}: ${escape(value.status)}; ${escape(value.reason ?? '')}.`), '',
    '## Coverage', '', `Substantive operations: ${report.coverage.substantiveOperations}. Categories: ${report.coverage.actualCategories.join(', ') || 'none'}. Healthy roles: ${report.coverage.actualRoles.join(', ') || 'none'}.`,
    ...(report.coverage.missingCategories.length ? [`Missing required categories: ${report.coverage.missingCategories.join(', ')}.`] : []),
    ...(report.coverage.missingRoles.length ? [`Missing required roles: ${report.coverage.missingRoles.join(', ')}.`] : []),
    ...(report.coverage.missingOperations.length ? [`Missing successful required operations: ${report.coverage.missingOperations.map(value => typeof value === 'string' ? value : `${value.name} [source=${value.source}]`).join(', ')}.`] : []), '',
    '| Participant | Role | Claimed | Enabled hooks |', '| --- | --- | --- | --- |',
    ...report.coverage.participants.slice(0, 100).map(value => `| ${escape(value.id)} | ${escape(value.role)} | ${value.claimed} | ${escape(value.enabledHooks.join(', '))} |`), '',
    'Exact native API capability entries are retained per participant in summary.json and execution health. Disabled entries and their scopes are not covered by enabled hook-family names.', '',
    '## Abandoned operations', '', ...report.abandonedOperations.map(value => `- ${escape(value.category)} / ${escape(value.name)} / ${escape(value.resource)}: ${value.count}`), '',
    `Trace diagnostics: ${Object.entries(report.diagnostics).filter(([key]) => key !== 'examples').map(([key, value]) => `${key}=${value}`).join(', ')}.`, '', report.measurement, ''].join('\n')
}

export async function writeOperationReport(directory, { source = directory, coverage } = {}) {
  if (!coverage) {
    try { coverage = JSON.parse(await readFile(join(resolve(source), 'manifest.json'), 'utf8')).coverage }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  }
  const report = await summarizeOperations(source, coverage ?? {})
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(directory, 'summary.md'), operationReportMarkdown(report))
  return report
}
export function operationReportHasFailures(report) {
  return report.diagnostics.fileLimitReached || ['malformed', 'oversized', 'unterminated', 'incomplete', 'persistenceFailures', 'journalReadFailures', 'pendingRecords', 'undurableRecords', 'sourceFailures', 'omittedRecords', 'activeOperations', 'unclosedExecutions',
    'recorderCountMismatches', 'recorderByteMismatches', 'missingRecords', 'incompleteNativeGpuTraces', 'graphicsCoverageFailures', 'nativeTimingLimitReached', 'sequenceGaps', 'duplicateSequences', 'duplicateOperationIds', 'unmatchedEnds',
    'unclosedOperations', 'mismatchedLifecycles', 'lifecycleLimitReached', 'missingParticipantHealth', 'missingParticipantJournals', 'unclaimedParticipants',
    'missingParticipantRegistrations', 'emptyRecording', 'missingRequiredCategories', 'missingRequiredRoles', 'missingRequiredOperations'].some(key => report.diagnostics[key] > 0)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), source = args[0]
    if (!source || args.length > 3 || args.length === 2 || args.length === 3 && args[1] !== '--out') throw new Error('Usage: node scripts/operation-report.mjs RUN_OR_TRACE_DIRECTORY [--out DIRECTORY]')
    const output = args[2] ? resolve(args[2]) : (await stat(source)).isFile() ? dirname(resolve(source)) : resolve(source)
    const report = await writeOperationReport(output, { source })
    console.log(operationReportMarkdown(report)); console.log(`Report: ${join(output, 'summary.json')}`)
    if (operationReportHasFailures(report)) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
