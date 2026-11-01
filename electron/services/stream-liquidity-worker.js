import { parentPort } from 'node:worker_threads'
import { createLiquidityEvaluator } from './liquidity.js'
import { onOperationMessage } from './worker-operations.js'

const evaluate = createLiquidityEvaluator()
const books = new Map()

onOperationMessage(parentPort, 'stream-liquidity', ({ type, id, input, bookVersion, bookSnapshot, evictBook }) => {
  if (type === 'closeOperations') {
    return { type: 'operationsClosed' }
  }
  try {
    const instId = input?.instrument?.instId
    if (evictBook !== undefined) books.delete(evictBook)
    let previousBook
    if (bookVersion !== undefined) {
      if (bookSnapshot) {
        previousBook = books.get(instId)?.book
        books.set(instId, { version: bookVersion, book: bookSnapshot })
      }
      const snapshot = books.get(instId)
      if (!snapshot || snapshot.version !== bookVersion) throw new Error('The requested order book version is not resident in this worker.')
      input = { ...input, book: snapshot.book }
    }
    return { id, result: evaluate(input, previousBook) }
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) }
  }
}, { closeWhen: message => message.type === 'closeOperations' })
