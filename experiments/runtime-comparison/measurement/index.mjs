import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { access, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const directory = dirname(fileURLToPath(import.meta.url))
const execute = promisify(execFile)
const sources = ['process-sampler.c', 'frontmost.m'].map(file => join(directory, file))
const flags = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror']
let buildPromise

// The ignored binary is shared by all samples and invalidated when source,
// compiler, SDK or architecture changes. Different Node processes may build
// concurrently; each writes its own temporary binary before atomic rename.
async function helperPath() {
  if (process.platform !== 'darwin') throw new Error('Process measurements require macOS.')
  if (!buildPromise) buildPromise = (async () => {
    const [compiler, sdk, ...contents] = await Promise.all([
      execute('/usr/bin/xcrun', ['--find', 'clang']).then(result => result.stdout.trim()),
      execute('/usr/bin/xcrun', ['--show-sdk-path']).then(result => result.stdout.trim()),
      ...sources.map(path => readFile(path)),
    ])
    const [compilerInfo, sdkInfo] = await Promise.all([stat(compiler), stat(join(sdk, 'SDKSettings.json'))])
    const hash = createHash('sha256').update(JSON.stringify({ compiler, sdk, compilerMtime: compilerInfo.mtimeMs, sdkMtime: sdkInfo.mtimeMs, arch: process.arch, flags }))
    for (const source of contents) hash.update(source)
    const build = join(directory, '.build')
    const output = join(build, `process-sampler-${hash.digest('hex').slice(0, 20)}`)
    await mkdir(build, { recursive: true })
    try { await access(output, constants.X_OK); return output } catch { /* build on first use */ }
    const temporary = `${output}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    try {
      await execute(compiler, [...flags, '-isysroot', sdk, ...sources, '-framework', 'AppKit', '-o', temporary], { maxBuffer: 1024 * 1024 })
      await rename(temporary, output)
      return output
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw new Error(`Could not build the macOS process sampler: ${error.stderr || error.message}`, { cause: error })
    }
  })().catch(error => { buildPromise = undefined; throw error })
  return buildPromise
}

function validatePids(pids, name) {
  if (!Array.isArray(pids) || pids.length > 1024 || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)) {
    throw new TypeError(`${name} must be an array of at most 1024 positive integer PIDs.`)
  }
  return [...new Set(pids)]
}

function numeric(value) {
  if (value === null || value === undefined) return null
  const n = BigInt(value)
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null
}

function normalize(raw, rootPids, extraPids) {
  if (raw.error) throw new Error(`macOS process sampler failed: ${raw.error}`)
  const timestampMS = Date.now()
  for (const p of raw.processes) {
    p.birthIdentity = `${p.pid}:${p.birthSeconds}:${p.birthMicroseconds}`
    // An explicitly supplied backend and its descendants are counted only in
    // backend even if that backend is also a child of the runtime root.
    p.group = p.extraMember ? 'backend' : 'runtime'
    if (p.counters) {
      for (const key of ['cpuUserNs', 'cpuSystemNs', 'cpuEnergyNj', 'startMonotonicNs', 'cpuPUserNs', 'cpuPSystemNs', 'cpuPEnergyNj', 'cpuCycles', 'cpuInstructions', 'cpuPCycles', 'cpuPInstructions']) {
        p.counters[key] = numeric(p.counters[`${key}Exact`])
      }
    }
  }
  const missingPids = [...rootPids, ...extraPids].filter(pid => !raw.processes.some(p => p.pid === pid && p.counters))
  const totals = Object.fromEntries(['runtime', 'backend', 'combined'].map(group => [group, sumGroup(raw.processes, group, raw.cpuEnergySupported)]))
  return {
    timestamp: new Date(timestampMS).toISOString(), timestampMS, ...raw, rootPids, extraPids, missingPids, totals,
    frontmostIsRuntime: raw.frontmostPid === null ? null : raw.processes.some(p => p.pid === raw.frontmostPid && p.group === 'runtime'),
    capabilityMeaning: 'Supported means the helper probe observed that counter advancing. False means unconfirmed, not proof the kernel lacks it; nonzero target counters can independently confirm availability. A zero is valid once availability is confirmed.',
    unavailable: {
      totalEnergyJoules: 'Total app/device energy is not measured: GPU, display, shared services, I/O and other system energy cannot be attributed here.',
      gpuEnergyJoules: 'GPU and WindowServer activity may run in shared system processes and cannot be attributed by this sampler.',
      ...(!raw.cpuEnergySupported ? { cpuEnergy: 'The per-process CPU energy counter did not advance during the helper capability probe, or is unsupported.' } : {}),
      ...(!raw.responsibleLookupAvailable ? { webKitAttribution: 'The private responsibility lookup is unavailable; launchd-hosted WebKit services may be missing.' } : {}),
    },
  }
}

function selected(p, group) { return group === 'combined' || p.group === group }
function sumGroup(processes, group, energySupported) {
  const members = processes.filter(p => selected(p, group))
  const complete = members.every(p => p.counters)
  const sum = key => members.reduce((n, p) => n + BigInt(p.counters?.[key] ?? 0), 0n)
  const user = sum('cpuUserNsExact'), system = sum('cpuSystemNsExact')
  const allEnergy = (energySupported || members.some(p => p.counters?.cpuEnergyNjExact != null && BigInt(p.counters.cpuEnergyNjExact) > 0n)) && members.every(p => p.counters?.cpuEnergyNjExact != null)
  const energy = allEnergy ? sum('cpuEnergyNjExact') : null
  return {
    processCount: members.length, sampledProcessCount: members.filter(p => p.counters).length, complete,
    cpuUserNs: numeric(user), cpuUserNsExact: String(user), cpuSystemNs: numeric(system), cpuSystemNsExact: String(system),
    cpuEnergyNj: numeric(energy), cpuEnergyNjExact: energy === null ? null : String(energy),
    residentBytes: complete ? members.reduce((n, p) => n + p.counters.residentBytes, 0) : null,
    physicalFootprintBytes: complete ? members.reduce((n, p) => n + p.counters.physicalFootprintBytes, 0) : null,
  }
}

export function intervalFor(previous, current) {
  const elapsed = BigInt(current.sampleEndMonotonicNsExact) - BigInt(previous.sampleEndMonotonicNsExact)
  const old = new Map(previous.processes.map(p => [p.birthIdentity, p]))
  const currentIds = new Set(current.processes.map(p => p.birthIdentity))
  const groups = Object.fromEntries(['runtime', 'backend', 'combined'].map(name => [name, { unknownPids: [] }]))
  const unknown = (name, pid) => { if (!groups[name].unknownPids.includes(pid)) groups[name].unknownPids.push(pid) }
  for (const p of current.processes) {
    const before = old.get(p.birthIdentity)
    const born = !before && p.counters && BigInt(p.counters.startMonotonicNsExact) >= BigInt(previous.sampleEndMonotonicNsExact)
    if (!p.counters || (!before && !born) || (before && !before.counters)) {
      unknown('combined', p.pid); unknown(p.group, p.pid)
      if (before && before.group !== p.group) unknown(before.group, p.pid)
    } else if (before && before.group !== p.group) {
      unknown(before.group, p.pid); unknown(p.group, p.pid)
    }
  }
  const disappearedPids = previous.processes.filter(p => !currentIds.has(p.birthIdentity)).map(p => p.pid)
  for (const p of previous.processes.filter(p => !currentIds.has(p.birthIdentity))) {
    unknown('combined', p.pid); unknown(p.group, p.pid)
  }
  const counters = [
    ['cpuTimeNs', ['cpuUserNsExact', 'cpuSystemNsExact'], ['cpuPUserNsExact', 'cpuPSystemNsExact']],
    ['cpuEnergyNj', ['cpuEnergyNjExact'], ['cpuPEnergyNjExact']],
    ['cpuCycles', ['cpuCyclesExact'], ['cpuPCyclesExact']],
    ['cpuInstructions', ['cpuInstructionsExact'], ['cpuPInstructionsExact']],
  ]
  for (const [name, target] of Object.entries(groups)) {
    target.breakdown = {}
    for (const [metric, nsTotals, nsPerformance] of counters) {
      const tickTotals = ['cpuUserTicksExact', 'cpuSystemTicksExact'], tickPerformance = ['cpuPUserTicksExact', 'cpuPSystemTicksExact']
      const timebase = current.timebase
      const useTicks = metric === 'cpuTimeNs' && Number.isSafeInteger(timebase?.numer) && timebase.numer > 0 && Number.isSafeInteger(timebase?.denom) && timebase.denom > 0
        && previous.timebase?.numer === timebase.numer && previous.timebase?.denom === timebase.denom
        && [previous, current].every(snapshot => snapshot.processes.filter(process => selected(process, name) && process.counters).every(process => tickTotals.every(key => process.counters[key] != null)))
      const totals = useTicks ? tickTotals : nsTotals, performance = useTicks ? tickPerformance : nsPerformance
      const supported = metric === 'cpuEnergyNj' ? previous.cpuEnergySupported === true && current.cpuEnergySupported === true
        : metric === 'cpuCycles' ? previous.cpuCyclesSupported === true && current.cpuCyclesSupported === true
          : metric === 'cpuInstructions' ? previous.cpuInstructionsSupported === true && current.cpuInstructionsSupported === true : true
      const pSupportKey = { cpuTimeNs: 'cpuPTimeSupported', cpuEnergyNj: 'cpuPEnergySupported', cpuCycles: 'cpuPCyclesSupported', cpuInstructions: 'cpuPInstructionsSupported' }[metric]
      const observed = keys => [previous, current].some(snapshot => snapshot.processes.some(process => selected(process, name) && process.counters && keys.some(key => process.counters[key] != null && BigInt(process.counters[key]) > 0n)))
      let total = 0n, pcore = 0n, totalValid = (supported || observed(totals)) && target.unknownPids.length === 0
      let valid = totalValid && ((previous[pSupportKey] === true && current[pSupportKey] === true) || observed(performance))
      for (const p of current.processes.filter(p => selected(p, name))) {
        const before = old.get(p.birthIdentity)
        const born = !before && p.counters && BigInt(p.counters.startMonotonicNsExact) >= BigInt(previous.sampleEndMonotonicNsExact)
        if (!p.counters || (!before && !born) || (before && (!before.counters || (name !== 'combined' && before.group !== p.group)))) { valid = false; totalValid = false; continue }
        const read = (entry, keys) => {
          if (!entry) return 0n
          const values = keys.map(key => entry.counters[key])
          return values.some(value => value == null) ? null : values.reduce((sum, value) => sum + BigInt(value), 0n)
        }
        const t1 = read(p, totals), p1 = read(p, performance), t0 = read(before, totals), p0 = read(before, performance)
        if (t1 === null || t0 === null || t1 < t0 || (before && totals.some(key => BigInt(p.counters[key]) < BigInt(before.counters[key])))) { totalValid = false; valid = false; continue }
        total += t1 - t0
        if (p1 === null || p0 === null || p1 > t1 || p0 > t0 || p1 < p0 || p1 - p0 > t1 - t0 || (before && performance.some(key => BigInt(p.counters[key]) < BigInt(before.counters[key])))) { valid = false; continue }
        pcore += p1 - p0
      }
      const toNs = value => value * BigInt(timebase.numer) / BigInt(timebase.denom)
      const totalDisplay = useTicks ? toNs(total) : total, pDisplay = useTicks ? toNs(pcore) : pcore
      const adjustment = useTicks && valid ? totalDisplay - pDisplay - toNs(total - pcore) : null
      target.breakdown[metric] = { complete: valid, totalComplete: totalValid, totalExact: totalValid ? String(totalDisplay) : null,
        pCoreExact: valid ? String(pDisplay) : null, eCoreExact: valid ? String(totalDisplay - pDisplay) : null,
        ...(metric === 'cpuTimeNs' ? { source: useTicks ? 'mach-ticks' : 'legacy-nanoseconds',
          totalTicksExact: useTicks && totalValid ? String(total) : null, pCoreTicksExact: useTicks && valid ? String(pcore) : null,
          eCoreTicksExact: useTicks && valid ? String(total - pcore) : null,
          eCoreRoundingAdjustmentNsExact: adjustment === null ? null : String(adjustment) } : {}) }
    }
  }
  const results = Object.fromEntries(Object.entries(groups).map(([name, value]) => {
    const cpu = value.breakdown.cpuTimeNs.totalExact, energy = value.breakdown.cpuEnergyNj.totalExact
    return [name, {
      complete: value.unknownPids.length === 0,
      cpuNs: numeric(cpu), cpuNsExact: cpu,
      cpuPercentOfOneCore: cpu !== null && elapsed > 0n ? Number(cpu) / Number(elapsed) * 100 : null,
      cpuEnergyNj: numeric(energy), cpuEnergyNjExact: energy,
      cpuEnergyJoules: energy === null ? null : Number(energy) / 1e9,
      cpuWatts: energy !== null && elapsed > 0n ? Number(energy) / Number(elapsed) : null,
      unknownPids: value.unknownPids, breakdown: value.breakdown,
    }]
  }))
  return {
    elapsedNs: numeric(elapsed), elapsedNsExact: String(elapsed), ...results, disappearedPids,
    observationWindow: { previousSnapshotStartNsExact: previous.sampleStartMonotonicNsExact, previousSnapshotEndNsExact: previous.sampleEndMonotonicNsExact,
      currentSnapshotStartNsExact: current.sampleStartMonotonicNsExact, currentSnapshotEndNsExact: current.sampleEndMonotonicNsExact },
    limitation: 'Known-process deltas; processes that exit or start and exit between samples can be missed. Per-PID reads are not simultaneous.',
  }
}

async function openHelper() {
  const executable = await helperPath()
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = '', pending, exited = false
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', text => { stderr = (stderr + text).slice(-8000) })
  const done = new Promise(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal }) }))
  const fail = error => { if (pending) { const reject = pending.reject; pending = undefined; reject(error) } }
  child.stdin.on('error', fail)
  child.once('error', error => fail(new Error(`Cannot start process sampler: ${error.message}`, { cause: error })))
  child.once('close', (code, signal) => fail(new Error(`Process sampler exited (${signal || code}): ${stderr}`)))
  createInterface({ input: child.stdout }).on('line', line => {
    if (!pending) return
    const { resolve, reject } = pending; pending = undefined
    try { resolve(JSON.parse(line)) } catch (error) { reject(new Error(`Invalid process sampler output: ${error.message}`)) }
  })
  const request = line => {
    if (exited) return Promise.reject(new Error(`Process sampler is not running: ${stderr}`))
    if (pending) return Promise.reject(new Error('A process sample is already in progress.'))
    return new Promise((resolve, reject) => {
      pending = { resolve, reject }
      child.stdin.write(`${line}\n`, error => { if (error) fail(error) })
    })
  }
  return {
    pid: child.pid,
    request(rootPids, extraPids, includeWebKit) {
      return request(`${rootPids.join(',') || '-'}|${extraPids.join(',') || '-'}|${includeWebKit ? 1 : 0}`)
    },
    requestBundle: path => request(`bundle|${path}`),
    async close() { if (!exited) child.stdin.end(); await done },
  }
}

/** Read-only LaunchServices lookup for a controller-owned .app path. */
export async function findAppPids(bundlePath) {
  if (typeof bundlePath !== 'string' || !bundlePath.startsWith('/') || !bundlePath.endsWith('.app') || /[\0\r\n]/.test(bundlePath)) throw new TypeError('An absolute .app bundle path is required.')
  const helper = await openHelper()
  try {
    const result = await helper.requestBundle(bundlePath)
    if (result.error) throw new Error(result.error)
    return validatePids(result.pids, 'bundle process IDs')
  } finally { await helper.close() }
}

/** One read-only snapshot. All root descendants and extra descendants are included. */
export async function snapshotProcessTree({ rootPids = [], extraPids = [], includeWebKit = true } = {}) {
  rootPids = validatePids(rootPids, 'rootPids')
  extraPids = validatePids(extraPids, 'extraPids')
  if (!rootPids.length && !extraPids.length) throw new TypeError('Provide at least one root or extra PID.')
  const helper = await openHelper()
  try { return normalize(await helper.request(rootPids, extraPids, includeWebKit), rootPids, extraPids) }
  finally { await helper.close() }
}

/** Parent contract: first root is the shell, later roots are the shared backend. */
export async function startSampling({ rootPids = [], extraPids, intervalMS = 1000, samples = [], onSample, includeWebKit = true } = {}) {
  rootPids = validatePids(rootPids, 'rootPids')
  if (!rootPids.length) throw new TypeError('Provide the shell PID as the first rootPids entry.')
  const separateRoots = extraPids === undefined
  extraPids = validatePids(separateRoots ? rootPids.slice(1) : extraPids, 'extraPids')
  if (separateRoots) rootPids = [rootPids[0]]
  if (![500, 1000].includes(intervalMS)) throw new TypeError('intervalMS must be 500 or 1000.')
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array.')
  const helper = await openHelper(), startedAt = new Date().toISOString()
  let previous, timer, inFlight, error, stopped = false, stopPromise, nextDue, stoppedAtMS, skippedSamples = 0, boundaryQueue = Promise.resolve(), boundaryPending = 0
  const identities = new Map()
  const take = async boundary => {
    const sample = normalize(await helper.request(rootPids, extraPids, includeWebKit), rootPids, extraPids)
    for (const pid of [...rootPids, ...extraPids]) {
      const found = sample.processes.find(p => p.pid === pid && p.counters)
      if (!found) throw new Error(`Requested process ${pid} is unavailable or exited during measurement.`)
      if (identities.has(pid) && identities.get(pid) !== found.birthIdentity) throw new Error(`PID ${pid} was reused during measurement; refusing to attribute a different process.`)
      identities.set(pid, found.birthIdentity)
    }
    if (boundary) sample.boundary = boundary
    sample.interval = previous ? intervalFor(previous, sample) : null
    previous = sample
    samples.push(sample)
    if (onSample) await onSample(sample)
  }
  const nowMS = () => Number(process.hrtime.bigint() / 1000000n)
  const schedule = () => {
    if (error || boundaryPending) return
    const now = stopped ? stoppedAtMS : nowMS()
    while (nextDue <= now) { nextDue += intervalMS; skippedSamples++ }
    if (stopped) return
    timer = setTimeout(() => {
      nextDue += intervalMS
      inFlight = take().catch(cause => { error = cause }).finally(() => { inFlight = undefined; schedule() })
    }, Math.max(0, nextDue - now))
  }
  try { await take(); nextDue = nowMS() + intervalMS; schedule() } catch (cause) { await helper.close(); throw cause }
  return {
    samples,
    sampleBoundary(boundary) {
      if (!['start', 'end'].includes(boundary)) return Promise.reject(new TypeError('Boundary must be start or end.'))
      if (stopped) return Promise.reject(new Error('Sampling has stopped.'))
      boundaryPending++
      clearTimeout(timer)
      const result = boundaryQueue.then(async () => {
        if (inFlight) await inFlight
        if (error) throw error
        await take(boundary)
      }).catch(cause => { error = cause; throw cause }).finally(() => {
        boundaryPending--
        if (!boundaryPending) schedule()
      })
      boundaryQueue = result.catch(() => {})
      return result
    },
    stop() {
      if (!stopPromise) stopPromise = (async () => {
        stoppedAtMS = nowMS(); stopped = true; clearTimeout(timer); schedule()
        if (inFlight) await inFlight
        await boundaryQueue
        try {
          if (error) throw error
          await take()
          return { intervalMS, startedAt, finishedAt: new Date().toISOString(), rootPids, extraPids, samples, skippedSamples,
            observer: { controllerPid: process.pid, helperPid: helper.pid, inclusion: 'Included only if present in the sampled process trees; see each snapshot process list.' },
            scope: 'Runtime tree and conservatively attributed WebKit XPC; the explicit backend tree is separate. CPU energy is a per-process CPU counter, not total app energy.',
            coverage: 'Periodic samples can miss short-lived processes and focus changes; WebKit responsibility is a private best-effort lookup. RSS sums can double-count shared pages.' }
        } finally { await helper.close() }
      })()
      return stopPromise
    },
  }
}
