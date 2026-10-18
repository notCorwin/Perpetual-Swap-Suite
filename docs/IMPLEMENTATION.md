# Market data implementation

The [original assessment](IMPROVEMENT_PLAN.md) records the earlier baseline. The current architecture separates live delivery, durable observations, historical acquisition, chart navigation, and exact indicator calculation. A missing statistic or a slow archive page does not determine whether a price can render.

## Responsibilities

| Layer | Responsibility |
| --- | --- |
| Native WebSocket collectors | Collect candles for every eligible USDT perpetual contract in 5m, 15m, and 1H; publish forming prices and public observations immediately. |
| `MarketService` | Apply source freshness and qualification rules, publish list/chart changes, and coordinate independent acquisition. |
| `HistorySync` | Persist desired history ranges, merge overlapping consumers by series/source, plan gaps, and schedule bounded pages fairly. Execution cursors and viewport consumers are temporary. |
| Market database workers | One SQLite WAL writer atomically updates confirmed facts, source evidence, versions, and checkpoint invalidation; two reader workers execute indexed bounded queries. |
| Chart pipeline and calculation workers | Publish local OHLC before optional data is ready, retain bounded projections, and calculate exact recursive indicators in chunks from validated checkpoints. |
| Renderer | Present available prices, source-specific readiness and truthful freshness; retain bounded navigation caches and coalesce directional demand. |

A dedicated market coordinator worker owns MarketService, metadata, and network scheduling. The Electron main process owns windows, security, and IPC dispatch. Separate database and indicator workers execute SQL and recursive replay. Subscription membership does not eagerly load every contract's history or calculate a chart for every timeframe.

## Durable observations

`MarketData/market.sqlite` is the sole authority for completed native candles and historical OI/Taker observations. Keyed native-period queries replace filesystem scans and Parquet delta/base publication. Statistics have independent storage keys and may commit before their price candle arrives. Facts and their per-series revisions change in the same transaction; observers are notified only after commit.

Price revisions are separate from all-source revisions. New statistics do not require an EMA/RSI recalculation. A historical price correction or prepend invalidates checkpoints at and after its affected timestamp; a later append preserves earlier checkpoints. Replacement removes only its requested native slots and preserves independent statistics.

Numeric published statistics are reused. An absent response carries its original bounded lease. Taker 0/0 is retained as source evidence, but a confirmed price with positive contract or quote volume makes that pair unavailable. Receiving the price does not renew the source lease. A fresh successful source response may renew unavailable evidence; transport failure cannot do so. See [source behavior](STATISTICS_SOURCES.md).

`metadata.sqlite` retains preferences, qualification records, desired synchronization ranges, audits, and private analysis configuration. It does not own market candle facts. The renderer receives no database connection or credentials.

## Historical scheduling

History coverage defaults to 30 days and accepts 1–3650 whole days. A separate 200-candle price warmup precedes each native history target. OI/Taker targets do not receive indicator warmup. This setting requests coverage; it does not automatically delete previously downloaded observations or guarantee provider availability or disk capacity.

Each instrument/timeframe/source planner shares source coverage across overlapping consumers. Missing ranges are coalesced before paging. A reconnect requests current continuity recovery rather than preserving thousands of old foreground execution tasks. Stale viewport consumers and their cursors are not restored after restart; current desired windows are reconstructed against durable facts. A global 5-minute boundary advances current range intentions even without a new selected-chart event. Expiring unavailable-source leases wake the relevant planner for bounded revalidation.

Current chart demand, continuity, prefetch, and archive work have distinct priorities. Per-endpoint request budgets and bounded adaptive concurrency overlap independent network latency. Queues admit lower-priority work periodically so a continuous stream of interactive or continuity demand cannot permanently stop the archive. Rate limits and retry delays remain scoped to the affected endpoint family.

Prices, OI, and Taker do not await each other's downloads or durable rows. Statistics use explicit bounded source requests. Known numeric values, unexpired unavailable observations, and actual source bounds prevent unnecessary acquisition without inventing provider availability.

Historical liquidity sources establish their own observations independently of the contract's qualification outcome. Turnover uses 288 completed native 5m quote-volume amounts; volume stability uses 24 completed native 1H candles. Source recovery reuses valid observations and saved windows before acquiring missing prices. A failed spread or another exclusion cannot turn a successfully recovered source into a missing-data error. Qualification consumes the recovered observation separately; incomplete windows and stale or cancelled reads remain ineligible evidence.

## Chart and indicator behavior

A normal viewport contains 96 candles; shorter listings and partially downloaded windows can display their available prices. OI, Taker, indicators, and live freshness have independent states. Historical OHLC remains navigable across unknown/expired statistics. A stored or cached close is not labeled live without a current observation and healthy stream continuity.

Renderer cache budgets use incremental serialized-bar byte accounting. Replacing or removing a frame adjusts its existing charge; an unchanged frame does not rescan other candidates or histories. History and compact latest frames retain separate logical charges and eviction policies. This estimate bounds cached bar payloads, not the Electron process's entire working set.

