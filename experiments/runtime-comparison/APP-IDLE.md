# App activation and presentation idle

The production Electron app uses macOS app activation (`app.isActive()`, `did-resign-active`, `did-become-active`). An inactive but visible window keeps its last frame. A window blur, a switch between application windows, or an application-owned dialog does not itself change this policy. There is no minimize, hide, reload, or Stage Manager window-order manipulation.

## Work retained and suspended

Inactive presentation stops renderer store delivery, countdowns, animation, chart projection, chart-only preparation/prefetch and UI notification subscriptions. Main-process notifications return before wire encoding or IPC. Already admitted database reads or worker calculations can finish; their obsolete continuation cannot restart display preparation. WebSocket collection, continuity repair, canonical confirmed-candle updates, persistence, qualification/ranking and user-started download/audit/analysis tasks continue.

An activation creates a new epoch. Old chart reads and notifications cannot cross that epoch. The backend rehydrates invalidated resident data from SQLite and settles the selected chart's local indicator replay without waiting for remote acquisition. It captures the market, retained chart frames, preferences and job reports in one synchronous turn, posts that response before installing notification subscriptions, and the main process sends the presentation barrier before later incremental messages. React applies that snapshot before releasing view subscribers. A historical cursor remains historical. Missing source data and calculation errors retain their explicit source status instead of claiming complete data. Failed catch-up pauses preparation again and displays retry guidance.

The gateway keeps raw response-body ownership while a user-started analysis runs in the background. It coalesces those bytes and the terminal status for delivery at activation; it does not encode or replay a queue of idle UI notifications. One-shot resume payloads are released from preload, bridge and presentation state after delivery.

## Measurement contract

Resource and latency evidence is in [results/app-idle-2026-11-06.json](results/app-idle-2026-11-06.json). It identifies the exact source and built frontend hashes, raw evidence hashes, phase windows, per-phase counter coverage, and individual restoration samples. The measured source is uncommitted task work on the recorded parent revision; its content fingerprints identify it rather than falsely attributing it to that parent commit.

The resource comparison reuses one prepared SQLite dataset: 287 contracts, 384 closed candles in each of three timeframes (330,624 rows), and deterministic native-intake updates every 500 ms. Active and idle both receive the same 861 native series updates per tick. Three pairs alternate active/idle, idle/active, active/idle. Each selected window contains exactly 40 successful contiguous source ticks and complete process CPU/physical-footprint coverage. Transition work and extra ticks fall outside paired windows; resume latency includes the entire catch-up. Production performance tracing is explicitly off. One unchanged 1 Hz sampler runs throughout; there is no V8 profile, mutation observer or frame polling inside the resource windows. The test driver remains outside the measured app tree, while RPC handling inside the app is included equally in both modes.

CPU is percent of one core for Electron's process tree, including backend worker threads in their parent process. Memory is sampled physical footprint rather than RSS or a continuously observed peak. Supported macOS task counters provide CPU-only energy and mean CPU watts. GPU, WindowServer, display, I/O and whole-device energy are unavailable. These three pairs are descriptive, with uncontrolled ambient activity while the user works; they are not confidence intervals or a prediction of battery runtime.

Activation is injected into the production app-wide lifecycle through a test-only entry point. Windows are hidden, nonfocusable and offscreen, and sampled frontmost PID checks reject the test runtime becoming active. This avoids interrupting Stage Manager or the user's desktop. The reported latency begins at that main-process activation handler and ends after the latest correct chart/list DOM commit and a subsequent RAF. Each sample validates the actual selected source revision, SVG identity, price label, indicator readiness and viewport. Live-source and quiescent-source samples are reported separately. Native activation-event delivery, input-to-photon delay and physical screen presentation cannot be measured in this background configuration.

The functional acceptance test waits at least 60 real seconds with continuous intake, checks zero chart/list DOM mutations and UI notifications while idle, verifies archive progress, and preserves search text, input selection, historical bars/cursor and caches across rapid interleaved activation epochs. A separate native HTTP/WebSocket loopback test checks that confirmed corrections persist during idle and that current snapshot delivery precedes later live increments. These are controlled correctness fixtures, not a measurement of external OKX latency or long-duration system sleep, network reconnect or day-scale retention.

## Result — 2026-11-06

The final source-frozen comparison passed six 20-second windows, each with 40 successful native ticks, complete CPU/CPU-energy/footprint coverage and 21 samples. All 320 admitted ticks completed, making 275,520 native series-update calls; every final native live value matched the oracle, and all 330,624 source rows remained present. The following values are medians of three window means. Paired changes are medians and observed ranges of the three individual pair ratios, so they need not equal a ratio of the displayed medians.

| Metric | Active | Idle | Paired idle change, median [range] |
| --- | ---: | ---: | ---: |
| CPU, percent of one core | 44.51 | 4.46 | -89.73% [-92.56%, -82.20%] |
| CPU-only mean watts | 0.583 | 0.017 | -97.24% [-97.38%, -88.27%] |
| Mean physical footprint, MiB | 1128 | 812 | -40.00% [-45.87%, -17.76%] |

Under continuous intake, activation-handler-to-correct-DOM/RAF p50/p95 was **761/827 ms** (13 validated samples). With the source quiescent it was **684/769 ms** (20 samples). This is a noticeable catch-up interval, not an instantaneous restoration guarantee. The current barrier sends all 861 retained series snapshots; reducing unchanged-frame transfer with explicit revision validation is a future optimization opportunity, not a measured attribution of those milliseconds. A two-contract long-idle acceptance sample is not substituted for the full-universe latency distribution.

The functional test with full retained tracing passed a real 60,003 ms idle, with 121 source ticks during idle and 180 total, zero chart/list mutations or UI notifications, archive progress and all preservation checks. The 57 integration/controller checks, including native loopback integration, passed. The first long-idle attempt in that integration group failed before entering idle because it asserted active state while the initial document snapshot was still pending; the corrected full-tracing acceptance passed separately. The focused affected suite passed 274 tests. Four final lifecycle/Gateway failure tests passed, including retry without losing or replaying a background analysis response. Trace diagnostics report no missing records, sequence gaps, unclosed operations or missing required participants. Earlier exploratory setup failures remain separate artifacts and are not relabeled as passing runs.

After the resource run, delivery fixes covered startup activation reconciliation/nonblocking window creation, background-only activation isolation, retained trace journals, initial-snapshot test readiness, separate latency summaries and Gateway error-path ownership. The evidence records the changed file hashes and their scope; the measurement is not represented as a fresh run of the installed artifact. Production tracing remains off by default. No source cadence, foreground refresh policy or data precision was reduced.

## Reproduce without taking focus

Use Node 24, build once, and keep application and benchmark sources unchanged until measurement finishes:

```sh
npm run build
node scripts/test-sandbox.mjs command --desktop -- node scripts/app-idle-benchmark.mjs --report artifacts/app-idle-comparison/final.json
node scripts/test-sandbox.mjs command --desktop -- node --test --test-concurrency=1 tests/e2e/app-idle.e2e.mjs tests/e2e/backend-lifecycle.e2e.mjs
```

This work keeps Electron as the production container. The measured inactive-presentation policy does not establish a new Tauri comparison or justify migration.
