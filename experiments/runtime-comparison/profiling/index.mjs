import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, open, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { snapshotProcessTree } from '../measurement/index.mjs'
import { parseSample } from './parse.mjs'

const SAMPLE = '/usr/bin/sample'
const MAX_BYTES = 16 * 1024 * 1024
const MAX_PIDS = 16
const MAX_SNAPSHOT_AGE_MS = 30_000
const STDERR_LIMIT = 16 * 1024

function validate({ snapshot, pids, durationSeconds, intervalMS, outputDirectory }) {
  if (process.platform !== 'darwin') throw new Error('Native call-stack sampling requires macOS /usr/bin/sample.')
  if (!snapshot || !Array.isArray(snapshot.processes) || !Array.isArray(snapshot.rootPids) || !Array.isArray(snapshot.extraPids) || !Number.isFinite(snapshot.timestampMS)) {
    throw new TypeError('Provide a recent measurement snapshotProcessTree/startSampling snapshot with owned runtime and backend roots.')
  }
  const age = Date.now() - snapshot.timestampMS
  if (age < -1000 || age > MAX_SNAPSHOT_AGE_MS) throw new Error('The measurement snapshot is stale; take a new snapshot of the owned process tree.')
  if (!Array.isArray(pids) || !pids.length || pids.length > MAX_PIDS || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) || new Set(pids).size !== pids.length) {
    throw new TypeError(`pids must contain 1 to ${MAX_PIDS} distinct positive integer PIDs from the snapshot.`)
  }
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 30) throw new TypeError('durationSeconds must be an integer from 1 to 30.')
  if (!Number.isInteger(intervalMS) || intervalMS < 5 || intervalMS > 1000) throw new TypeError('intervalMS must be an integer from 5 to 1000.')
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim() || outputDirectory.includes('\0')) throw new TypeError('Provide an outputDirectory for private raw sample files.')
  return pids.map(pid => {
    const matches = snapshot.processes.filter(p => p.pid === pid)
    const item = matches[0]
    if (matches.length !== 1 || !item.counters || !['runtime', 'backend'].includes(item.group) || item.uid !== process.getuid() ||
        !Number.isSafeInteger(item.birthSeconds) || !Number.isSafeInteger(item.birthMicroseconds) || item.birthIdentity !== `${pid}:${item.birthSeconds}:${item.birthMicroseconds}`) {
      throw new Error(`PID ${pid} is not a readable, same-user runtime/backend member of the measurement snapshot.`)
    }
    if (pid === process.pid) throw new Error('Refusing to sample the controller process.')
    return item
  })
}

function identityMatches(expected, actual) {
  return actual && actual.counters && actual.birthIdentity === expected.birthIdentity && actual.uid === expected.uid && actual.group === expected.group
}

async function captureOne(item, { durationSeconds, intervalMS, outputDirectory }) {
  const rawFile = join(outputDirectory, `sample-${item.pid}-${item.birthSeconds}-${item.birthMicroseconds}.txt`)
  let file
  try { file = await open(rawFile, 'wx', 0o600) }
  catch (error) { return { pid: item.pid, birthIdentity: item.birthIdentity, group: item.group, rawFile: null, status: 'output_error', error: error.message } }
  const stream = file.createWriteStream()
  let stderr = '', stderrTruncated = false, bytes = 0, outputLimit = false, timedOut = false, spawnError = null, fileError = null
  const startedAt = new Date().toISOString()
  const child = spawn(SAMPLE, [String(item.pid), String(durationSeconds), String(intervalMS)], { stdio: ['ignore', 'pipe', 'pipe'] })
  stream.on('error', error => { fileError = error.message; child.kill('SIGKILL') })
  child.once('error', error => { spawnError = error.message })
  child.stderr.on('data', chunk => {
    const text = chunk.toString()
    if (stderr.length + text.length > STDERR_LIMIT) stderrTruncated = true
    stderr = (stderr + text).slice(0, STDERR_LIMIT)
  })
  child.stdout.on('data', chunk => {
    const remaining = MAX_BYTES - bytes
    const part = chunk.subarray(0, Math.max(0, remaining))
    bytes += part.length
    if (part.length && !stream.write(part)) { child.stdout.pause(); stream.once('drain', () => child.stdout.resume()) }
    if (chunk.length > remaining) { outputLimit = true; child.kill('SIGKILL') }
  })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, (durationSeconds + 15) * 1000)
  timer.unref()
  const [code, signal] = await once(child, 'close').catch(error => { spawnError ??= error.message; return [null, null] })
  clearTimeout(timer)
  // end() may already have been reached by an I/O error; avoid waiting on a
  // finish event that will never fire in that case.
  if (!stream.destroyed) await new Promise(done => stream.end(done))
  const result = { pid: item.pid, birthIdentity: item.birthIdentity, group: item.group, name: item.name, rawFile,
    startedAt, finishedAt: new Date().toISOString(), bytes, stderr, stderrTruncated, exitCode: code, signal, status: 'ok', analysis: null }
  let raw = ''
  try { raw = await readFile(rawFile, 'utf8') } catch (error) { fileError ??= error.message }
  const diagnostic = `${stderr}\n${raw.slice(0, 8192)}\n${spawnError ?? ''}\n${fileError ?? ''}`
  if (/operation not permitted|permission denied|not authorized|not entitled|insufficient privileges|failed to (?:get|grab|access|acquire|gain).*\b(?:task|process)|cannot (?:examine|sample).*permission/i.test(diagnostic)) result.status = 'permission_denied'
  else if (timedOut) result.status = 'timed_out'
  else if (outputLimit) result.status = 'output_limit'
  else if (fileError) result.status = 'output_error'
  else if (spawnError || code !== 0 || signal) result.status = 'command_failed'
  else {
    const reportPid = /^(?:Analysis of sampling .*? \(pid (\d+)\)|Process:\s+.*?\[(\d+)\])/m.exec(raw)
    if (!reportPid || Number(reportPid[1] ?? reportPid[2]) !== item.pid) result.status = 'invalid_report'
    else {
      result.analysis = parseSample(raw)
      if (!result.analysis.coverage.callGraphFound || !result.analysis.threads.length) result.status = 'invalid_report'
    }
  }
  if (spawnError || fileError) result.error = spawnError || fileError
  return result
}

