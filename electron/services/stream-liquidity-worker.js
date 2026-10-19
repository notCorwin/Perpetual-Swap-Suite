import { parentPort } from 'node:worker_threads'
import { createLiquidityEvaluator } from './liquidity.js'
import { onOperationMessage } from './worker-operations.js'
import { measureOperation } from './operations.js'

const evaluate = createLiquidityEvaluator()
const books = new Map()
const MAX_BOOK_SNAPSHOTS = 512

onOperationMessage(parentPort, 'stream-liquidity', ({ type, id, input }) => {
  if (type === 'closeOperations') {
    return { type: 'operationsClosed' }
  }
  try {
    const instId = input?.instrument?.instId
    if (typeof instId === 'string' && input.book && typeof input.book === 'object') {
      // Structured cloning changes object identity. Restore an immutable
      // snapshot's identity so ticker/OI updates reuse its exact book fractions.
      const signature = measureOperation({ category: 'cpu', name: 'liquidity.book.identity', resource: instId,
        attributes: { bidLevels: input.book.bids?.length ?? 0, askLevels: input.book.asks?.length ?? 0 } }, () => JSON.stringify(input.book))
      const previous = books.get(instId)
      const snapshot = previous?.signature === signature ? previous : { signature, book: input.book }
      books.delete(instId)
      books.set(instId, snapshot)
      if (books.size > MAX_BOOK_SNAPSHOTS) books.delete(books.keys().next().value)
      input = { ...input, book: snapshot.book }
    }
    return { id, result: evaluate(input) }
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) }
  }
}, { closeWhen: message => message.type === 'closeOperations' })
