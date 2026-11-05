import { findAppPids } from './measurement/index.mjs'

const owned = new Set()
let interrupted
const pause = ms => new Promise(done => setTimeout(done, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
const signal = (pid, value) => { try { process.kill(pid, value) } catch (error) { if (error.code !== 'ESRCH') throw error } }

export function assertRunning() {
  if (interrupted) throw new Error(`Comparison interrupted by ${interrupted}.`)
}

export function registerProcess(controller) {
  assertRunning()
  owned.add(controller)
  return controller
}

export function stop(controller) {
  if (!controller) return Promise.resolve({ skipped: true })
  controller.stopping ??= (async () => {
    let forced = false
    const child = controller.child
    const launcherFinished = () => child.exitCode !== null || child.signalCode !== null
    // A unique cloned bundle identifies this launch even before readiness or
    // after the open -W launcher has exited. Never signal a shared app name.
    let pids = controller.bundlePath ? await findAppPids(controller.bundlePath) : launcherFinished() ? [] : [child.pid]
    for (let attempt = 0; controller.bundlePath && !pids.length && !launcherFinished() && attempt < 20; attempt++) {
      await pause(100)
      pids = await findAppPids(controller.bundlePath)
    }
    for (const pid of pids) signal(pid, 'SIGTERM')
    if (controller.bundlePath && !pids.length && !launcherFinished()) child.kill('SIGTERM')
    const deadline = Date.now() + 15000
    while ((!launcherFinished() || pids.some(alive)) && Date.now() < deadline) await pause(50)
    if (!launcherFinished() || pids.some(alive)) {
      forced = true
      // Reconfirm bundle ownership before SIGKILL instead of trusting an old PID.
      pids = controller.bundlePath ? await findAppPids(controller.bundlePath) : launcherFinished() ? [] : [child.pid]
      for (const pid of pids) signal(pid, 'SIGKILL')
      if (!launcherFinished()) child.kill('SIGKILL')
      const killDeadline = Date.now() + 3000
      while ((!launcherFinished() || pids.some(alive)) && Date.now() < killDeadline) await pause(50)
      if (!launcherFinished() || pids.some(alive)) throw new Error('Comparison processes did not exit after forced cleanup.')
    }
    return { code: child.exitCode, signal: child.signalCode, forced }
  })().finally(() => owned.delete(controller))
  return controller.stopping
}

export function installInterruptionCleanup(onInterrupt) {
  for (const value of ['SIGINT', 'SIGTERM']) process.once(value, () => {
    if (interrupted) return
    interrupted = value
    void (async () => {
      // Stop the most recently launched runtime before its backend, matching
      // normal teardown and allowing the SSE connection to close first.
      const results = []
      for (const controller of [...owned].reverse()) {
        try { results.push({ status: 'fulfilled', value: await stop(controller) }) }
        catch (reason) { results.push({ status: 'rejected', reason }) }
      }
      await onInterrupt(value, results)
      process.exit(value === 'SIGINT' ? 130 : 143)
    })().catch(error => { console.error(error); process.exit(1) })
  })
}
