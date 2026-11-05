# Shared backend optimization

## Scope

Keep Electron, the frontend, native intake cadence and complete operation recording unchanged for every performance control. This investigation optimizes the production Node services, not the runtime container or UI. Sources were frozen into `artifacts/backend-optimization/baseline-source` from `efd6643a` and an optimized copy with only the shared backend changes overlaid. The exact per-file hashes in each raw report identify the measured implementation. Concurrent changes to the daily tracing policy are deliberately excluded from these copies and their savings are not credited here.

Reuse the closed 287-contract, 384-candle, three-period seed from the earlier attribution experiment, with the same fixed virtual market epoch. Every trial checks the full-series indicator oracle, source cardinality, all contracts' final prices, every selected chart live tick, and every individually acknowledged interaction. Full lifecycle journals must close with no missing, omitted, undurable, pending or malformed records. Existing native sampler and nonfocusable background-only Electron window guards are retained. The controlled visible-page override and RAF acknowledgment measure scheduling/DOM correctness, not physical screen presentation.

The native comparison bridge is held fixed around the production backend and built production frontend. It is an experimental controller, not the packaged application's Electron-main gateway. Actual OKX networking, GPU/display/whole-device energy and physical input/presentation latency are outside this comparison. The final installed app receives separate integration and packaging verification.

## Changes and validity rules

1. Jobs and failures are indexed by series and source. Status queries with no matching failures do not plan missing history just to search an empty failure set. The latest overlapping failure and retry decisions are evaluated fresh, including focus, source epoch and current input version.
2. Missing-range plans reuse immutable intermediate results. Keys include the exact source/window and resident row-map identity; active task-group identity and membership revision fence task add/remove/cancel/replacement. Actual row mutations invalidate intersecting windows, optionally only the changed statistic family. The earliest relevant empty-statistic expiry limits reuse. A backward wall-clock adjustment forces recomputation. Each resident holds at most 12 plans and 256 gap spans; plans that exceed the span bound are not retained. No elapsed-time polling or new network acquisition is introduced.
3. Status equality compares scalar data directly instead of repeatedly encoding JSON. Indicator recursive prefixes are immutable and shared by resident/history owners. A confirmed append copies only the bounded mutable accumulators once per distinct prefix and source row; all owners reuse the successor. Corrections invalidate the affected generation. Worker messages already transfer owned checkpoint copies, so the replay worker no longer clones that checkpoint a second time.
4. Preference validation admits deeply frozen, module-owned snapshots. Only proven snapshots bypass validation/copying; mutable inputs and foreign frozen objects must be validated again. A settings update produces a new snapshot. Liquidity configuration encodings are weakly keyed only by admitted immutable configuration identity, so obsolete snapshots are released and changed settings immediately receive a new key. The exported TypeScript contract expresses the immutable return value.
5. Worker notifications follow actual event listeners. The desktop attaches listeners before a window loads and detaches them on window destruction or renderer loss; reload attaches them again. Reconnection creates a fresh chart compactor, requiring a complete first frame. Intake, database writes, universe preparation and all active consumers remain intact. All universe series have real frontend consumers, so active-window notifications are deliberately retained.

## Measurements

The first four-scenario baseline and the intermediate gap/prefix-only control are exploratory. That single control did not establish a large CPU-time saving: its realtime backend CPU time changed by about -2.9%, with noticeably variable per-task energy. It motivated further investigation rather than an energy claim.

A separate diagnostic counter run (`diagnostic-before-final`) found, after the first forming update and before disposal: 103,456 missing-range calls, 9,931,776 resident-row lookups and 70,256 structured clones. Startup counted another 3,502 clones. Most live clones came from repeated preference validation, not indicator prefix copying. Probe wall times are inclusive observer-perturbed observations and are not function CPU costs. Earlier `diagnostic-before`, `-v2` and `-v3` attempts only captured the parent observer and are excluded from work-reduction evidence.

The [separate work evidence](results/backend-work-2026-11-06.json) retains both complete counter snapshots and raw hashes. The final diagnostic made 132 missing-range calls with **zero resident-row lookups** during the live phase: these were reused plans, not newly scanned windows. Live structured clones fell to 39, and startup clones to 40. Both diagnostics still admitted 51,660 live updates and built 51,668 published frames; active frame construction was not suppressed. These counts demonstrate removed work, while only the uninstrumented pairs establish measured resource changes.

The final energy series uses three realtime pairs in AB/BA/AB order, with 60 updates at 500 ms and 152 search inputs at 200 ms per trial. Probe, V8, engine and native stack profilers are explicitly disabled. `backend-analysis.mjs` rejects probes, unknown probe provenance, unequal frontend/fixture hashes, input targets, live expected values, source size/cadence, incomplete recording, missing interactions, insufficient RAF cadence or incomplete CPU/energy coverage.

The [committed paired evidence](results/backend-optimization-2026-11-06.json) contains raw report hashes, deduplicated per-file source manifests, each trial's coverage/latency/recording checks and the independently computed aggregates:

