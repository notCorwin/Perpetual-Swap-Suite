#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { mkdir, opendir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const operationCategories = ['cpu', 'gpu', 'network', 'database', 'io', 'ipc']
export function operationRequirementKey(value) {
  const name = typeof value === 'string' ? value : value?.name
  const source = typeof value === 'string' ? undefined : value?.source
  if (typeof name !== 'string' || !name || name.length > 160 || source !== undefined && source !== 'native') throw new Error('Required operations need a name of at most 160 characters and an optional native source.')
  return JSON.stringify([name, source ?? null])
}
const statuses = new Set(['ok', 'error', 'cancelled'])
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
const recordingFile = path => /\.(jsonl|health\.json|participant\.json)$/.test(path) || /chromium-[^/]+\.status\.json$/.test(path)
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
function validEvent(event) {
  return event?.schemaVersion === 2 && operationCategories.includes(event.category)
    && ['start', 'end'].includes(event.phase) && (event.phase === 'start' ? event.status === 'running' && event.durationMS === 0 : statuses.has(event.status))
    && ['id', 'sessionId', 'executionId', 'traceId', 'name'].every(key => typeof event[key] === 'string' && event[key].length > 0 && event[key].length <= 512)
    && Number.isSafeInteger(event.sequence) && event.sequence > 0 && Number.isFinite(event.startedAt) && Number.isFinite(event.durationMS) && event.durationMS >= 0
}

