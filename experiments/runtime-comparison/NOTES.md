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

## Follow-up attribution experiment

The follow-up crosses transport (`http`, `native`) and operation telemetry (`full`, `off`). It concentrates the causal controls on the same realtime workload: 287 contracts, three timeframes, 60 ticks at 500 ms, 152 planned search actions at 200 ms, and the same complete chart/indicator oracle. Three rounds rotate the four configurations and alternate runtime order. A complete three-pair metric is required for a baseline contrast; unfinished inputs, missing/coalesced deliveries, changed targets, incomplete counters, or diagnostic flags invalidate the corresponding estimate. The full oracle is stored separately with its SHA-256, and search terms and expected result counts are retained explicitly.

HTTP mode uses the existing fetch/SSE bridge. Native mode keeps the same application JSON payloads but carries them through a persistent authenticated Unix-domain socket to Electron IPC/contextBridge or Tauri invoke/Channel. It still has framing, native SDK, JSON and copying costs. A native-minus-HTTP contrast measures the **net effect of replacing the complete communication path**, not the absolute cost of the HTTP protocol alone. The controller and initial asset loading remain loopback HTTP; resource measurements bracket the same browser workload. Route counters retain application request/response bytes and event counts/bytes without serializing a response a second time merely to count it. Header and hidden SDK/copy bytes are not counted.

`off` replaces only the renderer telemetry initializer in an isolated frontend build, preserving request, notification, chart decoding and event delivery, and disables backend operation recording by removing its recording directory. The rendering and business-data modules are unchanged. Native process CPU/energy/footprint counters, input acknowledgements and mathematical correctness checks remain enabled. This control removes operation journal generation/export/persistence, not every trace-related scaffold or every benchmark observer. In particular, the existing production application initializes operation recording by default: turning it off is a diagnostic counterfactual, not a proposed production optimization. Both native/full and native/off matter to the migration decision.

### Occlusion and platform limits

