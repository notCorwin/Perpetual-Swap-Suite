#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { mkdir, opendir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const categories = ['cpu', 'gpu', 'network', 'database']
const statuses = new Set(['ok', 'error', 'cancelled'])
const bucketLimits = Array.from({ length: 25 }, (_, index) => 2 ** (index - 4))
const aggregate = () => ({ count: 0, errors: 0, cancelled: 0, totalMS: 0, maxMS: 0, cpuTimeMS: 0, buckets: Array(bucketLimits.length + 1).fill(0) })
const label = value => typeof value === 'string' ? value.slice(0, 240) : ''
function add(target, event) {
  target.count++
  target.errors += Number(event.status === 'error')
  target.cancelled += Number(event.status === 'cancelled')
  target.totalMS += event.durationMS
  target.maxMS = Math.max(target.maxMS, event.durationMS)
  target.cpuTimeMS += Number.isFinite(event.cpuTimeMS) && event.cpuTimeMS >= 0 ? event.cpuTimeMS : 0
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
async function* traceFiles(path, depth = 0) {
  const info = await stat(path)
  if (info.isFile()) { if (path.endsWith('.jsonl') || /chromium-[^/]+\.status\.json$/.test(path)) yield path; return }
  if (!info.isDirectory() || depth > 8) return
  // A sandbox report never traverses its potentially huge database/temp trees.
  if (depth === 0) {
    try { if ((await stat(join(path, 'operations'))).isDirectory()) { yield* traceFiles(join(path, 'operations'), 1); return } } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for await (const entry of await opendir(path)) {
    if (entry.isFile() && (entry.name.endsWith('.jsonl') || /^chromium-.+\.status\.json$/.test(entry.name))) yield join(path, entry.name)
    else if (entry.isDirectory()) yield* traceFiles(join(path, entry.name), depth + 1)
  }
}

// Both line size and aggregate cardinality are bounded. Reports can inspect a
// long-running desktop archive without loading its events or resources in RAM.
export async function summarizeOperations(path, { maxGroups = 256, maxLineBytes = 128 * 1024, slowestLimit = 20, maxFiles = 10_000 } = {}) {
  if (!Number.isInteger(maxGroups) || maxGroups < 1 || !Number.isInteger(maxLineBytes) || maxLineBytes < 1 || !Number.isInteger(slowestLimit) || slowestLimit < 0 || !Number.isInteger(maxFiles) || maxFiles < 1) throw new Error('Report limits must be positive integers (slowestLimit may be zero).')
  const total = aggregate(), byCategory = Object.fromEntries(categories.map(category => [category, aggregate()]))
  const groups = new Map(), overflow = Object.fromEntries(categories.map(category => [category, aggregate()])), slowest = [], nativeTraces = []
  const diagnostics = { files: 0, lines: 0, malformed: 0, oversized: 0, unterminated: 0, incomplete: 0, groupedOverflow: 0,
    recorderHealthFiles: 0, persistenceFailures: 0, pendingRecords: 0, unclosedExecutions: 0, recorderCountMismatches: 0, missingRecords: 0,
    nativeGpuStatusFiles: 0, incompleteNativeGpuTraces: 0, fileLimitReached: false, examples: [] }
  const problem = (kind, file, line) => { diagnostics[kind]++; if (diagnostics.examples.length < 10) diagnostics.examples.push({ kind, file, line }) }
  const consume = (buffer, file, line) => {
    diagnostics.lines++
    if (!buffer.length) return
    let event
    try { event = JSON.parse(buffer.toString('utf8')) } catch { problem('malformed', file, line); return }
    if (event?.status === 'incomplete' || event?.attributes?.incomplete === true || event?.attributes?.interrupted === true) problem('incomplete', file, line)
    if (event?.schemaVersion !== 1 || !categories.includes(event.category) || !statuses.has(event.status) || typeof event.id !== 'string' || !event.id || typeof event.sessionId !== 'string' || typeof event.executionId !== 'string' || typeof event.name !== 'string' || !event.name || !Number.isFinite(event.startedAt) || !Number.isFinite(event.durationMS) || event.durationMS < 0) { problem('malformed', file, line); return }
    add(total, event); add(byCategory[event.category], event)
    const name = label(event.name), resource = label(event.resource), key = JSON.stringify([event.category, name, resource])
    let group = groups.get(key)
    if (!group && groups.size < maxGroups) { group = { category: event.category, name, resource, ...aggregate() }; groups.set(key, group) }
    if (group) add(group, event)
    else { add(overflow[event.category], event); diagnostics.groupedOverflow++ }
    if (slowestLimit && (slowest.length < slowestLimit || event.durationMS > slowest.at(-1).durationMS)) {
      slowest.push({ id: label(event.id), sessionId: label(event.sessionId), executionId: label(event.executionId), category: event.category, name, resource, startedAt: event.startedAt, durationMS: event.durationMS, status: event.status })
      slowest.sort((left, right) => right.durationMS - left.durationMS)
      if (slowest.length > slowestLimit) slowest.pop()
    }
  }
  let visitedFiles = 0
  for await (const file of traceFiles(resolve(path))) {
    if (visitedFiles++ >= maxFiles) { diagnostics.fileLimitReached = true; break }
    if (file.endsWith('.status.json')) {
      diagnostics.nativeGpuStatusFiles++
      try {
        if ((await stat(file)).size > maxLineBytes) { problem('oversized', file, 1); continue }
        const status = JSON.parse(await readFile(file, 'utf8'))
        if (status.error || status.enabled && !status.complete) problem('incompleteNativeGpuTraces', file, 1)
        if (nativeTraces.length < 128) nativeTraces.push({ statusFile: file, enabled: status.enabled === true, complete: status.complete === true,
          ...(typeof status.file === 'string' ? { traceFile: status.file } : {}),
          ...(typeof status.error === 'string' ? { error: status.error } : {}),
          ...(Number.isFinite(status.bufferUsage?.percentage) ? { bufferUsed: status.bufferUsage.percentage } : {}) })
      } catch { problem('malformed', file, 1) }
      continue
    }
    diagnostics.files++
    let health
    try {
      health = JSON.parse(await readFile(file.replace(/\.jsonl$/, '.health.json'), 'utf8'))
      diagnostics.recorderHealthFiles++
      diagnostics.persistenceFailures += Number.isFinite(health.failed) && health.failed > 0 ? health.failed : 0
      diagnostics.pendingRecords += Number.isFinite(health.pending) && health.pending > 0 ? health.pending : 0
      if (health.closed !== true) problem('unclosedExecutions', file, 0)
    } catch (error) {
      if (error.code === 'ENOENT') problem('unclosedExecutions', file, 0)
      else problem('malformed', file.replace(/\.jsonl$/, '.health.json'), 1)
    }
    const previousCount = total.count
    let pending = Buffer.alloc(0), oversized = false, line = 1
    for await (const chunk of createReadStream(file)) {
      let from = 0
      while (from < chunk.length) {
        const newline = chunk.indexOf(10, from), through = newline < 0 ? chunk.length : newline
        const piece = chunk.subarray(from, through)
        if (!oversized) {
          if (pending.length + piece.length > maxLineBytes) { problem('oversized', file, line); oversized = true; pending = Buffer.alloc(0) }
          else if (piece.length) pending = pending.length ? Buffer.concat([pending, piece]) : Buffer.from(piece)
        }
        if (newline < 0) break
        if (!oversized) consume(pending, file, line)
        pending = Buffer.alloc(0); oversized = false; line++; from = newline + 1
      }
    }
    if (pending.length || oversized) {
      problem('unterminated', file, line)
      // A missing final newline can be a fully persisted final event. Keep it,
      // but distinguish this file from a cleanly completed recording.
      if (!oversized) consume(pending, file, line)
    }
    if (health) {
      const actual = total.count - previousCount
      if (health.recorded !== actual || health.persisted !== actual) problem('recorderCountMismatches', file, 0)
      diagnostics.missingRecords += Number.isFinite(health.recorded) ? Math.max(0, health.recorded - actual) : 0
    }
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), source: resolve(path),
    totals: finish(total), categories: categories.map(category => ({ category, ...finish(byCategory[category]) })),
    groups: [...groups.values()].map(finish).concat(categories.filter(category => overflow[category].count).map(category => ({ category, name: '[other operations]', resource: '', ...finish(overflow[category]) }))).sort((left, right) => right.totalMS - left.totalMS),
    slowest, nativeTraces, diagnostics,
    measurement: 'Elapsed operation time can overlap across threads and nested operations; totals are not process wall time. CPU time, when present, uses the current thread CPU clock. GPU records describe graphics submission/capture boundaries and GPU-process samples, not hardware kernel timings. p95UpperBoundMS uses fixed exponential duration buckets.' }
}

const ms = value => Number(value.toFixed(3)).toLocaleString('en-US')
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
export function operationReportMarkdown(report) {
  const lines = ['# Expensive operations', '', `${report.totals.count.toLocaleString('en-US')} recorded operations; ${report.totals.errors} errors; ${report.totals.cancelled} cancelled.`, '',
    '| Category | Operations | Errors | Cancelled | Total ms | Max ms |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.categories.map(value => `| ${value.category} | ${value.count} | ${value.errors} | ${value.cancelled} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    '## Highest cumulative costs', '', '| Category | Operation | Resource | Count | Total ms | Max ms |', '| --- | --- | --- | ---: | ---: | ---: |',
    ...report.groups.slice(0, 30).map(value => `| ${value.category} | ${escape(value.name)} | ${escape(value.resource)} | ${value.count} | ${ms(value.totalMS)} | ${ms(value.maxMS)} |`), '',
    `Trace diagnostics: ${report.diagnostics.files} files, ${report.diagnostics.malformed} malformed records, ${report.diagnostics.oversized} oversized lines, ${report.diagnostics.unterminated} unfinished final lines, ${report.diagnostics.incomplete} interrupted operations, ${report.diagnostics.persistenceFailures} persistence failures, ${report.diagnostics.pendingRecords} unpersisted records, ${report.diagnostics.unclosedExecutions} unclosed executions, ${report.diagnostics.recorderCountMismatches} recorder count mismatches, ${report.diagnostics.missingRecords} missing records, ${report.diagnostics.incompleteNativeGpuTraces} incomplete native GPU traces, ${report.diagnostics.groupedOverflow} events grouped into overflow.${report.diagnostics.fileLimitReached ? ' File limit reached; this report is partial.' : ''}`, '', report.measurement, '']
  return lines.join('\n')
}

export async function writeOperationReport(directory, { source = directory } = {}) {
  const report = await summarizeOperations(source)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(directory, 'summary.md'), operationReportMarkdown(report))
  return report
}

export function operationReportHasFailures(report) {
  return report.diagnostics.fileLimitReached || ['malformed', 'oversized', 'unterminated', 'incomplete', 'persistenceFailures', 'pendingRecords', 'unclosedExecutions', 'recorderCountMismatches', 'missingRecords', 'incompleteNativeGpuTraces'].some(key => report.diagnostics[key] > 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), source = args[0]
    if (!source || args.length > 3 || args.length === 2 || args.length === 3 && args[1] !== '--out') throw new Error('Usage: node scripts/operation-report.mjs RUN_OR_TRACE_DIRECTORY [--out DIRECTORY]')
    const output = args[2] ? resolve(args[2]) : (await stat(source)).isFile() ? dirname(resolve(source)) : resolve(source)
    const report = await writeOperationReport(output, { source })
    console.log(operationReportMarkdown(report))
    console.log(`Report: ${join(output, 'summary.json')}`)
    try {
      const manifest = JSON.parse(await readFile(join(resolve(source), 'manifest.json'), 'utf8'))
      if (manifest.outcome?.status === 'running') console.warn('This run did not finish; completed operations are a partial recording.')
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
