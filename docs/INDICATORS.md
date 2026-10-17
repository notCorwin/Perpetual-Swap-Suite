# Indicator contract

All calculations consume one canonical, timestamp-ordered native candle series. Completed candles come from Parquet. A forming candle may be appended in memory for the live overlay; it never replaces a completed candle or enters historical storage. A missing period starts a new contiguous run and restarts initialization.

The list and chart project the same calculation. Their visible windows cannot choose the seed. Older source additions and historical corrections invalidate the affected generation; formula or input-schema changes invalidate derived snapshots. Unknown volume remains unknown instead of being inferred from price.

| Indicator | Formula and initialization |
| --- | --- |
| EMA(200) | First value is the mean of the first 200 closes of a contiguous run. Subsequent values are `close × 2/201 + previousEMA × 199/201`. |
| BOLL(20,2) | Middle is the arithmetic mean of 20 closes. Population deviation is `sqrt(sum((close − mean)²)/20)`. Upper/lower are `mean ± 2 × deviation`. A negative lower band is a valid result; the chart uses a linear price axis when a nonpositive band cannot be plotted logarithmically. |
| VWAP(14) | Rolling `sum(((high + low + close)/3) × baseVolume) / sum(baseVolume)` across 14 candles. Base volume is OKX candle `volCcy`, not contract count or quote amount. Missing/negative quantity or a zero total gives no value. This is a candle typical-price approximation, not tick-level execution VWAP. |
| ROC(9) | Signed relative change of the current close from the close nine candles earlier. First valid value is the tenth candle. |
| MAROC(9) | Arithmetic mean of nine consecutive valid ROC(9) values. First valid value is candle 18. Missing ROC cannot be treated as zero. |
| RSI(6/12/24) | Seed mean positive/negative close changes over the period; continue with Wilder smoothing `(previous × (period−1) + current)/period`. Both means zero gives 50; only loss zero gives 100; only gain zero gives 0. First valid sample needs `period + 1` closes. |
| Signed relative change | `(current − previous) / abs(previous) × 100%`. Missing, nonfinite or zero baseline gives no value, displayed as `—`. |
| Taker imbalance | `(buyContracts − sellContracts) / (buyContracts + sellContracts) × 100%`. A zero total gives no value. This is a participation ratio, not a relative change. |

OI and Taker Buy/Sell retain contract units and native candle periods. Unavailable statistics remain explicit gaps, never fabricated zeroes. Floating-point assertions use independent expected values with a stated tolerance; agreement with a second invocation of production code is not proof of mathematical correctness.
