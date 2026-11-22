import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

// Status transitions are infrequent, but bound both disk usage and queued work.
export function createStatusLog(path, { maxBytes = 1024 * 1024, maxPending = 256 } = {}) {
  let tail = Promise.resolve()
  let pending = 0
  let size
  const write = value => {
    if (pending >= maxPending) return Promise.reject(new Error('Status log queue is full.'))
    pending++
    const line = `${JSON.stringify({ recordedAt: new Date().toISOString(), ...value })}\n`
    const task = tail.then(async () => {
      if (size === undefined) {
        await mkdir(dirname(path), { recursive: true })
        size = await stat(path).then(value => value.size, error => { if (error.code === 'ENOENT') return 0; throw error })
      }
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await rename(path, `${path}.1`)
        size = 0
      }
      await appendFile(path, line, 'utf8')
      size += Buffer.byteLength(line)
    })
    tail = task.catch(() => { size = undefined }).finally(() => { pending-- })
    return task
  }
  return { write, flush: () => tail }
}