The pipeline reads bounded local tails and navigation ranges. Exact indicator replay reads bounded chunks and persists recursive checkpoints. It resumes from the nearest valid earlier checkpoint with the same formula version. When no checkpoint exists, obtaining an exact result can require replaying the available canonical prefix once; initial OHLC is already visible while this happens. A fixed 200-candle tail cannot reproduce the accumulated influence of an existing full-history EMA or Wilder RSI.

Historical navigation prioritizes the requested viewport before its surrounding reserve. Verified chunk results publish incrementally, and rows admitted during a calculation remain pending demand until calculated. An already calculated view switches to its requested historical window once that window's full expected price range and technical results are observed, including genuine warmup nulls and shorter listings. This also applies across canonical generations during first-time acquisition: newly downloaded earlier prices can change EMA/RSI initialization, so their exact replacement must finish before replacing the previous presentation. The previous presentation is marked pending and never admitted as a valid calculation for the new generation. OI/Taker availability does not gate this switch. Price generations invalidate technical results independently of already proven source statistics. Incoming authoritative statistics, including observed nulls, still replace previous facts. Pending projections cannot erase known calculations for unchanged canonical inputs. Corrections change the canonical generation and invalidate affected calculations.

Historical replay preserves the newest recursive live core and tail; restored mutable cores are copied. Source-specific asynchronous reads cannot replace a newer price or another statistic family. Checkpoint provenance is captured before reading its seed and checked across computation, publication, and the guarded durable write, so an older seed cannot be relabeled with a newer source revision.

Incoming archive batches retain 1,280 candles through the selected historical cursor and 256 newer candles, with an independent 128-candle latest tail. Acquisition pages refresh this active reserve and its durable admission proof; moving away retires further pages for the previous cursor. A bounded journal of committed price mutations can prove that a newer revision only changed timestamps after a replay's entire dependency prefix; that replay and its guarded checkpoint can then finish without restarting. Missing journal entries, a changed series identity, and any mutation inside the prefix retain the strict invalidation and replay path.

Forming revisions project from a copy of confirmed recursive state and never change the durable confirmed seed. Price corrections invalidate descendants; statistics updates affect their own observations. Formula, seed, gap, and boundary rules remain defined in the [indicator contract](INDICATORS.md).

## Existing-data migration

Parquet is a read-only import source, not a second active fact store. Migration runs in a separate Node child process and checkpoints each partition durably. The native DuckDB addon belongs to that process, so stopping an import cannot tear down native callbacks inside the app's worker-thread isolate. In packaged Electron, the child uses the same executable with `ELECTRON_RUN_AS_NODE=1` and loads its script from the app archive. Bounded foreground queries prioritize the required series/range; recent-tail queries import recent partitions first. Opening the store does not await the entire archive import.

The importer honors the newest base generation and only later deltas, so superseded files cannot resurrect repaired or deleted rows. It resolves logical revisions by `writtenAt`, validates native grids, schema, confirmation, quantities, and partition identity, and preserves original units and source expiry evidence. Newly collected SQLite facts take precedence over older imported values, independently for price and each statistics source. Imported failures remain explicit audit findings.

A completed import records a durable cutover marker before acknowledging completion, closes its connections, and exits normally. Shutdown cancels pending archive reads, drains already accepted SQLite transactions, and stops the child at a partition boundary; a hung native child can be killed without terminating the app or discarding acknowledged facts. An unexpected exit before cutover rejects pending legacy reads and leaves durable progress available on restart. An exit after durable cutover cannot invalidate committed SQLite facts. Subsequent launches skip the importer entirely, and queries do not reread the retained Parquet files. Original files remain unchanged for recovery. Imported rows, migration progress, and source versions commit atomically per partition; an interrupted import resumes rather than restarting or requiring permanent dual writes.

## Verification and delivery

Use the locked Node/npm versions and `npm ci`. Reproduction commands are listed in the [README](../README.md):

- `npm run typecheck`, `npm run lint`, and `npm run check:desktop` check the source and desktop boundary.
- `npm run test:core` checks native source handling, independent statistics, transactional persistence, import/cutover, correction invalidation, exact checkpoint replay, scheduling, and core UI contracts.
- `npm run test:e2e` exercises the actual Electron bridge, navigation, partial readiness, chart interactions, and isolation with temporary data.
- `npm run benchmark`, `npm run benchmark:chart`, and `npm run benchmark:instruments` measure the current implementation. Earlier Parquet timings do not describe the SQLite backend.
- `npm run benchmark:market` builds and seeds 287 × 3 native series into real SQLite, injects synthetic native updates while statistics are held and archive writes continue, and records receipt-to-SVG-commit/next-paint opportunities, switches, local scrolling, source correctness, worker diagnostics, and Electron process working sets. External WebSocket transport and network latency are excluded; `.build/resource-benchmark.json` records the outcome, including failures.
- `npm run app:deliver` builds, validates, installs, and verifies the macOS executable with rollback on failure. Smoke profiles are isolated from production data.

No test count, latency, capacity, memory, or live-source result is implied by this architecture description. Use the reports produced by the current verification run. GitHub Actions owns CI/CD; optional live OKX integration runs separately with endpoint diagnostics.
