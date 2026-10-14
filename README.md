# Perpetual Swap Suite

[![Publish macOS Release](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/notCorwin/Perpetual-Swap-Suite/actions/workflows/release.yml)

A native macOS app for discovering Bullish Setup signals on OKX perpetual swaps and researching their historical results. It covers live, non-TradFi USDT perpetual contracts and uses one-hour data throughout.

**Radar** discovers live signals. **Research** tests the same strategies against frozen data. Both modes share one strategy library, identity and revisions. Swift handles market data, calculations, storage, and native services; an AppKit window hosts the React dashboard in WKWebView. The interface is English-only. No OKX API key or local web server is required.

## Features

- **Live signal discovery:** a full-width Bullish Setup radar with separate confirmed and provisional readings and direct chart/evidence access. All markets retains sortable indicators, search, and Long/Short Opportunity rankings with score explanations. Indicators include EMA200, Log Bollinger Bands, RSI, ROC/MAROC, open interest, taker volume, and high breakouts/low breakdowns.
- **Visual and formula rules:** synchronized editors support AND/OR/NOT groups, calculations, hourly conditions, event sequences, reusable values, and BTC market context. Inspect actual operands and data gaps with rule previews and market explanations.
- **Shared strategy library:** save Universe and Bullish Setup rules together, monitor confirmed and provisional signals, and use the exact saved revisions in either mode.
- **Reproducible research:** study Bullish Setup signals, compare frozen strategy versions, and calibrate Opportunity scores on matching setups. Review coverage, fixed-horizon Long returns, costs, funding, and signal evidence; pause, resume, and export CSVs.
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

Select an **Active strategy** from the shared library to show its **Signals** and **All markets** together on one Radar page. Radar watches **Bullish Setup** across the supported universe. Each signal applies Universe and Bullish Setup rules from the same hour. **Both hours**, **Confirmed**, and **Provisional** control which readings appear. Confirmed matches sort first, followed by 24-hour turnover; signals paginate in groups of 25. Chart navigation follows the signal list you opened.

**All markets** appears below Signals. With an active Strategy, it contains only contracts whose current Universe result is **True**, so liquidity and other eligibility rules screen the market list as well as signals. With no active Strategy, it exposes the full supported exchange universe. **Explain markets** still includes nonmatches and Unknown inputs. Search applies to both sections. **Test strategy** carries the exact saved version into Bullish Setup Research.

With **No active strategy**, Radar displays every contract in the supported exchange universe and offers **Strategy Library…** to create or activate a strategy. Signals and confirmed alerts require an active Strategy. Turnover, spread, listing age and every other restriction belong to the Strategy Universe; no independent Filter configuration or saved combination is applied.

Search narrows the visible list. Click column headings to sort; the default **Opportunity** ordering groups `Candidate`, `Watch`, `Overheated`, and `Incomplete` results. Open a score to inspect its components and missing inputs. Opportunity scores are heuristics; use Research to evaluate them against historical data.

### Build and save strategy rules

1. In **Strategy Library**, choose a Strategy and its **Universe** or **Bullish Setup** rules, then open **Rules**, then **Add condition**. Search the condition library or choose a preset such as OI rising, Volume surge, or a BTC market context condition.
2. Edit conditions in sentence rows or **Guided cards**. Select **Live** for the forming hour or **Closed** for completed-hour evaluation; combine conditions with groups, calculations, or time requirements.
3. Use **Explain markets** to inspect matching, unmatched, and Unknown results.
4. Choose **Save strategy** to save Universe and Bullish Setup together. In Radar’s **Universe rules** panel, **Save Universe** updates the active Strategy directly.

Valid draft edits immediately preview rule matches and filter the All markets table. Alerts use the **active saved Strategy**. Invalid drafts retain the last valid preview and cannot be applied. Missing inputs evaluate as **Unknown**, including under NOT; only True Universe matches appear in All markets, and only True Universe and Bullish Setup matches become signals.

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

Taker Buy/Sell uses OKX's per-contract `1H` statistics in **contracts** (`unit=1`), accumulated within the selected hour. Compare the same perpetual contract, hour, and unit on OKX; coin or USDT amounts have a different scale. **Taker imbalance** is `(Buy − Sell) / (Buy + Sell) × 100%`, rather than the Buy/Sell quotient. Radar refreshes independent contracts concurrently, and the table, chart, and strategy readings share the newest observation. Unavailable current-hour data stays Unknown and is retried; completed-hour corrections are persisted, while live values stay in memory.

Latest trade prices and quotes use OKX's ticker stream with a REST fallback. Hourly candle inputs remain exchange candle observations; a ticker never fabricates candle OHLC. Recovery scans repair missing closing candles and OI observations, and a slow chart source does not pause live snapshot updates. Completed candle corrections invalidate derived indicators and survive reopening the application. Table and chart OI share the same timestamp checks, so an observation from the previous hour cannot appear as current-hour OI.

**Estimated turnover** values OKX's 24-hour base-currency volume at the latest USDT trade price. It is an estimate, rather than the sum of each trade's actual notional. Indicator comparisons also require the same candle period, price source, formula, and warmup history; Log BB and VWAP14 retain this application's documented definitions.

| Control | Action |
| --- | --- |
| Up / Down | Previous / next contract in visible list order, wrapping at either end |
| Left | First contract in the current sorted search results |
| Right | Highest-turnover contract matching the valid rule preview, regardless of search |
| Copy chart | Copy an image with an opaque theme background |
| Analyze chart / Analysis | Analyze the visible chart or reopen its conversation |

Open **Settings → Configure analysis** to save a Vercel AI Gateway API Key locally for your macOS user and choose an image-capable model. The default is `openai/gpt-6.1-sol`. Chart analysis uses the OpenAI-compatible AI SDK provider with native URLSession networking.

The key lives outside the app bundle in `~/Library/Application Support/PerpetualRadar/Credentials/ai-gateway.json`, with file permissions `0600` and directory permissions `0700`. It is stored as local plaintext protected by your macOS account's file permissions. App updates and repeated analyses use this record without Keychain authorization. Existing installations import their old Keychain key once; macOS may request authorization for that migration. A canceled or failed import can be retried, or bypassed by saving a new key. The local record then becomes authoritative, including after **Remove key**, so the unused legacy Keychain item is never reimported. Credential access runs off the main actor, and settings responses never contain the saved key.

**Analyze chart** opens the right-hand panel and sends an opaque PNG of the visible chart with the fixed long-entry question. Answers stream in Chinese. Follow-ups reuse that snapshot and the conversation's model; **New analysis** captures the current chart and starts over. Each contract's conversation and draft stay in memory until the app exits. Switching contracts, leaving the chart, closing the panel, or pressing **Stop** cancels an active request; retries are manual.

### Monitor Bullish Setup

Open **Strategy Library** and configure **Universe** plus **Bullish Setup**. Universe may be unrestricted; Bullish Setup must contain valid, nonempty market rules before saving or activation. Radar monitors one activated saved strategy at a time. Saving from either mode updates that same strategy and revision. **Duplicate saved strategy** creates a separate strategy in the shared library. Unsaved drafts remain separate for each mode.

**Confirmed** results use completed hourly snapshots; **Provisional** results use the forming hour and may retract. Both use the Universe evaluated at their own hour. Only definite matches become signals; missing inputs remain Unknown.

## Using Research

Click the **Perpetual Swap Radar / Perpetual Swap Research** title to switch modes. Each mode keeps its draft, page, and scroll position. Live monitoring continues while Research prepares or evaluates data.

1. Choose a **Research question**: Strategy signals, Opportunity, or Compare strategies. All three evaluate Bullish Setup together with its Strategy Universe and measure Long returns.
2. Select saved/frozen Strategy versions, contracts, and a UTC date range. A blank start date requests the longest obtainable history. **Strategy Library** manages the shared strategies. Research initially selects the active Radar strategy. New saved revisions are surfaced explicitly; **Use latest saved revisions** updates the study configuration before preparing a new dataset.
3. Select first-entry-per-episode or every-matching-hour sampling. Opportunity calibration uses every matching hour. Leave all three trading-cost fields blank for Gross results, or supply entry fee, exit fee, and per-side slippage in basis points, including explicit zero, for modeled Net results.
4. Choose **Review data plan → Prepare Data → Run Study**. Review source coverage and gaps before downloading; inspect the frozen dataset once preparation finishes.
5. Inspect reports, signal events, and frozen charts. Compare outcomes over 1, 3, 6, 12, 24, or 48 hours. Use **Studies & cache** to reopen or resume experiments, and export summary and event CSVs.

**Use this version in Radar** activates the selected configuration or the primary strategy from the displayed result. If its saved rules have changed, the app restores the researched version as a separate shared strategy before activation. Existing strategies and completed results retain their versions.

Research freezes rules, engine versions, input revisions, and a SHA-256 data manifest. Updating Radar rules or refreshing cached sources does not change an existing experiment. Historical evaluation runs at hourly close, with execution at the next hourly open; it does not use future candles or live EMA state.

Research excludes bid/ask spread data and omits conditions that depend on spread, including reusable formulas, BTC references, and captured values. Data plans and reports list the omitted conditions. Remaining AND/OR conditions retain their logic; sequence stages retain their timing and independent captures. Research does not query or download order book archives, including when resuming older preparation plans. Recorded turnover, Opportunity scoring, fees, and configured slippage remain available. Shared strategy versions retain their original spread rules for Radar. Completed experiments retain their original results; copy an older frozen experiment to run it with the current engine.

Missing prices, funding, or other required inputs remain Unknown or make affected results Incomplete. The data plan exposes public-history limits and gaps. Live BTC rules use an hourly approximation in historical studies. Fixed-horizon outcomes measure signals using next-hour opens and never infer actual positions.

Downloaded inputs and checkpoints persist without automatic expiry. **Clear unreferenced cache** removes only inputs no longer referenced by experiments.

Data plans are cached on disk for repeated configurations, including renamed studies, and reused after reopening the app. Changes to local inputs, instrument metadata, recorded Radar history, parser/engine versions, or the available completed-hour horizon invalidate the plan; source catalogs remain reusable. Explicit refresh bypasses the plan cache.

**Prepare Data** uses one independent parser worker per available CPU core and overlaps archive transfers with parsing. Native downloads write received buffers directly to resumable partial files. REST pages, normalized batches, verified source completion records, and per-source checkpoints are saved as work completes. Resuming or preparing another study reuses completed imports. A failed source stops scheduling new work while other active sources finish and save their results.

**Studies & cache** marks the current task separately from saved failures. Expand **Saved error** to read a study's complete previous error and its saved timestamp. **Resume** retries that study using its cached inputs.

**Run Study** uses a CPU-sized calculation pool with independent per-contract checkpoints and a single batch writer. Frozen reads use the instrument/time index and reuse overlapping decoded inputs. Historical readings retain separate anchor-hour and earlier-hour EMA semantics; complete signal explanations are generated for saved events. Indicator batches are losslessly compressed, and reports materialize their signal rows and matched baselines once while preserving medians, funding/cost results and confidence intervals.

Run `npm run benchmark:study -- STUDY_ID` to time the shipping worker against a consistent snapshot of the local research database. The command runs without application windows or network downloads, creates a new study in the snapshot, and measures calculation, durable writes and report generation together. It prints the snapshot directory and saves `benchmark-result.json` beside its complete study results. The installed application's studies remain untouched. An optional second argument selects a different research database.

Planning reports each stage separately, including local history ranges, cached source files, and hourly input coverage. Local coverage checks run in bounded time ranges and report measured progress, the current instrument/input/range, and an estimate for the current stage. Pause stops between ranges; failures retain the last progress and a checkpoint error. Published archive catalog checks and file downloads use their own progress units and wording.

OKX rate limits (`HTTP 429` or API code `50011`) keep Research active and automatically retry the current request. Requests share pacing and cooldowns, honor `Retry-After`, and use exponential backoff with jitter capped at 60 seconds unless OKX asks for a longer wait. The task panel shows the automatic retry countdown. Completed catalog pages, REST pages, and partial archive downloads remain reusable; Pause and Cancel interrupt the wait immediately.

Older OKX candle archives may contain `None` for currency volumes while their prices and contract volumes are valid. Research imports complete hourly OHLC, converts available contract volume with verified contract metadata, and records missing quote-currency volume as Unknown. Missing currency volume does not fail the entire archive; VWAP and volume-dependent readings require the corresponding actual inputs. Retrying after a parser update reuses cached originals.

Archive minutes marked `confirm=0` are skipped and reported separately from malformed records. Missing required candle hours are supplemented with confirmed REST history; an inspected archive alone never makes those hours complete. API pacing follows each endpoint's published quota, including separate instrument quotas for funding, open interest, and taker volume.

## Monitoring, notifications, and updates

Choose the run mode under **Settings → Run mode**:

| Mode | Closing the window or Cmd+Q |
| --- | --- |
| On-demand, the default | Checkpoints Research and stops collection and the helper. Reopen the app and explicitly resume paused studies. |
| Background Monitoring | Keeps native collection and alerts running. Enables optional Start at Login. Use the menu bar's Quit Completely to stop both processes. |

Minimizing keeps work running. **Pause Monitoring** stops collection and alerts; resuming establishes a quiet baseline.

Enable **Settings → Strategy notifications** and allow notifications for **Perpetual Swap Suite Monitor**. Alerts report confirmed Bullish Setup membership changes from the active saved Strategy; drafts, search, and sort do not change their rules. Startup and rule changes establish quiet baselines, and Unknown readings preserve prior definite membership. Clicking a notification opens its contract and signal evidence. Notifications and Start at Login require the packaged `.app`.

Automatic update installation is enabled by default. Use **Perpetual Swap Suite → Automatically Install Updates** to change it, or **Check for Updates** for a manual check. The helper verifies the release digest and source revision before installation; updates wait for active Research work and resume when it finishes, including while the Research page remains open. The update menu shows download progress, installation, and retry delays; hover over a failed update for the error. Downloads retry after 30 seconds without data, with a five-minute limit per attempt. When the server supports resuming, retries retain partial downloads for the same release.

Choose Light, Dark, or System in the native **Appearance** menu. **Settings** controls the frosted background and opacity; the initial appearance is Dark with opacity 0.3. Dropdown menus, popovers, dialogs, and research task overlays share dense frosted glass: a stable high-opacity tint over strong backdrop blur, with inset edges and shadows in both appearances and no gradient. This material stays independent of window opacity; the blur subtly diffuses underlying text and shapes while the dense tint keeps popup content steady and readable. Text and chart lines remain clear as background opacity changes.

**Window blur** controls the native blur behind the entire window, including the desktop. **Popover blur** controls app content behind menus, dialogs, and task overlays. Both default to 64 and can be adjusted independently from 0 to 160: sliders preview immediately and save on release, with errors and retry controls if persistence fails. Preferences survive window and monitor restarts. Window blur requires the frosted background to be on and background opacity below 1. Popover blur remains independent; increasing it alone cannot change the native desktop blur or make glass opaque.

## Local data

| Location | Contents |
| --- | --- |
| `~/Library/Application Support/PerpetualRadar/radar.sqlite3` | Completed hourly candles/statistics, EMA state, saved Universe/Bullish Setup strategies and shared settings |
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

The CI runner enforces a 60-second wall-clock budget. It shares one optimized native build between the packaged app and the tests, runs independent checks concurrently, and partitions every discovered WebKit test across isolated processes. No checks are selected by changed files or silently skipped to meet the budget. The 250 ms menu benchmark runs alone before a bounded native test pool. SwiftPM and icon assets reuse validated build outputs; clearing caches can exceed the budget and will fail CI. Stage logs and a successful run's timings are saved in `.build/ci`; install dependencies with `npm ci` before running CI.

For a fresh checkout or cleared build cache, run `CI=1 npm run app` and `scripts/build-native.sh --build-tests` once to prime compilation, then run `npm run ci:local`. Cache warm-up does not replace any CI check.

| Command | Purpose |
| --- | --- |
| `npm test` | Swift tests in isolated preference/cache domains, then TypeScript tests |
| `npm run lint` | Oxlint, shared component surface contracts, and the background-test contract |
| `npm run test:ui` | Build the renderer and run native WKWebView interaction, material, and pixel checks offscreen |
| `npm run test:ui:visual` | Run the focused material and chart pixel acceptance suite entirely offscreen |

Asserted native material pixel captures are saved under `.build/ui-qa`. Functional checks, material checks, and native compositor pixel captures are all part of local CI. Screenshots capture only the test window, including real backdrop filters, without displaying it. Packaged lifecycle tests use isolated, re-signed app copies with `LSUIElement` set before launch, preventing a Dock icon before Swift starts. They hide the research window without invoking Dock animations; native miniaturize/deminiaturize callbacks are covered separately. There is no foreground test mode, including when `RADAR_VISUAL_TESTS=1`.

GitHub Actions handles **CD only**. Every push to `main` builds and packages the app, publishes `Perpetual.Swap.Suite.app.tar` and `update.json`, and moves the single `autobuild` release/tag to that commit. The workflow does not run the test or lint suites.

## Help and contributing

Maintained by [notCorwin](https://github.com/notCorwin). Report bugs or request features through [GitHub Issues](https://github.com/notCorwin/Perpetual-Swap-Suite/issues); include your macOS version, build revision, reproduction steps, and the relevant error message or data gap.

The in-app condition library and **Explain markets** describe supported rules and their readings. Developers can inspect the [native indicator/function catalog](Sources/PerpetualRadar/FilterCatalog.swift), [rule compiler](Sources/PerpetualRadar/FilterCompiler.swift), and [tests](Tests/PerpetualRadarTests) for executable examples.

Before contributing, read [AGENTS.md](AGENTS.md). Keep system services in Swift/native APIs, reuse shadcn/ui components, and follow the shared design tokens and `data-surface` material contract. Use current stable toolchains, run `npm run ci:local` before pushing, and keep GitHub Actions focused on release delivery. Submit focused pull requests with a description of the resulting behavior and local validation.
