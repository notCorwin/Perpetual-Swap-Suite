# Electron and Tauri runtime comparison

## Scope and environment

This is an isolated prototype comparison, not a replacement for the production app. Both shells load the same built production frontend and use the same existing Node backend, workers, SQLite services, loopback HTTP/SSE bridge, fixtures, and operation recording. It compares the shell and web engine around a common backend; it does not compare an Electron implementation with a Rust rewrite. External OKX, actual WebSocket transport, real network conditions, and native input are outside the workload.

The intended host is macOS with Stage Manager enabled. Both nonfocusable windows are ordered behind the user's windows at native level -1, ignore mouse events, and are intended never to activate. The Tauri app is launched through LaunchServices to establish WebKit XPC responsibility. Each current trial uses its own cloned bundle path, so read-only NSWorkspace lookup can identify and stop that exact app even before readiness or after the `open -W` launcher exits. Interruption cleanup stops the runtime before its backend. The harness checks that the sampled frontmost app is not the runtime and aborts on its detected focus violations. Periodic observation cannot prove that focus never changed between samples; window placement and actual native visibility can vary with macOS and Stage Manager.

For the same active-page workload in both engines, the test page overrides `document.visibilityState` to `visible` and separately records native visibility. This is a controlled simulation, not evidence that the window was physically visible or presented. A requestAnimationFrame (RAF) represents a scheduling opportunity; an acknowledgement checks the DOM/chart state at a subsequent RAF, not native compositor, screen presentation, photon, or input-device latency. Engine scheduling, occlusion, refresh cadence, and system activity can still differ.

## Workload and correctness

The runner creates one closed, pristine SQLite seed and clones it for each trial. Each backend uses a constant clock offset selected at its own launch to align candle boundaries to a common market epoch; the offset remains fixed within that trial. Timers, `performance.now()`, and OS counters run at their normal rate. The formal default is three alternating pairs: Electron/Tauri, Tauri/Electron, Electron/Tauri (AB/BA/AB). The phases are idle, realtime, history scrolling, and download. Inputs are planned every 200 ms during non-idle phases; their planned and actual dispatch times, exact history targets, commit, supersession, and errors are retained. Idle has no synthetic inputs. Default non-realtime phase duration is 20 seconds; realtime uses 60 ticks at 500 ms with a 30.5-second requested phase.

The offline replay injects deterministic native-intake updates for 287 contracts and three timeframes per tick, 60 ticks in all. It exercises backend and UI processing, not a real market feed. Delivery and latency reporting focuses on the first contract's 15-minute chart, while the backend checks the whole fixture for replay mismatches. A finite, identical 30-day download commits 12,240 archive rows from an initially empty archive; the independent integrity audit is excluded so it does not introduce different or partially cancelled work.

Before and during the replay, chart data and indicators are checked against the full-series oracle; a canonical data hash must agree across trials, and indicator SVG path identities and topology are compared. Coordinate differences can arise from native text metrics, so this is not a physical-pixel comparison. Successful input acknowledgement requires an individually correct committed result for its target; superseded, missed, and failed inputs remain visible in the counts rather than being folded into latency. Realtime delivery statuses include committed, coalesced, missed, and missing. Source-to-RAF timing uses a clock calibration with recorded uncertainty.

## Resource accounting and analysis

The sampler takes initial and final snapshots and targets 1 Hz during each phase. The resource sampling window brackets the browser control request and is not exactly the browser's phase duration. CPU percentages are relative to one core and weighted by elapsed interval time; CPU seconds, per-task CPU joules, and mean CPU watts are derived from process-counter deltas. Runtime, backend, and combined process groups are separate, with no backend double counting. The footprint is the arithmetic mean and peak of sampled physical footprint, not a continuously observed maximum.

An interval with missing or inconsistent process counters is excluded. The analyzer reports covered intervals, elapsed time, and snapshot counts; it leaves whole-window CPU or energy totals and means unavailable unless every relevant interval is complete. It similarly withholds the full-snapshot footprint statistics when any footprint snapshot is incomplete. Explicit covered-interval sums in JSON are labeled as such and are not full-window totals. Energy requires both a working per-task CPU-energy counter and complete energy coverage. It is CPU energy only, not full application or device energy: GPU, display, WindowServer, I/O, and shared-system energy are not attributable here. See [measurement/NOTES.md](measurement/NOTES.md) for sampler details and limitations.

Tauri's launchd-hosted WebKit processes are selected using exact responsible-PID matching, the same UID, and a WebKit XPC executable. This uses a private best-effort responsibility lookup; the runner requires an attributed WebContent process at each resource sample. These checks do not guarantee that every transient process or all WebKit work is included. Process snapshots are non-atomic and can miss short-lived processes or focus changes; 1 Hz footprint peaks are lower bounds on the continuous peak. A skipped scheduled sample is reported; counters spanning the longer interval may still be complete, but temporal resolution is reduced.

Analyze a completed report without starting any application:

```sh
node experiments/runtime-comparison/analyze.mjs path/to/report.json
```

The default output is `summary.json` beside the report; use `--output path/to/summary.json` to select another path. The CLI rejects failed and smoke reports by default. `--allow-smoke` permits diagnostic analysis of either, explicitly labels a smoke run, and does not make it formal comparison evidence. JSON retains per-trial values, coverage and median/min/max by scenario and runtime. Interaction and realtime p50/p95 are nearest-rank percentiles over unique successful commits within a trial; aggregate medians and ranges are across trial statistics, not pooled input samples.

