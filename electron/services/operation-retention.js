import { constants } from 'node:fs'
import { mkdir, readdir, lstat, realpath, open, rename, unlink, rmdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { withOperationSuppressed } from './operations.js'
import { isOperationJournal, operationJournalExecutionId } from './operation-journal.js'

export const DEFAULT_OPERATION_RETENTION = Object.freeze({ maxAgeMS: 7 * 86_400_000, maxBytes: 512 * 1024 * 1024 })
const kind = 'perpetual-swap-operation-session', statusKind = 'perpetual-swap-operation-retention'
const manifestName = 'session.retention.json', statusName = 'retention.json', lockName = 'retention.lock', auditName = 'retention-deletions.ndjson'
const previousAuditName = 'retention-deletions.1.ndjson', auditLimit = 256 * 1024
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const execution = new RegExp(`^(?:[1-9]\\d*-\\d+-${uuid}|renderer-${uuid})$`)
const sessionName = new RegExp(`^session-(\\d{13})-([1-9]\\d*)-${uuid}$`), legacyName = /^(\d{13})-([1-9]\d*)$/
const quarantineName = new RegExp(`^\\.pruning-(${uuid})$`)
const participantName = new RegExp(`^(${uuid})\\.participant\\.json$`)
const graphicsName = new RegExp(`^chromium-[1-9]\\d*-${uuid}\\.(?:status|trace)\\.json$`)
const errorCode = error => error?.code ?? error?.name ?? 'Error'
const number = value => Number.isSafeInteger(value) && value >= 0
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const validPID = value => Number.isSafeInteger(value) && value > 0
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
const fileKind = name => name === manifestName ? 'manifest' : name.endsWith('.health.json') && execution.test(name.slice(0, -12)) ? 'health'
  : isOperationJournal(name) && execution.test(operationJournalExecutionId(name)) ? 'journal' : participantName.test(name) ? 'participant' : graphicsName.test(name) ? 'graphics' : null

async function safeRoot(path) {
  const absolute = resolve(path)
  await mkdir(absolute, { recursive: true, mode: 0o700 })
  const info = await lstat(absolute)
  if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('Operation retention requires a real directory.'), { code: 'UNSAFE_RETENTION_ROOT' })
  return realpath(absolute)
}
async function readJSON(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('Invalid retention metadata file.')
    return JSON.parse(await file.readFile('utf8'))
  } finally { await file.close() }
}
async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}
async function atomicJSON(path, value) {
  const temporary = join(dirname(path), `.tmp-${randomUUID()}-${basename(path)}`)
  let file
  try {
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(`${JSON.stringify(value)}\n`)
    await file.sync(); await file.close(); file = undefined
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
const validManifest = (value, id) => value?.schemaVersion === 1 && value.kind === kind && value.id === id
  && (sessionName.test(id) || legacyName.test(id)) && typeof value.token === 'string' && new RegExp(`^${uuid}$`).test(value.token)
  && validPID(value.pid) && number(value.createdAt) && number(value.updatedAt) && ['active', 'closed', 'interrupted'].includes(value.state)
  && (value.state !== 'closed' || timestamp(value.closedAt))

async function inspectSession(root, name, isProcessAlive) {
  const path = join(root, name), info = await lstat(path)
  const result = { id: name, name, path, info, bytes: info.isFile() || info.isSymbolicLink() ? info.size : 0, state: 'unsafe', reason: 'unknown-session', files: [], sizeIncomplete: false }
  if (!info.isDirectory() || info.isSymbolicLink()) return result
  const parsed = sessionName.exec(name) ?? legacyName.exec(name), quarantined = quarantineName.exec(name)
  // Unknown directories are measured without descending through symlinks, but
  // never become deletion candidates based on their apparent age alone.
  const entries = await readdir(path, { withFileTypes: true })
  let unsafe = false, lastWrite = 0
  for (const entry of entries) {
    const child = join(path, entry.name), stat = await lstat(child)
    result.files.push({ name: entry.name, path: child, info: stat, kind: fileKind(entry.name) })
    if (stat.isFile() || stat.isSymbolicLink()) result.bytes += stat.size
    else { unsafe = true; result.sizeIncomplete = true }
    if (!stat.isFile() || stat.isSymbolicLink() || !fileKind(entry.name)) unsafe = true
    if (entry.name !== manifestName) lastWrite = Math.max(lastWrite, stat.mtimeMs)
  }
  if (!parsed && !quarantined) return result
  const manifestFile = result.files.find(file => file.kind === 'manifest')
  let manifest
  if (manifestFile && !manifestFile.info.isSymbolicLink()) {
    try { manifest = await readJSON(manifestFile.path) } catch { unsafe = true }
  }
  const id = quarantined ? manifest?.id : name
  if (manifestFile && !validManifest(manifest, id) || quarantined && (!manifest?.prune || manifest.prune.token !== quarantined[1]) || !manifestFile && !legacyName.test(name)) unsafe = true
  result.id = id ?? name; result.manifest = manifest
  const ownerPID = manifest?.pid ?? Number(parsed?.[2]), pids = new Set(validPID(ownerPID) ? [ownerPID] : [])
  const health = new Map(), participants = new Map()
  let healthy = true
  for (const file of result.files) {
    try {
      if (file.kind === 'health') {
        const value = await readJSON(file.path), id = file.name.slice(0, -12)
        if (value.executionId !== id || ![undefined, 1, 2].includes(value.schemaVersion)) healthy = false
        health.set(id, value)
        const pid = Number(id.split('-')[0]); if (validPID(pid)) pids.add(pid)
        if (value.closed !== true || !number(value.recorded) || value.recorded !== value.persisted || value.failed !== 0 || value.pending !== 0
          || value.durableRecords !== undefined && value.durableRecords !== value.persisted
          || ['sourceFailures', 'omittedRecords', 'activeOperations'].some(key => value[key] !== undefined && value[key] !== 0)) healthy = false
      } else if (file.kind === 'participant') {
        const value = await readJSON(file.path), id = participantName.exec(file.name)[1]
        if (value.schemaVersion !== 2 || value.id !== id || value.status !== 'ready' || !execution.test(value.executionId ?? '')) healthy = false
        participants.set(id, value)
        const pid = Number(value.executionId?.split('-')[0]); if (validPID(pid)) pids.add(pid)
      } else if (file.kind === 'graphics' && file.name.endsWith('.status.json')) {
        const value = await readJSON(file.path)
        if (value.error || value.enabled && (!value.complete || dirname(resolve(value.file ?? '')) !== path
          || !result.files.some(file => file.path === resolve(value.file)))) healthy = false
      }
    } catch { healthy = false }
  }
  const journals = result.files.filter(file => file.kind === 'journal')
  if (!journals.length || journals.length !== health.size || journals.some(file => !health.has(operationJournalExecutionId(file.name)))) healthy = false
  for (const [id, value] of health) {
    if (value.schemaVersion === 2) {
      const participant = participants.get(value.participantId)
      if (!participant || participant.executionId !== id || participant.role !== value.role) healthy = false
    }
  }
  for (const value of participants.values()) if (!health.has(value.executionId)) healthy = false
  const running = [...pids].some(pid => isProcessAlive(pid) !== false)
  result.closedAt = manifest?.closedAt ?? lastWrite
  result.pids = [...pids]
  result.healthy = healthy && !unsafe
  if (unsafe) result.reason = 'unsafe-contents-or-manifest'
  else if (legacyName.test(result.id) && running) { result.state = 'active'; result.reason = 'live-owner' }
  else if (manifest?.state === 'closed' && manifest.prune && quarantined) { result.state = 'closed'; result.reason = 'resuming-prune' }
  else if (manifest?.state === 'active' || !manifest && running) { result.state = running ? 'active' : 'interrupted'; result.reason = running ? 'live-owner' : 'owner-exited-without-close' }
  else if (manifest?.state === 'interrupted' || !healthy) { result.state = 'interrupted'; result.reason = 'recorder-not-closed-or-incomplete' }
  else if (manifest?.state === 'closed' || !running) { result.state = 'closed'; result.reason = 'completed' }
  else { result.state = 'active'; result.reason = 'live-owner' }
  return result
}

/** Allocate one owned session. Heartbeat does not authorize deleting a live PID. */
export async function createOperationSession({ root, now = Date.now, pid = process.pid } = {}) {
  return withOperationSuppressed(async () => {
    if (!validPID(pid)) throw new TypeError('Invalid operation session owner PID.')
    root = await safeRoot(root)
    const createdAt = now(), id = `session-${createdAt}-${pid}-${randomUUID()}`
    if (!sessionName.test(id)) throw new TypeError('Invalid operation session clock.')
    const directory = join(root, id)
    await mkdir(directory, { mode: 0o700 })
    let manifest = { schemaVersion: 1, kind, id, token: randomUUID(), pid, createdAt, updatedAt: createdAt, state: 'active' }, closing, tail = Promise.resolve()
    await atomicJSON(join(directory, manifestName), manifest)
    const update = async value => {
      const current = await readJSON(join(directory, manifestName))
      if (!validManifest(current, id) || current.token !== manifest.token) throw new Error('Operation session ownership changed.')
      manifest = { ...manifest, ...value, updatedAt: now() }
      await atomicJSON(join(directory, manifestName), manifest)
      return { ...manifest }
    }
    return { id, directory,
      heartbeat: () => withOperationSuppressed(() => {
        if (closing) return closing
        if (manifest.state !== 'active') return Promise.resolve({ ...manifest })
        const task = tail.then(() => update({})); tail = task.catch(() => {})
        return task
      }),
      close({ complete = true } = {}) {
        if (!closing) closing = withOperationSuppressed(async () => {
          await tail
          const session = await inspectSession(root, id, alive)
          // The owning process is still alive here. Health, rather than PID
          // death, proves that every writer has completed its durable close.
          if (complete && !session.healthy) {
            await update({ state: 'interrupted', failure: session.reason })
            throw new Error('Operation session cannot close before all recorder journals are healthy and closed.')
          }
          return update(complete ? { state: 'closed', closedAt: now() } : { state: 'interrupted', failure: 'owner-reported-incomplete' })
        })
        return closing
      },
    }
  })
}

async function acquireLock(root, isProcessAlive) {
  const path = join(root, lockName)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600), token = randomUUID()
      let info
      try { info = await file.stat(); await file.writeFile(JSON.stringify({ schemaVersion: 1, kind: statusKind, token, pid: process.pid })); await file.sync() }
      finally { await file.close() }
      return async () => {
        const current = await lstat(path).catch(() => undefined)
        if (current?.ino === info.ino && current.dev === info.dev) await unlink(path)
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) return null
      let owner
      try { owner = await readJSON(path) } catch { return null }
      if (owner.kind !== statusKind || !validPID(owner.pid) || isProcessAlive(owner.pid) !== false) return null
      const current = await lstat(path)
      if (current.ino !== info.ino || current.dev !== info.dev) return null
      await unlink(path)
    }
  }
  return null
}
async function validateAudit(file) {
  const info = await file.stat(), header = Buffer.alloc(1024)
  if (!info.isFile() || info.size > auditLimit) throw new Error('Invalid retention audit file.')
  const { bytesRead } = await file.read(header, 0, header.length, 0)
  let previous
  try { previous = JSON.parse(header.subarray(0, bytesRead).toString('utf8').split('\n')[0]) } catch { throw new Error('An unrelated file occupies the retention audit path.') }
  if (previous.kind !== statusKind || previous.schemaVersion !== 1) throw new Error('An unrelated file occupies the retention audit path.')
  return info.size
}
async function audit(root, value) {
  const path = join(root, auditName)
  const line = `${JSON.stringify({ schemaVersion: 1, kind: statusKind, ...value })}\n`
  let file
  try {
    try { file = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      file = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW)
      const size = await validateAudit(file)
      if (size + Buffer.byteLength(line) > auditLimit) {
        const previousPath = join(root, previousAuditName)
        const previous = await open(previousPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (previous) { try { await validateAudit(previous) } finally { await previous.close() } }
        await file.close(); file = undefined
        await rename(path, previousPath); await syncDirectory(root)
        file = await open(path, 'wx', 0o600)
      }
    }
    await file.writeFile(line); await file.sync()
  } finally { await file?.close() }
}
async function metadataBytes(root) {
  let bytes = 0
  for (const name of [statusName, lockName, auditName, previousAuditName]) {
    const info = await lstat(join(root, name)).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe operation retention metadata path.')
      bytes += info.size
    }
  }
  return bytes
}
async function pruneSession(root, session, reason, now, isProcessAlive) {
  const fresh = await inspectSession(root, session.name, isProcessAlive)
  if (fresh.info.ino !== session.info.ino || fresh.info.dev !== session.info.dev || fresh.state !== 'closed') throw new Error('Operation session is no longer eligible for cleanup.')
  session = fresh
  const token = session.manifest?.prune?.token ?? randomUUID()
  const manifest = session.manifest ?? { schemaVersion: 1, kind, id: session.id, token: randomUUID(), pid: Number(legacyName.exec(session.id)[2]),
    createdAt: Number(legacyName.exec(session.id)[1]), updatedAt: now, state: 'closed', closedAt: session.closedAt }
  const intent = { ...manifest, prune: { token, reason, requestedAt: now } }
  await atomicJSON(join(session.path, manifestName), intent)
  await audit(root, { phase: 'scheduled', id: session.id, token, reason, bytes: session.bytes, at: now })
  const quarantine = join(root, `.pruning-${token}`)
  if (session.path !== quarantine) await rename(session.path, quarantine)
  await syncDirectory(root)
  const checked = await inspectSession(root, basename(quarantine), isProcessAlive)
  if (checked.info.ino !== session.info.ino || checked.info.dev !== session.info.dev || checked.state !== 'closed' || checked.reason !== 'resuming-prune') throw new Error('Operation session changed during retention cleanup.')
  // Flat, validated artifacts only: never follow a directory/symlink with rm -r.
  for (const file of checked.files.filter(file => file.kind !== 'manifest')) {
    const current = await lstat(file.path)
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== file.info.ino || current.dev !== file.info.dev) throw new Error('Operation artifact changed during retention cleanup.')
    await unlink(file.path)
  }
  await unlink(join(quarantine, manifestName)); await rmdir(quarantine); await syncDirectory(root)
  await audit(root, { phase: 'deleted', id: session.id, token, reason, bytes: session.bytes, at: now })
}

