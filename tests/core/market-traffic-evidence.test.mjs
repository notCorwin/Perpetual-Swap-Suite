import assert from 'node:assert/strict'
import test from 'node:test'
import { createMarketTrafficEvidence, validateMarketTrafficEvidence } from '../helpers/market-traffic-evidence.mjs'

const instId = 'T000-USDT-SWAP'
const sampleStartedAt = 1_798_000_000_000
const sampleEndedAt = sampleStartedAt + 7_000
const fullCadence = Array.from({ length: 13 }, (_, index) => sampleStartedAt + 500 + index * 500)

function evidence({ expectedSubscriptions = { tickers: [instId] }, app = fullCadence, sent = fullCadence,
  cadenceMS = 500, tradeStats = {}, allowNoFillTrades = false } = {}) {
  const applicationReceipts = {}, fixtureDeliveries = {}
  for (const channel of Object.keys(expectedSubscriptions)) {
    applicationReceipts[channel] = app === null ? {} : { [instId]: app }
    fixtureDeliveries[channel] = sent === null ? {} : { [instId]: sent }
  }
  return createMarketTrafficEvidence({ expectedSubscriptions, applicationReceipts: { ...applicationReceipts, tradeStats },
    fixtureDeliveries, sampleStartedAt, sampleEndedAt, cadenceMS, allowNoFillTrades })
}

test('accepted app receipts preserve every channel and contract timestamp through the sample', () => {
  const result = evidence({ expectedSubscriptions: { tickers: [instId], books: [instId] } })
  const ticker = result.channels.tickers.entries[0]
  assert.equal(ticker.applicationReceiptCount, fullCadence.length)
  assert.equal(ticker.fixtureSendCount, fullCadence.length)
  assert.equal(ticker.maxIntervalMS, 500)
  assert.equal(ticker.firstReceivedAt, sampleStartedAt + 500)
  assert.equal(ticker.lastReceivedAt, sampleStartedAt + 6_500)
  assert.equal(ticker.maxIntervalFrom, sampleStartedAt)
  assert.equal(ticker.maxIntervalTo, ticker.firstReceivedAt)
})

test('application receipts cannot borrow fixture send timestamps', () => {
  const sendOnlyEvents = fullCadence.map(sentAt => ({ sentAt }))
  assert.throws(() => createMarketTrafficEvidence({
    expectedSubscriptions: { tickers: [instId] },
    applicationReceipts: { tickers: { [instId]: { events: sendOnlyEvents } } },
    fixtureDeliveries: { tickers: { [instId]: { events: sendOnlyEvents } } },
    sampleStartedAt, sampleEndedAt, cadenceMS: 500,
  }), /Application receipt tickers\/T000-USDT-SWAP contains a timestamp outside the complete measurement window/)
})

test('a missing middle event is rejected even when the last receipt is fresh', () => {
  const held = [...fullCadence]
  held.splice(6, 1)
  assert.throws(() => evidence({ app: held }), /application receipt count does not match fixture deliveries/)
})

test('a delayed middle event is rejected by its maximum interval', () => {
  const heldThenReleased = [...fullCadence]
  heldThenReleased[3] = sampleStartedAt + 3_000
  heldThenReleased[4] = sampleStartedAt + 3_500
  assert.throws(() => evidence({ app: heldThenReleased }), /maximum receipt interval .* exceeded/)
})

test('configured books demand cannot pass without accepted book receipts', () => {
  assert.throws(() => evidence({ expectedSubscriptions: { books: [instId] }, app: [], sent: [] }),
    /books\/T000-USDT-SWAP has no accepted app receipts/)
})

test('a trade subscription can have no fills while its subscription demand remains explicit', () => {
  const result = evidence({ expectedSubscriptions: { trades: [instId] }, app: [], sent: [], allowNoFillTrades: true,
    tradeStats: { [instId]: { messageCount: 0, fillCount: 0, noFillMessageCount: 0 } } })
  const trade = result.channels.trades.entries[0]
  assert.deepEqual(result.expectedSubscriptions.trades, [instId])
  assert.equal(trade.applicationReceiptCount, 0)
  assert.equal(trade.fillCount, 0)
  assert.equal(trade.noFillMessageCount, 0)
  assert.equal(validateMarketTrafficEvidence(result, { allowNoFillTrades: true }), true)
})

test('accepted trade messages report fills and no-fill callbacks separately', () => {
  const result = evidence({ expectedSubscriptions: { trades: [instId] },
    tradeStats: { [instId]: { messageCount: fullCadence.length, fillCount: 7, noFillMessageCount: 6 } } })
  const trade = result.channels.trades.entries[0]
  assert.equal(trade.tradeMessageCount, fullCadence.length)
  assert.equal(trade.fillCount, 7)
  assert.equal(trade.noFillMessageCount, 6)
})