| Metric | Median paired change | Three-pair range |
| --- | ---: | ---: |
| Shared backend CPU seconds | -8.91% | -10.05% to -8.09% |
| Shared backend CPU energy | -21.57% | -23.00% to -20.95% |
| Combined runtime + backend CPU seconds | -3.88% | -5.18% to -3.53% |
| Combined runtime + backend CPU energy | -18.31% | -19.57% to -18.18% |
| Runtime CPU seconds | +2.69% | +1.66% to +2.99% |

All six trials committed all 60 live ticks and all 152 search inputs, with zero replay mismatch, missing/coalesced live ticks or recording omissions. Active consumers still received exactly 51,660 chart notifications and 61 market notifications in each trial (about 62.5 MB chart JSON). Hence the active-window gains do not come from suppressing fanout or reducing refresh rate. Runtime CPU time did not improve; total per-task CPU energy changed by a larger percentage than CPU seconds, so neither metric should substitute for the other.

Search p95 across trials ranged from 25.0–33.5 ms before and 25.5–34.1 ms after. Source-to-RAF p95 ranged from 9.77–21.40 ms before and 15.23–20.36 ms after. Direction varies by pair: these controls establish preserved complete realtime/interaction delivery, not an independent latency improvement or equivalence test. In particular, the second pair's search p95 increased about 4.8 ms, and some source-to-RAF p95 values increased with frame-phase alignment. No target missed its 200 ms input cadence.

Results are descriptive measurements on an active desktop, not statistical significance or a prediction for other computers and network loads. CPU energy is the existing per-task counter; it does not include disk, GPU, display or shared-system energy. Complete operation records are retained; generated work counts can legitimately differ when redundant operations disappear, but omitted-record counts may not.

Final review additionally hardened snapshot admission against getters that change between caller validation and structured cloning: the owned clone is validated before entering the trusted set. That boundary-only correctness fix came after the measured snapshots; final tests verify it. The performance numbers identify the measured hashes and are not an exact measurement of the final packaged binary. No measured workload contained such an accessor.

## Recording and next priorities

Existing recorder health data already shows one-time event serialization, bounded queues/spill, batched compression/writes, shared flush barriers and unchanged-state durability reuse. Across six historical full Electron controls, complete-trial batch building used roughly 0.96–1.10 seconds of summed thread CPU; health commits used roughly 0.16–0.22 seconds. These bulk stages do not include all admission, timing, import or hashing work. Removing unused notification transfers avoids their generation, import and persistence work without dropping records of operations that actually occur.

This patch preserves the recorder's format, 128-event renderer trigger, 250 ms timer, durability checkpoints, error reporting and flush/close contract. Rewriting the durable writer or delaying acknowledgments is not justified before the measured redundant business work. Remaining active-universe frame construction and transport have real consumers. Any future reduction needs a smaller correct data contract and independent proof, rather than suppressing updates or completeness checks.

## Validation and review

The final targeted sandbox run passed 284 tests across prepared-source caching, prepared-chart replay/cancellation/candidates, backend persistence/subscription ownership, metadata/preferences, market-service behavior and offline analysis guards. Type checking and lint checks passed (lint reports existing UI warnings). All tests remained headless/background-only. The optimized four-scenario spot check also passed idle, realtime, 100 history inputs and the finite 12,240-row archive download with complete journals. It is a functional spot check, not a replicated four-scenario energy estimate.

Independent reviews audited row/task cache invalidation, recursive ownership, notification lifecycle, configuration trust and paired analysis. They caught clock rollback, changing-accessor admission and probe/cross-scenario analysis gaps; these were fixed. A separate reviewer reproduced all six report hashes, identical frontend/fixture fingerprints and the aggregate values. Test pruning retained the new regressions because each detects a distinct future failure; an obsolete clone-identity assertion was replaced by prefix immutability and mathematical output checks. Packaged-app integration and installation are coordinated with the separate tracing-policy change after these frozen measurements.

## Reproduction

Use Node 24.22, a new output directory for every trial, the same closed seed/market epoch, identical built `dist` and the exact source revisions listed in the committed result. The sampler starts no foreground window.

```sh
node experiments/runtime-comparison/run.mjs --runtime electron --rounds 1 --count 287 \
  --scenarios realtime --variants native:full --market-epoch-ms "$epoch" \
  --seed-report "$seed_report" --output "$new_output"

# Separate diagnostic only; never include its resources in energy pairs.
node experiments/runtime-comparison/run.mjs --runtime electron --rounds 1 --count 287 \
  --scenarios realtime --variants native:full --backend-work-probe \
  --market-epoch-ms "$epoch" --seed-report "$seed_report" --output "$diagnostic_output"

node experiments/runtime-comparison/backend-analysis.mjs result.json \
  before-1/report.json after-1/report.json \
  before-2/report.json after-2/report.json \
  before-3/report.json after-3/report.json
```
