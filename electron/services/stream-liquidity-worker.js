import { parentPort } from 'node:worker_threads'
import { createLiquidityEvaluator } from './liquidity.js'

const evaluate = createLiquidityEvaluator()
const books = new Map()

parentPort.on('message', ({ id, input, bookVersion, bookSnapshot, evictBook }) => {
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
    parentPort.postMessage({ id, result: evaluate(input, previousBook) })
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
