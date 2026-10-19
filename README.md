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

`app:deliver` builds the app for the current macOS architecture, validates and smoke-tests the candidate, replaces `/Applications/Perpetual Swap Suite.app`, and smoke-tests the installed executable. It asks the old app to quit before replacement and restores it if installation or installed-app validation fails. Smoke checks use temporary user data and exercise the actual executable, build revision, window, preload isolation, SQLite worker I/O, indicator workers, normal exit, and persistence after restart.

For development, run `npm run dev` to start Vite and Electron together. Opening the renderer in an ordinary browser does not provide the desktop data service.

## Market workspace

The contract list stays on the left and the selected contract's chart stays on the right. The whole workspace, including dialogs, scales from a 1,600-pixel design width so both columns retain their proportions. Shared shadcn/ui components use Base UI and CSS design tokens, with system light/dark themes, tabular figures, and signed values and direction symbols alongside price colors.

The list shows only contracts that meet every enabled liquidity condition and the USDT perpetual/no-scheduled-closure requirements. Search narrows the visible results. Contracts are ordered by the **absolute signed price change**, largest first; the sign still shows whether the price rose or fell.

Changing liquidity thresholds immediately reevaluates fresh observations in memory. Source updates and missing history continue in the background; contracts with missing or expired required observations stay unqualified. Completed volume windows are reused until their next candle boundary or a durable source correction. Historical-source recovery validates its own saved window independently of other criteria: a spread rejection cannot turn complete turnover data into a missing-data error.

Current chart demand, live continuity, prefetch, and historical archiving have separate scheduling priorities. Endpoint and storage queues reserve opportunities for interactive work while giving background work a bounded share. Independent endpoint budgets and adaptive concurrency overlap network latency without removing rate limits. The Updating count tracks outstanding acquisitions, separately from contracts whose observations cannot prove qualification.

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

Indicators use one canonical contiguous native candle series, independently of the visible window. EMA seeds from 200 closes; BOLL uses arithmetic prices and population deviation; VWAP weights typical prices by base-currency volume; RSI uses Wilder smoothing and returns 50 for a flat run. ATR%(14) normalizes Wilder-smoothed true range by the current close, while BBW(20, 2) divides the existing BOLL band width by its middle band; both share a percentage panel between RSI and Open Interest. Missing periods restart initialization, and missing values display as `—`. Older source additions and corrections invalidate derived calculations. See the [indicator contract](docs/INDICATORS.md) for formulas, units, initialization, and boundary conditions.

Applicable relative changes use `(current − previous) / abs(previous) × 100%`. A missing, nonfinite, or zero baseline is unavailable. Taker imbalance uses `(Buy − Sell) / (Buy + Sell) × 100%`; its zero-total case is unavailable. Historical OI and taker availability depends on the provider; unavailable observations remain explicit gaps.

## History and live updates

**Settings → History to retain (days)** controls the requested history coverage, defaulting to **30 days**, with a supported range of **1–3,650 whole days**. Synchronization also requests 200 earlier **price** candles for initial indicator coverage; statistics do not need indicator warmup. Exact recursive calculations reuse durable checkpoints or replay the available canonical prefix, rather than treating those 200 candles as a substitute for earlier input. Available history depends on listing dates and source availability.

Every eligible contract subscribes to native 5m, 15m, and 1h candles and public ticker, 400-level order-book, open-interest, and trade channels. Public connections carry at most 25 contracts each, with paced connection starts. Books are reconstructed from snapshots and sequence-checked incremental updates; a gap rebuilds the affected connection without stopping the others.

At a native close, acquisition gives the acknowledged candle stream up to 10 seconds to deliver the final candle. Accepted confirmations finish committing before competing acquisition proceeds. Qualification, chart recovery, and archive downloads share this wait and reuse the durable candle; older gaps and disconnected or silent streams use REST recovery.

Completed native candles, independent OI/Taker observations, source coverage evidence, and recursive indicator checkpoints are stored in SQLite WAL. One dedicated writer worker commits facts and their versions atomically; two reader workers serve indexed range queries. A dedicated market coordinator worker owns MarketService, network scheduling, and metadata. The Electron main process handles windows, security, and IPC; separate database and indicator workers execute market SQL and calculations. Forming candles and their live OI/Taker observations remain in memory.

