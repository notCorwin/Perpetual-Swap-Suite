import { createReadStream } from 'node:fs'
import { gzipSync, createGunzip, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const operationJournalSuffix = '.jsonl.gz'
export const isOperationJournal = path => /\.jsonl(?:\.gz)?$/.test(path)
export const operationJournalExecutionId = path => path.replace(/\.jsonl(?:\.gz)?$/, '')

// Each drained batch is one complete member. Concatenated gzip members retain
// exact JSONL bytes and leave earlier checkpoints readable after a torn write.
export function encodeOperationJournal(buffer) {
  return gzipSync(buffer, { level: constants.Z_BEST_SPEED })
}

async function* decodedJournal(path) {
  const source = createReadStream(path)
  if (!String(path).endsWith('.gz')) { yield* source; return }
  const decoder = createGunzip()
  let failure
  const completion = pipeline(source, decoder).catch(error => { failure = error })
  try { yield* decoder }
  finally { source.destroy(); decoder.destroy(); await completion }
  if (failure) throw failure
}

export const readOperationJournal = path => Readable.from(decodedJournal(path))