// Journal streaming, lifecycle tracking, metadata indexes and aggregate
// cardinality all have explicit bounds. A limit makes the report fail closed.
export async function summarizeOperations(path, { maxGroups = 256, maxLineBytes = 128 * 1024, slowestLimit = 20,
  maxFiles = 10_000, maxOpenOperations = 4096, allowEmpty = false, requireCategories = [], requireRoles = [], requireOperations = [] } = {}) {
  for (const [name, value] of Object.entries({ maxGroups, maxLineBytes, maxFiles, maxOpenOperations })) if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  if (!Number.isInteger(slowestLimit) || slowestLimit < 0) throw new Error('slowestLimit must be a nonnegative integer.')
  if (requireCategories.some(category => !operationCategories.includes(category))) throw new Error('Unknown required operation category.')
  const total = aggregate(), byCategory = Object.fromEntries(operationCategories.map(category => [category, aggregate()]))
  const groups = new Map(), operations = new Map(), overflow = Object.fromEntries(operationCategories.map(category => [category, aggregate()])),
    operationOverflow = Object.fromEntries(operationCategories.map(category => [category, aggregate()])), slowest = [], nativeTraces = [], abandoned = new Map()
  const healthRecords = new Map(), executions = new Map(), participants = new Map(), actualCategories = new Set()
  const missingOperations = new Map(requireOperations.map(value => [operationRequirementKey(value), value]))
  let journalRecords = 0, substantiveOperations = 0, visitedFiles = 0, abandonedOverflow = 0
  const diagnostics = { files: 0, lines: 0, malformed: 0, oversized: 0, unterminated: 0, incomplete: 0, groupedOverflow: 0,
    recorderHealthFiles: 0, persistenceFailures: 0, pendingRecords: 0, undurableRecords: 0, sourceFailures: 0, omittedRecords: 0, activeOperations: 0,
    unclosedExecutions: 0, recorderCountMismatches: 0, missingRecords: 0,
    sequenceGaps: 0, duplicateSequences: 0, duplicateOperationIds: 0, unmatchedEnds: 0, unclosedOperations: 0, mismatchedLifecycles: 0,
    lifecycleLimitReached: 0, missingParticipantHealth: 0, missingParticipantJournals: 0, unclaimedParticipants: 0, missingParticipantRegistrations: 0,
    nativeGpuStatusFiles: 0, incompleteNativeGpuTraces: 0, emptyRecording: 0, missingRequiredCategories: 0, missingRequiredRoles: 0, missingRequiredOperations: 0,
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
    if (!file.endsWith('.jsonl')) {
      try {
        const metadata = await readMetadata(file, maxLineBytes)
        if (file.endsWith('.participant.json')) {
          if (metadata.schemaVersion !== 2 || typeof metadata.id !== 'string' || !metadata.id || typeof metadata.role !== 'string' || !metadata.role) throw new Error('Invalid participant.')
          if (participants.has(metadata.id)) problem('malformed', file, 1, 'Duplicate participant registration')
          participants.set(metadata.id, { id: metadata.id, role: label(metadata.role), executionId: metadata.executionId, status: metadata.status, parentExecutionId: metadata.parentExecutionId, file })
        } else if (file.endsWith('.health.json')) {
          if (metadata.schemaVersion !== 2) throw new Error('Invalid health schema.')
          const executionId = metadata.executionId ?? basename(file, '.health.json')
          if (healthRecords.has(executionId)) problem('malformed', file, 1, 'Duplicate execution health')
          healthRecords.set(executionId, { executionId, file, participantId: metadata.participantId, role: label(metadata.role),
            recorded: metadata.recorded, recordedOperations: metadata.recordedOperations, persisted: metadata.persisted, durableRecords: metadata.durableRecords,
            failed: metadata.failed, pending: metadata.pending, closed: metadata.closed,
            sourceFailures: metadata.sourceFailures, omittedRecords: metadata.omittedRecords, activeOperations: metadata.activeOperations,
            durability: label(metadata.durability),
            enabledHooks: Array.isArray(metadata.enabledHooks) ? metadata.enabledHooks.filter(value => typeof value === 'string').slice(0, 128).map(label) : [] })
          diagnostics.recorderHealthFiles++
        } else {
          diagnostics.nativeGpuStatusFiles++
          if (metadata.error || metadata.enabled && !metadata.complete) problem('incompleteNativeGpuTraces', file, 1)
          if (metadata.enabled && metadata.complete) {
            try { if (!(await stat(metadata.file)).isFile()) throw new Error('Missing native trace.') }
            catch { problem('incompleteNativeGpuTraces', file, 1, 'Completed native GPU trace file is absent') }
          }
          if (nativeTraces.length < 128) nativeTraces.push({ statusFile: file, enabled: metadata.enabled === true, complete: metadata.complete === true,
            ...(typeof metadata.file === 'string' ? { traceFile: metadata.file } : {}), ...(typeof metadata.error === 'string' ? { error: metadata.error } : {}),
            ...(Number.isFinite(metadata.bufferUsage?.percentage) ? { bufferUsed: metadata.bufferUsage.percentage } : {}) })
        }
      } catch { problem('malformed', file, 1) }
      continue
    }
    diagnostics.files++
    const active = new Map(), recentlyEnded = new Set()
    let fileExecutionId = basename(file, '.jsonl'), rawCount = 0, endCount = 0, previousSequence = 0
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
        else active.set(event.id, Object.fromEntries(['id', 'traceId', 'parentId', 'category', 'name', 'resource', 'startedAt'].map(key => [key, event[key]])))
        return
      }
      endCount++
      const start = active.get(event.id)
      if (!start) problem(recentlyEnded.has(event.id) ? 'duplicateOperationIds' : 'unmatchedEnds', file, line, event.name)
      else {
        if (['traceId', 'parentId', 'category', 'name', 'resource', 'startedAt'].some(key => start[key] !== event[key])) problem('mismatchedLifecycles', file, line, event.name)
        active.delete(event.id)
      }
      recentlyEnded.add(event.id)
      if (recentlyEnded.size > maxOpenOperations) recentlyEnded.delete(recentlyEnded.values().next().value)
      if (event.attributes?.incomplete === true || event.attributes?.interrupted === true) problem('incomplete', file, line, event.name)
      completed(event)
    }
    let pending = Buffer.alloc(0), oversized = false, line = 1
    for await (const chunk of createReadStream(file)) {
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
    }
    if (pending.length || oversized) { problem('unterminated', file, line); if (!oversized) consume(pending, line) }
    for (const event of active.values()) { problem('unclosedOperations', file, 0, event.name); abandon(event) }
    if (executions.has(fileExecutionId)) problem('malformed', file, 0, 'Multiple journals for one execution')
    executions.set(fileExecutionId, { rawCount, endCount, file })
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
      durability: health?.durability ?? '', claimed,
      healthy })
  }
  const missingCategories = [...new Set(requireCategories)].filter(category => !actualCategories.has(category))
  const missingRoles = [...new Set(requireRoles)].filter(role => !roles.has(role))
  diagnostics.emptyRecording = Number(!allowEmpty && substantiveOperations === 0)
  diagnostics.missingRequiredCategories = missingCategories.length; diagnostics.missingRequiredRoles = missingRoles.length; diagnostics.missingRequiredOperations = missingOperations.size
  return { schemaVersion: 2, generatedAt: new Date().toISOString(), source: resolve(path), journalRecords,
    totals: finish(total), categories: operationCategories.map(category => ({ category, ...finish(byCategory[category]) })),
    operations: [...operations.values()].map(finish).concat(operationCategories.filter(category => operationOverflow[category].count)
      .map(category => ({ category, name: '[other operation names]', ...finish(operationOverflow[category]) }))).sort((left, right) => right.totalMS - left.totalMS),
    groups: [...groups.values()].map(finish).concat(operationCategories.filter(category => overflow[category].count)
      .map(category => ({ category, name: '[other operations]', resource: '', ...finish(overflow[category]) }))).sort((left, right) => right.totalMS - left.totalMS),
    abandonedOperations: [...abandoned.values()], abandonedOverflow, slowest, nativeTraces, diagnostics,
    coverage: { allowEmpty, requireCategories, requireRoles, requireOperations, substantiveOperations, actualCategories: [...actualCategories].sort(), actualRoles: [...roles].sort(),
      missingCategories, missingRoles, missingOperations: [...missingOperations.values()], participants: participantCoverage },
    measurement: 'Elapsed times overlap across nested/concurrent boundaries and are not process wall time. Work counters are totals at each recorded boundary, not unique business facts. Database calls count hooked native API calls; queryCount counts exec/all/get/run/iterate execution batches, not parsed SQL statements. CPU time uses the current thread clock when supported. GPU submission/capture times and process peaks are not hardware kernel timings. p95UpperBoundMS uses exponential duration buckets. Raw traceId/parentId/scenarioId fields preserve correlation.' }
}

