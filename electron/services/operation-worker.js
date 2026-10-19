import { beginOperation } from './operations.js'

/** Stop a worker only after its operation journal has acknowledged shutdown. */
export async function stopOperationWorker(worker, resource, timeoutMS = 2_000) {
  const span = beginOperation({ category: 'ipc', name: 'diagnostics.worker.flush', resource,
    attributes: { measurement: 'shutdown-wait', threadId: worker.threadId } })
  const outcome = await new Promise(resolve => {
    const finished = reason => {
      clearTimeout(timer)
      worker.off('message', message)
      worker.off('exit', exited)
      worker.off('error', failed)
      resolve(reason)
    }
    const message = value => { if (value?.type === 'operationsClosed') finished(value.error ? 'flush-failed' : 'flushed') }
    const exited = () => finished('worker-exited')
    const failed = () => finished('worker-error')
    const timer = setTimeout(() => finished('flush-timeout'), timeoutMS)
    worker.on('message', message)
    worker.once('exit', exited)
    worker.once('error', failed)
    worker.ref()
    if (worker.threadId === -1) finished('worker-exited')
    else {
      try { span.run(() => worker.postMessage({ type: 'closeOperations' })) }
      catch { finished('worker-unreachable') }
    }
  })
  span.end({ status: outcome === 'flushed' ? 'ok' : 'error', attributes: { reason: outcome, incomplete: outcome !== 'flushed' } })
  await worker.terminate()
}
