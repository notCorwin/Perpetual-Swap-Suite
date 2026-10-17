// Quantify "incomplete info": direct 1H rows vs derivable 1H bars from 5m,
// per instrument. gappy = hours with complete 5m buckets that are NOT derivable.
import { DuckDBInstance } from '@duckdb/node-api'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(process.env.HOME, 'Library/Application Support/perp-radar/MarketData/candles')
const instance = await DuckDBInstance.create(':memory:')
const conn = await instance.connect()
const list = async (frame, inst) => {
  const base = join(root, `timeframe=${frame}`, `instrument=${inst}`)
  const dates = await readdir(base).catch(() => [])
  return `[${dates.map(d => `'${join(base, d)}'`).join(', ')}]`
}
const instruments = (await readdir(join(root, 'timeframe=5m'))).filter(d => d.startsWith('instrument='))
for (const instDir of instruments.slice(0, 30)) {
  const inst = instDir.replace('instrument=', '')
  const f5 = await list('5m', inst), fh = await list('1H', inst)
  const q = `WITH raw AS (
    SELECT timestamp FROM (SELECT timestamp, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt,0) DESC) r FROM read_parquet(${f5}, union_by_name=true)) WHERE r=1
  ), buckets AS (
    SELECT (timestamp - timestamp % 3600000) AS hour, COUNT(*) AS n FROM raw GROUP BY hour HAVING COUNT(*) = 12 AND MIN(timestamp) = hour AND MAX(timestamp) = hour + 3300000
  ), direct AS (
    SELECT timestamp FROM (SELECT timestamp, ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY COALESCE(writtenAt,0) DESC) r FROM read_parquet(${fh}, union_by_name=true)) WHERE r=1
  )
  SELECT
    (SELECT COUNT(*) FROM buckets) AS derivable,
    (SELECT COUNT(*) FROM direct) AS directRows,
    (SELECT COUNT(*) FROM direct d WHERE NOT EXISTS (SELECT 1 FROM buckets b WHERE b.hour = d.timestamp)) AS directNotDerivable,
    (SELECT COUNT(*) FROM buckets b WHERE NOT EXISTS (SELECT 1 FROM direct d WHERE d.timestamp = b.hour)) AS statsMissing`
  const row = (await conn.runAndReadAll(q)).getRowObjectsJS()[0]
  const N = v => Number(v)
  console.log(`${inst.padEnd(18)} derivable1H=${N(row.derivable)} direct=${N(row.directRows)} directNotDerivable=${N(row.directNotDerivable)} statsMissingOnDerivable=${N(row.statsMissing)}`)
}
