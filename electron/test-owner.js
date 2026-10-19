const MAX_PID = 2 ** 31 - 1

function explicitOwnerPID(value) {
  if (value === undefined) return undefined
  const pid = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(pid) || pid <= 1 || pid > MAX_PID) {
    throw new Error('PERPETUAL_SWAP_TEST_OWNER_PID must be an integer PID greater than 1.')
  }
  return pid
}

function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'EPERM') return true
    if (error.code === 'ESRCH') return false
    throw error
  }
}

// Playwright can detach Electron into another process group. Keep its runner
// and its captured launch parent as owners even after the OS reparents it.
export function startTestOwnerWatchdog({
  onOwnerLost,
  ownerPID = process.env.PERPETUAL_SWAP_TEST_OWNER_PID,
  parentPID = process.ppid,
  intervalMS = 250,
} = {}) {
  const runnerPID = explicitOwnerPID(ownerPID)
  if (typeof onOwnerLost !== 'function') throw new TypeError('onOwnerLost must be a function.')
  if (!Number.isFinite(intervalMS) || intervalMS <= 0) throw new TypeError('intervalMS must be positive.')
  const owners = []
  if (runnerPID !== undefined) owners.push({ pid: runnerPID, source: 'runner' })
  // Finder launches may have parent PID 1; it is not a test owner.
  if (Number.isInteger(parentPID) && parentPID > 1 && parentPID <= MAX_PID && parentPID !== runnerPID) {
    owners.push({ pid: parentPID, source: 'parent' })
  }
  let timer, stopped = false
  const stop = () => {
    stopped = true
    clearInterval(timer)
  }
  const check = () => {
    if (stopped) return
    const lost = owners.find(owner => !ownerIsAlive(owner.pid))
    if (lost) {
      stop()
      onOwnerLost(lost)
    }
  }
  if (owners.length) {
    timer = setInterval(check, intervalMS)
    timer.unref()
    check()
  }
  return stop
}