Taker totals require continuous trade coverage from the native period's start; startup and reconnect gaps remain unavailable until a complete period can be observed. Reconnection repairs bounded gaps alongside immediate live delivery. A coordinator timer advances current desired ranges at native boundaries, including a global 5-minute boundary, and wakes acquisition when unavailable source leases expire. Historical scheduling persists desired coverage ranges, not old viewport requests, HTTP cursors, or a growing queue of past single-candle repairs. Overlapping consumers share source acquisition, and restarts plan from committed facts.

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
| `metadata.sqlite` | Transactional preferences, qualification catalog, desired synchronization ranges, audit reports, and private analysis settings |

Existing Parquet is imported once in a separate Node child process, with durable per-partition progress. Its native DuckDB lifetime is isolated from the app and SQLite workers. First access prioritizes the required series/range, and bounded latest queries import recent partitions first. The importer honors the newest base and later deltas, resolves source revisions, validates observations, and never overwrites newer SQLite facts with old imported data. Original files remain unchanged. Corrupt or incompatible partitions become explicit repairable audit findings. After the import cutover, the importer exits and retained Parquet is no longer consulted; there is no permanent dual authority.

Market writes update keyed rows rather than republishing a day's files. Price corrections invalidate affected later indicator checkpoints atomically; statistics updates have their own revisions and do not invalidate price calculations. Checkpoints retain exact recursive state, formula version, and a source revision. Derived renderer and chart projections are bounded memory caches; they can be rebuilt from SQLite. A cached projection alone does not establish that a price is live.

History days describes requested coverage, not automatic deletion of already downloaded facts. Listing dates, actual provider availability, available disk space, and initial synchronization time still limit obtainable history. Large archives use bounded reads and calculations; the supported day setting is not a measured capacity guarantee.

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
| `npm run test:core` | Test core market, indicator, persistence, synchronization, audit, and protocol behavior |
| `npm run test:e2e` | Build and test actual Electron interactions with isolated fixture data |
| `npm test` | Run core tests and Electron E2E |
| `npm run app` | Build, package, and verify a candidate macOS app |
| `npm run app:deliver` | Build, smoke-test, install, and verify the installed app with rollback on failure |
| `npm run app:smoke -- --app "/path/to/Perpetual Swap Suite.app" --revision <full-git-sha>` | Verify an existing packaged executable using isolated data |
| `npm run test:okx:1h` | Run live public OKX candle/OI/taker integration with temporary storage |
| `npm run test:okx:streams` | Verify every eligible contract's public streams and three native candle subscriptions against OKX |
| `node scripts/okx-live-statistics.mjs --report .build/okx-statistics.json` | Check bounded older OI/Taker requests, zero placeholders, reuse and persistence against actual public responses |
| `npm run benchmark` | Measure SQLite worker writes, range queries, coverage, and gap detection |
| `npm run benchmark:chart` | Exercise chart scrolling, reversals, jumps, and delayed reads |
| `npm run benchmark:instruments` | Exercise local chart admission, switching, and revisits |
| `npm run benchmark:market` | Build and measure 287 contracts × 3 native periods with real SQLite/renderer work, synthetic intake, blocked statistics, and concurrent archive I/O; save `.build/resource-benchmark.json` |
| `PERPETUAL_SWAP_BENCHMARK_BACKGROUND=1 npm run benchmark:instruments` | Measure navigation while real synchronization and audit process an offline synthetic source |
| `node scripts/workspace-visual-check.mjs` | Check light/dark, grayscale, scaling, and measured contrast after building |
| `node scripts/benchmark-startup.mjs --app "/path/to/Perpetual Swap Suite.app"` | Measure three isolated process launches and process working sets |

[GitHub Actions](.github/workflows/release.yml) checks pull requests with lint, desktop syntax checks, types, core tests, and Electron E2E. On `main`, successful validation is followed by packaging, executable smoke, and publication of the `autobuild` app and digest metadata. [Live OKX integration](.github/workflows/okx-live.yml) runs separately on a schedule or manual dispatch and records endpoint diagnostics to distinguish external unavailability from integration failures. Benchmarks can be run locally as needed.

## Help and contributions

Read [AGENTS.md](AGENTS.md) before contributing. Keep market access behind the desktop bridge, reuse shared components and design tokens, and test core behavior relevant to the change. See the [improvement plan](docs/IMPROVEMENT_PLAN.md) and [implementation status](docs/IMPLEMENTATION.md) for the original assessment and implementation evidence.

Report bugs through [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues), including reproduction steps, macOS version, and the affected contract, timeframe, or data range. Repository maintainers and contributors review changes through GitHub.
