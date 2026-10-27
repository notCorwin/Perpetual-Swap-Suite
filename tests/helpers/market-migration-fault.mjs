import { existsSync } from 'node:fs'
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api'

const [, , , , mode, gate] = process.argv
const inject = () => {
  if (!existsSync(gate)) return
  if (mode === 'startup') throw new TypeError('Injected archive engine startup failure.')
  if (mode === 'io') throw new Error(JSON.stringify({ exception_type: 'IO', exception_message: "Cannot open file 'invalid parquet archive.parquet': Permission denied" }))
  throw new Error(JSON.stringify({ exception_type: 'Internal', exception_message: 'Injected parquet scan engine failure.' }))
}
if (mode === 'startup') {
  const create = DuckDBInstance.create
  DuckDBInstance.create = async (...args) => { inject(); return create(...args) }
} else {
  const read = DuckDBConnection.prototype.runAndReadAll
  DuckDBConnection.prototype.runAndReadAll = async function (...args) { inject(); return read.apply(this, args) }
}
await import('../../electron/services/market-store-migration.js')
process.send({ fixtureReady: true })
