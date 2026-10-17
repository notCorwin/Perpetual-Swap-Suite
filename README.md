# Perpetual Swap Suite

[![Publish macOS Release](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml)

An Electron desktop app for screening and charting live OKX USDT perpetual contracts. The React dashboard uses an isolated preload bridge; the Electron main process collects public market data, stores completed observations in Parquet, and queries them with DuckDB. No OKX API key is required.

## Features

- A searchable, sortable market table with Long/Short Opportunity scores, price changes, high breakouts/low breakdowns, taker imbalance, open interest, ROC/MAROC, RSI, and Bollinger Band readings.
- Liquidity screening for live, non-TradFi USDT perpetual contracts, with an optional hourly volume stability requirement.
- Native OKX 5m, 15m, and 1h charts with 96 candles per window, historical scrolling, keyboard navigation, chart copying, and technical indicator panels.
- Optional AI chart analysis through Vercel AI Gateway, with separate Long/Short prompts and follow-up conversations.
- English interface controls, tabular numbers, system light/dark styles, and shared design tokens for background materials and components.

## Install or build

Download `Perpetual.Swap.Suite.app.zip` from the [autobuild release](https://github.com/notCorwin/Perpetual-Swap-Suite/releases/tag/autobuild), extract it, and move `Perpetual Swap Suite.app` to `/Applications`. Local and CI packages are ad hoc signed.

To build on Apple Silicon macOS, use Node.js 24.11+ and npm, with network access for dependencies and OKX public endpoints:

```sh
git clone https://github.com/notCorwin/Perpetual-Swap-Suite.git
cd Perpetual-Swap-Suite
npm ci
npm run app
open "dist/mac-arm64/Perpetual Swap Suite.app"
```

`npm run app` builds the TypeScript/Vite renderer, packages Electron with electron-builder, and verifies the app signature. `npm run dev` starts Vite and Electron together for development. The renderer requires the Electron preload bridge; opening `dist/index.html` in an ordinary browser does not provide market data.

## Screen markets

The collector includes live, non-TradFi USDT perpetuals that pass all mandatory checks:

| Check | Requirement |
| --- | --- |
| Bid-ask spread | Below 0.05% |
| Order book depth | At least 100,000 USDT on each side |
| Estimated slippage | Below 0.10% on each side for a 100,000 USDT fill |
| Estimated 24h turnover | Above 30,000,000 USDT |
| Open interest notional | Above 5,000,000 USDT |
| Hourly volume stability, optional | Maximum/minimum volume below 2 across 24 completed hours |

Enable **Settings → Require stable hourly volume** to apply the optional check; it is off by default and persists locally. The other thresholds are fixed in the data service. Estimated turnover is 24-hour base-currency volume multiplied by the latest price.

Search narrows the market list. Column headings change the sort order. The default **Opportunity** ordering groups `Candidate`, `Watch`, `Overheated`, and `Incomplete` readings; open a score to inspect its components and missing inputs. These scores are heuristic rankings. Missing or warming indicator values display as `—`, and the collection status distinguishes cached data, loading, retries, and live observations.

## Review charts

Open a contract to view its chart and select **5m**, **15m**, or **1h**. Hold the primary mouse button to inspect a candle, drag to inspect others, and release to return to the window's latest candle. Scroll through history; returning to the newest range resumes following.

| Control | Action |
| --- | --- |
| Up / Down | Previous / next contract in the visible list, wrapping at either end |
| Left | First contract in the current sorted search results |
| Right | Highest-turnover eligible contract, independent of search |
| Copy chart | Copy the visible chart with an opaque theme background |
| Analyze Long / Analyze Short | Start or reopen analysis of a chart snapshot |

Chart OHLCV uses the selected period's native OKX candles. Confirmed candles are read from persisted data; the forming candle remains in memory as a live overlay. Ticker prices do not fabricate candle OHLC. Open interest and taker Buy/Sell volumes use the matching contract and candle period in **contracts** (`unit=1`). Taker imbalance is `(Buy − Sell) / (Buy + Sell) × 100%`.

The chart statistics loader supports OKX's latest 1,440 periods: approximately 5 days at 5m, 15 days at 15m, or 60 days at 1h. Older locally saved statistics remain available; price candles alone cannot reconstruct them. Missing statistics are shown explicitly. A zero Buy/Sell pair that contradicts a positive-volume candle is treated as unavailable.

Each displayed chart is a complete 96-candle snapshot. If a requested range needs preparation, the previous complete chart stays visible with a **Preparing** label. The service coalesces scrolling requests, prewarms candidate contracts, reuses saved history, and repairs missing ranges without blocking renderer input. Prepared latest snapshots also persist with calculation versions and source-write watermarks so they can be validated after restart.

### Indicator definitions

A worker calculates indicators over the persisted contiguous series, independently of the visible window. Missing periods split the series and restart initialization. Unavailable warmup values remain null; corrections or older history rebuild the affected indicator generation.

| Indicator | Definition |
| --- | --- |
| EMA(200) | Seed with the arithmetic mean of 200 closes, then use multiplier `2 / 201` |
| BOLL(20, 2) | Arithmetic mean of 20 closes ± two population standard deviations |
| VWAP(14) | Base-volume-weighted typical price `(High + Low + Close) / 3` over 14 candles; undefined for missing weights or zero total volume |
| ROC(9) | Signed relative close change over nine candles, as a percentage |
| MAROC(9) | Arithmetic mean of nine ROC readings |
| RSI(6), RSI(12), RSI(24) | Wilder smoothing, seeded with mean gains/losses over the period; a flat run gives 50; positive gains with zero losses gives 100 |

Applicable relative changes use `(current − previous) / abs(previous) × 100%`; a zero baseline is unavailable. Indicator comparisons require matching periods, source data, formulas, and warmup history. See the [indicator contract](docs/INDICATORS.md), [indicator calculations](electron/services/indicators.js) and [market metrics](electron/services/market-metrics.js) for implementation details.

## AI chart analysis

Open **Settings → Configure analysis**, enter a Vercel AI Gateway API key, and choose a model with image input support. The default model is `openai/gpt-6.1-sol`.

**Analyze Long** and **Analyze Short** capture the visible chart as an opaque PNG and send it through the Electron main process to Gateway. Responses stream in Chinese. Follow-up questions reuse the captured image and selected model; **New analysis** captures the current chart again. Conversations and drafts remain in memory until the app exits. **Stop**, changing contracts, or closing the panel cancels active generation. Failed requests retry automatically while the panel is open.

The API key is stored as plaintext in the local `settings.json` file with mode `0600`; settings responses expose whether a key is configured without returning the key. Charts and conversations are sent to Gateway only when analysis is requested.

## Local data

Paths are relative to `~/Library/Application Support/Perpetual Swap Suite/`:

| Path | Contents |
| --- | --- |
| `MarketData/candles/` | Confirmed candle Parquet parts partitioned by timeframe, instrument, and UTC date |
| `MarketData/catalog.parquet` | Cached liquid-contract catalog |
| `MarketData/prepared-charts/` | Validated latest chart snapshots |
| `settings.json` | Liquidity and appearance preferences, analysis model, and Gateway key |

Parquet writes are serialized and published atomically. Corrections append newer observations; DuckDB selects the latest record for each timestamp. DuckDB uses an in-memory query connection rather than a separate durable database file. Unconfirmed candles stay in memory.

## Development and validation

| Path | Responsibility |
| --- | --- |
| [electron](electron) | Main process, isolated preload bridge, and desktop operations |
| [electron/services](electron/services) | OKX collection, Parquet storage, DuckDB queries, chart preparation, and indicators |
| [src](src) | React dashboard, charts, and analysis UI |
| [src/components/ui](src/components/ui) | Shared shadcn/ui components |
| [src/index.css](src/index.css) | Design tokens and shared surface materials |
| [tests/e2e](tests/e2e) | Real Electron interaction and chart acceptance tests |
| [scripts](scripts) | Development, packaging, benchmarks, and validation tools |

Resolved dependencies are in [package-lock.json](package-lock.json). Use the commands in [package.json](package.json):

| Command | Purpose |
| --- | --- |
| `npm test` | Core TypeScript tests and Electron end-to-end checks |
| `npm run test:renderer` | Indicators, market logic, chart controller, prepared cache, storage, and bridge contracts |
| `npm run test:e2e` | Build and verify real Electron interactions and rendered chart snapshots |
| `npm run lint` | Oxlint and shared component surface checks |
| `npm run benchmark` | Parquet write and DuckDB query timings |
| `npm run benchmark:chart` | Scrolling, reversals, large jumps, and delayed storage reads |
| `npm run benchmark:instruments` | Contract prewarming, switching, and cache-pressure revisits |
| `npm run test:okx:1h` | Live OKX hourly candle, open interest, and taker integration |
| `npm run app` | Build and package the macOS app |

Chart acceptance compares committed 96-candle snapshots with a full-series numeric oracle and checks the rendered SVG metadata and OI/Taker geometry. Navigation checks include revisiting contracts beyond the deep-history cache and switching while an older history request is delayed.

[GitHub Actions](.github/workflows/release.yml) runs tests, live OKX integration, and benchmarks for pushes to `main`, then packages the app and publishes the `autobuild` release with its digest metadata.

Before contributing, read [AGENTS.md](AGENTS.md). Keep data access behind the preload bridge, reuse shared components and design tokens, and run checks relevant to the change. Report bugs through [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues) with reproduction steps, macOS version, and the relevant error or data gap.
