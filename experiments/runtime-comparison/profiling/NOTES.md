# Native diagnostic stack sampling

This is an opt-in diagnostic for a **separate workload run**, after resource
controls have been measured. Importing it starts nothing and the comparison
runner has no profiling overhead until the parent explicitly calls it.
`/usr/bin/sample` inspects the selected processes and can perturb their timing,
CPU usage and energy. Do not combine its numbers with baseline measurements.

```js
import { snapshotProcessTree } from '../measurement/index.mjs'
import { capture, probeCapability } from './index.mjs'

// Optional independent check. This launches, samples and reaps only its own
// disposable CPU-burning Node child. Use a fresh private directory each time.
const capability = await probeCapability({ outputDirectory: '/absolute/path/probe' })
if (!capability.available) console.log(capability.status, capability.error)

// These roots MUST come from the comparison runner's still-live registered
// runtime and backend controllers, never from a user app or process-name search.
const snapshot = await snapshotProcessTree({ rootPids: [runtimePid], extraPids: [backendPid] })
const pids = snapshot.processes.filter(p => p.counters).map(p => p.pid)
const result = await capture({ snapshot, pids, durationSeconds: 3, intervalMS: 10,
  outputDirectory: '/absolute/path/isolated-capture' })
for (const process of result.processes) {
  console.log(process.pid, process.group, process.status, process.rawFile,
    process.identityAfter, process.analysis?.coverage, process.analysis?.rankedStacks)
}
```

`capture` requires a snapshot less than 30 seconds old and **explicit** PIDs
from that snapshot. It re-snapshots the same runtime/backend roots, requires
same-user membership, readable counters, matching PID birth identity and group,
checks the foreground process, and checks identity again after capture. It
refuses a foreground measurement tree or unknown frontmost PID. These checks
cannot establish who registered the roots: the caller must supply only roots
it owns. PID reuse between the final pre-check and attachment is an unavoidable
race with this command; the post-check cannot rule out a process that both
changed and exited before it. A post-check failure or disappearance is reported
as unverified, not silently presented as confirmed attribution. WebKit
responsibility attribution has the existing measurement helper's limitations;
new and short-lived processes can be missed. `focus` reports before/after
read-only observations; it neither requests nor changes focus and cannot detect
an intervening change. A user changing focus independently can also make the
comparison false.

Durations are integer 1–30 seconds, intervals integer 5–1000 milliseconds,
and each call permits at most 16 distinct PIDs. All selected processes start
concurrently, but not at identical instants. Each command has a duration plus
15-second timeout and 16 MiB stdout limit. Raw files are created exclusively
with owner-only permissions, so choose a new output directory for every call.
Incomplete files are retained; per-process status distinguishes permission
failure, timeout, output limit, command or output error, and invalid report.
No sudo, privilege escalation, GUI launch, automatic permission request, or
fallback sampling of other processes is used. Raw stacks and diagnostics may
contain paths or application data: keep them private. `probeCapability`
reports `available: false` and a failure status if attachment is denied or
unavailable; availability does not guarantee that all other owned targets can
be inspected.

Each successful report includes the complete parsed inclusive call tree and the
raw text file. `categories` and `rankedStacks` are weighted by **exclusive
terminal thread-observation counts**: a node contributes only its count minus
its direct children, so inclusive ancestors are not counted again. Rankings
exclude stacks with an apparent blocking leaf; their top 50 entries retain up
to the last 40 frames, with an omitted-ancestor count. The complete tree and
raw file retain the rest. A thread with inconsistent inclusive weights or an
unrecognized graph line is excluded and recorded in coverage errors. Counts
are not elapsed time or a share of CPU. They also need not sum to the number of
sampling intervals: each thread contributes independently.

Classification is a heuristic based on known symbols and the nearest specific
operation in a stack, with JS engine frames used only as a fallback. Categories
separate JSON/serialization, memory copy, transport/IPC, layout/style,
SVG/paint, JS/JSC/V8, GC, apparent idle/wait, other and unknown. Blocking
symbols are suggestive, not proof that every observation was asleep. An
unresolved terminal frame is always unknown even under a JS trampoline; some
JIT frames have no symbols and native stacks do not reliably reveal JS source
functions. Engine symbols can also cover runtime work other than executing JS.
`coverage` records thread-observation totals, unresolved leaves, stacks with
unresolved ancestors, excluded threads and truncated ranking entries. A missing
symbol may hide an operation or caller, and ranking is limited to captured
stacks and successful processes.

On this macOS `sample(1)` format, per-observation running state is not present:
blocked and running observations are mixed. Consequently `cpu.runningStateAvailable`
is false and `cpu.normalizedCategories` is null. The module never labels
non-wait observations as CPU samples or uses process CPU-counter totals to
invent a distribution. Use independently measured per-process CPU counters for
CPU/energy totals; they cannot validate per-stack percentages. GPU,
WindowServer and shared-process work are outside these PID captures.

Run the focused headless regressions and disposable-child capability check with
Node 24 (the sandbox records expensive operations and opens no application):

```sh
node scripts/test-sandbox.mjs command --allow-empty \
  --output experiments/runtime-comparison/profiling/.build/sandbox -- \
  node --test --test-concurrency=1 experiments/runtime-comparison/profiling/profiling.test.mjs
```