Paired relative changes use `(Tauri - Electron) / Electron × 100` and require a positive Electron baseline, complete metric coverage, matching interaction targets/workload, successful acknowledgement of every input and focused live tick, correctness evidence, and the formal three-pair order. Superseded inputs or missing/coalesced live ticks remain diagnostics and exclude that pair from resource deltas. A missing metric or invalid pair remains unavailable rather than being inferred. Three pairs are descriptive; medians and ranges do not establish statistical significance or generalize to other machines, workloads, network conditions, versions, or configurations. Reported joules and CPU time also depend on the sampled window duration. No result from the smoke report is a performance conclusion.

## Reproduce

Use Node 24 and the stable Rust toolchain with the macOS SDK. Build the common production frontend once, then keep source and build files unchanged throughout a measurement. The comparison bundles and all isolated profiles stay under ignored `artifacts/runtime-comparison`; the production app in `/Applications` is not replaced.

```sh
npm run build
node experiments/runtime-comparison/build.mjs
node --test --test-concurrency=1 experiments/runtime-comparison/*.test.mjs experiments/runtime-comparison/measurement/measurement.test.mjs
node experiments/runtime-comparison/run.mjs --smoke --measure --runtime all --duration-ms 3500
node experiments/runtime-comparison/run.mjs --runtime all --rounds 3 --count 287 --duration-ms 20000 --output artifacts/runtime-comparison/formal-YYYY-MM-DD
node experiments/runtime-comparison/analyze.mjs artifacts/runtime-comparison/formal-YYYY-MM-DD/report.json
```

Each trial must finish with clean backend/runtime termination and complete operation journals for the backend, reader, writer, prepared-chart workers, and renderer. The runner checks these after resource sampling. The source fingerprint rejects changes during measurement; raw evidence also identifies the actual runtime executable hashes. Use a new output directory for each run.

## Measured result — 2026-11-05

The three formal pairs passed on a battery-powered Mac15,12 running macOS 15.8.2, Electron 44.9.0, Tauri 2.12.5, and Node 24.22.2, while the user continued working with Stage Manager. All 564 recorded resource intervals were complete, with no skipped scheduled samples. Each runtime acknowledged all 1,056 planned inputs across three trials. Each trial delivered all 60 focused live updates without coalescing or missing updates, completed 51,660 native series-update calls, retained the same 330,624 source rows, and downloaded exactly 12,240 new archive rows. Verification checks every focused-chart tick and the final value of all 861 series; it does not independently observe every intermediate value for every series. Active phases observed approximately 60 RAF opportunities per second in both engines. No sampled runtime became frontmost; all six runtime processes exited after measurement.

The following values are medians across three trial statistics, including the common backend. CPU is percent of one core. Footprint is the mean of 1 Hz physical-footprint samples. CPU energy is the kernel's CPU-only counter over the whole phase: approximately 20.1 seconds idle/history, 20.2 seconds download, and 30.6 seconds live. The finite download can complete before the window ends; its average includes the remaining interaction and idle time, so it is not a sustained network-download power figure.

| Scenario | CPU % Electron / Tauri | CPU J Electron / Tauri | Mean footprint MiB Electron / Tauri | Acknowledgement p95 ms Electron / Tauri |
| --- | ---: | ---: | ---: | ---: |
| Idle | 15.73 / 1.38 | 0.496 / 0.045 | 1445 / 1130 | — |
| Live | 72.72 / 88.26 | 40.907 / 45.356 | 1515 / 1332 | 19.56 / 20.12 |
| History | 35.02 / 40.30 | 3.858 / 3.569 | 1605 / 1495 | 24.60 / 34.00 |
| Download | 24.13 / 20.29 | 3.437 / 2.643 | 1599 / 1505 | 34.00 / 27.00 |

Live acknowledgement is source-to-correct-DOM/RAF for the selected chart; history is a scripted wheel step; download is search acknowledgement while the finite archive task runs. These are different actions and should be compared only between runtimes within a scenario. Live p95 ranges were 9.51–19.58 ms for Electron and 15.95–20.49 ms for Tauri. History p95 ranges were 21.60–32.20 ms and 23–35 ms respectively; they overlap, so there is no established general interaction-speed advantage. History uses cached data and five one-candle wheel steps per second, not extreme scrolling through missing history.

Tauri reduced idle and finite-download CPU energy and physical footprint in this experiment. It increased live combined CPU energy in every pair (paired median +10.9%) and runtime-only CPU energy (paired median +36.0%), while live combined mean footprint fell (paired median −11.3%). This supports keeping Electron for the production application for now: the core live workload has no demonstrated CPU-energy advantage, and lower memory alone does not establish a better performance/energy tradeoff. A future migration decision needs a separate foreground presentation and real network workload measurement; total application/device, GPU, display energy and physical interaction latency remain unavailable here.

The committed [analysis and evidence metadata](results/2026-11-05.json) retain per-trial values, ranges, coverage, paired deltas, the measured source fingerprint, runtime hashes, and the raw report SHA-256. The complete local raw report is `artifacts/runtime-comparison/formal-2026-11-05/report.json`; it is intentionally outside version control along with profiles and journals. The three initial regressions and the dual-runtime smoke passed before the formal run. Post-run review hardened rejection of unequal completed work, pre-readiness app cleanup and interruption cleanup, without changing resource-counter arithmetic, frontend, runtime binaries, or replay cadence; the expanded seven regressions passed. A post-review dual-runtime smoke and final Electron cleanup smoke passed all phases. The full Tauri interruption path exited with code 130, preserved an atomic interruption report, closed both processes without force, and left no owned app running. The hardened analyzer reproduced the formal summary exactly. The formal results had complete work and clean termination, so these changes do not alter their numerical analysis. No production source, frontend refresh cadence, or market real-time cadence was reduced or migrated.
