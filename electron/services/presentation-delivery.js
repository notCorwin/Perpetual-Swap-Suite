import { encodeChartWire } from '../chart-wire.js'

// Own response bodies until the renderer successfully receives its restoration
// snapshot. Electron window creation and network acquisition live elsewhere.
export class PresentationDelivery {
  #pending = new Map()

  constructor({ getState, notify, isClosing = () => false }) {
    this.getState = getState
    this.notify = notify
    this.isClosing = isClosing
  }

  chunk(owner, id, bytes) {
    if (this.isClosing() || owner.isDestroyed()) return
    if (this.getState()?.active) {
      this.notify(owner, 'radar:gateway-stream', { id, type: 'data', base64: Buffer.from(bytes).toString('base64') })
    } else {
      const pending = this.#pending.get(id) ?? { owner, chunks: [] }
      pending.chunks.push(Buffer.from(bytes))
      this.#pending.set(id, pending)
    }
  }

  terminal(owner, detail) {
    if (this.isClosing() || owner.isDestroyed()) return
    if (this.getState()?.active) this.notify(owner, 'radar:gateway-stream', detail)
    else {
      const pending = this.#pending.get(detail.id) ?? { owner, chunks: [] }
      pending.terminal = detail
      this.#pending.set(detail.id, pending)
    }
  }

  publish(owner, update) {
    if (owner.isDestroyed()) return
    let value = update
    const delivered = []
    if (update.snapshot) {
      const gateway = []
      for (const [id, pending] of this.#pending) {
        if (pending.owner !== owner) continue
        if (pending.chunks.length) gateway.push({ id, type: 'data', base64: Buffer.concat(pending.chunks).toString('base64') })
        if (pending.terminal) gateway.push(pending.terminal)
        delivered.push(id)
      }
      value = { ...update, snapshot: encodeChartWire({ ...update.snapshot, gateway }) }
    }
    owner.send('radar:presentation', value)
    // Encoding or sending may throw. Release only after successful delivery.
    for (const id of delivered) this.#pending.delete(id)
  }

  discard(id) { this.#pending.delete(id) }

  discardOwner(owner) {
    for (const [id, pending] of this.#pending) if (pending.owner === owner) this.#pending.delete(id)
  }
}
