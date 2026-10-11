# Perpetual Swap Suite

[![Publish macOS Release](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml)

A native macOS app for screening OKX perpetual swaps, monitoring strategies, recording actual positions, and researching historical results. It covers live, non-TradFi USDT perpetual contracts and uses one-hour data throughout.

**Radar** discovers live signals. **Research** tests the same strategies against frozen data. Both modes share one strategy library, identity and revisions. Swift handles market data, calculations, storage, and native services; an AppKit window hosts the React dashboard in WKWebView. The interface is English-only. No OKX API key or local web server is required.

## Features

- **Live signal discovery:** simultaneous Bullish Setup and Bearish Reversal lanes, separate confirmed and provisional readings, visible conflicts, and direct chart/evidence access. All markets retains sortable indicators, search, and Long/Short Opportunity rankings with score explanations. Indicators include EMA200, Log Bollinger Bands, RSI, ROC/MAROC, open interest, taker volume, and high breakouts/low breakdowns.
- **Visual and formula rules:** synchronized editors support AND/OR/NOT groups, calculations, hourly conditions, event sequences, reusable values, and BTC market context. Inspect actual operands and data gaps with rule previews and market explanations.
- **Strategies and positions:** one shared Radar and Research library supports four-phase strategies, confirmed and provisional signals, and manually recorded Long/Short entries and exits.
- **Reproducible research:** compare frozen strategy versions, study strategy signals, calibrate Opportunity scores, or simulate independent per-contract capital. Review coverage, costs, funding, equity, drawdown, and trade evidence; pause, resume, and export CSVs.
- **Interactive charts:** review 96 hourly candles at a time with VWAP14, EMA200, Log BB, RSI, ROC/MAROC, OI, and taker volume. Load older history, navigate contracts by keyboard, and copy charts to the clipboard.
- **Native macOS workflow:** optional background monitoring, menu bar controls, notifications, Start at Login, automatic updates, Light/Dark/System appearance, adjustable frosted backgrounds, and tabular numbers.

## Quick start

### Install the app

Running the app requires **macOS 14 or newer** and network access to OKX and GitHub.

The current `autobuild` package targets Apple Silicon (`arm64`). For Intel Macs, build from source.

1. Open the [latest `autobuild` release](https://github.com/notCorwin/Perpetual-Swap-Suite/releases/tag/autobuild).
2. Download and extract `Perpetual.Swap.Suite.app.tar`.
3. Move `Perpetual Swap Suite.app` to Applications and launch it.

The release contains an ad hoc signed app bundle. Each successful release build replaces the `autobuild` package.

On first launch, the collector loads hourly history across the exchange universe. Markets and indicators appear as their data becomes available; missing readings display as `—`.

### Build from source

Use a macOS version supported by your Xcode installation, with:

- **Full Xcode and Swift 6.2+**, with Xcode selected as the active developer directory. Command Line Tools alone do not provide the asset compiler used to build the app.
- **Node.js 22.18+ within the 22.x line, or Node.js 24.11+**, and npm. These minimums follow the current dependency lockfile.
- Network access for npm/Swift dependencies, OKX public REST and WebSocket endpoints, and GitHub releases.

```sh
git clone https://github.com/notCorwin/Perpetual-Swap-Suite.git
cd Perpetual-Swap-Suite
npm ci
npm run app
open ".build/app/Perpetual Swap Suite.app"
```

`npm run app` builds the TypeScript renderer and release Swift executable, packages the dashboard and monitor helper, compiles the app icon, and ad hoc signs both bundles. It builds without opening the app; the final command launches it.

## Using Radar

### Screen markets

Select an **Active strategy** from the shared library to open **Signals**. Radar watches both entry phases at the same time: **Bullish Setup** for Long setups and **Bearish Reversal** for Short setups. A contract may appear in both lanes when phases conflict; inspect both rules before choosing a direction. Each reading applies Universe and phase rules from the same hour. **Both hours**, **Confirmed**, and **Provisional** control which readings appear. Confirmed matches sort first, followed by 24-hour turnover; each lane has its own pagination. Chart navigation follows the lane you opened.

**All markets** exposes the full supported universe, including nonmatches and Unknown inputs. Search applies to either view. **Positions** opens actual records; exits continue outside Universe. **Test strategy** carries the exact saved version into Research.

With **No active strategy**, Radar displays every contract in the supported exchange universe and offers **Strategy Library…** to create or activate a strategy. Signals and confirmed alerts require an active Strategy. Turnover, spread, listing age and every other restriction belong to the Strategy Universe; no independent Filter configuration or saved combination is applied.

Search narrows the visible list. Click column headings to sort; the default **Opportunity** ordering groups `Candidate`, `Watch`, `Overheated`, and `Incomplete` results. Open a score to inspect its components and missing inputs. Opportunity scores are heuristics; use Research to evaluate them against historical data.

### Build and save strategy rules

1. In **Strategies & Positions**, choose a Strategy and its **Universe** or phase, then open **Rules**, then **Add condition**. Search the condition library or choose a preset such as OI rising, Volume surge, or a BTC market context condition.
2. Edit conditions in sentence rows or **Guided cards**. Select **Live** for the forming hour or **Closed** for completed-hour evaluation; combine conditions with groups, calculations, or time requirements.
3. Use **Check a contract** or **Explain markets** to inspect matching, unmatched, and Unknown results.
4. Choose **Save strategy** to save all five configurations together. In Radar’s **All markets → Universe rules** panel, **Save Universe** updates the active Strategy directly.

Valid draft edits immediately preview rule matches. The All markets table remains complete. Alerts use the **active saved Strategy**. Invalid drafts retain the last valid preview and cannot be applied. Missing inputs evaluate as **Unknown**, including under NOT; only True Universe and entry phase matches become signals.

New numeric conditions default to **Greater than >**. Numeric presets use strict **> / <** comparisons, with these choices first in the comparison menu. Inclusive comparisons remain available when selected explicitly.

The optional **Formula** view edits the same rule tree. Try each example as a separate configuration:

```text
// Live quote volume exceeds twice the mean of the previous 20 closed hours
let relativeVolume = Volume / mean(lag(Volume, 1), 20);
relativeVolume > 2
```

```text
// RSI14 exceeds 50 in each of the latest three completed hours
closed(every(RSI(14) > 50, 3))
```

### Review charts

Click a symbol to open its chart. Hold the primary mouse button to inspect a candle, drag while holding to inspect others, and release to return to the displayed window's latest candle. Scroll to load older history; returning to the newest candle resumes automatic following.

| Control | Action |
| --- | --- |
| Up / Down | Previous / next contract in visible list order, wrapping at either end |
| Left | First contract in the current sorted search results |
| Right | Highest-turnover contract matching the valid rule preview, regardless of search |
| Copy chart | Copy an image with an opaque theme background |

### Monitor strategies and record positions

Open **Strategies & Positions** and configure **Universe** plus four independent phases: **Bullish Setup**, **Bullish Exhaustion**, **Bearish Reversal**, and **Bearish Exhaustion**. Every phase must contain valid, nonempty rules before saving or activation. Radar monitors one activated saved strategy at a time. Saving from either mode updates that same strategy and revision. **Duplicate saved strategy** creates a separate strategy in the shared library; copying between modes is unnecessary. Unsaved drafts remain separate for each mode.

**Confirmed** results use completed hourly snapshots; **Provisional** results use the forming hour and may retract. Conflicting entry phases suppress directional entry prompts. Universe gates entries, while holding exits still evaluate for recorded positions outside Universe.

After executing a trade yourself, use **Record entry…** or **Record exit…** with its direction, actual price, and UTC time. These records alone change actual holdings. The app currently supports analysis and manual tracking; it does not submit exchange orders.

## Using Research

Click the **Perpetual Swap Radar / Perpetual Swap Research** title to switch modes. Each mode keeps its draft, page, and scroll position. Live monitoring continues while Research prepares or evaluates data.

1. Choose a **Research question**: Multi-direction cycle, Long entry / exit, Strategy signals, Opportunity, or Compare strategies.
2. Select saved/frozen Strategy versions, a phase where applicable, contracts, and a UTC date range. Signals and comparisons include the Strategy Universe; Opportunity uses its Universe. Long simulations use Universe plus Bullish Setup for entry and Bullish Exhaustion for exit. A blank start date requests the longest obtainable history. **Strategy Library** manages the shared strategies. Research initially selects the active Radar strategy and its execution policy. New saved revisions are surfaced explicitly; **Use latest saved revisions** updates the study configuration before preparing a new dataset.
3. Set execution and capital parameters for cycle studies. Each contract has its own account, initially 10,000 USDT, 100% margin allocation, and 1× leverage. Enter maintenance margin and liquidation fees explicitly. Leave all three trading-cost fields blank for Gross results, or supply entry fee, exit fee, and per-side slippage in basis points, including explicit zero, for modeled Net results.
4. Choose **Review data plan → Prepare Data → Run Study**. Review source coverage and gaps before downloading; inspect the frozen dataset once preparation finishes.
5. Inspect reports, trades/events, and frozen charts. Use **Studies & cache** to reopen or resume experiments, and the export controls to save summary, event/trade, and equity CSVs as applicable.

**Use this version in Radar** activates the selected configuration or the primary strategy from the displayed cycle result. If its saved rules or execution policy have changed, the app restores the researched version as a separate shared strategy before activation. Existing strategies and completed results retain their versions.

Research freezes rules, engine versions, input revisions, and a SHA-256 data manifest. Updating Radar rules or refreshing cached sources does not change an existing experiment. Historical evaluation runs at hourly close, with execution at the next hourly open; it does not use future candles or live EMA state.

Missing prices, funding, or other required inputs remain Unknown or make affected results Incomplete. The data plan exposes public-history limits and gaps. Cycle liquidation is a simplified isolated model using hourly traded OHLC; live BTC rules use an hourly approximation. Fixed-horizon signal studies and cycle capital simulations are separate research models.

Downloaded inputs and checkpoints persist without automatic expiry. **Clear unreferenced cache** removes only inputs no longer referenced by experiments.

## Monitoring, notifications, and updates

Choose the run mode under **Settings → Run mode**:

| Mode | Closing the window or Cmd+Q |
| --- | --- |
| On-demand, the default | Checkpoints Research and stops collection and the helper. Reopen the app and explicitly resume paused studies. |
| Background Monitoring | Keeps native collection and alerts running. Enables optional Start at Login. Use the menu bar's Quit Completely to stop both processes. |

Minimizing keeps work running. **Pause Monitoring** stops collection and alerts; resuming establishes a quiet baseline.

Enable **Settings → Strategy notifications** and allow notifications for **Perpetual Swap Suite Monitor**. Alerts report confirmed entry phases and position exits from the active saved Strategy; drafts, search, and sort do not change their rules. Startup and rule changes establish quiet baselines, and Unknown readings preserve prior definite membership. Clicking a notification opens its contract or strategy. Notifications and Start at Login require the packaged `.app`.

Automatic update installation is enabled by default. Use **Perpetual Swap Suite → Automatically Install Updates** to change it, or **Check for Updates** for a manual check. The helper verifies the release digest and source revision before installation; updates are deferred while Research is busy.

Choose Light, Dark, or System in the native **Appearance** menu. **Settings** controls the frosted background and opacity; the initial appearance is Dark with opacity 0.3. Text and chart lines remain clear as background opacity changes.

## Local data

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/PerpetualRadar/radar.sqlite3` | Completed hourly candles/statistics, EMA state, saved strategies, actual position records, and shared settings |
| `~/Library/Application Support/PerpetualRadar/Research/research.sqlite3` | Normalized historical data, frozen experiments, results, and checkpoints |
| `~/Library/Application Support/PerpetualRadar/Research/Raw/` | Downloaded research source files |

Active quotes, live calculations, strategy rule previews, and notification membership remain in memory. Research datasets and workers use their own database, reuse confirmed Radar history, and do not change live market history. Editable strategies are read and written through the same native monitoring service in both modes. SQLite uses write-ahead logging; native services retry transient database and monitor failures automatically.

## Development

### Project layout

| Path | Responsibility |
| --- | --- |
| [Sources/PerpetualRadar](Sources/PerpetualRadar) | AppKit/WebKit host, native monitor and IPC, OKX networking, indicators, rules, SQLite, Research, notifications, and updater |
| [src](src) | React/TypeScript dashboard, rule editors, charts, and Research views |
| [src/components/ui](src/components/ui) | Shared shadcn/ui primitives |
| [src/index.css](src/index.css) | Design tokens and component material contract; Tailwind CSS supplies layout and styling |
| [Tests/PerpetualRadarTests](Tests/PerpetualRadarTests) and `src/*.test.ts` | Native and TypeScript test suites |
| [scripts](scripts) | App packaging, isolated native test runner, and surface checks |
| [macos](macos) | Bundle metadata and icon assets |
| [.github/workflows/release.yml](.github/workflows/release.yml) | Release build, packaging, and publication |

Swift dependencies are declared in [Package.swift](Package.swift) and resolved in [Package.resolved](Package.resolved). Web dependencies and commands are in [package.json](package.json), with exact versions in [package-lock.json](package-lock.json).

`npm run build` produces only the renderer in `dist/`. The dashboard requires the native WKWebView bridge; use `npm run app` to build the complete application.

### Checks and release workflow

Run the complete local CI before pushing:

```sh
npm run ci:local
```

This runs Swift and TypeScript tests, lint and surface-contract checks, a full macOS app build, real WKWebView interaction/material checks, and isolated monitor lifecycle tests. Every test runs in the background without taking focus, occupying visible displays, or creating Dock icons. Native test windows remain outside every connected display even when resized, centered, or reordered; runtime audits check window bounds, activation, and Dock eligibility.

| Command | Purpose |
| --- | --- |
| `npm test` | Swift tests in isolated preference/cache domains, then TypeScript tests |
| `npm run lint` | Oxlint, shared component surface contracts, and the background-test contract |
| `npm run test:ui` | Build the renderer and run native WKWebView interaction, material, and pixel checks offscreen |
| `npm run test:ui:visual` | Run the focused material and chart pixel acceptance suite entirely offscreen |

UI review snapshots are saved under `.build/ui-qa`. Functional checks, material checks, and native compositor pixel captures are all part of local CI. Screenshots capture only the test window, including real backdrop filters, without displaying it. Packaged lifecycle tests use isolated, re-signed app copies with `LSUIElement` set before launch, preventing a Dock icon before Swift starts. They hide the research window without invoking Dock animations; native miniaturize/deminiaturize callbacks are covered separately. There is no foreground test mode, including when `RADAR_VISUAL_TESTS=1`.

GitHub Actions handles **CD only**. Every push to `main` builds and packages the app, publishes `Perpetual.Swap.Suite.app.tar` and `update.json`, and moves the single `autobuild` release/tag to that commit. The workflow does not run the test or lint suites.

## Help and contributing

Maintained by [notCorwin](https://github.com/notCorwin). Report bugs or request features through [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues); include your macOS version, build revision, reproduction steps, and the relevant error message or data gap.

The in-app condition library, **Check a contract**, and **Explain markets** describe supported rules and their readings. Developers can inspect the [native indicator/function catalog](Sources/PerpetualRadar/FilterCatalog.swift), [rule compiler](Sources/PerpetualRadar/FilterCompiler.swift), and [tests](Tests/PerpetualRadarTests) for executable examples.

Before contributing, read [AGENTS.md](AGENTS.md). Keep system services in Swift/native APIs, reuse shadcn/ui components, and follow the shared design tokens and `data-surface` material contract. Use current stable toolchains, run `npm run ci:local` before pushing, and keep GitHub Actions focused on release delivery. Submit focused pull requests with a description of the resulting behavior and local validation.
