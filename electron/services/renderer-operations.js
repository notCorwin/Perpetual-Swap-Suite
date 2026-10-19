import { randomUUID, createHash } from 'node:crypto'
import { importOperationEvents } from './operations.js'
import { registerOperationParticipant, claimExternalOperationParticipant, markExternalOperationSourceIncomplete, flushExternalOperationSource } from './operation-runtime.js'

/** Trusted IPC source ownership and replay-safe durable batch acknowledgments. */
export function createRendererOperationReceiver({ register = registerOperationParticipant, claim = claimExternalOperationParticipant,
  importEvents = importOperationEvents, flush = flushExternalOperationSource, incomplete = markExternalOperationSourceIncomplete } = {}) {
  const sources = new Map(), initializations = new Map()
  const sourceFor = (owner, executionId) => {
    const source = sources.get(executionId)
    if (!source || source.owner !== owner) throw new Error('Unknown renderer operation source.')
    return source
  }
  return {
    initialize(owner, nonce) {
      if (typeof nonce !== 'string' || !/^[\w-]{1,100}$/.test(nonce)) throw new TypeError('Invalid renderer operation initialization.')
      const key = `${owner}:${nonce}`
      if (initializations.has(key)) return initializations.get(key)
      const participant = register('renderer')
      const identity = claim(participant.id, `renderer-${randomUUID()}`)
      sources.set(identity.executionId, { owner, ...identity, lastSequence: 0, tail: Promise.resolve() })
      initializations.set(key, identity)
      return identity
    },
    receive(owner, batch) {
      const source = sourceFor(owner, batch?.executionId)
      if (!batch || typeof batch.batchId !== 'string' || batch.batchId.length > 256 || !Array.isArray(batch.events)
        || !batch.events.length || batch.events.length > 128 || !Number.isSafeInteger(batch.firstSequence)
        || batch.firstSequence !== batch.events[0]?.sequence
        || batch.events.some((event, index) => event?.executionId !== source.executionId || event.sessionId !== source.sessionId || event.sequence !== batch.firstSequence + index)) {
        throw new TypeError('Invalid renderer operation batch.')
      }
      const signature = createHash('sha256').update(JSON.stringify(batch.events)).digest('hex')
      const accept = async () => {
        if (source.lastBatch?.id === batch.batchId && source.lastBatch.signature !== signature) throw new Error('A renderer operation batch ID was reused with different records.')
        const result = importEvents(batch.events)
        if (result.rejected || result.accepted + result.duplicates !== batch.events.length) throw new Error('Renderer operation records are invalid or out of sequence.')
        await flush(source.executionId)
        source.lastSequence = batch.events.at(-1).sequence
        source.lastBatch = { id: batch.batchId, signature }
        return { batchId: batch.batchId, lastSequence: source.lastSequence }
      }
      const task = source.tail.then(accept)
      source.tail = task.catch(() => {})
      return task
    },
    fail(owner, value) {
      const source = sourceFor(owner, value?.executionId)
      if (typeof value.reason !== 'string' || value.reason.length > 160 || !Number.isSafeInteger(value.omitted) || value.omitted < 0) throw new TypeError('Invalid renderer operation failure.')
      // The renderer sends its lifetime omission high-water mark. A lost IPC
      // acknowledgment can replay the same report without counting loss twice.
      if (source.omittedHighWater !== undefined && value.omitted <= source.omittedHighWater) return
      incomplete(source.executionId, value.reason, value.omitted - (source.omittedHighWater ?? 0))
      source.omittedHighWater = value.omitted
    },
    markIncomplete(owner, reason) { for (const source of sources.values()) if (source.owner === owner) incomplete(source.executionId, reason) },
    sourcesFor(owner) { return [...sources.values()].filter(source => source.owner === owner).map(source => source.executionId) },
  }
}
