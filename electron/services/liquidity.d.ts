export type LiquidityConfig = {
  spread: { enabled: boolean; maxPercent: number }
  depth: { enabled: boolean; minUSDT: number }
  slippage: { enabled: boolean; maxPercent: number; notionalUSDT: number }
  volume24h: { enabled: boolean; minUSDT: number }
  openInterest: { enabled: boolean; minUSDT: number }
  volumeStability: { enabled: boolean; maxRatio: number }
}

export type LiquidityStatus = 'verified' | 'failed' | 'unknown'
export type LiquidityKey = 'instrument' | keyof LiquidityConfig
export type LiquidityCheck = {
  key: LiquidityKey
  status: LiquidityStatus | 'disabled'
  /** Percentage, USDT amount, or ratio; paired checks use the worse side. */
  value: number | null
  reason: string
}

/** Normalized native candle; timestamp is its opening time in epoch ms. */
export type QuoteVolumeCandle = {
  timestamp: number
  timeframe: string
  confirmed: boolean
  quoteVolume?: number | null
  instrument?: string
}

export type LiquidityInput = {
  instrument: unknown
  ticker?: { bidPx?: unknown; askPx?: unknown; [key: string]: unknown } | null
  /** OKX levels [price, contracts, ...]; finite snapshots provide depth lower bounds. */
  book?: { bids?: readonly (readonly unknown[])[]; asks?: readonly (readonly unknown[])[] } | null
  openInterest?: { oiUsd?: unknown; [key: string]: unknown } | null
  /** Exactly the latest 24 confirmed native '1H' intervals are needed when enabled. */
  hourlyCandles?: readonly QuoteVolumeCandle[] | null
  /** Actual quote amount, never base volume multiplied by a current price. */
  turnover24hUSDT?: number | null
  /** Shared evaluation time in epoch ms. Freshness policy belongs to the caller. */
  asOf: number
  /** The caller's complete preferences; this module supplies no defaults. */
  config: LiquidityConfig
}

export type LiquidityResult = {
  eligible: boolean
  status: LiquidityStatus
  reasons: string[]
  turnover: number | null
  spread: number | null
  oiUSD: number | null
  askSlippage: number | null
  bidSlippage: number | null
  volumeRatio: number | null
  depthBid: number | null
  depthAsk: number | null
  checks: LiquidityCheck[]
}

/**
 * Requires explicit SWAP/linear/USDT/live, Crypto instCategory='1', normal rules,
 * a matching USDT perpetual ID, and no populated expiry/session/TradFi metadata.
 * Missing or unknown eligibility metadata never qualifies. Historical initial
 * listing openType/contTdSwTime are not recurring trading sessions.
 * Sources: https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
 * and https://www.okx.com/help/i-perpetual-swaps (Crypto perpetuals trade 24/7).
 */
export function eligibleInstrument(instrument: unknown): boolean

/**
 * All enabled checks AND mandatory instrument eligibility must be verified.
 * Disabled checks require no observations. Known failures take precedence over
 * unknowns. Depth is uncapped, strictly greater on both sides; insufficient
 * visible depth is unknown. Slippage fills an independent quote notional per
 * side and compares VWAP to that side's best nonzero book price. Contract amount
 * is ctVal*ctMult, with ctValCcy explicitly base or USDT; missing units are unknown.
 * Decimal boundaries are compared exactly. Outputs contain only finite numbers
 * or null; zero hourly volume is failed with null ratio, not Infinity over IPC.
 * The caller validates observation identity/freshness before invoking this pure
 * evaluator. It does not retrieve data, mutate config, or retain prior checks.
 */
export function evaluateLiquidity(input: LiquidityInput): LiquidityResult

/**
 * Sum actual quoteVolume over [floor(asOf/300000)*300000 - 24h, floor(asOf/300000)*300000).
 * Every one of the 288 native '5m' records must be confirmed, on-grid, unique,
 * and have a finite nonnegative numeric quoteVolume. Order is irrelevant; missing
 * intervals, duplicate required records or mixed instruments return null. Forming
 * and older records outside the window are ignored; inputs are never mutated.
 */
export function quoteTurnover24h(candles: readonly QuoteVolumeCandle[], asOf: number): number | null
