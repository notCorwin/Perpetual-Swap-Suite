import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

export function classifyV8Stack(frames) {
  const leaf = frames.at(-1)
  if (!leaf) return 'unresolved-native'
  const name = leaf.functionName ?? '', url = leaf.url ?? ''
  if (name === '(idle)') return 'idle'
  if (name === '(garbage collector)') return 'gc'
  if (/^\((program|root)\)$/.test(name) || !name && !url || /^0x[0-9a-f]+$/i.test(name)) return 'unresolved-native'
  // A telemetry scope surrounds business functions too. Attribute only the
  // exclusive leaf, never the whole subtree of a recording/context wrapper.
  if (/operation-runtime|operations\.js|operation-hooks|operation-telemetry|recorder-self|operation-journal|renderer-operations/.test(url)
      || name === 'threadCpuUsage') return 'telemetry-direct'
  if (/JSON|Serializer|serializ|ChartWire/i.test(name) || /chart-wire|chart-notifications/.test(url)) return 'serialization'
  if (/memcpy|memmove|copy|clone|deserialize/i.test(name)) return 'copy-or-deserialization'
  if (/native-broker|native-client|node:(?:net|http|stream)/.test(url) || /^(?:writev|writeUtf8String|read|send|fetch)$/.test(name)) return 'communication'
  if (/^(?:rename|fdatasync|fsync|writeFile)$/.test(name)) return 'native-io'
  return url ? 'application-or-runtime-js' : 'unresolved-native'
}
export function summarizeV8(profile, from = profile.startTime, through = profile.endTime) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const stack = id => { const frames = []; for (let n = id, depth = 0; n != null && depth < 128; n = parent.get(n), depth++) frames.unshift(nodes.get(n)?.callFrame ?? {}); return frames }
  const categories = {}, functions = new Map()
  if (!Array.isArray(profile.samples) || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length
      || !Number.isFinite(profile.startTime) || !Number.isFinite(profile.endTime) || profile.endTime < profile.startTime) throw new Error('Invalid V8 profile samples or clock.')
  let time = profile.startTime, negativeDeltas = 0
  const observations = profile.samples.map((sample, index) => {
    const delta = profile.timeDeltas[index]
    if (!Number.isFinite(delta)) throw new Error('V8 time delta is not finite.')
    if (delta < 0) negativeDeltas++
    time += delta
    return { time, sample, index }
  })
  // DevTools likewise reconstructs and sorts sample timestamps before weighting.
  // Never clamp negative deltas and then double-count overlapping time spans.
  observations.sort((a, b) => a.time - b.time || a.index - b.index)
  let kept = 0, totalUS = 0
  for (let i = 0; i < observations.length; i++) {
    const current = observations[i], end = observations[i + 1]?.time ?? profile.endTime
    const begin = Math.max(current.time, profile.startTime, from)
    const weight = Math.max(0, Math.min(end, profile.endTime, through) - begin)
    if (!weight) continue
    const frames = stack(current.sample), category = classifyV8Stack(frames), leaf = frames.at(-1) ?? {}
    categories[category] = (categories[category] ?? 0) + weight / 1000; kept++; totalUS += weight
    const key = `${leaf.functionName}|${leaf.url}|${leaf.lineNumber}|${leaf.columnNumber}`
    const item = functions.get(key) ?? { ...leaf, category, sampledWallMS: 0, observations: 0 }
    item.sampledWallMS += weight / 1000; item.observations++; functions.set(key, item)
  }
  return { sampleCount: kept, rawSampleCount: profile.samples.length, negativeDeltas, timestampsSorted: true, sampledWindowMS: totalUS / 1000, categories,
    rankedFunctions: [...functions.values()].filter(x => x.category !== 'idle').sort((a, b) => b.sampledWallMS - a.sampledWallMS).slice(0, 40),
    limitation: 'Time-delta-weighted V8 observations clipped to the resource window, not measured per-function CPU or energy. Idle and native/unknown remain separate; categories use exclusive-leaf heuristics and do not charge business work to ancestor instrumentation wrappers.' }
}
export function summarizeTrace(trace, rendererPid) {
  const events = trace.traceEvents ?? [], categories = {}, counts = {}, edges = []
  const main = events.find(e => e.ph === 'M' && e.name === 'thread_name' && e.pid === rendererPid && /CrRendererMain|RendererMain/.test(e.args?.name ?? ''))?.tid
  const classifyEvent = name => /Layout|RecalcStyle|UpdateLayoutTree/.test(name) ? 'layout-style'
    : /Paint|Raster|Layerize|UpdateLayerTree/.test(name) ? 'svg-or-other-paint'
      : /GC|GarbageCollect/.test(name) ? 'gc'
        : /JSON|Serialize|Deserialize/.test(name) ? 'serialization'
          : /FunctionCall|EvaluateScript|V8\.Execute/.test(name) ? 'javascript'
            : /Message|IPC/.test(name) ? 'communication' : null
  if (main == null) return { available: false, reason: 'Renderer main thread was not identified.' }
  let id = 0
  for (const event of events) {
    if (event.ph !== 'X' || event.pid !== rendererPid || event.tid !== main || !(event.dur > 0)) continue
    const category = classifyEvent(event.name); if (!category) continue
    counts[event.name] = (counts[event.name] ?? 0) + 1
    const value = { id: id++, category, duration: event.dur }
    edges.push({ time: event.ts, add: value }, { time: event.ts + event.dur, remove: value.id })
  }
  edges.sort((a, b) => a.time - b.time || Number(Boolean(a.add)) - Number(Boolean(b.add)))
  const active = new Map(); let prior = edges[0]?.time
  for (const edge of edges) {
    if (active.size && edge.time > prior) {
      const inner = [...active.values()].sort((a, b) => a.duration - b.duration)[0]
      categories[inner.category] = (categories[inner.category] ?? 0) + (edge.time - prior) / 1000
    }
    if (edge.add) active.set(edge.add.id, edge.add); else active.delete(edge.remove)
    prior = edge.time
  }
  return { available: true, rendererPid, mainThreadId: main, exclusiveInstrumentedWallMS: categories, counts,
    limitation: 'Innermost recognized complete events on the renderer main thread, unioned to avoid nested double counting. Instrumented wall time is not OS CPU or GPU time. Paint includes SVG and non-SVG; it is not an SVG-only measurement.' }
}
async function main(args) {
if (!args[0]) throw new Error('Provide a diagnostic report.json path.')
const reportPath = resolve(args[0]), directory = dirname(reportPath)
const report = JSON.parse(await readFile(reportPath, 'utf8'))
const trials = []
for (const run of report.runs) {
  const trialDirectory = run.bundlePath ? dirname(run.bundlePath) : join(directory, `${run.round}-${run.transport}-${run.telemetry}-${run.runtime}`)
  const phase = run.phases.find(p => p.scenario === 'realtime')
  const samples = phase?.resources?.samples
  if (!samples?.length) continue
  const from = Number(BigInt(samples[0].sampleEndMonotonicNsExact) / 1000n), through = Number(BigInt(samples.at(-1).sampleEndMonotonicNsExact) / 1000n)
  const item = { runtime: run.runtime, transport: run.transport, telemetry: run.telemetry, round: run.round,
    diagnostics: phase.diagnostics, profiles: [], nativeStacks: (run.stackProfiles ?? []).map(c => ({
      focus: c.focus, processes: c.processes.map(p => ({ pid: p.pid, group: p.group, status: p.status, rawFile: p.rawFile,
        coverage: p.analysis?.coverage, categories: p.analysis?.categories, rankedStacks: p.analysis?.rankedStacks?.slice(0, 12),
        error: p.error })), limitation: 'Native sample observations include blocked threads and unresolved JIT; these are not CPU percentages.' })) }
  for (const folder of ['v8-profiles', 'engine-profiles']) {
    let files; try { files = await readdir(join(trialDirectory, folder)) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    for (const name of files) {
      if (!name.endsWith('.cpuprofile')) continue
      const profile = JSON.parse(await readFile(join(trialDirectory, folder, name), 'utf8'))
      const clip = folder === 'engine-profiles' ? [profile.startTime, profile.endTime] : [from, through]
      item.profiles.push({ file: join(trialDirectory, folder, name), kind: folder, ...summarizeV8(profile, ...clip) })
    }
    const traceName = files.find(n => n.endsWith('.trace.json'))
    if (traceName) item.trace = summarizeTrace(JSON.parse(await readFile(join(trialDirectory, folder, traceName), 'utf8')), run.native.rendererPid)
  }
  trials.push(item)
}
const result = { diagnosticOnly: true, report: reportPath, outcome: report.outcome, trials }
await writeFile(join(directory, 'profile-summary.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(trials.map(t => ({ runtime: t.runtime, variant: `${t.transport}/${t.telemetry}`, native: t.nativeStacks.flatMap(s => s.processes.map(p => p.status)),
  diagnostics: t.diagnostics?.measurements, trace: t.trace, profiles: t.profiles.map(p => ({ kind: p.kind, file: p.file, samples: p.sampleCount, categories: p.categories, top: p.rankedFunctions.slice(0, 5) })) })), null, 2))

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exitCode = 1 })
}
