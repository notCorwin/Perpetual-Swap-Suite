# macOS process measurement

`startSampling({ rootPids: [shellPid, backendPid], intervalMS: 1000, samples: [] })`
takes an initial sample, samples at a fixed 500 or 1000 ms cadence without
overlap, and takes a final sample when `await sampler.stop()` is called. The
returned object includes `samples`, `skippedSamples`, and the actual per-sample
monotonic times. The first PID is the shell; further PIDs are separate backend
roots. Alternatively pass `{rootPids: [shellPid, ...], extraPids: [backendPid, ...]}`
to specify multiple shell roots. `snapshotProcessTree({rootPids, extraPids})`
returns one snapshot. The helper is built once into ignored `.build/` and is
kept alive for the sampling session.

Each snapshot lists process identity, PPID, executable, argv where readable,
responsible PID where available, cumulative user/system CPU nanoseconds,
resident size and physical footprint in bytes. `totals.runtime`, `.backend`,
and `.combined` are sums over the live, readable processes in each group. If a
backend is also a descendant of a shell, the backend subtree is assigned to the
backend group once. `sample.interval` contains process-identity-aware CPU and
CPU-energy deltas from the preceding sample. Long counters that cannot be
represented safely as a JavaScript number are null in the numeric field and
remain available in its `...Exact` decimal-string companion.

`frontmostPid` is read through `NSWorkspace` with no application or window
creation. `frontmostIsRuntime` checks whether that PID belongs to the sampled
runtime tree. This is a periodic observation: it cannot prove a shell never
became active between samples. An inaccessible or exited requested root stops a
session, as does reuse of its PID for a different birth identity.

WebKit XPC processes can be children of launchd. The sampler adds a WebKit XPC
only if its responsible PID exactly matches a discovered process in the selected
tree, its UID matches, and its executable is a WebKit XPC service. The
responsibility function is a private, best-effort macOS API; it can be absent or
point to a launcher instead of the shell. A zero match does not prove WebKit is
accounted for. No process is selected by executable name alone.

RSS totals may double-count shared pages; physical footprint has different
accounting and should be interpreted separately. Polling cannot account for a
process that starts and exits between samples, or the final unsampled work of a
process that exits; `disappearedPids` and `unknownPids` expose known gaps.
Processes are read sequentially, not atomically. WindowServer, GPU, display,
I/O, and other shared system activity are outside process attribution.

On supported ARM64 systems the helper exposes Apple's **CPU-only** per-task
`ri_energy_nj` counter. It requires an advancing counter in a brief local
capability probe before reporting values. `interval.*.cpuEnergyJoules` divides
the counter delta by 1e9; `cpuWatts` divides nanojoules by elapsed nanoseconds.
These are not total app/device joules or watts, and no CPU/RSS-to-energy
conversion or Energy Impact score is used. Apple documents the CPU counter's
nanojoule units and context-switch granularity in [XNU Recount](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/doc/observability/recount.md),
and [the kernel's rusage implementation](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/osfmk/kern/bsd_kern.c)
shows the field assignment. Mach CPU time is converted with the host timebase.
`sudo -n powermetrics` was unavailable on the measured host, and its manual
also describes reported subsystem power as estimated.

A background-only regression and independent Node `process.cpuUsage()` CPU
calibration can be run with:

```sh
node scripts/test-sandbox.mjs command --allow-empty --output experiments/runtime-comparison/measurement/.build/sandbox -- node --test experiments/runtime-comparison/measurement/measurement.test.mjs
```
