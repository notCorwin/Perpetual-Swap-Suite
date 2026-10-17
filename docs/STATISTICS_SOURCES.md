# Historical OI and Taker sources

The application requests native candles, contract open interest, and contract Taker volumes as independent background sources. A statistics page waits only for its matching price page before merging into durable Parquet rows. It does not wait for the entire price-history target. Requests remain paced separately for each OKX endpoint family.

## Bounded historical requests

The official endpoint references are [Get contract open interest history](https://www.okx.com/docs-v5/en/#trading-statistics-rest-api-get-contract-open-interest-history) and [Get contract taker volume](https://www.okx.com/docs-v5/en/#trading-statistics-rest-api-get-contract-taker-volume). Taker requests use `unit=1`, so quantities are contracts. Each source is queried independently at the requested native period; a coarser period is never distributed into finer bars.

For an internal inclusive range `[from, through]` on period `Δ`, the adapter requests `begin=from−Δ`, `end=through+Δ`, and `limit=100`, then retains only rows inside the internal range. Public API probes on 2026-10-17 found both bounds to be exclusive for both endpoints at 5m, 15m, and 1H. A backward page can continue with `end` equal to the oldest returned timestamp, avoiding overlap. A `begin` value alone is a lower bound, not a forward cursor.

The documentation describes a recent 1,440-entry window. That description is not used as a shared local cutoff: the application sends bounded requests for the actual requested ranges and evaluates each source's returned values. Adjusting `begin` and `end` selects a time range; it does not guarantee that every requested field is available at that resolution.

## Observed availability and zero placeholders

On 2026-10-17, unauthenticated public API requests for `BTC-USDT-SWAP` produced the following results for the same UTC hour, 2026-09-17 15:00–15:59:59.999:

| Source | Native period | Returned observations |
| --- | --- | --- |
| Open interest | 5m / 15m | Empty |
| Open interest | 1H | 2,878,721.98000001355 contracts |
| Taker | 5m | Twelve rows, all sell/buy pairs 0/0 |
| Taker | 15m | Four rows, all sell/buy pairs 0/0 |
| Taker | 1H | Sell 214,629.71 / buy 231,976.96 contracts |

These are dated observations, not a promise about future API behavior. The finer-period Taker zero totals conflict with the positive same-hour 1H total. Receiving timestamped rows therefore does not establish that the granular quantities are available. The API did not explicitly label those zero rows as unavailable.

The application keeps an absent OI observation as `null`. A Taker pair of 0/0 on a confirmed native candle with positive contract volume or quote turnover is inconsistent and also becomes `null`. Genuine zero Taker quantities remain valid on a candle whose contract volume and quote turnover are both zero. A valid sibling source is preserved when the other source is unavailable.

Null observations receive a bounded retry lease. They are explicit unavailable chart values during that lease, not permanent proof that a range can never be fetched. Published historical values remain reusable; unexpired observations prevent repeated scrolling from downloading the same unsuccessful source page. No zero values, carried values, or interpolated values are invented for missing history.

## Opt-in live regression

Run `node scripts/okx-live-statistics.mjs` with network access. Add `--report PATH` to save its JSON report. `OKX_LIVE_TIMEOUT_MS` can override the default 90-second timeout.

The script uses an isolated temporary data directory and real `MarketService`/`MarketStore` integration. It requests one hour from 30 days earlier at 5m and 1H, verifies explicit `begin`/`end` bounds for both statistics sources, checks persisted values against their actual HTTP responses, checks zero-pair consistency against native candles, verifies repeat calls reuse bounded leases, and reopens DuckDB to verify durability. It does not require an API key, install the App, or touch production user data. Successful live results describe that run's responses; they do not assert permanent availability or permanent unavailability.