/**
 * Capture ONLY PIDs selected from a recent measurement snapshot of the
 * caller-owned runtime/backend tree. No executable-name discovery is used.
 */
export async function capture({ snapshot, pids, durationSeconds = 3, intervalMS = 10, outputDirectory } = {}) {
  const selected = validate({ snapshot, pids, durationSeconds, intervalMS, outputDirectory })
  const roots = { rootPids: snapshot.rootPids, extraPids: snapshot.extraPids, includeWebKit: true }
  const before = await snapshotProcessTree(roots)
  if (before.frontmostPid === null) throw new Error('Cannot establish the frontmost process; refusing to start profiling.')
  if (before.processes.some(item => item.pid === before.frontmostPid)) throw new Error('The owned measurement tree is frontmost; refusing to start profiling.')
  for (const item of selected) {
    const current = before.processes.find(p => p.pid === item.pid)
    if (!identityMatches(item, current)) throw new Error(`PID ${item.pid} exited, was reused, or no longer belongs to the owned measurement tree; take a new snapshot.`)
  }
  const directory = resolve(outputDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const startedAt = new Date().toISOString()
  const processes = await Promise.all(selected.map(item => captureOne(item, { durationSeconds, intervalMS, outputDirectory: directory })))
  let after = null, postSnapshotError = null
  try { after = await snapshotProcessTree(roots) } catch (error) { postSnapshotError = error.message }
  for (const [index, result] of processes.entries()) {
    const observed = after?.processes.find(p => p.pid === result.pid)
    result.identityAfter = !after ? 'unavailable' : !observed ? 'exited_or_unobservable' : identityMatches(selected[index], observed) ? 'matched' : 'changed'
    result.attributionVerifiedAfter = result.identityAfter === 'matched'
  }
  return {
    startedAt, finishedAt: new Date().toISOString(), durationSeconds, intervalMS, outputDirectory: directory, processes,
    focus: { before: before.frontmostPid, after: after?.frontmostPid ?? null,
      unchanged: before.frontmostPid !== null && after?.frontmostPid != null ? before.frontmostPid === after.frontmostPid : null,
      limitation: 'Read-only observations before and after capture; intervening changes can be missed and external focus changes are not controlled.' },
    coverage: { requestedPids: pids.length, successfulReports: processes.filter(result => result.status === 'ok').length,
      identityVerifiedAfter: processes.filter(result => result.attributionVerifiedAfter).length, postSnapshotError,
      limitation: 'Only the supplied snapshot members are sampled; newly spawned, exited, unattributed WebKit, and transient processes may be missed. Sampling starts are not simultaneous. PID identity checks cannot eliminate the small race between checking and sample(1) attaching.' },
    interpretation: 'Separate diagnostic run; do not include sampler overhead in baseline comparisons. Stack observations include blocked threads and are not CPU percentages.',
  }
}

/** A local capability check: samples only a Node child created and reaped here. */
export async function probeCapability({ outputDirectory, durationSeconds = 2, intervalMS = 10 } = {}) {
  if (process.platform !== 'darwin') return { available: false, status: 'unsupported_platform', error: 'macOS /usr/bin/sample is required.' }
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) throw new TypeError('Provide an outputDirectory for the disposable capability sample.')
  const source = `process.send('ready', () => { let x = 1; for (;;) x = Math.sqrt(x + Math.random()); });`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT) })
  const closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })))
  try {
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message === 'ready'),
      closed.then(() => false),
      new Promise(done => { const timer = setTimeout(() => done(false), 5000); timer.unref() }),
    ])
    if (!ready) return { available: false, status: 'child_not_ready', error: stderr || 'Disposable CPU child failed to start.' }
    const snapshot = await snapshotProcessTree({ rootPids: [child.pid], includeWebKit: false })
    const result = await capture({ snapshot, pids: [child.pid], durationSeconds, intervalMS, outputDirectory })
    const sample = result.processes[0]
    return { available: sample.status === 'ok' && sample.attributionVerifiedAfter,
      status: sample.status === 'ok' && !sample.attributionVerifiedAfter ? 'identity_unverified' : sample.status, pid: child.pid, result }
  } catch (error) {
    return { available: false, status: 'probe_error', error: error.message, pid: child.pid }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
}
