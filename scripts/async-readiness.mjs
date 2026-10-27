import { setTimeout as sleep } from 'node:timers/promises'

// Await each IPC result before testing its truthiness. Browser-side
// waitForFunction treats a returned Promise itself as a successful predicate.
export async function waitForAsyncCondition(condition, { description, timeoutMS = 30_000, pollingMS = 100 } = {}) {
  if (typeof condition !== 'function' || typeof description !== 'string' || !description
    || !Number.isFinite(timeoutMS) || timeoutMS <= 0 || !Number.isFinite(pollingMS) || pollingMS <= 0) {
    throw new Error('Async readiness requires a predicate, description and positive finite timing limits.')
  }
  const deadline = performance.now() + timeoutMS
  const failure = () => new Error(`Timed out after ${timeoutMS} ms waiting for ${description}.`)
  let timer
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(failure()), timeoutMS) })
  try {
    for (;;) {
      const value = await Promise.race([Promise.resolve().then(condition), expired])
      if (performance.now() >= deadline) throw failure()
      if (value) return value
      await Promise.race([sleep(Math.min(pollingMS, deadline - performance.now())), expired])
    }
  } finally { clearTimeout(timer) }
}
