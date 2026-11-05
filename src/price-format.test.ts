import assert from 'node:assert/strict'
import test from 'node:test'
import { formatCurrentPrice, formatHistoricalPrice, formatIndicatorPrice } from './price-format.ts'

test('current prices keep exactly the normalized contract decimal precision', () => {
  for (const [value, tickSz, expected] of [
    [0.12, '0.0001', '0.1200'], [0.1234, '0.0001', '0.1234'],
    [123, '0.1', '123.0'], [123, '1', '123'], [120, '10.000', '120'],
    [1.5, '0.25', '1.50'], [1, '.25', '1.00'],
    [1.2, '0.0100', '1.20'], [1.2, '0.0001000', '1.2000'],
    [1.2, '1e-4', '1.2000'], [1.2, '10e-4', '1.200'],
    [1.2, '2.500e-3', '1.2000'], [1.2, '1.00E+0', '1'],
    [0.00000012, '1e-10', '0.0000001200'],
    [123456.123456, '0.000001', '123,456.123456'],
    [1.2345, '0.01', '1.23'], [-0, '0.01', '0.00'],
  ] as const) assert.equal(formatCurrentPrice(value, tickSz), expected, `${value} at tick ${tickSz}`)
})

test('missing or invalid precision preserves the price without guessed padding', () => {
  for (const tickSz of [undefined, null, '', ' ', '0', '0.000', '-0.01', 'NaN', 'Infinity', 'oops', '1.2.3', '1e', '.', 'e2', '1e-101', '1e999', '1e-999']) {
    assert.equal(formatCurrentPrice(1.234567891, tickSz), '1.234567891', String(tickSz))
  }
})

test('historical prices retain finer source precision independently of current ticks', () => {
  assert.equal(formatHistoricalPrice(123456.123456), '123,456.123456')
  assert.equal(formatHistoricalPrice(1.234567891234567), '1.234567891234567')
  assert.equal(formatHistoricalPrice(0.00000000000123), '0.00000000000123')
  assert.equal(formatHistoricalPrice(1e-101), `0.${'0'.repeat(100)}1`)
  assert.equal(formatHistoricalPrice(1.2), '1.2')
})

test('indicators preserve sub-tick values using their independent significant-digit policy', () => {
  assert.equal(formatIndicatorPrice(1.234567891), '1.2345679')
  assert.equal(formatIndicatorPrice(0.000000123456789), '0.00000012345679')
  assert.equal(formatIndicatorPrice(1.2), '1.2')
})

test('unavailable prices and non-finite derived values have a consistent placeholder', () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(formatCurrentPrice(value, '0.0001'), '—')
    assert.equal(formatHistoricalPrice(value), '—')
    assert.equal(formatIndicatorPrice(value), '—')
  }
})
