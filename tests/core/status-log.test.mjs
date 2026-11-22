import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStatusLog } from '../../electron/services/status-log.js'
import { parseDesktopRequest } from '../../electron/desktop-contract.js'
import { MarketBackend } from '../../electron/services/market-backend.js'

test('status log serializes transitions, rotates and flushes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-status-log-'))
  try {
    const path = join(root, 'Logs', 'market-status.jsonl')
    const log = createStatusLog(path, { maxBytes: 150 })
    await Promise.all([log.write({ status: 'Incomplete' }), log.write({ status: 'Live' })])
    await log.flush()
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(lines.map(line => line.status), ['Incomplete', 'Live'])
    assert.ok(lines.every(line => Number.isFinite(Date.parse(line.recordedAt))))
    await log.write({ status: 'Disconnected', cause: 'x'.repeat(100) })
    assert.equal(JSON.parse((await readFile(path, 'utf8')).trim()).status, 'Disconnected')
    assert.deepEqual((await readFile(`${path}.1`, 'utf8')).trim().split('\n').map(line => JSON.parse(line).status), ['Incomplete', 'Live'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('status log IPC rejects malformed or oversized data', () => {
  const statusLog = { status: 'Incomplete', realtime: 'live', updatedAt: 42, issues: [], cause: '', catalog: null }
  assert.deepEqual(parseDesktopRequest({ statusLog }), { statusLog })
  assert.throws(() => parseDesktopRequest({ statusLog: { ...statusLog, cause: 'x'.repeat(1025) } }))
  assert.throws(() => parseDesktopRequest({ statusLog: { ...statusLog, issues: Array(33).fill('issue') } }))
})

test('backend records market changes while presentation is idle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-backend-log-'))
  const backend = new MarketBackend({ userData: root, testMode: true, e2eLiveRefresh: false })
  const waitForSource = async source => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const data = await readFile(join(root, 'Logs', 'market-backend.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
      if (data.trim().split('\n').filter(Boolean).map(JSON.parse).some(line => line.source === source)) return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Backend did not record source ${source}.`)
  }
  try {
    await backend.ready
    await backend.presentation(false, 1)
    await waitForSource('none')
    await backend.request({ e2e: { action: 'seedCachedListProjection' } })
    // The coalescing timer has not elapsed: shutdown must persist its pending state.
    await backend.dispose()
    await waitForSource('live')
  } finally {
    await backend.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
