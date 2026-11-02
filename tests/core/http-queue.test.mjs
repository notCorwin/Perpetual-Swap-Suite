import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarketService } from '../../electron/services/market-service.js'
import { MarketStore } from '../../electron/services/market-store.js'

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'perp-http-queue-')), store = await MarketStore.open(root)
  const service = new MarketService(store, undefined, fetch, false)
  await service.ready
  const queue = service.requestLane('market').queue
  context.after(async () => { context.mock.restoreAll(); queue.clear(); await service.dispose(); await store.close(); await rm(root, { recursive: true, force: true }) })
  return queue
}

const ranks = { background: 0, chartWarm: 0, prefetch: 1, statistics: 2, foreground: 3, interactive: 4 }
const reference = (requests, now, allow, fairness) => {
  const eligible = requests.filter(request => (allow || ranks[request.priority] >= 3) && Math.max(request.bucket.nextAt, request.bucket.rateLimitedUntil) <= now)
  if (fairness) return eligible.find(request => ranks[request.priority] <= 1) ?? null
  let chosen = null, score = -Infinity
  for (const request of eligible) {
    const value = ranks[request.priority] + Math.min(5, (now - request.enqueuedAt) / 5_000)
    if (!chosen || value > score) { chosen = request; score = value }
  }
  return chosen
}

test('indexed admission matches a full scan across dynamic priorities, clock changes and bucket limits', async context => {
  const queue = await fixture(context)
  let now = 1_800_000_000_000, seed = 0x8514
  context.mock.method(Date, 'now', () => now)
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  const requests = []
  const buckets = Array.from({ length: 31 }, () => ({ nextAt: 0, rateLimitedUntil: 0 }))
  const labels = Object.keys(ranks)
  for (let step = 0; step < 12_000; step++) {
    const action = random(10)
    if (action < 4 || !requests.length) {
      const request = { priority: labels[random(labels.length)], bucket: buckets[random(buckets.length)], enqueuedAt: now }
      requests.push(request); queue.add(request)
    } else if (action === 4) {
      const request = requests[random(requests.length)]
      request.priority = labels[random(labels.length)]; queue.reprioritize(request)
    } else if (action === 5) {
      const bucket = buckets[random(buckets.length)]
      bucket.nextAt = now + random(10_000) - 3_000; bucket.rateLimitedUntil = now + random(10_000) - 3_000
      queue.bucketChanged(bucket)
    } else if (action === 6) now += random(40_000) - 15_000
    else if (action === 7) {
      const index = random(requests.length), [request] = requests.splice(index, 1)
      assert.equal(queue.delete(request), true); assert.equal(queue.delete(request), false)
    } else {
      const allow = Boolean(random(2)), fairness = Boolean(random(2))
      const expected = reference(requests, now, allow, fairness)
      assert.equal(queue.pick(allow, now, fairness), expected, `step ${step}, fairness ${fairness}, capacity ${allow}`)
      if (expected && random(2)) { requests.splice(requests.indexOf(expected), 1); assert.equal(queue.delete(expected), true) }
    }
    assert.equal(queue.size, requests.length)
  }
  queue.clear()
  assert.equal(queue.size, 0); assert.equal(queue.pick(true, now, false), null)
  assert.equal(queue.groups.size, 0)
})

test('saturated and cross-priority ties preserve admission order after reprioritization', async context => {
  const queue = await fixture(context)
  let now = 100_000
  context.mock.method(Date, 'now', () => now)
  const lane = { nextAt: 0, rateLimitedUntil: 0 }
  const first = { priority: 'background', enqueuedAt: now - 30_000, bucket: lane }
  const second = { priority: 'background', enqueuedAt: now - 40_000, bucket: lane }
  queue.add(first); queue.add(second)
  assert.equal(queue.pick(true, now, false), first, 'Saturated scores tie even when the clock made the later request older.')
  first.priority = 'interactive'; queue.reprioritize(first)
  first.priority = 'background'; queue.reprioritize(first)
  assert.equal(queue.pick(true, now, false), first, 'A priority update does not change admission order.')
  queue.clear()
  const low = { priority: 'background', enqueuedAt: now - 10_000, bucket: lane }
  const high = { priority: 'prefetch', enqueuedAt: now - 5_000, bucket: lane }
  queue.add(low); queue.add(high)
  assert.equal(queue.pick(true, now, false), low, 'Equal scores across priorities retain admission order.')
  now -= 20_000
  assert.equal(queue.pick(true, now, false), low, 'A clock rollback restores unsaturated candidates.')
})

test('a shared bucket limit moves every priority and cancellation removes all indexes', async context => {
  const queue = await fixture(context)
  let now = 100_000
  context.mock.method(Date, 'now', () => now)
  const bucket = { nextAt: 0, rateLimitedUntil: 0 }
  const first = { priority: 'background', enqueuedAt: now, bucket }, second = { priority: 'interactive', enqueuedAt: now, bucket }
  queue.add(first); queue.add(second)
  bucket.rateLimitedUntil = now + 60_000; queue.bucketChanged(bucket)
  assert.equal(queue.pick(true, now, false), null)
  assert.equal(queue.delay(true, now), 60_000)
  queue.delete(second)
  assert.equal(queue.pick(false, now, false), null)
  now += 60_000
  assert.equal(queue.pick(true, now, false), first)
  queue.delete(first)
  assert.equal(queue.groups.size, 0)
  for (const indexes of [queue.young, queue.mature, queue.order, queue.waiting]) for (const index of indexes) assert.equal(index.items.length, 0)
})