/** Expire whole completed sessions; protected data may honestly exceed policy. */
export async function enforceOperationRetention(path, { maxAgeMS = DEFAULT_OPERATION_RETENTION.maxAgeMS, maxBytes = DEFAULT_OPERATION_RETENTION.maxBytes,
  now = Date.now, isProcessAlive = alive } = {}) {
  return withOperationSuppressed(async () => {
    if (!number(maxAgeMS) || !number(maxBytes)) throw new TypeError('Operation retention budgets must be nonnegative safe integers.')
    const root = await safeRoot(path), timestamp = now()
    if (!number(timestamp)) throw new TypeError('Invalid operation retention clock.')
    const status = { schemaVersion: 1, kind: statusKind, updatedAt: timestamp, policy: { maxAgeMS, maxBytes },
      state: 'ok', busy: false, totalBytes: 0, retainedBytes: 0, protectedBytes: 0, overBudgetBytes: 0,
      expiredProtectedSessions: 0, unmeasuredPaths: 0, metadataBytes: 0, sessions: [], pruned: [], failures: [], auditFile: auditName,
      auditPolicy: { maxSegmentBytes: auditLimit, segments: 2 } }
    const release = await acquireLock(root, isProcessAlive)
    if (!release) { status.state = 'blocked'; status.busy = true; status.unmeasuredPaths = 1; return status }
    try {
      const existing = await lstat(join(root, statusName)).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (existing && (existing.isSymbolicLink() || (await readJSON(join(root, statusName))).kind !== statusKind)) throw new Error('An unrelated file occupies the retention status path.')
      const sessions = []
      for (const entry of await readdir(root)) {
        if ([statusName, lockName, auditName, previousAuditName].includes(entry)) continue
        try { sessions.push(await inspectSession(root, entry, isProcessAlive)) }
        catch (error) { status.failures.push({ id: entry, code: errorCode(error) }) }
      }
      status.totalBytes = sessions.reduce((sum, session) => sum + session.bytes, 0)
      let retained = status.totalBytes
      status.metadataBytes = await metadataBytes(root)
      for (const session of sessions.toSorted((a, b) => (a.closedAt ?? Infinity) - (b.closedAt ?? Infinity) || a.name.localeCompare(b.name))) {
        const expired = timestamp - session.closedAt > maxAgeMS
        const reason = expired ? 'age' : retained + status.metadataBytes > maxBytes ? 'capacity' : session.reason === 'resuming-prune' ? 'interrupted-prune' : null
        if (session.state === 'closed' && reason) {
          try { await pruneSession(root, session, reason, timestamp, isProcessAlive); retained -= session.bytes; status.pruned.push({ id: session.id, bytes: session.bytes, reason }); continue }
          catch (error) { status.failures.push({ id: session.id, code: errorCode(error) }); session.reason = 'prune-failed' }
        }
        status.sessions.push({ id: session.id, state: session.state, reason: session.reason, bytes: session.bytes })
        status.unmeasuredPaths += Number(session.sizeIncomplete)
        if (session.state !== 'closed') { status.protectedBytes += session.bytes; status.expiredProtectedSessions += Number(expired) }
      }
      const sessionBytes = status.totalBytes
      // Include bounded manager metadata too. A second atomic update accounts
      // for the size of this status document itself without a hidden log budget.
      for (let attempt = 0; attempt < 4; attempt++) {
        status.metadataBytes = await metadataBytes(root)
        status.totalBytes = sessionBytes + status.metadataBytes; status.retainedBytes = retained + status.metadataBytes
        status.overBudgetBytes = Math.max(0, status.retainedBytes - maxBytes)
        status.state = status.failures.length || status.unmeasuredPaths ? 'blocked' : status.overBudgetBytes || status.expiredProtectedSessions ? 'over-budget' : 'ok'
        await atomicJSON(join(root, statusName), status)
        if (await metadataBytes(root) === status.metadataBytes) break
      }
      return status
    } finally { await release() }
  })
}
