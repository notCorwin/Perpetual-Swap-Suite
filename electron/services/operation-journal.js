import { createReadStream } from 'node:fs'
import { Buffer } from 'node:buffer'
import { brotliCompressSync, brotliDecompressSync, crc32, createGunzip, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

export const operationJournalSuffix = '.jsonl.brj'
export const isOperationJournal = path => /\.jsonl(?:\.(?:gz|brj))?$/.test(path)
export const operationJournalExecutionId = path => path.replace(/\.jsonl(?:\.(?:gz|brj))?$/, '')

// OPB1 frames: magic, compressed length, decoded length, decoded CRC32 (u32 BE),
// then one complete quality-zero Brotli stream. The decoder bounds both sizes
// and checks exact stream consumption, so a changed length cannot swallow frames.
const magic = Buffer.from('OPB1'), headerBytes = 16, maximumDecodedBytes = 1024 * 1024
const maximumEncodedBytes = maximumDecodedBytes + 65536
const compression = { params: { [constants.BROTLI_PARAM_QUALITY]: 0 } }
export function encodeOperationJournal(buffer) {
  const frames = []
  for (let offset = 0; offset < buffer.length || offset === 0; offset += maximumDecodedBytes) {
    const raw = buffer.subarray(offset, offset + maximumDecodedBytes), payload = brotliCompressSync(raw, compression)
    const header = Buffer.allocUnsafe(headerBytes)
    magic.copy(header); header.writeUInt32BE(payload.length, 4); header.writeUInt32BE(raw.length, 8); header.writeUInt32BE(crc32(raw), 12)
    frames.push(header, payload)
  }
  return Buffer.concat(frames)
}

async function* decodedFrames(source) {
  let pending = Buffer.alloc(0), frames = 0
  for await (const chunk of source) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= headerBytes) {
      if (!pending.subarray(0, 4).equals(magic)) throw new Error('Invalid operation journal frame magic.')
      const encodedBytes = pending.readUInt32BE(4), decodedBytes = pending.readUInt32BE(8), checksum = pending.readUInt32BE(12)
      if (encodedBytes < 1 || encodedBytes > maximumEncodedBytes || decodedBytes > maximumDecodedBytes) throw new Error('Invalid operation journal frame length.')
      const frameBytes = headerBytes + encodedBytes
      if (pending.length < frameBytes) break
      const { buffer, engine } = brotliDecompressSync(pending.subarray(headerBytes, frameBytes), { info: true, maxOutputLength: maximumDecodedBytes })
      if (engine.bytesWritten !== encodedBytes || buffer.length !== decodedBytes || crc32(buffer) !== checksum) throw new Error('Operation journal frame integrity check failed.')
      frames++; yield buffer
      pending = pending.subarray(frameBytes)
    }
  }
  if (pending.length || !frames) throw new Error('Truncated operation journal frame.')
}

async function* decodedJournal(path) {
  const source = createReadStream(path)
  if (String(path).endsWith('.brj')) {
    try { yield* decodedFrames(source) } finally { source.destroy() }
    return
  }
  if (!String(path).endsWith('.gz')) { yield* source; return }
  const decoder = createGunzip()
  let failure
  const completion = pipeline(source, decoder).catch(error => { failure = error })
  try { yield* decoder }
  finally { source.destroy(); decoder.destroy(); await completion }
  if (failure) throw failure
}

export const readOperationJournal = path => Readable.from(decodedJournal(path))
