import type { LiquidityInput, LiquidityResult } from './liquidity.js'

/** One lazily started worker owns exact liquidity calculations and a bounded book cache. */
export class StreamLiquidityEvaluator {
  constructor()
  /** Captures the exact input snapshot. Callers coalesce pending work per instrument. */
  evaluate(input: LiquidityInput): Promise<LiquidityResult>
  /** Idempotently rejects pending work and terminates the worker immediately. */
  close(): Promise<void>
}
