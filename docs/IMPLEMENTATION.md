# Improvement implementation

The [original plan](IMPROVEMENT_PLAN.md) describes baseline `470916a`. Its six implementation stages are complete in the current source. The original audit is preserved as historical evidence, with source links pinned to that baseline.

| Stage | Result | Behavioral evidence |
| --- | --- | --- |
| Canonical calculations | Lists and charts share full contiguous native history and one indicator worker. Arithmetic BOLL, base-volume VWAP, Wilder RSI flat=50, signed changes and null zero baselines replace the former inconsistent paths. | Independent golden values, corrections, older additions, eviction, restart and list/chart equality. See [formulas](INDICATORS.md). |
| Durable data coordination | SQLite owns preferences, current qualification, sync checkpoints and audit jobs. HistorySync owns source requests; Parquet remains the completed-candle fact store, queried through DuckDB. | Transaction/CAS, restart recovery, exact foreground priority, source-specific coverage, strict schema/OHLC/grid/confirmation validation and full-day corrupt-partition replacement. |
| Screening and ranking | Six independently configurable AND conditions; actual closed 24h quote volume; uncapped book depth and explicit insufficient observations; finite qualification leases. Separate completed-5m ranking and chart settings. | Strict equality boundaries, decimal price comparisons, contract units, disabled conditions, stale/configuration-mismatched qualification and stable absolute-change ordering. |
| Realtime lifecycle | WebSocket forming observations remain in memory. Confirmation publishes only after durable ingestion. Reconnect recovery uses HistorySync. | Duplicate/correction ordering, stale REST protection, reconnect/heartbeat cancellation, and shutdown draining accepted writes. |
| Workspace | Persistent two-column Base UI workspace, one 1600px baseline, shared tokens, English controls and analysis prompts. | Actual Electron pointer/capture/portal behavior at 1200/1600/2000 widths and DPR 1/2; light/dark and grayscale screenshots and measured contrast. |
| Desktop and delivery | One strictly validated bridge, trusted main-frame sender, navigation/protocol restrictions; PR checks, separate live integration, packaged executable smoke and safe installation/rollback. | Invalid mixed commands have no effects, untrusted windows are rejected, credentials stay private, navigation cancels owned streams; actual source-Electron and filesystem delivery checks. |

## Fixed conventions

- Native periods: 5m, 15m and 1H. Default chart: 15m. Ranking: independent 15-minute lookback using the same completed native 5m close boundary for every instrument, descending absolute signed change, unknown last, fixed instrument-ID ties.
- Requested history: 30 days by default, adjustable from 1 through 3650 whole days. A separate 200-candle warmup precedes each native target. This is a coverage target, not an automatic deletion policy. Listing and provider availability bound obtainable history.
- Qualification observations expire after 90 seconds. Only verified, unexpired entries for the current liquidity configuration enter the list. Refresh failure does not renew observations; chart/ranking changes do not change liquidity identity. Volume stability remains off by default, with all six controls independently adjustable.
- Frequent metadata uses SQLite transactions. Legacy settings are imported once; retired appearance settings are discarded, private analysis settings remain main-only, and malformed legacy input blocks import without destroying its source or leaking credentials in errors.
- The latest endpoint publishes only explicit observations, including confirmed corrections. An empty response does not invent a missing range from an old cache through the present. Requested history/window tasks determine ranges.
- Repair replacement and ordinary candle/statistics mutations share the same instrument queue. Replacement preserves valid current statistics and invalidates canonical/prepared generations before publication. Damaged schema/files require full UTC-partition repair; valid-file anomalies use precise ranges.
- Completed, unavailable and cancelled sync checkpoints retain the most recent 512 results by default. Active, paused and registered-waiter tasks are protected. Evicted result IDs can be absent; re-enqueueing always rechecks durable coverage. Paused work remains resumable after restart.

## Local validation

macOS arm64; supported tooling Node 24.22.0 and npm 12.2.0; Electron 44.9.0. A clean `npm ci` succeeds with the committed lockfile.

- Core: **260/260**. Actual Electron E2E: **30/30**. Type checking, desktop syntax and design-token checks pass. Lint has no errors and seven existing shadcn Fast Refresh export warnings.
- Live OKX 1H integration passes against public price, OI and Taker endpoints. It checks native period/contract units, complete prepared windows and reuse without repeated source downloads. This is a dated external integration result, not a permanent provider-availability guarantee.
- Visual acceptance generates **28** PNGs with actual pixel dimensions verified, including DPR 2. Both themes have zero measured non-exempt text/critical-graphic contrast failures. Light ordinary text minimum is **4.623:1**, dark **5.857:1**. Required financial RGB colors are retained; low-contrast light fills/lines have verified foreground boundaries. Grayscale retains hollow/solid candles, different EMA/VWAP line styles and Taker hatch.
- Native scroll benchmark: p95 input-to-paint across phases **16.4–22.1ms**; complete 96-candle paints, no wrong-source values, maximum one preparation request at a time and zero redundant source downloads, including delayed reads.
- Sixteen-instrument navigation baseline keyboard p95: **18.5–20.0ms**. With real SQLite/Parquet synchronization and audit processing an offline synthetic source, p95 is **13.1–19.7ms**, below the **50ms** local warmed-navigation budget. That run writes **20,640** source records while audit checks **88,124 / 218,280** requested slots; no incomplete/wrong-instrument paints. Source network timing is synthetic; this does not establish a live-network latency guarantee.
- Storage benchmark: 1000-row append median **42.420ms**, p95 **54.977ms**; 1000-row read median **13.953ms**, p95 **28.126ms**. These are local store measurements, not renderer-latency claims. Per-partition write metrics remain available; no additional compaction subsystem was needed.
- Production dependency audit: **0** reported vulnerabilities. Development tooling has **15** upstream findings (8 moderate, 7 high). Suggested forced fixes would downgrade current toolchains; no forced downgrade or suppression was added.

Reproduction commands are in the [README](../README.md). `scripts/workspace-visual-check.mjs` writes screenshots plus raw paint, boundary geometry and effective contrast evidence. `scripts/benchmark-startup.mjs` records three fresh-process launches and working sets; it explicitly does not control the OS filesystem cache. Optional Markdown plugins were removed and analysis Markdown remains lazy-loaded; the main bundle still has a Vite size advisory, so no blanket startup/memory improvement is claimed.

## Deployment evidence

Earlier canonical/storage code batches were independently built, installed, smoke-tested and pushed (`db04a86`, then `f5df3b8`). Product integration is delivered with `npm run app:deliver` after committing and freezing all packaging inputs. It requires candidate validation before replacement, staged signature/revision validation, installed executable smoke and normal restart; failure restores the previous app.

The generated `.build/package-smoke.json`, `.build/installed-smoke.json` and build revision resource identify the executable actually tested. Smoke uses isolated profiles set before Electron readiness, exercises DuckDB/Parquet and a real worker thread, verifies normal exit, then reopens the same temporary profile to check persistence. It does not use or delete production market data. Packaging fingerprints reject concurrent source changes rather than accepting a corrupted ASAR.

GitHub Actions runs PR validation and visual acceptance. Main publication additionally requires packaged executable smoke. Live OKX checks run separately with endpoint diagnostics. No live AI request is required for any deterministic check.
