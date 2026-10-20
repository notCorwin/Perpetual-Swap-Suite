# Perpetual Swap Suite

[![Verify and Publish macOS](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml)

An Electron desktop app that rebuilds OKX perpetual market data locally. Screen USDT perpetual contracts, rank completed price changes, and review candlestick charts with reproducible indicators. Public market data needs no OKX API key. The interface and optional AI analysis use English.

## Get started

Download `Perpetual.Swap.Suite.app.zip` from the [autobuild release](https://github.com/notCorwin/Perpetual-Swap-Suite/releases/tag/autobuild), extract it, and move `Perpetual Swap Suite.app` to `/Applications`. Local and CI packages use ad hoc signing.

To build and install from source on macOS, select **Node.js 24.22.0** from [.nvmrc](.nvmrc) and use **npm 12.2.0**:

```sh
git clone https://github.com/notCorwin/Perpetual-Swap-Suite.git
cd Perpetual-Swap-Suite
npm install --global npm@12.2.0
npm ci
npm run app:deliver
open "/Applications/Perpetual Swap Suite.app"
```

`app:deliver` builds the app for the current macOS architecture, validates and smoke-tests the candidate, replaces `/Applications/Perpetual Swap Suite.app`, and smoke-tests the installed executable. It asks the old app to quit before replacement and restores it if installation or installed-app validation fails. Smoke checks use temporary user data and exercise the actual executable, build revision, window, preload isolation, SQLite worker I/O, indicator workers, normal exit, and persistence after restart. Installation checks keep windows hidden, verify a background Finder launch with the production profile, and exit their verification processes afterwards.

For development, run `npm run dev` to start Vite and Electron together. Opening the renderer in an ordinary browser does not provide the desktop data service.

## Market workspace

The contract list stays on the left and the selected contract's chart stays on the right. The whole workspace, including dialogs, scales from a 1,600-pixel design width so both columns retain their proportions. Shared shadcn/ui components use Base UI and CSS design tokens, with system light/dark themes, tabular figures, and signed values and direction symbols alongside price colors.

The list shows only contracts that meet every enabled liquidity condition and the USDT perpetual/no-scheduled-closure requirements. Search narrows the visible results. Contracts are ordered by the **absolute signed price change**, largest first; the sign still shows whether the price rose or fell.

Changing liquidity thresholds immediately reevaluates fresh observations in memory. Source updates and missing history continue in the background; contracts with missing or expired required observations stay unqualified. Completed volume windows are reused until their next candle boundary or a durable source correction. Historical-source recovery validates its own saved window independently of other criteria: a spread rejection cannot turn complete turnover data into a missing-data error.

Current chart demand, live continuity, prefetch, and manually requested history downloads have separate scheduling priorities. Endpoint and storage queues reserve opportunities for interactive work while giving an active download a bounded share. Independent endpoint budgets and adaptive concurrency overlap network latency without removing rate limits. The Updating count tracks outstanding acquisitions, separately from contracts whose observations cannot prove qualification.

The default ranking lookback is **15 minutes**, calculated from completed native **5m** candle closes. Change it in **Settings → Ranking lookback (minutes)** using multiples of five minutes. Ranking lookback and chart timeframe are separate persisted settings: choosing a 1h chart does not change a 15-minute ranking window.

Rankings reuse completed candles in memory, and changing the lookback calculates immediately when that window is cached. Missing candles are repaired in the background. The previous confirmed ranking keeps its original timestamp until a newer complete window is available; the last confirmed ranking is also restored on restart.

### Liquidity conditions

Open **Settings → Liquidity conditions** to enable or disable each condition and edit its parameters independently. Disabled conditions retain their saved parameters. The defaults are:

| Condition | Default requirement | Enabled |
| --- | --- | --- |
| Bid-ask spread | Below 0.05% | Yes |
| Order book depth | Strictly above 100,000 USDT on each side | Yes |
| Slippage | Below 0.10% on each side for a 100,000 USDT trade | Yes |
| 24h trading volume | Above 30,000,000 USDT | Yes |
| Open interest | USDT notional above 5,000,000 USDT | Yes |
| Volume stability | Maximum/minimum hourly volume below 2 over 24 completed 1h candles | No |

The 24h trading-volume check sums actual quote volume from **288 completed 5m candles**. The slippage trade size is also configurable. A contract needs valid observations for every enabled condition; eligibility must be revalidated as its observations expire.

All eligible USDT perpetual contracts receive live streams independently of liquidity filters, historical preparation, search, and chart selection. Prices publish immediately; fresh depth, spread, and open-interest observations recheck qualification in short batches. Quiet tickers remain usable through their acknowledged, uninterrupted native subscription without changing raw timestamps; missing snapshots and source faults use bounded per-contract REST recovery. Exact depth/slippage calculations run in a worker, coalescing new observations while preserving each result's original freshness lease. Instrument metadata uses a bootstrap/reconnect REST snapshot plus the global SWAP instruments subscription. Incremental listing, parameter, suspension, and delisting events update the universe directly; healthy collection does not periodically rescan it. Missing or expired data stays unqualified while acquisition continues.

The contract list loads once and then follows desktop change notifications. Healthy snapshots do not poll or start background requests; a hidden workspace resynchronizes when shown, and failed IPC reads keep bounded retries. Required observation leases and native candle boundaries invalidate qualification at their actual deadlines. Waiting for a closing candle is shown as updating; unavailable observations and actual source failures remain distinct. A ranking whose current completed interval is missing stays unavailable until that close is persisted.

## Charts and indicators

Select a contract and choose **5m**, **15m**, or **1h**. The default chart timeframe is **15m**. The main chart contains candlesticks, EMA(200), BOLL(20, 2), and VWAP(14). Separate panels show ROC(9) + MAROC(9), RSI(6/12/24), ATR%(14) + BBW(20, 2), Open Interest in contracts, and Taker Buy/Sell in contracts.

| Control | Action |
| --- | --- |
| Primary mouse button, then drag | Inspect candles; release to return to the window end |
| Scroll | Review history; return to the newest range to follow live updates |
| Up / Down | Previous / next contract in the visible list, wrapping at either end |
| Left | First contract in the visible ranking |
| Right | Highest-turnover eligible contract, independent of search |
| Copy chart | Copy the chart with an opaque theme background |
| Analyze Long / Analyze Short | Analyze a captured chart snapshot |

A normal viewport shows 96 candles, but any available prices can render immediately, including a new listing with fewer observations. OHLC, forming prices, OI, Taker, and recursive indicators have independent readiness. Missing or expired statistics leave gaps in their own panels; they do not hide prices, block history, or force the chart back to an older complete window. Stored data is labeled stale until current source observations and stream continuity establish freshness.

Loading, incomplete history, and history boundary messages share a reserved status row above the plot. Source updates do not cover candles or change the plot's dimensions; truncated summaries retain their full text on hover and for assistive technology.

Without candle inspection, the OI and Taker legends each show their latest valid observation in the visible range. An older observation includes its candle time as `as of`; Taker Buy and Sell always come from the same candle. Holding a candle shows only that candle's values, including `Unavailable` for missing statistics. Forming-candle gaps remain gaps in the plots.

When scrolling an already calculated chart, its current complete view remains visible while the requested window's technical indicators finish, including when first-time history downloads change the recursive input prefix. Prices and curves then move together; an intermediate calculation cannot replace a complete window with a shorter fragment. Price generations invalidate derived calculations independently of proven OI/Taker observations. The retained view remains a previous presentation, not a valid calculation for new inputs. First-time chart prices still appear before optional sources finish.

Contract and timeframe changes reuse bounded renderer caches. Uncached selections read an indexed local tail; historical navigation reads bounded local ranges before acquiring missing source pages. The renderer retains a separate bounded history cache, so movement inside a saved range is synchronous. **Preparing** identifies a price range that is still being acquired. Indicator computation and auxiliary-source requests continue independently after prices appear.

Every eligible contract keeps its native 5m, 15m, and 1h subscriptions, but subscription membership does not eagerly build or restore charts for the whole exchange. Chart projections are prepared for requested series, and warm forming updates project from their existing confirmed indicator state. Independent source versions prevent a delayed statistics update from overwriting newer prices.

Approaching a cache boundary starts directional prefetch. Requests and results remain bounded, and repeated input coalesces around the newest cursor. Local history remains usable across OI/Taker holes. A jump beyond downloaded prices still requires acquisition; neither caching nor this scheduler can remove actual network latency.

Indicators use one canonical contiguous native candle series, independently of the visible window. EMA seeds from 200 closes; BOLL uses arithmetic prices and population deviation; VWAP weights typical prices by base-currency volume; RSI uses Wilder smoothing and returns 50 for a flat run. ATR%(14) normalizes Wilder-smoothed true range by the current close, while BBW(20, 2) divides the existing BOLL band width by its middle band; both share a panel between RSI and Open Interest with independent percentage scales. Each scale fits its own visible minimum and maximum with 5% range padding, so a change in one cannot compress the other. Vertical coordinate labels are hidden; the colored legends retain the current or inspected percentage values. Missing periods restart initialization, and missing values display as `—`. Older source additions and corrections invalidate derived calculations. See the [indicator contract](docs/INDICATORS.md) for formulas, units, initialization, and boundary conditions.

Applicable relative changes use `(current − previous) / abs(previous) × 100%`. A missing, nonfinite, or zero baseline is unavailable. Taker imbalance uses `(Buy − Sell) / (Buy + Sell) × 100%`; its zero-total case is unavailable. Historical OI and taker availability depends on the provider; unavailable observations remain explicit gaps.

## History and live updates

**Settings → Download all qualified history** starts a finite download for contracts meeting the saved conditions at the time of the click. It requests native **5m, 15m, and 1H** prices, OI, and Taker observations from each contract's listing through the latest completed period at task start. The scope stays fixed while the download runs. Local data is reused and only missing or expired source observations are requested, in bounded chunks. A missing listing time is reported as a failure rather than inventing a history boundary.

Progress counts verified source timestamps after durable coverage checks. Available data, reused data, unavailable observations, pending timestamps, completed contracts/streams, active source ranges, retries, and errors are shown separately. Finishing with unavailable observations does not mean complete market data. Closing Settings keeps an explicit download running; reopening reads its latest checkpoint. Cancel stops it, and restarting the application never resumes a download automatically. Starting again reuses saved facts. No bulk archive starts on discovery, native candle boundaries, preference changes, or launch. On-demand chart, qualification, ranking, and live continuity requests remain active.

**Settings → Data audit lookback (days)** limits the integrity audit, defaulting to **30 days**, with a supported range of **1–3,650 whole days**. It does not cap full history downloads. Exact recursive indicator calculations reuse durable checkpoints or replay the available canonical prefix.

Every eligible contract subscribes to native 5m, 15m, and 1h candles and public ticker, 400-level order-book, open-interest, and trade channels. Public connections carry at most 25 contracts each, with paced connection starts. Books are reconstructed from snapshots and sequence-checked incremental updates; a gap rebuilds the affected connection without stopping the others.

At a native close, acquisition gives the acknowledged candle stream up to 10 seconds to deliver the final candle. Accepted confirmations finish committing before competing acquisition proceeds. Qualification, chart recovery, and archive downloads share this wait and reuse the durable candle; older gaps and disconnected or silent streams use REST recovery.

Completed native candles, independent OI/Taker observations, source coverage evidence, and recursive indicator checkpoints are stored in SQLite WAL. One dedicated writer worker commits facts and their versions atomically; two reader workers serve indexed range queries. A dedicated market coordinator worker owns MarketService, network scheduling, and metadata. The Electron main process handles windows, security, and IPC; separate database and indicator workers execute market SQL and calculations. Forming candles and their live OI/Taker observations remain in memory.

Taker totals require continuous trade coverage from the native period's start; startup and reconnect gaps remain unavailable until a complete period can be observed. Reconnection repairs bounded gaps alongside immediate live delivery. Historical consumers are finite and share source acquisition. Old rolling archive intentions are discarded on launch. Unavailable-source leases are rechecked only when explicitly needed by a consumer; they never restart a finished archive.

Price, OI, and Taker pages run independently with per-endpoint pacing, concurrency limits, and backoff. A statistics response is committed even if its price candle has not arrived. Each statistics page specifies `begin` and `end`; availability comes from its source response. Missing values and Taker zero placeholders inconsistent with traded volume remain unavailable with a bounded retry lease. Only a new source response can renew that lease. See [historical source behavior](docs/STATISTICS_SOURCES.md) for the dated API observations and pagination rules.

### Check and repair data

In **Settings → Data integrity**:

1. Choose **Start audit** to inspect persisted history for gaps and invalid data.
2. Follow the progress and issue list, or choose **Cancel audit** to stop the current run.
3. Choose **Repair issues** for repairable findings. Repairs run in the background and are followed by verification of persisted data; unresolved issues remain visible.

Audit progress and findings are pushed after each durable checkpoint. Settings reads the current report when opened and then follows ordered updates without periodic status requests. Reopening resynchronizes any updates received while Settings was closed.

## Optional AI chart analysis

Open **Settings → Optional AI analysis → Configure analysis**, enter a Vercel AI Gateway key, and select a model with image input support. The default model is `openai/gpt-6.1-sol`. Market collection and charts work without AI credentials.

**Analyze Long** and **Analyze Short** capture the chart as an opaque PNG and send it through the main process to Gateway. Responses stream in English. Follow-up questions reuse that snapshot and model; **New analysis** captures the current chart. Conversations and drafts stay in memory until exit. **Stop**, changing contracts, or closing the panel cancels generation. Failed requests retry while the panel remains open.

The model and API key are stored in a private analysis record inside `metadata.sqlite`. The database has mode `0600`; the key is plaintext on disk and available only to the main process. Public settings responses report whether a key exists without returning it. Chart images and conversations are sent to Gateway when analysis is requested.

## Local storage

Paths are relative to `~/Library/Application Support/perp-radar/`:

| Path | Contents |
| --- | --- |
| `MarketData/market.sqlite` | Authoritative completed native candles, independent OI/Taker observations, per-series versions, indicator checkpoints, and migration/audit evidence |
| `MarketData/market.sqlite-wal`, `market.sqlite-shm` | SQLite WAL coordination files while connections are open |
| `MarketData/candles/` | Previous Parquet data retained as a read-only migration/recovery source; new observations are not written here |
| `metadata.sqlite` | Transactional preferences, qualification catalog, manual download checkpoints, audit reports, and private analysis settings |

Existing Parquet is imported once in a separate Node child process, with durable per-partition progress. Its native DuckDB lifetime is isolated from the app and SQLite workers. First access prioritizes the required series/range, and bounded latest queries import recent partitions first. The importer honors the newest base and later deltas, resolves source revisions, validates observations, and never overwrites newer SQLite facts with old imported data. Original files remain unchanged. Corrupt or incompatible partitions become explicit repairable audit findings. After the import cutover, the importer exits and retained Parquet is no longer consulted; there is no permanent dual authority.

Market writes update keyed rows rather than republishing a day's files. Price corrections invalidate affected later indicator checkpoints atomically; statistics updates have their own revisions and do not invalidate price calculations. Checkpoints retain exact recursive state, formula version, and a source revision. Derived renderer and chart projections are bounded memory caches; they can be rebuilt from SQLite. A cached projection alone does not establish that a price is live.

The audit lookback does not delete downloaded facts. Listing dates, actual provider availability, available disk space, and download time limit obtainable history. Large archives use bounded reads and calculations.

On the first migration, recognized values from an existing `settings.json` are imported once into SQLite. Retired glass and blur preferences are not part of the new settings schema.

The renderer uses a single isolated `window.radarDesktop` bridge. The main process validates the caller and complete command before executing an operation; Node APIs and credentials stay outside the page context.

## Development and checks

Install the locked dependencies with `npm ci`. The shadcn CLI is a development dependency; `@shadcn/react` remains a runtime dependency for the analysis message scroller. Base components, styles, and tokens live in [src/components/ui](src/components/ui), [src/index.css](src/index.css), and [components.json](components.json).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Vite renderer and Electron host |
| `npm run typecheck` | Check TypeScript projects |
| `npm run check:desktop` | Check syntax of main, preload, services, and scripts without executing them |
| `npm run lint` | Run source lint and shared design-token checks |
| `npm run test:core` | Run existing core business suites in the recorded, offline expensive-operation sandbox |
| `npm run test:e2e` | Build and test actual Electron interactions invisibly with isolated fixture data and operation recording |
| `npm test` | Run core tests and invisible functional Electron E2E in one isolated, recorded sandbox |
| `npm run test:foreground` | CI-only native chart-paint performance tests on GitHub-hosted macOS runners; local requests are rejected |
| `npm run sandbox -- command -- node scripts/example.mjs` | Record a custom offline test or benchmark command |
| `npm run operations:report -- .build/sandbox/<run>` | Rebuild an offline cost summary from persisted operation records |
| `npm run app` | Build, package, and verify a candidate macOS app |
| `npm run app:deliver` | Build, smoke-test, install, and verify the installed app with rollback on failure |
| `npm run app:smoke -- --app "/path/to/Perpetual Swap Suite.app" --revision <full-git-sha>` | Verify an existing packaged executable using isolated data |
| `npm run test:okx:1h` | Run live public OKX candle/OI/taker integration with temporary storage |
| `npm run test:okx:chart` | Build and validate genuine OKX candles in the hidden native App and selected SVG |
| `npm run test:okx:streams` | Verify every eligible contract's public streams and three native candle subscriptions against OKX |
| `node scripts/okx-live-statistics.mjs --report .build/okx-statistics.json` | Check bounded older OI/Taker requests, zero placeholders, reuse and persistence against actual public responses |
| `npm run benchmark:operations` | Compare five alternating fresh-process baseline/recorded pairs with matched CPU, SQLite, native market traffic and hidden renderer work; enforce CPU, latency, memory and stored-log budgets |
| `npm run benchmark` | Measure distinct SQLite insert, correction, duplicate-fact reuse, range-query, coverage, and gap-detection scenarios; validate mutations outside latency measurements |
| `npm run benchmark:chart:foreground` | CI-only foreground measurements of chart scrolling, reversals, jumps, and delayed reads; local requests are rejected |
| `npm run benchmark:instruments` | Exercise local chart admission, switching, and revisits |
| `npm run benchmark:market:foreground` | CI-only foreground measurements of 287 contracts × 3 native periods with real SQLite/renderer work, synthetic intake, blocked statistics, and concurrent archive I/O; save `.build/resource-benchmark.json`; local requests are rejected |
| `PERPETUAL_SWAP_BENCHMARK_BACKGROUND=1 npm run benchmark:instruments` | Measure navigation while real synchronization and audit process an offline synthetic source |
| `node scripts/workspace-visual-check.mjs` | Check light/dark, grayscale, scaling, and measured contrast after building |
| `npm run benchmark:startup -- --app "/path/to/Perpetual Swap Suite.app"` | Record three isolated process launches and process working sets |

Local tests, benchmarks, and installation validation keep native Electron windows invisible and cannot raise, pin, activate, or focus desktop windows. `npm test` and `npm run test:e2e` still use the real Electron host, preload, IPC, and workers. Foreground paint-performance acceptance runs only on GitHub-hosted macOS GitHub Actions runners; local foreground requests are rejected before building or launching Electron. Minimizing a window changes visibility and frame scheduling, so it cannot represent foreground timing. The CI workflow builds the renderer before its foreground benchmarks, which reuse that build.

[GitHub Actions](.github/workflows/release.yml) checks pull requests with lint, desktop syntax checks, types, sandboxed core tests, functional Electron E2E, a separate required foreground chart-paint suite, and the full-market foreground benchmark. Every test and benchmark run retains its operation journal, command logs, manifest, and summary in the CI `artifacts/` upload, including failed runs. On `main`, successful validation is followed by packaging, executable smoke, and publication of the `autobuild` app and digest metadata. [Live OKX integration](.github/workflows/okx-live.yml) separately checks history, statistics, all-contract WebSocket subscriptions, and the real native chart on a schedule or manual dispatch. Each check keeps its exit status and evidence. A demonstrated chart defect takes precedence over unrelated endpoint probe failures; a smoke failure without sufficient source evidence remains an unclassified integration failure. Background benchmarks can be run locally as needed.

The live chart check starts with an empty isolated profile and uses no seeded market values. A bounded relay witnesses original upstream BTC/ETH candles before forwarding unchanged prices to the app. It verifies exact selected-SVG price/OHLC, instrument/timeframe identity, current native period, advancing observation time and the Live badge across cold selection, a later update, a contract switch and warm return. The source price may repeat. Subscription commands, original acknowledgments, clock probes, source digests, expected/actual values and closed recorder health remain in artifacts. The only market-universe transformation restricts actual instrument-discovery rows to BTC/ETH. External checks have hard time/traffic limits and stay separate from deterministic offline tests.

### Expensive-operation sandbox

Tests stay with their existing business suites. Their shared runner records the same CPU, GPU/graphics, network, database, file I/O, and IPC boundaries used by the app, so regression assertions and performance review share one source of evidence. Existing chart reuse checks also assert that warm forming ticks emit no repeated canonical calculation or confirmed-chart projection. Injected test sources remain deterministic; recording does not replace correctness assertions.

Recording installs native hooks for fetch and response consumption, WebSocket traffic, HTTP/TCP/HTTP2 clients, DNS, UDP sockets, Electron net/Session clients, filesystem callbacks/promises/streams, SQLite calls, crypto, and compression. Execution health retains a live per-API capability inventory, including disabled entries, installation readback and scope limits; Electron capabilities update after app readiness. Direct UDP constructors, HTTP/2 servers/push, pre-existing sockets and unsupported custom transports are outside the validated scope and application boundary checks reject bypasses. Shared worker/process factories register admission before launch, propagate causal context, and record queue, delivery, execution, and lifetime. Renderer IPC and performance observers feed a retained queue that is removed only after a durable main-process acknowledgment. Actual document disposal cancels its open requests and submits every retained terminal batch before waiting for acknowledgments, so reload does not leave an unreachable old renderer journal. Ordinary flushes leave the document active. Nested transport and filesystem implementation calls are suppressed where the outer boundary already accounts for the work; bulk database commands retain API-call, execution-batch, row, and change counts. Lint rejects direct application Worker/fork and SQLite construction that would bypass these shared boundaries.

Every run creates `.build/sandbox/<timestamp>-<id>/` with independent temporary files and Electron user data. The runner sets `PERPETUAL_SWAP_SANDBOX=1`, blocks external network in the application transports by default, and permits local servers and injected fixtures. This is an application test sandbox, not operating-system process confinement; arbitrary commands can access the host filesystem and their own transports. Existing live OKX commands explicitly enable external network and still record their work. For another live integration, opt in with `npm run sandbox -- command --allow-network -- node scripts/example.mjs`.

Custom sandbox commands also default to invisible Electron windows without native focus. The sandbox's `--foreground` option is restricted to GitHub-hosted macOS GitHub Actions runners; local requests are rejected. Do not set or spoof CI environment variables to bypass this restriction. Native paint benchmarks reject background mode instead of reporting hidden-window timing as foreground performance.

The run directory contains:

| Path | Contents |
| --- | --- |
| `manifest.json` | Git revision/dirty state, Node/platform, isolated paths, commands, timings, and original exit status |
| `operations/*.jsonl.brj` | Framed, compressed schema 2 start/end lifecycle records with operation IDs, monotonic execution sequences, trace/parent correlation, and scenario labels |
| `operations/*.health.json` | Raw-record and completed-operation counts, disk/source failures, omitted records, participant role, enabled hooks, and flush durability |
| `operations/*.participant.json` | Parent-registered processes/workers and claimed executions; a missing child cannot silently disappear from coverage |
| `summary.json`, `summary.md` | Category/operation/resource costs, API-call/query-batch/row/change/byte totals, CPU time, GPU/process peaks, hook/participant coverage, slowest operations, and damaged/incomplete lifecycle diagnostics |
| `command-*.log` | Streamed stdout/stderr for each test, build, or benchmark phase |
| `tmp/`, `user-data/` | Run-local temporary files and app storage, retained for diagnosis |

Standard suites resolve the official Electron package before entering the offline sandbox, preparing its binary on a clean dependency installation without launching an app. Dependency preparation may download Electron; application traffic stays offline unless explicitly enabled. Generic `command` runs do not prepare unrelated desktop dependencies.

Use `npm run operations:report -- <run-or-operations-directory> [--out <directory>]` to review saved data without launching the app, recomputing indicators, querying SQLite, or contacting a provider. Reports aggregate operation names independently of bounded resource details, so a large contract universe cannot hide the total cost of a known operation; excess names/resources contribute to per-category overflow totals. Reports validate paired lifecycle records, sequence gaps/duplicates, abandoned operation names, malformed/truncated records, unclosed executions, missing registered children, recorder count mismatches, source/omission failures, unpersisted records, and incomplete opt-in GPU traces. Incomplete recording fails an otherwise successful sandbox run. A terminated process can only report work that reached durable storage. Completed work remains reviewable after test failure, and the sandbox preserves the command's failure code. Use `--output artifacts/sandbox` before a command's `--` to choose the run parent directory.

Desktop operation journals are saved under the app's `Operations/` directory. Every operation has a start and terminal record sharing its ID. Records contain execution IDs, per-execution sequence, trace/parent IDs, scenario, category, operation name, safe resource identity, start time, elapsed duration, result, and allowed scalar work counts. Health `recorded`/`persisted` count raw journal entries; `recordedOperations` and report operation totals count completed operations. Explicit flush, orderly shutdown, and five-second background checkpoints use `fdatasync`; `durableRecords` and `lastDurableAt` distinguish durable progress from OS-buffered writes. A sudden termination before the next checkpoint can still lose buffered entries, and an interrupted session never claims a complete recording. Request bodies, response bodies, SQL parameters, credentials, and error text are excluded. Network records represent physical requests/transmissions; reuse and request coalescing do not invent extra network work. Database records describe worker-side execution separately from caller queue/wait boundaries. Their `calls` counter includes every hooked native database API call, while `queryCount` counts `exec`/`all`/`get`/`run`/`iterate` execution batches; a multi-statement `exec` is one batch, without parsing its SQL. Iterators count once when created and count rows only as consumed; consumption after a group ends is recorded separately without counting the same call again. CPU records cover canonical indicator work, qualification, chart projection, and renderer construction rather than each arithmetic primitive.

Journals use lossless quality-zero Brotli frames with decoded CRC32 checksums. Each `OPB1` frame has a 16-byte header (magic, compressed length, decoded length, decoded CRC32; unsigned big-endian lengths and checksum), followed by one Brotli stream. A frame decodes to at most 1 MiB; larger drained batches split across frames. Every file begins with a valid empty frame, so participants with no operations remain readable. Decoders bound both lengths, require exact compressed-stream consumption, and reject checksum failures, torn frames or trailing garbage. Sequence, identity, Unicode data, and lifecycle records are unchanged after decoding. Offline reports also stream saved gzip and plain journals, show stored and decoded byte counts, and reject health byte-count mismatches. Admission follows source sequence even when native callbacks reenter serialization; only complete contiguous snapshots may drain. Renderer acknowledgments synchronize only their owning journal; unchanged durable high-water marks reuse their existing proof without extra disk synchronization. Disabled liquidity dependencies reuse their existing valid assessment while retaining new source observations. Full-universe forming data stays resident as raw observations; chart frames are constructed and published only for requested or cached charts. Opening an unvisited contract reads its latest retained forming price without replaying old notifications.

Desktop sessions apply a seven-day / 512 MiB retention policy to completed recordings, removing whole oldest sessions rather than truncating journals. Startup, one-minute maintenance, and orderly shutdown update `Operations/retention.json`; a bounded deletion audit records cleanup decisions. Active, interrupted, incomplete, unknown, and unsafe sessions remain protected and count toward the reported storage pressure. Continuous high-throughput recording can still produce substantial active data; compression does not impose a hard cap on an active session. Protected data can exceed the configured budget: the status explicitly reports `over-budget` or `blocked` instead of dropping current operations. Fully closed legacy recorder sessions are eligible only after their processes have exited and their paired metadata passes validation. Sandbox artifacts use their independent CI artifact policy and are never pruned by desktop retention.

Elapsed durations can overlap across threads and nested boundaries, so their sum is not process wall time. CPU time is included for synchronous spans where the runtime provides a thread CPU clock; asynchronous spans omit it to avoid attributing unrelated work performed during an await. Graphics capture/submission timing and GPU-process resource samples do not claim GPU hardware execution time. `npm run test:gpu` runs a separate hidden, accelerated chart scenario, captures three actual SVG charts and checks native Chromium service tasks against durable journal identities and counts. Its default policy explicitly reports confirmed unsupported environments; unknown or failed probes fail. Use `npm run test:gpu -- --require-gpu` to require acceleration. `npm test` also includes this capability check. The resource-tracing command `npm run sandbox -- command --foreground --gpu-trace -- node scripts/market-resource-benchmark.mjs` runs only in GitHub-hosted macOS GitHub Actions after building. The app saves `chromium-*.json` alongside its operation journal for offline trace inspection. Native tracing is opt-in because capturing a full graphics trace adds overhead. Native completion observations have zero epoch-wall duration; native timestamps and durations retain their service or device clock domain and aggregate separately. Capability decisions, exact execution/participant ownership, trace digests and portable relative artifact paths remain reviewable offline. Missing or mismatched evidence fails the report.

`npm run test:gpu:metal` explicitly builds the optional macOS diagnostic provider with Command Line Tools, runs its native lifecycle tests, and requires positive Metal command-buffer timestamps from the actual GPU process. Only that owned hidden Electron child receives its diagnostic environment. Private bounded journals record every admitted commit/completion, errors, zero timings, capacity rejections and a live stop acknowledgment before application shutdown. A restricted loader, missing completion or exhausted limit cannot pass. This observes the default device’s discovered command-buffer class; it does not cover every Metal/Metal4 path, kernel or SVG cost. Overlapping buffer durations are not utilization. The provider adds diagnostic overhead and is excluded from default launch and normal recorder-overhead budgets.

The standard [GitHub-hosted macOS runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) performs the same capability probe. An [Apple paravirtual Metal adapter](https://developer.apple.com/documentation/paravirtualizedgraphics) reports `adapterKind: apple-paravirtual`; missing vendor/device identification in telemetry does not mean acceleration is absent. Native enabled features, the Apple Metal driver/backend and actual graphics tasks establish acceleration, while hardware timing still needs the separate validated provider. For other environments, a skipped hardware check is recorded as unsupported rather than claimed as hardware coverage. GitHub documents accelerated M2 GPU access for [XLarge macOS runners](https://docs.github.com/en/actions/reference/runners/larger-runners); no paid runner is selected automatically.

A sandbox run fails when it records no substantive work. Standard `core`, `e2e`, and `foreground` suites also enforce category, healthy participant-role, and successfully completed business-operation requirements; `all` combines the core and Electron contracts. Core requires compute, network, SQLite, I/O, and worker paths. Electron suites require renderer/main/database/compute workers and chart geometry/SVG/desktop IPC paths; functional E2E also requires chart capture and successful native HTTP/WebSocket traffic. Injected traffic and rejected native attempts cannot satisfy the native-source requirements. Foreground paint tests retain their fixture-based chart contract and run only in hosted macOS CI. Their exact requirements are saved in `manifest.json` under `coverage`, including `requireOperations`, and are checked independently of report display limits. Incidental module-loading I/O cannot satisfy these contracts. Custom `command` runs have no implicit business-path requirements, so an intentional I/O-only command remains valid. Extend coverage with repeatable `--require-category cpu|gpu|network|database|io|ipc` and `--require-role <role>` flags; missing categories, unhealthy roles, missing successful key operations, and registered children without a claimed journal fail validation. Use `--allow-empty` only for a custom scenario that intentionally exercises no resource operations; it does not clear standard-suite requirements. For example: `npm run sandbox -- command --scenario sqlite-insert --require-category database --require-role market-writer -- node scripts/example.mjs`. `--scenario <label>` travels with inherited operation context and is saved in the manifest; trace/parent IDs link nested work and propagated worker requests. Participant health lists enabled hook families so a missing hook is visible during review. These are coverage contracts for instrumented boundaries, not proof that arbitrary native code has been instrumented.

The recording-overhead benchmark intentionally launches separate baseline processes with recording disabled and matching recorded processes. It checks exact business results and journal completeness before accepting measurements. Backend actors and their SQLite/prepared workers run with the installed Electron executable in Node mode (`ELECTRON_RUN_AS_NODE=1`); renderer measurements use the same executable in desktop mode. The driver runs in ordinary Node. Reports identify the Node/V8/Electron versions and executable separately, require matching baseline/enabled engines and retain actual worker runtime evidence. Equal Node versions alone do not establish equal V8 engines.

Two warmup rounds precede five reversed-order pairs. The scenario uses 130 native WebSocket contracts, SQLite WAL workers, canonical indicators, and actual hidden Chromium geometry/IPC/durable acknowledgments. A monotonic simulated market clock keeps the input bucket fixed while real performance clocks measure costs; source cadence stays fixed when qualification work is reused. Reports include end-to-end drain costs, process CPU, event-loop delay, peak memory, logical bytes, physical journal bytes, and configured budgets. Overlapping backend measurement windows share one 5 ms memory sampler; immediate boundary scans update every active window, and each window retains its own peaks. Baseline and enabled columns are group medians; added CPU costs use matched-pair differences and each pair's own message or operation count. Phase CPU covers the whole process during its window, including worker threads, V8/libuv and possibly earlier journal drain. Per-message normalization does not claim exclusive network CPU. Missing phases, missing/invalid metrics, omitted records, or budget regressions fail CI. Use `--output DIRECTORY` to retain reports and individual trials, or `--budgets FILE` for explicit budget changes. These are measurements for the supplied workload, not a claim of zero recorder overhead.

A native-market budget failure saves its original report before collecting a separate baseline/recorded CPU-profile pair. Those diagnostic trials keep the same workload and actual runtime, validate business results and recording completeness, and save `diagnostic-native-*/native-market.cpuprofile`. They never enter gated medians or replace the original failures. Diagnostic errors remain visible in `report.json`. Use `--profile` to profile every original backend trial explicitly instead. After successful dependency installation, CI also runs this independent gate when earlier acceptance fails; both failures still block publication.

To instrument a new expensive boundary, use `measureOperation({ category, name, resource, attributes }, operation)` for synchronous or asynchronous work, or `beginOperation(...).end(...)` for a lifecycle such as a stream connection. Choose stable names and bounded resource identities; only actual work belongs inside the boundary. Core tests can attach `attachOperationSink` to assert counts, failure/cancellation outcomes, and absence of repeated work without brittle machine-speed thresholds. The standard Node test/benchmark entrypoints install recording before importing app modules; desktop and worker entrypoints initialize their own inherited recording directory.

## Help and contributions

Read [AGENTS.md](AGENTS.md) before contributing. Keep market access behind the desktop bridge, reuse shared components and design tokens, and test core behavior relevant to the change. See the [improvement plan](docs/IMPROVEMENT_PLAN.md) and [implementation status](docs/IMPLEMENTATION.md) for the original assessment and implementation evidence.

Report bugs through [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues), including reproduction steps, macOS version, and the affected contract, timeframe, or data range. Repository maintainers and contributors review changes through GitHub.
