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

`app:deliver` builds the app for the current macOS architecture, validates and smoke-tests the candidate, replaces `/Applications/Perpetual Swap Suite.app`, and smoke-tests the installed executable. It asks the old app to quit before replacement and restores it if installation or installed-app validation fails. Smoke checks use temporary user data and exercise the actual executable, build revision, window, preload isolation, DuckDB/Parquet I/O, indicator worker, normal exit, and persistence after restart.

For development, run `npm run dev` to start Vite and Electron together. Opening the renderer in an ordinary browser does not provide the desktop data service.

## Market workspace

The contract list stays on the left and the selected contract's chart stays on the right. The whole workspace, including dialogs, scales from a 1,600-pixel design width so both columns retain their proportions. Shared shadcn/ui components use Base UI and CSS design tokens, with system light/dark themes, tabular figures, and signed values and direction symbols alongside price colors.

The list shows only contracts that meet every enabled liquidity condition and the USDT perpetual/no-scheduled-closure requirements. Search narrows the visible results. Contracts are ordered by the **absolute signed price change**, largest first; the sign still shows whether the price rose or fell.

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

Qualified contracts are rechecked independently every 30 seconds while full-market discovery continues. Historical preparation finishes before live observations are collected. Missing or expired data is reported as unavailable verification, separately from confirmed filter rejections. During a temporary verification gap, the current chart and its live subscription remain available while the qualified list is rechecked.

## Charts and indicators

Select a contract and choose **5m**, **15m**, or **1h**. The default chart timeframe is **15m**. The main chart contains candlesticks, EMA(200), BOLL(20, 2), and VWAP(14). Separate panels show ROC(9) + MAROC(9), RSI(6/12/24), Open Interest in contracts, and Taker Buy/Sell in contracts.

| Control | Action |
| --- | --- |
| Primary mouse button, then drag | Inspect candles; release to return to the window end |
| Scroll | Review history; return to the newest range to follow live updates |
| Up / Down | Previous / next contract in the visible list, wrapping at either end |
| Left | First contract in the visible ranking |
| Right | Highest-turnover eligible contract, independent of search |
| Copy chart | Copy the chart with an opaque theme background |
| Analyze Long / Analyze Short | Analyze a captured chart snapshot |

Each chart presents a complete 96-candle window. Selecting a contract preloads up to 16,384 contiguous, fully prepared local candles into the chart cache, enough for the default 30 days of 5m history. Scrolling within that cache switches synchronously without waiting for IPC or network requests. This focused local preload runs independently of source requests; the contract list keeps compact latest frames. Missing or expired source observations still need background preparation. While an uncached range is being prepared, the previous complete chart remains visible with a **Preparing** label. Data collection, storage, and indicator preparation run outside renderer interactions.

Indicators use one canonical contiguous native candle series, independently of the visible window. EMA seeds from 200 closes; BOLL uses arithmetic prices and population deviation; VWAP weights typical prices by base-currency volume; RSI uses Wilder smoothing and returns 50 for a flat run. Missing periods restart initialization, and missing values display as `—`. Older source additions and corrections invalidate derived calculations. See the [indicator contract](docs/INDICATORS.md) for formulas, units, initialization, and boundary conditions.

Applicable relative changes use `(current − previous) / abs(previous) × 100%`. A missing, nonfinite, or zero baseline is unavailable. Taker imbalance uses `(Buy − Sell) / (Buy + Sell) × 100%`; its zero-total case is unavailable. Historical OI and taker availability depends on the provider; unavailable observations remain explicit gaps.

## History and live updates

**Settings → History to retain (days)** controls the requested history coverage, defaulting to **30 days**, with a supported range of **1–3,650 whole days**. Synchronization also requests 200 earlier candles for indicator warmup. Available history depends on listing dates and source availability.

Completed candles are written to Parquet and read through DuckDB for charts and indicators. WebSocket updates keep the forming candle in memory; confirmed data passes through durable ingestion before becoming completed history. Reconnection coordinates missing-range repair with the history synchronizer. Complete saved ranges are reused, and background jobs checkpoint their progress in SQLite.

Price, OI and Taker history start on independent paced source lanes. Statistics wait only for their matching price page to be durable. Each statistics page explicitly specifies `begin` and `end`; availability is evaluated from the source response, without a shared local retention cutoff. Missing values and Taker zero placeholders inconsistent with actual traded volume remain unavailable with a bounded retry lease. See [historical source behavior](docs/STATISTICS_SOURCES.md) for the dated API observations and pagination rules.

