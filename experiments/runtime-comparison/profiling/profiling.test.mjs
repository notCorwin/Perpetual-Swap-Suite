import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSample } from './parse.mjs'
import { capture, probeCapability } from './index.mjs'

const fixture = `Analysis of sampling node (pid 4321) every 10 milliseconds
Call graph:
    100 Thread_1: main
    + 100 start  (in dyld) + 2  [0x123]
    +   100 Builtins_JSEntry  (in node) + 10  [0x234]
    +     40 memcpy  (in libsystem_c.dylib) + 4  [0x345]
    +     20 v8::internal::JsonStringifier::Serialize()  (in node) + 4  [0x456]
    +     20 ???  (in <unknown binary>)  [0x567]
    +     20 v8::internal::Heap::CollectGarbage()  (in node) + 4  [0x678]
    +       15 v8::internal::RootVisitor::Visit()  (in node) + 3  [0x789]
    100 Thread_2: worker
      100 thread_start  (in libsystem_pthread.dylib) + 8  [0x111]
        100 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x222]

Total number in stack (recursive counted multiple, when >=5):
        100 Builtins_JSEntry  (in node)
`

test('parses exclusive stack weights without counting inclusive ancestors or waits as CPU', () => {
  const parsed = parseSample(fixture)
  assert.deepEqual(parsed.categories, { json_serialization: 20, memory_copy: 40, transport_ipc: 0, layout_style: 0,
    svg_paint: 0, js_execution: 0, garbage_collection: 20, idle_wait: 100, other: 0, unknown: 20 })
  assert.equal(parsed.coverage.totalThreadObservations, 200)
  assert.equal(parsed.coverage.attributedObservations, 200)
  assert.equal(parsed.coverage.symbolizedLeafObservations, 180)
  assert.equal(parsed.coverage.unknownLeafObservations, 20)
  assert.equal(parsed.cpu.normalizedCategories, null)
  assert.equal(parsed.cpu.runningStateAvailable, false)
  assert.equal(parsed.rankedStacks[0].observations, 40)
  assert.equal(parsed.rankedStacks[0].frames.at(-1).symbol, 'memcpy')
  assert.ok(parsed.rankedStacks.every(stack => stack.category !== 'idle_wait'))
})

test('recognizes distinct transport and rendering stacks and rejects inconsistent inclusive counts', () => {
  const text = `Call graph:
    10 Thread_1
    + 10 start  (in dyld) + 1  [0x1]
    +   3 WebCore::RenderBox::layout()  (in WebCore) + 1  [0x2]
    +   2 WebCore::SVGPath::paint()  (in WebCore) + 1  [0x3]
    +   2 IPC::Connection::sendMessage()  (in WebKit) + 1  [0x4]
    +   3 JSC::Interpreter::execute()  (in JavaScriptCore) + 1  [0x5]
    5 Thread_2
      5 start  (in dyld) + 1  [0x1]
        6 bad  (in other) + 1  [0x2]

Binary Images:
`
  const result = parseSample(text)
  assert.equal(result.categories.layout_style, 3)
  assert.equal(result.categories.svg_paint, 2)
  assert.equal(result.categories.transport_ipc, 2)
  assert.equal(result.categories.js_execution, 3)
  assert.equal(result.coverage.invalidThreadObservations, 5)
  assert.equal(result.coverage.attributedObservations, 10)
  assert.match(result.coverage.errors.join(' '), /Invalid inclusive weights/)
  const malformed = parseSample('Call graph:\n    1 Thread_1\n    + 1 start  (in dyld) + 1  [0x1]\n    ? unexpected frame\n')
  assert.equal(malformed.coverage.invalidThreadObservations, 1)
  assert.equal(malformed.coverage.attributedObservations, 0)
})

test('refuses arbitrary PID requests without a measurement snapshot', async () => {
  if (process.platform !== 'darwin') return
  await assert.rejects(capture({ pids: [process.pid], outputDirectory: '.' }), /measurement snapshot/)
})

test('probes sample on an owned disposable CPU child without changing focus', { timeout: 30000 }, async t => {
  if (process.platform !== 'darwin') return t.skip('macOS sample is required')
  const build = join(dirname(fileURLToPath(import.meta.url)), '.build')
  await mkdir(build, { recursive: true })
  const directory = await mkdtemp(join(build, 'capability-'))
  const probe = await probeCapability({ outputDirectory: directory, durationSeconds: 2, intervalMS: 10 })
  assert.ok(probe.result || probe.error, JSON.stringify(probe))
  if (!probe.available) {
    console.log(`Native sample unavailable: ${JSON.stringify(probe)}`)
    if (probe.status === 'permission_denied') return t.skip('macOS denied the independent sampling capability probe')
    assert.fail(`Capability probe failed: ${probe.status}`)
  }
  const report = probe.result.processes[0]
  assert.equal(report.status, 'ok')
  assert.equal(report.identityAfter, 'matched')
  assert.equal(probe.result.focus.unchanged, true, 'Foreground process changed during the isolated capability check')
  assert.ok((await readFile(report.rawFile, 'utf8')).includes('Call graph:'))
  assert.ok(report.analysis.coverage.attributedObservations > 0)
  assert.ok(report.analysis.coverage.symbolizedLeafObservations > 0)
  assert.equal(report.analysis.cpu.normalizedCategories, null)
  console.log(`Native sample capability: ${report.rawFile}; observations=${report.analysis.coverage.attributedObservations}, unknown leaves=${report.analysis.coverage.unknownLeafObservations}, focus unchanged=${probe.result.focus.unchanged}`)
})