const ms = value => Number(value.toFixed(3)).toLocaleString('en-US')
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
export function operationReportMarkdown(report) {
  return ['# Expensive operations', '', `${report.totals.count.toLocaleString('en-US')} completed operations; ${report.journalRecords.toLocaleString('en-US')} lifecycle records; ${report.totals.errors} errors; ${report.totals.cancelled} cancelled.`, '',
    '| Category | Operations | Errors | Cancelled | Total ms | Max ms |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.categories.map(value => `| ${value.category} | ${value.count} | ${value.errors} | ${value.cancelled} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    '## Highest cumulative operation costs', '', '| Category | Operation | Count | Total ms | Calls | Query batches | Rows | Changes | Bytes | Sent bytes | Received bytes |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.operations.slice(0, 30).map(value => `| ${value.category} | ${escape(value.name)} | ${value.count} | ${ms(value.totalMS)} | ${value.work.calls} | ${value.work.queryCount} | ${value.work.rows} | ${value.work.changes} | ${value.work.bytes} | ${value.work.sentBytes} | ${value.work.receivedBytes} |`), '',
    '## Resource details', '', '| Category | Operation | Resource | Count | Total ms | Max ms |', '| --- | --- | --- | ---: | ---: | ---: |',
    ...report.groups.slice(0, 30).map(value => `| ${value.category} | ${escape(value.name)} | ${escape(value.resource)} | ${value.count} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    `GPU/process peaks: ${report.totals.peaks.residentKB ?? 'unavailable'} resident KB; ${report.totals.peaks.cpuPercent ?? 'unavailable'} CPU %.`, '',
    '## Coverage', '', `Substantive operations: ${report.coverage.substantiveOperations}. Categories: ${report.coverage.actualCategories.join(', ') || 'none'}. Healthy roles: ${report.coverage.actualRoles.join(', ') || 'none'}.`,
    ...(report.coverage.missingCategories.length ? [`Missing required categories: ${report.coverage.missingCategories.join(', ')}.`] : []),
    ...(report.coverage.missingRoles.length ? [`Missing required roles: ${report.coverage.missingRoles.join(', ')}.`] : []),
    ...(report.coverage.missingOperations.length ? [`Missing successful required operations: ${report.coverage.missingOperations.map(value => typeof value === 'string' ? value : `${value.name} [source=${value.source}]`).join(', ')}.`] : []), '',
    '| Participant | Role | Claimed | Enabled hooks |', '| --- | --- | --- | --- |',
    ...report.coverage.participants.slice(0, 100).map(value => `| ${escape(value.id)} | ${escape(value.role)} | ${value.claimed} | ${escape(value.enabledHooks.join(', '))} |`), '',
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
  return report.diagnostics.fileLimitReached || ['malformed', 'oversized', 'unterminated', 'incomplete', 'persistenceFailures', 'pendingRecords', 'undurableRecords', 'sourceFailures', 'omittedRecords', 'activeOperations', 'unclosedExecutions',
    'recorderCountMismatches', 'missingRecords', 'incompleteNativeGpuTraces', 'sequenceGaps', 'duplicateSequences', 'duplicateOperationIds', 'unmatchedEnds',
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