On macOS Sequoia 15.8, full Stage Manager occlusion can suspend WebKit RAF even with its public inactive scheduling policy disabled. The follow-up prototype uses WebKit's private `_setWindowOcclusionDetectionEnabled:NO` **only inside this experiment**, matching Chromium's explicit occlusion/background-throttling overrides while leaving the native window at level -1, nonfocusable and mouse-transparent. This SPI is present on the measured host and declared in [WebKit's own private header](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewPrivate.h). It is not a production deployment choice. Native RAF must complete a preflight, and unprofiled active phases fail below 50 opportunities/second; successful controls observe approximately 60. Engine visibility under these overrides does not establish physical unoccluded presentation. Total GPU/display/WindowServer energy and screen latency remain unavailable.

The native transport has a bounded 128 MiB frame size because this fixture's startup chart universe exceeds the initial 20 MiB experimental limit. No input data, contract count or cadence is reduced to fit the transport. Bounds apply to complete frames, not the number of frames coalesced in one socket read. Startup/preparation is outside the timed phase, and complete preparation must settle before measurement. A reusable seed report must validate the exact fixture size and virtual market epoch; source rows are reseeded/idempotently validated in each isolated clone, and the full oracle, source cardinality and final live values are checked again.

### Profiling and observer controls

Call-stack collection is a separate diagnostic run. Native `sample(1)` attaches only to birth-identity-checked PIDs from the owned runtime/backend snapshot, records permission failures and unknown symbols, and never inspects user applications. Its counts include blocked threads and cannot be turned into CPU percentages. Backend V8 CPU profiles and an Electron renderer CPU profile retain source functions where available; the Electron timeline records script, style/layout and paint events without opening DevTools. WebKit native JIT stacks can remain unresolved and do not supply equivalent JS-source-level timing.

Diagnostic browser wrappers count and time explicit JSON, encoding/cloning, geometry and SVG-attribute calls. These are inclusive wall-time observations, can overlap, omit engine-internal work/copies, and are not CPU/energy measurements. DOM setter time is not deferred layout or SVG paint. A separate three-pair native/off probe-on run checks their aggregate observer effect, but its later time block also includes ambient variation; profiled/diagnostic resource values never enter the primary baseline estimator. Renderer timeline totals likewise require exclusive interval accounting and are instrumented thread wall time, not an allocation of OS CPU or GPU energy. The statistics-history fixture intentionally remains pending; this synthetic workload does not represent a fully quiescent real market application.

The raw factorial, profiling, observer and four-scenario check reports are separate, so an attribution or observer failure cannot silently contaminate the unprofiled resource controls. The core scientific limit remains unchanged: these are descriptive results on one M3/24 GB host in normal desktop use, not a statistical significance or battery-life claim.

### Attribution results — 2026-11-05

All 24 unprofiled trials passed: three rounds of both runtimes and all four transport/recording configurations. All 744 resource intervals had complete CPU/CPU-energy counters and footprint snapshots, no scheduled samples were skipped, and no sampled runtime became frontmost. Every trial acknowledged 152/152 search actions and 60/60 focused updates without coalescing or missing deliveries, while processing the same 51,660 native updates and retaining 330,624 source rows. All full-oracle hashes agree. RAF opportunities ranged from 59.89 to 60.02/s; neither cadence nor realtime freshness was reduced. The CPU-energy windows were 30.62–30.68 seconds. Three pairs remain descriptive, not a significance claim.

Medians of per-trial combined runtime/backend measurements:

| Transport / recording | CPU % Electron / Tauri | CPU J Electron / Tauri | Mean footprint MiB Electron / Tauri | Search p95 ms Electron / Tauri | Live source→RAF p95 ms Electron / Tauri |
| --- | ---: | ---: | ---: | ---: | ---: |
| HTTP / full | 70.38 / 85.72 | 40.90 / 43.00 | 1689 / 1399 | 27.3 / 27.0 | 18.11 / 16.42 |
| HTTP / off | 57.41 / 66.95 | 25.10 / 28.71 | 1443 / 1245 | 33.2 / 26.0 | 15.20 / 17.41 |
| Native / full | 77.71 / 89.85 | 44.17 / 48.91 | 1620 / 1423 | 27.4 / 27.0 | 8.82 / 17.45 |
| Native / off | 56.73 / 60.88 | 24.60 / 26.94 | 1668 / 1366 | 31.6 / 26.0 | 10.47 / 17.03 |

The controls support two conclusions. First, operation recording is a substantial cost: removing it changes combined CPU energy by paired medians of −38.1% (Electron HTTP), −42.2% (Electron native), −33.7% (Tauri HTTP), and −43.1% (Tauri native). Corresponding absolute CPU changes are −14.93, −21.04, −18.61 and −25.78 percentage points of one core. Full recording exported 346–479 renderer batches totaling 96.76–98.12 MB of application JSON per trial; off exported none. These are aggregate recording-generation/export/persistence effects, not a measurement of disk writes alone. Production initializes this recording by default, so it cannot all be dismissed as benchmark-only overhead or simply removed as an optimization.

Second, replacing HTTP/SSE is not a universal saving. The paired native-minus-HTTP CPU-energy changes were:

| Recording | Electron median [min, max] | Tauri median [min, max] |
| --- | ---: | ---: |
| Full | +8.0% [+2.7%, +10.9%] | +0.8% [−0.02%, +13.7%] |
| Off | −2.0% [−3.1%, +3.5%] | −6.1% [−9.9%, −3.0%] |

This is the net complete-path change, including native SDK serialization and copying. It does not isolate a pure HTTP tax. Both transports still deliver 51,660 prepared-chart notifications, about 62.50 MB of application JSON, plus 61 snapshot requests with about 2.89 MB of responses per trial. All 861 series are updated, although one chart is visible. Preserving backend intake while avoiding unnecessary frontend fanout is a more promising question than choosing a container by process name.

With native transport and recording off, Tauri still used more combined CPU energy in all three pairs: median +6.1%, range +5.3% to +9.5%, and +5.86 CPU percentage points. Its paired mean footprint was lower by 14.9% (13.2–18.3%). With recording retained, native Tauri CPU energy was +10.7% (2.7–11.1%) and footprint −9.9%. Search latency favored Tauri in these cells, while focused live source→RAF latency favored Electron; the experiment establishes no across-the-board experience advantage.

### What the stacks establish

The eight separate diagnostic trials all completed the same workload correctly. Backend V8 profiles resolve actual source functions: `pendingSourceRanges` remains a leading leaf in the market worker with recording off (about 1.04–1.19 seconds of time-delta-weighted observations per trial). It repeatedly builds/filter-sorts the task list and scans the requested candle range. `sourceStatus`, `cachedStatus`, `projectBars`, and `structuredClone` also remain visible; clone observations in that worker were about 0.34–0.40 seconds with recording off. These are sampling leads for shared-backend work, not exact per-function CPU times or demonstrated cache savings.

Full-recording profiles additionally resolve `renderer-operations.receive`, `importOperationEvents`, `operation-runtime.enqueue`, per-operation `threadCpuUsage`, and native `rename`/`writev` leaves. Removing recording eliminates or greatly reduces the first group, consistent with the unprofiled causal contrast. The wire path still resolves `encodeChartWire`/`visit`, JSON parsing and socket/native send work. An operation wrapper can surround real business work: the analyzer attributes the exclusive leaf rather than charging its entire subtree to telemetry. V8 sample timestamps are reconstructed and sorted before weighting, including negative deltas in the Electron CDP profiles, following [DevTools' timestamp handling](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts). Unresolved native/program frames remain unresolved.

Explicit browser JSON.parse probes observed roughly 103,000 calls and 254–389 ms per diagnostic trial. Browser stringify, backend structured cloning, the type-preserving chart-wire traversal, socket writes, and Tauri Channel/serde string escaping are distinct observed work; internal engine/SDK copies are not fully measured. Native stacks contain actual JSC parser/compiler, WebCore style invalidation/selector, SVG paint, and IPC/serde frames. Their terminal counts include waits, unknown JIT and heuristic operation context; they cannot provide a percentage split of CPU by category.

Electron's main-renderer timeline gives exclusive recognized-event wall times of 1.27–1.43 seconds for script, 0.37–0.43 seconds for layout/style, 0.60–0.73 seconds for paint/prepaint/layer work, and 0.11–0.14 seconds for GC, over approximately 31 seconds. Explicit SVG `d` setters took only 7–12 ms, but their deferred rendering is elsewhere. Geometry reads took 94–149 ms. These observations do not prove SVG is cheap overall: paint includes non-SVG, WebKit lacks an equivalent timeline here, compositor/GPU work is not attributed, and unknown frames are substantial. There is no evidence sufficient to blame the gap on JavaScript as a language or to promise that a Rust rewrite or canvas conversion would fix it.

The later diagnostic-wrapper-only check (three native/off pairs, without native/V8/CDP profilers) changed CPU by medians of +1.70 percentage points for Electron and +2.04 for Tauri. Observed CPU-energy changes ranged from −1.33% to +4.29% and −4.72% to +0.16%, respectively. Because this is a later time block on a working desktop, these are observed changes with ambient variation, not pure observer overhead or evidence of negative overhead. The primary matrix had all these diagnostic wrappers/profilers disabled. Mandatory correctness/controller work and the 1 Hz native sampler were retained equally in both runtimes; their indirect scheduling/frequency effects have not been completely isolated. Do not claim all testing-tool influence was removed.

A separate native/full idle/live/history/download pair passed all four scenarios and the finite 12,240-row download check. This is a correctness/interaction spot check, not a replicated four-scenario power estimate. Real missing-history extreme scrolling, actual WebSocket/download networking, physical presentation/input latency and whole-app/GPU/display energy remain unmeasured.

### Optimization order and migration decision

1. Preserve complete operation records while reducing their construction, clock-query, serialization/export and journal-publication work. Investigate compact schema/batches and sharing encoded records; validate no dropped records, explicit flush/close and crash/durability semantics. The full/off contrast measures the opportunity ceiling, not a shipping patch.
2. Reuse missing-range/status calculations in the shared prepared-chart service. Invalidation must include relevant source input versions, source epoch, task coverage and freshness/window changes; process only changed ranges. Do not cache solely by contract/timeframe or hide source failures. The stacks motivate this work; its savings still need a controlled validation.
3. Restrict expensive prepared-chart encoding/delivery to active consumers and share immutable results where safe, while keeping every contract's backend intake, current values and subscription freshness unchanged. Preserve chart-wire types and mathematical oracles. Then compare any protocol/copy reduction independently of the native SDK.
4. Investigate geometry reads and WebCore style invalidation only with matched interaction/presentation evidence. An SVG-to-canvas rewrite or JS-to-Rust rewrite is not supported as the first optimization by these results.

Keep Electron in production for now. Once operation-recording and bridge effects are separated, this prototype still offers no live CPU-energy improvement from Tauri, and preserving production recording strengthens that conclusion. Lower footprint is real within the sampled workload, but it does not establish a better overall experience/energy tradeoff. A future migration gate should repeat unprofiled pairs after the shared-work optimizations, preserve records and all correctness/cadence checks, and add real network and unobscured physical-presentation measurements. This experiment does not modify the production application or deploy the experimental private SPI.

The committed [attribution evidence](results/attribution-2026-11-05.json) preserves grouped/per-trial resources and coverage, paired effects, diagnostic observations, raw artifact SHA-256 values, executable identities and limitations. Raw reports/profiles/journals remain in the four ignored `artifacts/runtime-comparison/attribution-*-2026-11-05*` directories identified there. Measurements identify their own dirty source fingerprints; later offline analysis, unused-branch removal, seed-report chaining and review fixes do not make the final commit the exact measured fingerprint. All measured runtime/backend processes exited cleanly.

Final independent review reproduced the grouped values, paired effects and four raw report hashes. It removed an incidental internal-tree assertion while retaining the behavioral protocol, statistical, instrumentation and identity regressions; all 18 offline Node tests passed, including a disposable native sampling capability check with no window. Review also hardened the offline analyzer to reject missing/insufficient RAF evidence independently of the runner. The six affected analysis tests then passed and the real factorial analysis remained eligible with identical numerical results. No additional window or benchmark run was needed. The compact committed evidence explicitly identifies the exact interaction/delivery records as retained in the hashed raw report and full analyzer output rather than repeated in that compact file.

Offline reanalysis starts no application:

```sh
node experiments/runtime-comparison/attribution-analysis.mjs artifacts/runtime-comparison/attribution-factorial-2026-11-05-v2/report.json
node experiments/runtime-comparison/profile-analysis.mjs artifacts/runtime-comparison/attribution-profiles-2026-11-05/report.json
```

To reproduce on a new day, select that day's common market epoch and a valid seed report, build the isolated telemetry-off frontend once, then keep sources unchanged during the runs. Use a new output directory for each command; these commands launch the background-only comparison windows:

```sh
node experiments/runtime-comparison/frontend-build.mjs
node experiments/runtime-comparison/build.mjs
comparison_epoch_ms=$(node -p 'Math.floor(Date.now()/900000)*900000+1000')
node experiments/runtime-comparison/run.mjs --market-epoch-ms "$comparison_epoch_ms" --rounds 3 --count 287 --scenarios realtime --variants http:full,http:off,native:full,native:off --output artifacts/runtime-comparison/new-factorial
node experiments/runtime-comparison/run.mjs --market-epoch-ms "$comparison_epoch_ms" --seed-report artifacts/runtime-comparison/new-factorial/report.json --rounds 1 --count 287 --scenarios realtime --variants http:full,http:off,native:full,native:off --diagnostics --sample-stacks --v8-profile --engine-profile --output artifacts/runtime-comparison/new-profiles
node experiments/runtime-comparison/run.mjs --market-epoch-ms "$comparison_epoch_ms" --seed-report artifacts/runtime-comparison/new-factorial/report.json --rounds 3 --count 287 --scenarios realtime --variants native:off --diagnostics --output artifacts/runtime-comparison/new-observer
```