### Check and repair data

In **Settings → Data integrity**:

1. Choose **Start audit** to inspect persisted history for gaps and invalid data.
2. Follow the progress and issue list, or choose **Cancel audit** to stop the current run.
3. Choose **Repair issues** for repairable findings. Repairs run in the background and are followed by verification of persisted data; unresolved issues remain visible.

## Optional AI chart analysis

Open **Settings → Optional AI analysis → Configure analysis**, enter a Vercel AI Gateway key, and select a model with image input support. The default model is `openai/gpt-6.1-sol`. Market collection and charts work without AI credentials.

**Analyze Long** and **Analyze Short** capture the chart as an opaque PNG and send it through the main process to Gateway. Responses stream in English. Follow-up questions reuse that snapshot and model; **New analysis** captures the current chart. Conversations and drafts stay in memory until exit. **Stop**, changing contracts, or closing the panel cancels generation. Failed requests retry while the panel remains open.

The model and API key are stored in a private analysis record inside `metadata.sqlite`. The database has mode `0600`; the key is plaintext on disk and available only to the main process. Public settings responses report whether a key exists without returning it. Chart images and conversations are sent to Gateway when analysis is requested.

## Local storage

Paths are relative to `~/Library/Application Support/perp-radar/`:

| Path | Contents |
| --- | --- |
| `MarketData/candles/` | Completed candles in Parquet, partitioned by native timeframe, instrument, and UTC date |
| `MarketData/prepared-charts/` | Derived chart snapshots with formula versions and source watermarks |
| `metadata.sqlite` | Transactional preferences, eligibility catalog, synchronization checkpoints, audit reports, and private analysis settings |

DuckDB uses an in-memory query connection over Parquet. Writes validate completed candles and atomically publish immutable delta files. Reaching eight active files compacts the UTC-day partition into one base; its generation excludes superseded files even after an interrupted cleanup. Repairs publish a new base, including when removing all rows. Derived snapshots identify their exact active source files.

History and warmup targets have stable identities per instrument, period and source. Advancing a target updates its desired range; verified coverage is reused until the affected persisted range changes or an unavailable-statistics lease expires. Source checkpoints commit in batches. Live indicators project one forming candle from a bounded confirmed seed, without recomputing history or writing the forming candle. The full-history navigation cache is independent of these subscription seeds.

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
| `node scripts/okx-live-statistics.mjs --report .build/okx-statistics.json` | Check bounded older OI/Taker requests, zero placeholders, reuse and persistence against actual public responses |
| `npm run benchmark` | Measure Parquet writes and DuckDB queries |
| `npm run benchmark:chart` | Exercise chart scrolling, reversals, jumps, and delayed reads |
| `npm run benchmark:instruments` | Exercise contract prewarming, switching, and revisits |
| `PERPETUAL_SWAP_BENCHMARK_BACKGROUND=1 npm run benchmark:instruments` | Measure navigation while real synchronization and audit process an offline synthetic source |
| `node scripts/workspace-visual-check.mjs` | Check light/dark, grayscale, scaling, and measured contrast after building |
| `node scripts/benchmark-startup.mjs --app "/path/to/Perpetual Swap Suite.app"` | Measure three isolated process launches and process working sets |

[GitHub Actions](.github/workflows/release.yml) checks pull requests with lint, desktop syntax checks, types, core tests, and Electron E2E. On `main`, successful validation is followed by packaging, executable smoke, and publication of the `autobuild` app and digest metadata. [Live OKX integration](.github/workflows/okx-live.yml) runs separately on a schedule or manual dispatch and records endpoint diagnostics to distinguish external unavailability from integration failures. Benchmarks can be run locally as needed.

## Help and contributions

Read [AGENTS.md](AGENTS.md) before contributing. Keep market access behind the desktop bridge, reuse shared components and design tokens, and test core behavior relevant to the change. See the [improvement plan](docs/IMPROVEMENT_PLAN.md) and [implementation status](docs/IMPLEMENTATION.md) for the original assessment and implementation evidence.

Report bugs through [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues), including reproduction steps, macOS version, and the affected contract, timeframe, or data range. Repository maintainers and contributors review changes through GitHub.
