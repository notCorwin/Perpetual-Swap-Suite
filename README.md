# Perpetual Swap Suite

A native macOS workspace for rebuilding the OKX perpetual-swap market locally, writing JavaScript entry strategies, and backtesting them against completed 5-minute data.

The application uses AppKit and WKWebView as its native shell, React and Base UI for the interface, Lightweight Charts for market visualization, DuckDB for analytical queries, and Parquet as the source of truth for completed market data. The interface is English-only.

## Why it is useful

- **One workspace:** eligible contracts, charts, indicators, strategy code, backtests, AI analysis, and local data tools stay in a fixed three-column layout.
- **Local market history:** completed 5-minute candles and funding rates are stored in Parquet. Forming candles remain in memory.
- **Explicit liquidity rules:** spread, side depth, slippage, 24-hour volume, open interest, and hourly volume stability are persistent settings.
- **Open JavaScript strategies:** an embedded Node.js process runs local `.mjs` strategies with filesystem, network, read-only DuckDB query, TradingView-style, and exchange-style order APIs.
- **Deterministic backtesting:** 5-minute candles use TradingView's four-point OHLC path rule. Larger chart periods use completed 5-minute bars as their internal detail.
- **Native lifecycle:** closing the window leaves collection active; launch-at-login and SHA-256-verified GitHub updates are supported without a Developer ID.

## Requirements

- macOS 14 or newer
- Swift 6.1 or newer
- Node.js and npm
- Xcode Command Line Tools

No OKX API key is required. Market data uses public OKX endpoints.

## Get started

Install dependencies, run the local checks, and build the application:

```sh
npm ci
npm run ci:local
npm run app
open ".build/app/Perpetual Swap Suite.app"
```

For interface development:

```sh
npm run dev
```

For native development, build the web interface first so the AppKit executable can load `dist/`:

```sh
npm run build
swift run PerpetualSwapSuite
```

## Workspace

### Contracts

The left column shows OKX perpetual swaps that satisfy the configured liquidity requirements. The default scope is USDT-settled perpetuals; settlement currencies are configurable. `USDC-USDT-SWAP` is always excluded.

Default eligibility settings:

| Requirement | Default |
| --- | ---: |
| Bid–ask spread | `< 0.05%` |
| Bid and ask depth | `> 100,000 USDT` within `0.5%` of mid |
| Buy and sell slippage | `< 0.10%` for `100,000 USDT` |
| 24-hour volume | `> 30,000,000 USDT` |
| Open interest | `> 5,000,000 USDT` |
| Optional volume stability | maximum / minimum of 24 completed 1-hour buckets `< 2` |

### Charts

The center column displays candles, volume, EMA 20/50/200, RSI 14, forming data, and backtest markers. Supported chart periods begin at 5 minutes. Closed chart data always originates from local Parquet files; up to 500 recent candles are loaded for the current view.

### Strategies

Strategies live in:

```text
~/Library/Application Support/Perpetual Swap Suite/Strategies/
```

Each strategy is an ES module. A minimal entry strategy looks like this:

```js
export async function onTick(context) {
  if (!context.bar.confirmed || context.position) return

  const fast = context.indicators.ema(20)
  const slow = context.indicators.ema(50)

  if (fast != null && slow != null && fast > slow) {
    strategy.entry('Long entry', strategy.long, {
      marginUSDT: context.settings.initialCapitalUSDT,
    })
  }
}
```

Available interfaces include:

- `strategy.entry`, `strategy.order`, `strategy.exit`, `strategy.close`, `strategy.cancel`, and `strategy.cancelAll`
- `exchange.placeOrder`, `exchange.amendOrder`, `exchange.cancelOrder`, and `exchange.cancelAllOrders`
- `suite.query(sql)` for read-only `SELECT`, `WITH`, or `EXPLAIN` queries through DuckDB
- `context.indicators.ema()` and `context.indicators.rsi()`

Strategies are trusted local code and run with the permissions of the current macOS user.

## Backtesting model

- A 5-minute historical candle exposes four ticks: Open, the nearer extreme, the other extreme, and Close.
- For 15-minute and larger strategies, completed 5-minute candles provide the internal price path.
- Strategies can run on close, on each historical tick, after fills, or with close-tick order execution.
- Market orders normally fill on the next available tick.
- Limit fills can require an additional configurable number of ticks beyond the limit.
- The emulator supports market, limit, stop, stop-limit, amend, cancel, OCA, Long, and Short instructions.
- Default take-profit and stop-loss percentages apply to margin return. Fees, fixed-tick slippage, historical funding, leverage, and liquidation are included.
- A contract can hold one position at a time. Results list the longest-held trades first.

The emulator deliberately does not invent sub-5-minute interpolation or historical order-book queues. It cannot reproduce partial fills caused by unavailable historical L2 capacity.

## Local data

Application data is stored under:

```text
~/Library/Application Support/Perpetual Swap Suite/
├── Market/
│   ├── Candles/          # partitioned 5m Parquet
│   ├── Funding/          # funding-rate Parquet
│   └── catalog.duckdb    # file catalog, sync state, validation records
├── Strategies/           # user-authored .mjs files
├── Credentials/          # AI key, mode 0600
├── Cache/
└── settings.json
```

The Data panel can synchronize the full available history for any user-selected contracts and validate local Parquet files. Existing partitions are deduplicated by instrument and timestamp.

## AI analysis

The AI panel uses `@ai-sdk/openai-compatible`. Configure a base URL, model, and API key. The key is stored by the native process and injected into requests; it is not returned to the WebKit page. Analysis includes recent candles, market and liquidity readings, and the active backtest report.

## Development

| Path | Purpose |
| --- | --- |
| [`Sources/PerpetualSwapSuite`](Sources/PerpetualSwapSuite) | AppKit host, OKX client, DuckDB/Parquet, strategy runtime, broker emulator, AI gateway, and updater |
| [`src`](src) | React workspace, Base UI controls, charts, editor, and reports |
| [`node/strategy-host.mjs`](node/strategy-host.mjs) | Embedded Node.js strategy protocol and APIs |
| [`Tests/PerpetualSwapSuiteTests`](Tests/PerpetualSwapSuiteTests) | Core native storage, liquidity, strategy, and backtest tests |
| [`scripts`](scripts) | Local CI and application packaging |

Useful commands:

```sh
npm run build        # Type-check and bundle the interface
npm run lint         # Lint TypeScript and React
npm test             # Run TypeScript business tests
npm run test:native  # Run Swift tests
npm run ci:local     # Run the complete local CI pipeline
npm run app          # Build the packaged macOS application
```

Local CI owns testing. GitHub Actions builds and publishes the latest successful `main` revision.

## Updates and security

Published builds use ad-hoc macOS code signing. The updater downloads the GitHub release declared by `update.json`, verifies its SHA-256 digest, validates the bundle identifier and source revision, replaces the application, and rolls back if relaunch fails.

SHA-256 proves download integrity but does not provide publisher identity when the manifest and asset share the same unsigned GitHub release. Review this tradeoff before distributing builds outside a trusted repository.

## Help and contribution

Use [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues) for bugs and focused feature requests. Include the macOS version, source revision, reproduction steps, and relevant logs without credentials.

Contributions should keep the UI English-only, preserve the 5-minute source-of-truth model, use Base UI and shared design tokens, and add tests only for core business logic and critical behavior. The project is maintained through the `notCorwin/Perpetual-Swap-Suite` repository.
