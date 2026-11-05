import { createServer } from 'node:net'
import { chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Persistent authenticated RPC; payload strings are identical to HTTP JSON. */
export async function createNativeBroker({ token, dispatch }) {
  const path = join(tmpdir(), `radar-compare-${process.pid}-${randomUUID().slice(0, 8)}.sock`)
  const sockets = new Set()
  let active, connected = false
  const server = createServer(socket => {
    sockets.add(socket)
    let authorized = false, buffer = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); if (active === socket) { active = undefined; connected = false } })
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (let end; (end = buffer.indexOf(10)) >= 0;) {
        if (end > 128 * 1024 * 1024) return socket.destroy()
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1)
        try {
          const value = JSON.parse(line)
          if (!authorized) {
            if (value.kind !== 'hello' || value.token !== token || active) return socket.destroy()
            authorized = true; active = socket; continue
          }
          if (value.kind !== 'request' || !Number.isSafeInteger(value.id) || value.id < 1 || typeof value.path !== 'string' || typeof value.payload !== 'string') return socket.destroy()
          if (value.path === 'connect') connected = true
          void dispatch(value.path, JSON.parse(value.payload), Buffer.byteLength(value.payload)).then(result => {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ kind: 'response', id: value.id, result })}\n`)
          }).catch(error => { if (!socket.destroyed) socket.write(`${JSON.stringify({ kind: 'response', id: value.id, error: error.message })}\n`) })
        } catch { socket.destroy(); return }
      }
      if (buffer.length > 128 * 1024 * 1024) socket.destroy()
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  await chmod(path, 0o600)
  return {
    path, get connected() { return connected },
    send(payload) { if (connected) active.write(`${JSON.stringify({ kind: 'event', payload })}\n`) },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise(done => server.close(done))
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
    },
  }
}
