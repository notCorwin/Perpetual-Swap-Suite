import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isOperationJournal, operationJournalExecutionId, readOperationJournal } from '../../electron/services/operation-journal.js'

const runtime = new URL('../../electron/services/operation-runtime.js', import.meta.url).href
const operations = new URL('../../electron/services/operations.js', import.meta.url).href
const network = new URL('../../electron/services/sandbox-network.js', import.meta.url).href
const sessionId = 'operation-runtime-regression'

async function execute(directory, source, environment = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, ...environment, PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_SESSION: sessionId },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16_384) })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Recorder child failed (${code ?? signal}): ${diagnostics}`)))
  })
  const files = (await readdir(directory)).filter(isOperationJournal)
  return Promise.all(files.map(async file => {
    const chunks = []
    for await (const chunk of readOperationJournal(join(directory, file))) chunks.push(chunk)
    const decoded = Buffer.concat(chunks)
    return {
      decoded,
      events: decoded.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
      health: JSON.parse(await readFile(join(directory, `${operationJournalExecutionId(file)}.health.json`), 'utf8')),
    }
  }))
}

test('pressure writes preserve event order, retry short writes, and close drains records admitted while flushing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-order-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      // Simulate legal short file writes in both persistence paths.
      const write = fs.write, writeSync = fs.writeSync;
      fs.write = (fd, buffer, offset, length, position, callback) => write(fd, buffer, offset, Math.min(length, 97), position, callback);
      fs.writeSync = (...args) => {
        if (Buffer.isBuffer(args[1])) args[3] = Math.min(args[3], 4096);
        return writeSync(...args);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation, attachOperationJournalSink } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      // Later observers may mutate events; an admitted record keeps its snapshot.
      attachOperationJournalSink(event => {
        if (event.name === 'runtime.ordered') {
          event.attributes.count = -1;
          event.resource = 'mutated-after-admission';
        }
      });
      const emit = count => measureOperation({ category: 'cpu', name: 'runtime.ordered', resource: '界'.repeat(256), attributes: { count } }, () => {});
      emit(0);
      const initialFlush = recording.flush();
      for (let index = 1; index <= 1600; index++) emit(index);
      await initialFlush;
      const closing = recording.close();
      emit(1601);
      assert.equal(recording.close(), closing, 'Concurrent close calls share their completion barrier.');
      await closing;
    `)
    assert.equal(recordings.length, 1)
    const { events, health, decoded } = recordings[0]
    assert.equal(decoded.toString('utf8'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'Every snapshot has exactly one JSONL delimiter, including across pressure batches.')
    assert.equal(health.uncompressedBytes, decoded.length, 'The byte total includes UTF-8 Unicode and every newline.')
    assert.deepEqual(events.filter(event => event.phase === 'end' && event.name === 'runtime.ordered').map(event => event.attributes.count), Array.from({ length: 1602 }, (_, index) => index))
    assert.ok(events.every(event => event.sessionId === sessionId))
    assert.ok(events.filter(event => event.name === 'runtime.ordered').every(event => event.resource === '界'.repeat(256)))
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.equal(health.recorded, events.length)
    assert.equal(events.filter(event => event.phase === 'end' && event.name === 'runtime.ordered').length, 1602)
    assert.equal(health.persisted, events.length)
    assert.equal(health.failed, 0)
    assert.equal(health.pending, 0)
    assert.equal(health.closed, true)
    assert.equal(health.durableRecords, events.length)
    assert.ok(health.journalBytes < health.uncompressedBytes / 5, 'The journal retains every Unicode record while bounding repeated JSON storage overhead.')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reentrant observations preserve sequence order when serialization crosses a pressure drain and flush', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-reentrant-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), stringify = JSON.stringify;
      const flushes = [];
      let interrupted = false;
      JSON.stringify = (value, ...args) => {
        if (!interrupted && value?.name === 'runtime.interrupted' && value.phase === 'end') {
          interrupted = true;
          for (let count = 0; count < 200; count++) measureOperation({ category: 'cpu', name: 'runtime.reentrant', resource: '界'.repeat(256), attributes: { count } }, () => {});
          flushes.push(recording.flush());
        }
        return stringify(value, ...args);
      };
      measureOperation({ category: 'cpu', name: 'runtime.interrupted' }, () => {});
      JSON.stringify = stringify;
      assert.equal(interrupted, true);
      await Promise.all(flushes);
      await recording.close();
    `)
    const { events, health } = recordings[0]
    assert.ok(health.uncompressedBytes > 256 * 1024, 'The nested observations exceed a real pressure batch.')
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.deepEqual(events.filter(event => event.name === 'runtime.reentrant' && event.phase === 'end').map(event => event.attributes.count), Array.from({ length: 200 }, (_, index) => index))
    assert.equal(health.failed, 0)
    assert.equal(health.recorded, events.length)
    assert.equal(health.durableRecords, events.length)
    const { summarizeOperations, operationReportHasFailures } = await import('../../scripts/operation-report.mjs')
    assert.equal(operationReportHasFailures(await summarizeOperations(directory)), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('later sequences admitted before an interrupted observation wait for its contiguous prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-before-admission-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), writer = recording.writers.get(recording.executionId), enqueue = writer.enqueue;
      const flushes = [];
      let interrupted = false;
      writer.enqueue = entry => {
        if (!interrupted && entry.name === 'runtime.before-admission' && entry.phase === 'end') {
          interrupted = true;
          for (let count = 0; count < 200; count++) measureOperation({ category: 'cpu', name: 'runtime.admitted-first', resource: '界'.repeat(256), attributes: { count } }, () => {});
          flushes.push(recording.flush());
        }
        return enqueue(entry);
      };
      measureOperation({ category: 'cpu', name: 'runtime.before-admission' }, () => {});
      assert.equal(interrupted, true);
      await Promise.all(flushes);
      await recording.close();
    `)
    const { events, decoded, health } = recordings[0]
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.deepEqual(events.filter(event => event.name === 'runtime.admitted-first' && event.phase === 'end').map(event => event.attributes.count), Array.from({ length: 200 }, (_, index) => index))
    assert.equal(decoded.toString('utf8'), `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'No reserved slot can become a blank JSONL line.')
    assert.equal(health.recorded, events.length)
    assert.equal(health.durableRecords, events.length)
    const { summarizeOperations, operationReportHasFailures } = await import('../../scripts/operation-report.mjs')
    assert.equal(operationReportHasFailures(await summarizeOperations(directory)), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('independent observations arriving during batch encoding are retained in the next complete batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-encoding-reentry-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import zlib from 'node:zlib';
      import { AsyncResource } from 'node:async_hooks';
      import { syncBuiltinESMExports } from 'node:module';
      let armed = false, interrupted = false, measureOperation;
      const independent = new AsyncResource('independent-operation-observer');
      for (const key of ['gzipSync', 'brotliCompressSync']) {
        const original = zlib[key];
        zlib[key] = (...args) => {
          if (armed) {
            armed = false; interrupted = true;
            independent.runInAsyncScope(() => {
              for (let count = 0; count < 200; count++) measureOperation({ category: 'cpu', name: 'runtime.during-encoding', resource: '界'.repeat(256), attributes: { count } }, () => {});
            });
          }
          return original(...args);
        };
      }
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      ({ measureOperation } = await import(${JSON.stringify(operations)}));
      const recording = initializeOperationRecording();
      armed = true;
      for (let count = 0; count < 200; count++) measureOperation({ category: 'cpu', name: 'runtime.before-encoding', resource: '界'.repeat(256), attributes: { count } }, () => {});
      await recording.close();
      independent.emitDestroy();
      assert.equal(interrupted, true);
    `)
    const { events, decoded, health } = recordings[0]
    for (const name of ['runtime.before-encoding', 'runtime.during-encoding']) assert.deepEqual(events.filter(event => event.name === name && event.phase === 'end').map(event => event.attributes.count), Array.from({ length: 200 }, (_, index) => index))
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.uncompressedBytes, decoded.length)
    assert.equal(health.failed, 0)
    const { summarizeOperations, operationReportHasFailures } = await import('../../scripts/operation-report.mjs')
    assert.equal(operationReportHasFailures(await summarizeOperations(directory)), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed reentrant serialization preserves other records and permanently fails recorder health', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-serialization-failure-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), stringify = JSON.stringify;
      JSON.stringify = (value, ...args) => {
        if (value?.name === 'runtime.serialization-failure' && value.phase === 'end') {
          measureOperation({ category: 'cpu', name: 'runtime.admitted-during-failure' }, () => {});
          throw new Error('Injected serialization failure');
        }
        return stringify(value, ...args);
      };
      measureOperation({ category: 'cpu', name: 'runtime.serialization-failure' }, () => {});
      JSON.stringify = stringify;
      measureOperation({ category: 'cpu', name: 'runtime.after-serialization-failure' }, () => {});
      await assert.rejects(recording.flush(), /did not complete/);
      await assert.rejects(recording.close(), /did not close cleanly/);
    `)
    const { events, health } = recordings[0]
    assert.equal(events.filter(event => event.name === 'runtime.serialization-failure' && event.phase === 'end').length, 0)
    for (const name of ['runtime.admitted-during-failure', 'runtime.after-serialization-failure']) assert.deepEqual(events.filter(event => event.name === name).map(event => event.phase), ['start', 'end'])
    assert.equal(health.failed, 1)
    assert.equal(health.sourceFailures, 1)
    assert.equal(health.omittedRecords, 1)
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.pending, 0)
    assert.equal(health.closed, true)
    const { summarizeOperations, operationReportHasFailures } = await import('../../scripts/operation-report.mjs')
    assert.equal(operationReportHasFailures(await summarizeOperations(directory)), true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('repeated durable flushes of unchanged journals do no additional disk synchronization or metadata writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-clean-'))
  try {
    await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const fdatasync = fs.fdatasync, writeFileSync = fs.writeFileSync, writeFile = fs.writeFile;
      let synchronizations = 0, healthWrites = 0;
      fs.fdatasync = (...args) => { synchronizations++; return fdatasync(...args) };
      fs.writeFileSync = (path, ...args) => { if (String(path).endsWith('.health.json')) healthWrites++; return writeFileSync(path, ...args) };
      fs.writeFile = (path, ...args) => { if (String(path).endsWith('.health.json')) healthWrites++; return writeFile(path, ...args) };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'runtime.one-real-operation' }, () => 42);
      await recording.flush();
      const expected = { synchronizations, healthWrites };
      await Promise.all([recording.flush(), recording.flush(), recording.flush()]);
      assert.deepEqual({ synchronizations, healthWrites }, expected, 'An unchanged durability high-water mark must reuse its proof.');
      measureOperation({ category: 'cpu', name: 'runtime.changed-operation' }, () => 43);
      await recording.flush();
      assert.ok(synchronizations > expected.synchronizations);
      assert.ok(healthWrites > expected.healthWrites);
      await recording.close();
    `)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('recorder self-timing attributes delayed bulk stages without recursive records or redundant health writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-self-timing-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import zlib from 'node:zlib';
      import { syncBuiltinESMExports } from 'node:module';
      const waiting = new Int32Array(new SharedArrayBuffer(4));
      const delay = () => Atomics.wait(waiting, 0, 0, 12);
      let encodeDelay = false, writeDelay = false, healthDelay = false, healthWrites = 0;
      const compress = zlib.brotliCompressSync, write = fs.write, writeFile = fs.writeFile;
      zlib.brotliCompressSync = (...args) => { if (encodeDelay) { encodeDelay = false; delay() } return compress(...args) };
      fs.write = (...args) => { if (writeDelay) { writeDelay = false; setTimeout(() => write(...args), 15) } else write(...args) };
      fs.writeFile = (path, ...args) => {
        if (String(path).endsWith('.health.json')) {
          healthWrites++;
          if (healthDelay) { healthDelay = false; setTimeout(() => writeFile(path, ...args), 15); return }
        }
        writeFile(path, ...args);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation, withOperationSuppressed } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      encodeDelay = writeDelay = healthDelay = true;
      for (let count = 0; count < 200; count++) measureOperation({ category: 'cpu', name: 'runtime.self-timing', resource: '界'.repeat(256), attributes: { count } }, () => {});
      await recording.flush();
      assert.equal(encodeDelay || writeDelay || healthDelay, false, 'Every controlled bulk path must actually execute.');
      const live = recording.health().selfTiming;
      for (const stage of ['batch-build', 'journal-write-wait', 'health-publish-wait']) {
        assert.ok(live.slowSamples.some(sample => sample.stage === stage && sample.durationMS >= 12), stage);
      }
      const published = withOperationSuppressed(() => JSON.parse(fs.readFileSync(${JSON.stringify(directory)} + '/' + recording.executionId + '.health.json', 'utf8'))).selfTiming;
      assert.equal(live.stages['health-publish-wait'].count, (published.stages['health-publish-wait']?.count ?? 0) + 1,
        'A persisted publication cannot include its own unfinished measurement.');
      const writes = healthWrites;
      await Promise.all([recording.flush(), recording.flush(), recording.flush()]);
      assert.equal(healthWrites, writes, 'Unpublished diagnostic progress must not invalidate the durable proof.');
      await recording.close();
    `)
    const { events, health } = recordings[0]
    assert.deepEqual(events.filter(event => event.name === 'runtime.self-timing' && event.phase === 'end').map(event => event.attributes.count), Array.from({ length: 200 }, (_, index) => index))
    assert.equal(events.some(event => ['batch-build', 'journal-write-wait', 'health-publish-wait'].includes(event.name)), false)
    assert.equal(health.failed, 0)
    assert.equal(health.pending, 0)
    assert.equal(health.recorded, events.length)
    assert.equal(health.durableRecords, events.length)
    for (const stage of ['batch-build', 'journal-write-wait', 'health-publish-wait']) assert.ok(health.selfTiming.slowSamples.some(sample => sample.stage === stage && sample.durationMS >= 12), stage)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('persisted health reflects hook replacement and recovery without new records and retains complete durable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-health-readback-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { join } from 'node:path';
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation, withOperationSuppressed } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), readFile = fs.readFileSync;
      const path = join(${JSON.stringify(directory)}, recording.executionId + '.health.json');
      const readHealth = () => withOperationSuppressed(() => JSON.parse(readFile(path, 'utf8')));
      measureOperation({ category: 'cpu', name: 'fixture.health-state' }, () => 42);
      const before = Date.now();
      await recording.flush();
      const initial = readHealth();
      assert.ok(initial.updatedAt >= before && initial.updatedAt <= Date.now());
      assert.equal(initial.durableRecords, initial.recorded);
      assert.equal(initial.pending, 0);
      assert.equal(initial.failed, 0);
      assert.equal(initial.hookCapabilities.find(value => value.api === 'fs.readFileSync').enabled, true);
      assert.ok(initial.enabledHooks.includes('filesystem'));
      fs.readFileSync = (...args) => Reflect.apply(readFile, fs, args);
      await recording.flush();
      const replaced = readHealth();
      assert.equal(replaced.recorded, initial.recorded);
      assert.equal(replaced.hookCapabilities.find(value => value.api === 'fs.readFileSync').enabled, false);
      assert.equal(replaced.enabledHooks.includes('filesystem'), false);
      fs.readFileSync = readFile;
      await recording.flush();
      const restored = readHealth();
      assert.equal(restored.recorded, initial.recorded);
      assert.equal(restored.hookCapabilities.find(value => value.api === 'fs.readFileSync').enabled, true);
      assert.ok(restored.enabledHooks.includes('filesystem'));
      await recording.close();
      const persisted = readHealth(), live = recording.health();
      const durableState = ({ updatedAt, selfTiming, ...state }) => state;
      assert.deepEqual(durableState(persisted), durableState(live));
      assert.equal(live.selfTiming.stages['health-publish-wait'].count, (persisted.selfTiming.stages['health-publish-wait']?.count ?? 0) + 1,
        'The final health publication remains observable in live timing without recursively publishing itself.');
      assert.equal(persisted.closed, true);
    `)
    assert.equal(recordings.length, 1)
    assert.equal(recordings[0].health.recorded, recordings[0].events.length)
    assert.equal(recordings[0].health.durableRecords, recordings[0].events.length)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('close joins overlapping durability flushes before releasing the journal descriptor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-flush-close-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const fdatasync = fs.fdatasync;
      let calls = 0;
      fs.fdatasync = (descriptor, callback) => {
        if (++calls === 1) setTimeout(() => fdatasync(descriptor, callback), 100);
        else fdatasync(descriptor, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'fixture.before-flush' }, () => 1);
      const flushing = recording.flush();
      const closing = recording.close();
      measureOperation({ category: 'cpu', name: 'fixture.admitted-during-close' }, () => 2);
      const overlapping = recording.flush();
      await Promise.all([flushing, closing, overlapping]);
      assert.equal(recording.health().failed, 0);
      assert.equal(recording.health().pending, 0);
      assert.equal(recording.health().closed, true);
    `)
    assert.equal(recordings.length, 1)
    assert.equal(recordings[0].health.failed, 0)
    assert.equal(recordings[0].health.closed, true)
    for (const name of ['fixture.before-flush', 'fixture.admitted-during-close']) {
      assert.equal(recordings[0].events.filter(event => event.name === name && event.phase === 'end').length, 1)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('health-file write failure rejects flush and remains visible after orderly descriptor closure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-health-failure-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const writeFile = fs.writeFile;
      let rejectHealth = false;
      fs.writeFile = (path, ...args) => {
        if (rejectHealth && String(path).endsWith('.health.json')) {
          rejectHealth = false;
          const callback = args.at(-1);
          queueMicrotask(() => callback(Object.assign(new Error('Injected health failure'), { code: 'ENOSPC' })));
          return;
        }
        return writeFile(path, ...args);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'fixture.health-failure' }, () => 1);
      rejectHealth = true;
      await assert.rejects(recording.flush(), /Injected health failure/);
      assert.equal(recording.health().failed, 1);
      await assert.rejects(recording.close(), /did not close cleanly/);
      assert.equal(recording.health().closed, true);
    `)
    assert.equal(recordings[0].health.failed, 1)
    assert.equal(recordings[0].health.pending, 0)
    assert.equal(recordings[0].health.closed, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a closed renderer journal rejects late imports without acknowledging dropped records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-closed-import-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      const { initializeOperationRecording, registerOperationParticipant, claimExternalOperationParticipant, closeExternalOperationSource } = await import(${JSON.stringify(runtime)});
      const { importOperationEvents } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      const participant = registerOperationParticipant('renderer');
      const executionId = 'renderer-late-' + process.pid;
      const identity = claimExternalOperationParticipant(participant.id, executionId);
      assert.equal(identity.scenarioId, 'late-import-scenario');
      await closeExternalOperationSource(executionId);
      const result = importOperationEvents([{ schemaVersion: 2, ...identity,
        phase: 'start', id: executionId + ':1', traceId: executionId + ':1', sequence: 1,
        category: 'cpu', name: 'renderer.late', startedAt: Date.now(), durationMS: 0, status: 'running', attributes: {} }]);
      assert.equal(result.accepted, 0, 'A dropped record must never become an acknowledged renderer sequence.');
      assert.equal(result.rejected, 1);
      await assert.rejects(recording.flush(), /did not complete/);
      await assert.rejects(recording.close(), /did not close cleanly/);
      const health = recording.writers.get(executionId).health();
      assert.equal(health.recorded, 0);
      assert.equal(health.persisted, 0);
      assert.equal(health.sourceFailures, 1);
      assert.equal(health.omittedRecords, 1);
      assert.equal(health.failed, 0, 'A rejected source handoff is distinct from disk failure.');
    `, { PERPETUAL_SWAP_OPERATION_SCENARIO: 'late-import-scenario' })
    const external = recordings.find(value => value.health.role === 'renderer')
    assert.equal(external.events.length, 0)
    assert.equal(external.health.sourceFailures, 1)
    assert.equal(external.health.closed, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renderer close freezes admission while durability flush is still pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-closing-import-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const fdatasync = fs.fdatasync;
      let signalSyncStarted, releaseSync;
      const syncStarted = new Promise(resolve => { signalSyncStarted = resolve });
      const syncReleased = new Promise(resolve => { releaseSync = resolve });
      let delayed = false;
      fs.fdatasync = (descriptor, callback) => {
        if (!delayed) {
          delayed = true;
          signalSyncStarted();
          void syncReleased.then(() => fdatasync(descriptor, callback));
        } else fdatasync(descriptor, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording, registerOperationParticipant, claimExternalOperationParticipant, closeExternalOperationSource } = await import(${JSON.stringify(runtime)});
      const { importOperationEvents } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      const participant = registerOperationParticipant('renderer');
      const executionId = 'renderer-closing-' + process.pid;
      const identity = claimExternalOperationParticipant(participant.id, executionId);
      const base = { schemaVersion: 2, ...identity, id: executionId + ':1', traceId: executionId + ':1',
        category: 'cpu', name: 'renderer.before-close', startedAt: Date.now(), attributes: {} };
      assert.equal(importOperationEvents([
        { ...base, phase: 'start', sequence: 1, durationMS: 0, status: 'running' },
        { ...base, phase: 'end', sequence: 2, durationMS: 1, status: 'ok' },
      ]).accepted, 2);
      const closing = closeExternalOperationSource(executionId);
      await syncStarted;
      assert.equal(recording.writers.get(executionId).health().closed, false, 'The descriptor remains open while its durability barrier is pending.');
      const result = importOperationEvents([{ ...base, id: executionId + ':2', phase: 'start', sequence: 3,
        durationMS: 0, status: 'running', name: 'renderer.after-close-started' }]);
      assert.equal(result.accepted, 0);
      assert.equal(result.rejected, 1);
      releaseSync();
      await assert.rejects(closing, /did not complete/);
      await assert.rejects(recording.close(), /did not close cleanly/);
    `)
    const external = recordings.find(value => value.health.role === 'renderer')
    assert.equal(external.events.length, 2, 'Already admitted operations drain; post-close records do not enter the journal.')
    assert.equal(external.health.recorded, 2)
    assert.equal(external.health.persisted, 2)
    assert.equal(external.health.activeOperations, 0)
    assert.equal(external.health.sourceFailures, 1)
    assert.equal(external.health.omittedRecords, 1)
    assert.equal(external.health.closed, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('parent and concurrent workers share a session with separate complete execution journals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-session-'))
  try {
    const workerSource = `
      import { workerData } from 'node:worker_threads';
      import { initializeOperationRecording } from ${JSON.stringify(runtime)};
      import { measureOperation } from ${JSON.stringify(operations)};
      const recording = initializeOperationRecording();
      for (let count = 0; count < 40; count++) measureOperation({ category: 'cpu', name: 'runtime.worker', attributes: { count, threadId: workerData } }, () => {});
      await recording.close();
    `
    const recordings = await execute(directory, `
      import { Worker } from 'node:worker_threads';
      import { initializeOperationRecording } from ${JSON.stringify(runtime)};
      import { measureOperation } from ${JSON.stringify(operations)};
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'runtime.parent' }, () => {});
      await Promise.all([1, 2].map(workerData => new Promise((resolve, reject) => {
        const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(${JSON.stringify(workerSource)})), { workerData });
        worker.once('error', reject);
        worker.once('exit', code => code === 0 ? resolve() : reject(new Error('Worker exited: ' + code)));
      })));
      await recording.close();
    `)
    assert.equal(recordings.length, 3)
    const events = recordings.flatMap(recording => recording.events).filter(event => event.phase === 'end' && ['runtime.worker', 'runtime.parent'].includes(event.name))
    assert.equal(events.length, 81)
    assert.equal(new Set(events.map(event => event.executionId)).size, 3)
    assert.equal(new Set(events.map(event => event.id)).size, 81)
    assert.ok(events.every(event => event.sessionId === sessionId))
    assert.equal(events.filter(event => event.name === 'runtime.parent').length, 1)
    for (const threadId of [1, 2]) assert.deepEqual(events.filter(event => event.attributes.threadId === threadId).map(event => event.attributes.count), Array.from({ length: 40 }, (_, index) => index))
    for (const { events: execution, health } of recordings) {
      assert.equal(health.recorded, execution.length)
      assert.equal(health.persisted, execution.length)
      assert.equal(health.failed, 0)
      assert.equal(health.pending, 0)
      assert.equal(health.closed, true)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('sandbox blocks external transports before construction, permits loopback fixtures, and rejects external redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-runtime-network-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      let socketConstructions = 0;
      const NativeSocket = globalThis.WebSocket;
      globalThis.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
        socketConstructions++;
        return Reflect.construct(target, args, target);
      } });
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { assertSandboxURL } = await import(${JSON.stringify(network)});
      const recording = initializeOperationRecording();
      const blocked = error => error.code === 'SANDBOX_NETWORK_BLOCKED';
      await assert.rejects(globalThis.fetch('https://sandbox-no-outbound.invalid/api'), blocked);
      assert.throws(() => new globalThis.WebSocket('wss://sandbox-no-outbound.invalid/feed'), blocked);
      assert.equal(socketConstructions, 0, 'A blocked WebSocket never invokes the native transport constructor.');
      assert.throws(() => assertSandboxURL('http://user:private@127.0.0.1/'), blocked);
      assert.doesNotThrow(() => assertSandboxURL('http://[::1]/'));
      const requests = [];
      const server = createServer((request, response) => {
        requests.push(request.url);
        if (request.url === '/redirect') response.writeHead(302, { Location: 'https://sandbox-no-outbound.invalid/redirected' }).end();
        else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ fixture: true }));
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        const origin = 'http://127.0.0.1:' + server.address().port;
        const response = await globalThis.fetch(origin + '/fixture');
        assert.deepEqual(await response.json(), { fixture: true });
        await assert.rejects(globalThis.fetch(origin + '/redirect'), error => error.name === 'TypeError');
        assert.deepEqual(requests, ['/fixture', '/redirect']);
      } finally { await new Promise(resolve => server.close(resolve)); }
      // Verify the explicit gate without making any live external request.
      process.env.PERPETUAL_SWAP_ALLOW_NETWORK = '1';
      assert.doesNotThrow(() => assertSandboxURL('https://sandbox-no-outbound.invalid/allowed'));
      process.env.PERPETUAL_SWAP_ALLOW_NETWORK = '0';
      assert.throws(() => assertSandboxURL('https://sandbox-no-outbound.invalid/blocked-again'), blocked);
      await recording.close();
    `, { PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_ALLOW_NETWORK: '0' })
    assert.equal(recordings.length, 1)
    assert.equal(recordings[0].health.closed, true)
    assert.equal(recordings[0].health.failed, 0)
    assert.equal(recordings[0].health.pending, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('pressure batches use bounded asynchronous writes and flush waits for the earlier prefix', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-async-pressure-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync, write = fs.write, writeSync = fs.writeSync;
      let journalFD, armed = false, synchronousWrites = 0;
      const held = [];
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).endsWith('.jsonl.brj')) journalFD = fd; return fd };
      fs.writeSync = (fd, ...args) => { if (armed && fd === journalFD) synchronousWrites++; return writeSync(fd, ...args) };
      fs.write = (fd, buffer, offset, length, position, callback) => {
        if (armed && fd === journalFD) held.push({ fd, buffer, offset, length, position, callback });
        else write(fd, buffer, offset, length, position, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      const emit = count => measureOperation({ category: 'cpu', name: 'runtime.async-pressure', resource: '界'.repeat(256), attributes: { count } }, () => {});
      armed = true;
      let count = 0;
      while (held.length < 4 && count < 5000) emit(count++);
      assert.equal(held.length, 4, 'Normal pressure starts four independent bounded asynchronous batches.');
      assert.equal(synchronousWrites, 0, 'The ordinary 256 KiB trigger does not synchronously write the journal.');
      while (!synchronousWrites && count < 6000) emit(count++);
      assert.ok(synchronousWrites > 0, 'Synchronous backpressure is explicit only after the job bound is saturated.');
      assert.equal(held.length, 4, 'Saturation never grows the outstanding native write count.');
      let settled = false;
      const flushing = recording.flush().then(() => { settled = true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'The event loop can run while the flush waits.');
      const before = recording.health();
      assert.ok(before.persisted > 0, 'Newer overload batches completed synchronously.');
      assert.equal(before.durableRecords, 0, 'Later persisted batches cannot prove the earlier prefix durable.');
      const later = held.at(-1).buffer;
      const release = async item => new Promise((resolve, reject) => {
        write(item.fd, item.buffer, item.offset, Math.min(item.length, 1024), item.position, (error, size) => {
          item.callback(error, size);
          if (error) reject(error); else resolve();
        });
      });
      while (held.some(item => item.buffer === later)) {
        const index = held.findIndex(item => item.buffer === later);
        await release(held.splice(index, 1)[0]);
      }
      assert.ok(recording.health().persisted > before.persisted, 'A later batch actually completed first.');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'The earlier in-flight batches still hold the durability barrier.');
      assert.equal(recording.health().durableRecords, 0);
      while (held.length) await release(held.shift());
      await flushing;
      armed = false;
      await recording.close();
    `)
    const { events, health } = recordings[0]
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.durableRecords, events.length)
    assert.equal(health.failed, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a reentrant sequence hole spills excess admissions to disk without dropping or reordering', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-spill-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync, write = fs.writeSync, read = fs.readSync, spillFDs = new Set(), indexFDs = new Set();
      let spillWrites = 0;
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).includes('.spill')) spillFDs.add(fd); if (String(path).endsWith('.spill.index')) indexFDs.add(fd); return fd };
      fs.writeSync = (fd, ...args) => { if (spillFDs.has(fd)) spillWrites++; return write(fd, ...args) };
      fs.readSync = (fd, buffer, offset, length, position) => read(fd, buffer, offset, indexFDs.has(fd) ? Math.min(length, 5) : length, position);
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), writer = recording.writers.get(recording.executionId), enqueue = writer.enqueue;
      let interrupted = false, pending;
      writer.enqueue = entry => {
        if (!interrupted && entry.name === 'runtime.spill-hole' && entry.phase === 'end') {
          interrupted = true;
          for (let count = 0; count < 2600; count++) measureOperation({ category: 'cpu', name: 'runtime.spilled', resource: '界'.repeat(256), attributes: { count } }, () => {});
          assert.ok(spillWrites > 0, 'The bounded memory queue switches to a synchronous on-disk spill.');
          pending = recording.flush();
        }
        return enqueue(entry);
      };
      measureOperation({ category: 'cpu', name: 'runtime.spill-hole' }, () => {});
      await pending;
      await recording.close();
      assert.equal(fs.readdirSync(${JSON.stringify(directory)}).some(file => file.includes('.spill')), false, 'Drained spill files are removed.');
    `)
    const { events, health } = recordings[0]
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.deepEqual(events.filter(event => event.name === 'runtime.spilled' && event.phase === 'end').map(event => event.attributes.count), Array.from({ length: 2600 }, (_, index) => index))
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.durableRecords, events.length)
    assert.equal(health.failed, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renderer ACK waits for health publication and a newer synchronous failure cannot be overwritten', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-health-barrier-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const writeFile = fs.writeFile, open = fs.open, close = fs.close, sync = fs.fdatasync, held = [], syncHeld = [], healthFDs = new Set();
      let armed = false, holdSync = false;
      fs.open = (path, ...args) => {
        const callback = args.pop();
        open(path, ...args, (error, fd) => { if (!error && String(path).endsWith('.health.json')) healthFDs.add(fd); callback(error, fd) });
      };
      fs.close = (fd, callback) => { healthFDs.delete(fd); close(fd, callback) };
      fs.fdatasync = (fd, callback) => {
        if (holdSync && healthFDs.has(fd)) { holdSync = false; syncHeld.push(() => sync(fd, callback)) }
        else sync(fd, callback);
      };
      fs.writeFile = (path, ...args) => {
        if (armed && String(path).endsWith('.health.json')) held.push(() => writeFile(path, ...args));
        else writeFile(path, ...args);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording, registerOperationParticipant, claimExternalOperationParticipant, flushExternalOperationSource, markExternalOperationSourceIncomplete } = await import(${JSON.stringify(runtime)});
      const { importOperationEvents, withOperationSuppressed } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      const identity = name => claimExternalOperationParticipant(registerOperationParticipant('renderer').id, name);
      const admit = source => {
        const base = { schemaVersion: 2, ...source, id: source.executionId + ':1', traceId: source.executionId + ':1', category: 'cpu', name: 'renderer.barrier', startedAt: Date.now(), attributes: {} };
        assert.equal(importOperationEvents([{ ...base, sequence: 1, phase: 'start', durationMS: 0, status: 'running' }, { ...base, sequence: 2, phase: 'end', durationMS: 1, status: 'ok' }]).accepted, 2);
      };
      const untilHeld = async () => { while (!held.length) await new Promise(resolve => setImmediate(resolve)) };
      const readHealth = source => withOperationSuppressed(() => JSON.parse(fs.readFileSync(${JSON.stringify(directory)} + '/' + source.executionId + '.health.json', 'utf8')));
      const first = identity('renderer-async-health-ok'); admit(first); armed = true; holdSync = true;
      let acknowledged = false;
      const ack = flushExternalOperationSource(first.executionId).then(() => { acknowledged = true });
      await untilHeld();
      let frame = false; await new Promise(resolve => setImmediate(() => { frame = true; resolve() }));
      assert.equal(frame, true); assert.equal(acknowledged, false, 'ACK waits while health I/O is held.');
      assert.equal(recording.writers.get(first.executionId).health().durableRecords, 2, 'Journal sync completed before health publication.');
      assert.equal(readHealth(first).durableRecords, 0, 'The old health proof remains until atomic publication.');
      held.shift()();
      while (!syncHeld.length) await new Promise(resolve => setImmediate(resolve));
      assert.equal(acknowledged, false, 'ACK also waits for the health file durability barrier.');
      assert.equal(readHealth(first).durableRecords, 0);
      syncHeld.shift()(); await ack;
      assert.equal(readHealth(first).durableRecords, 2);
      armed = false;
      const second = identity('renderer-async-health-stale'); admit(second); armed = true;
      const stale = flushExternalOperationSource(second.executionId);
      await untilHeld();
      markExternalOperationSourceIncomplete(second.executionId, 'injected-terminal-failure', 3);
      const newer = readHealth(second);
      assert.equal(newer.sourceFailures, 1); assert.equal(newer.omittedRecords, 3);
      held.shift()();
      await assert.rejects(stale, /did not complete/);
      const final = readHealth(second);
      assert.equal(final.sourceFailures, 1); assert.equal(final.omittedRecords, 3);
      assert.equal(final.durableRecords, 2);
      armed = false;
      await assert.rejects(recording.close(), /did not close cleanly/);
      assert.equal(fs.readdirSync(${JSON.stringify(directory)}).some(file => file.startsWith('.tmp-')), false, 'Superseded temporary health files are removed.');
    `)
    const good = recordings.find(value => value.health.executionId === 'renderer-async-health-ok')
    const bad = recordings.find(value => value.health.executionId === 'renderer-async-health-stale')
    assert.equal(good.events.length, 2)
    assert.equal(good.health.durableRecords, 2)
    assert.equal(bad.events.length, 2)
    assert.equal(bad.health.sourceFailures, 1)
    assert.equal(bad.health.omittedRecords, 3)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('forced process exit synchronously drains held journal writes and supersedes a pending health publication', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-exit-drain-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync, write = fs.write, writeFile = fs.writeFile;
      let journalFD, holdJournal = false, holdHealth = false, healthStarted, journalStarted;
      const healthPending = new Promise(resolve => { healthStarted = resolve });
      const journalPending = new Promise(resolve => { journalStarted = resolve });
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).endsWith('.jsonl.brj')) journalFD = fd; return fd };
      fs.write = (fd, buffer, offset, length, position, callback) => {
        if (holdJournal && fd === journalFD) {
          holdJournal = false;
          write(fd, buffer, offset, Math.min(length, 1024), position, (error, size) => { assert.ifError(error); assert.ok(size > 0); journalStarted() });
        } else write(fd, buffer, offset, length, position, callback);
      };
      fs.writeFile = (path, ...args) => {
        if (holdHealth && String(path).endsWith('.health.json')) {
          holdHealth = false; args.pop();
          writeFile(path, ...args, error => { assert.ifError(error); healthStarted() });
        } else writeFile(path, ...args);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'runtime.before-exit-health' }, () => {});
      holdHealth = true;
      void recording.flush();
      await healthPending;
      holdJournal = true;
      for (let count = 0; count < 500; count++) measureOperation({ category: 'cpu', name: 'runtime.exit-drain', resource: '界'.repeat(256), attributes: { count } }, () => {});
      await journalPending;
      await new Promise(resolve => setImmediate(resolve));
      process.exit(0);
    `)
    const { events, health } = recordings[0]
    assert.deepEqual(events.map(event => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1))
    assert.equal(events.filter(event => event.name === 'runtime.exit-drain' && event.phase === 'end').length, 500)
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.durableRecords, events.length)
    assert.equal(health.failed, 0)
    assert.equal((await readdir(directory)).some(file => file.startsWith('.tmp-')), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('asynchronous write failure or zero progress fails durability without inventing persisted records', async () => {
  for (const mode of ['error', 'zero']) {
    const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-write-failure-'))
    try {
      const recordings = await execute(directory, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const open = fs.openSync, write = fs.write;
        let journalFD, armed = false;
        fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).endsWith('.jsonl.brj')) journalFD = fd; return fd };
        fs.write = (fd, buffer, offset, length, position, callback) => {
          if (armed && fd === journalFD) {
            armed = false;
            queueMicrotask(() => ${JSON.stringify(mode)} === 'error' ? callback(Object.assign(new Error('Injected journal failure'), { code: 'ENOSPC' })) : callback(null, 0, buffer));
          } else write(fd, buffer, offset, length, position, callback);
        };
        syncBuiltinESMExports();
        const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
        const { measureOperation } = await import(${JSON.stringify(operations)});
        const recording = initializeOperationRecording();
        measureOperation({ category: 'cpu', name: 'runtime.failed-write' }, () => {});
        armed = true;
        await assert.rejects(recording.flush(), /did not complete/);
        assert.equal(recording.health().failed, 1);
        assert.equal(recording.health().persisted, 0);
        assert.equal(recording.health().durableRecords, 0);
        await assert.rejects(recording.close(), /did not close cleanly/);
        assert.equal(recording.health().closed, true);
      `)
      assert.equal(recordings[0].events.length, 0)
      assert.ok(recordings[0].health.recorded >= 2)
      assert.equal(recordings[0].health.persisted, 0)
      assert.equal(recordings[0].health.durableRecords, 0)
      assert.equal(recordings[0].health.pending, recordings[0].health.recorded)
      assert.equal(recordings[0].health.failed, 1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('reentrant terminal health publication during atomic rename is repaired before returning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-health-reentry-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      let armed = false, reenter;
      fs.renameSync = (from, to) => {
        if (armed && String(to).endsWith('.health.json')) { armed = false; reenter() }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording, registerOperationParticipant, claimExternalOperationParticipant, flushExternalOperationSource, markExternalOperationSourceIncomplete } = await import(${JSON.stringify(runtime)});
      const { importOperationEvents, withOperationSuppressed } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), source = claimExternalOperationParticipant(registerOperationParticipant('renderer').id, 'renderer-health-reentry');
      const base = { schemaVersion: 2, ...source, id: source.executionId + ':1', traceId: source.executionId + ':1', category: 'cpu', name: 'renderer.reentry', startedAt: Date.now(), attributes: {} };
      assert.equal(importOperationEvents([{ ...base, sequence: 1, phase: 'start', durationMS: 0, status: 'running' }, { ...base, sequence: 2, phase: 'end', durationMS: 1, status: 'ok' }]).accepted, 2);
      reenter = () => markExternalOperationSourceIncomplete(source.executionId, 'reentrant-terminal', 1);
      armed = true;
      await assert.rejects(flushExternalOperationSource(source.executionId), /did not complete/);
      const health = withOperationSuppressed(() => JSON.parse(fs.readFileSync(${JSON.stringify(directory)} + '/' + source.executionId + '.health.json', 'utf8')));
      assert.equal(health.sourceFailures, 1); assert.equal(health.omittedRecords, 1); assert.equal(health.durableRecords, 2);
      await assert.rejects(recording.close(), /did not close cleanly/);
    `)
    const health = recordings.find(value => value.health.executionId === 'renderer-health-reentry').health
    assert.equal(health.sourceFailures, 1)
    assert.equal(health.omittedRecords, 1)
    assert.equal(health.closed, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('concurrent flush requests coalesce behind one active barrier and retain the latest target', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-flush-coalesce-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync, sync = fs.fdatasync;
      let journalFD, release, started, armed = false, journalSyncs = 0;
      const entered = new Promise(resolve => { started = resolve });
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).endsWith('.jsonl.brj')) journalFD = fd; return fd };
      fs.fdatasync = (fd, callback) => {
        if (fd === journalFD) journalSyncs++;
        if (armed && fd === journalFD) { armed = false; release = () => sync(fd, callback); started() }
        else sync(fd, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), writer = recording.writers.get(recording.executionId);
      measureOperation({ category: 'cpu', name: 'runtime.coalesce-first' }, () => {});
      armed = true;
      const first = writer.flush();
      await entered;
      const requests = [writer.flush()];
      measureOperation({ category: 'cpu', name: 'runtime.coalesce-later' }, () => {});
      for (let i = 0; i < 1000; i++) requests.push(writer.flush());
      assert.equal(new Set(requests).size, 1, 'Pending requests share one bounded successor job.');
      release();
      await Promise.all([first, ...requests]);
      assert.equal(writer.health().durableRecords, writer.health().recorded, 'The shared barrier includes the newest requested records.');
      assert.equal(journalSyncs, 2, 'One successor synchronizes all queued targets.');
      await recording.close();
    `)
    const { events, health } = recordings[0]
    assert.equal(events.filter(event => event.name === 'runtime.coalesce-first' && event.phase === 'end').length, 1)
    assert.equal(events.filter(event => event.name === 'runtime.coalesce-later' && event.phase === 'end').length, 1)
    assert.equal(health.recorded, events.length)
    assert.equal(health.durableRecords, events.length)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a failed admission during a reentrant flush cannot create a false durable count', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-failed-target-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), stringify = JSON.stringify;
      let pending;
      JSON.stringify = (value, ...args) => {
        if (value?.name === 'runtime.failed-flush-target' && value.phase === 'end') {
          pending = recording.flush();
          throw new Error('Injected admission failure');
        }
        return stringify(value, ...args);
      };
      measureOperation({ category: 'cpu', name: 'runtime.failed-flush-target' }, () => {});
      JSON.stringify = stringify;
      await assert.rejects(pending, /did not complete/);
      const health = recording.health();
      assert.ok(health.durableRecords <= health.persisted);
      assert.ok(health.durableRecords <= health.recorded);
      await assert.rejects(recording.close(), /did not close cleanly/);
    `)
    const health = recordings[0].health
    assert.ok(health.durableRecords <= health.persisted)
    assert.ok(health.durableRecords <= health.recorded)
    assert.equal(health.failed, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('forced exit during orderly close still drains records admitted during the first flush', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-exit-during-close-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync, sync = fs.fdatasync, write = fs.write;
      let journalFD, holdSync = true, releaseSync, syncEntered, holdWrite = false, writeEntered;
      const syncPending = new Promise(resolve => { syncEntered = resolve });
      const writePending = new Promise(resolve => { writeEntered = resolve });
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).endsWith('.jsonl.brj')) journalFD = fd; return fd };
      fs.fdatasync = (fd, callback) => {
        if (fd === journalFD && holdSync) { holdSync = false; releaseSync = () => sync(fd, callback); syncEntered() }
        else sync(fd, callback);
      };
      fs.write = (fd, buffer, offset, length, position, callback) => {
        if (fd === journalFD && holdWrite) { holdWrite = false; writeEntered() }
        else write(fd, buffer, offset, length, position, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'runtime.before-close' }, () => {});
      void recording.close();
      await syncPending;
      measureOperation({ category: 'cpu', name: 'runtime.during-close-flush' }, () => {});
      holdWrite = true;
      releaseSync();
      await writePending;
      process.exit(0);
    `)
    const { events, health } = recordings[0]
    assert.deepEqual(events.filter(event => event.name === 'runtime.during-close-flush').map(event => event.phase), ['start', 'end'])
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.durableRecords, events.length)
    assert.equal(health.failed, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('terminal handoff joins a late native callback before descriptor closure without double counting', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-exit-callback-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const open = fs.openSync, write = fs.write;
      let journalFD, hold = false, pending;
      fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (String(path).endsWith('.jsonl.brj')) journalFD = fd; return fd };
      fs.write = (fd, buffer, offset, length, position, callback) => {
        if (hold && fd === journalFD) { hold = false; pending = () => write(fd, buffer, offset, length, position, callback) }
        else write(fd, buffer, offset, length, position, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), writer = recording.writers.get(recording.executionId);
      hold = true;
      let count = 0;
      while (!pending && count < 1000) measureOperation({ category: 'cpu', name: 'runtime.exit-callback', resource: '界'.repeat(256), attributes: { count: count++ } }, () => {});
      assert.ok(pending);
      writer.exit();
      const before = writer.health();
      assert.equal(before.recorded, before.persisted);
      assert.equal(before.persisted, before.durableRecords);
      let finished = false;
      const closing = writer.close().then(() => { finished = true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false, 'The descriptor remains open until the native write callback returns.');
      pending();
      await closing;
      const after = writer.health();
      assert.equal(after.persisted, before.persisted, 'The late callback cannot count the terminal handoff twice.');
      assert.equal(after.durableRecords, before.durableRecords);
      await recording.close();
    `)
    const { events, health } = recordings[0]
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.durableRecords, events.length)
    assert.equal(health.failed, 0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('terminal handoff with an unfillable sequence hole reports failure and does not hang close', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-exit-hole-'))
  try {
    const recordings = await execute(directory, `
      import assert from 'node:assert/strict';
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const recording = initializeOperationRecording(), writer = recording.writers.get(recording.executionId);
      writer.enqueue({ sequence: 2, phase: 'start', name: 'runtime.missing-prefix' });
      writer.exit(); writer.exit();
      assert.equal(writer.health().sourceFailures, 1);
      assert.equal(writer.health().omittedRecords, 1);
      assert.equal(writer.health().durableRecords, 0);
      await assert.rejects(writer.close(), /did not complete/);
      await assert.rejects(recording.close(), /did not close cleanly/);
    `)
    assert.equal(recordings[0].events.length, 0)
    assert.equal(recordings[0].health.recorded, 1)
    assert.equal(recordings[0].health.sourceFailures, 1)
    assert.equal(recordings[0].health.omittedRecords, 1)
    assert.equal(recordings[0].health.durableRecords, 0)
    assert.equal(recordings[0].health.closed, true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('forced exit reentrant inside health rename publishes the terminal durable proof immediately', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-exit-health-rename-'))
  try {
    const recordings = await execute(directory, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      let armed = false;
      fs.renameSync = (from, to) => {
        if (armed && String(to).endsWith('.health.json')) { armed = false; process.exit(0) }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      measureOperation({ category: 'cpu', name: 'runtime.exit-in-health-rename' }, () => {});
      armed = true;
      await recording.flush();
      throw new Error('The armed terminal interrupt did not fire.');
    `)
    const { events, health } = recordings[0]
    assert.deepEqual(events.filter(event => event.name === 'runtime.exit-in-health-rename').map(event => event.phase), ['start', 'end'])
    assert.equal(health.recorded, events.length)
    assert.equal(health.persisted, events.length)
    assert.equal(health.durableRecords, events.length)
    assert.equal(health.failed, 0)
    assert.equal((await readdir(directory)).some(file => file.startsWith('.tmp-')), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('failed health temporary cleanup remains bounded and permanently fails subsequent flushes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-recorder-health-cleanup-'))
  try {
    await execute(directory, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const writeFile = fs.writeFile, unlink = fs.unlink;
      let armed = false, healthCreations = 0;
      fs.writeFile = (path, ...args) => { if (armed && String(path).endsWith('.health.json')) healthCreations++; return writeFile(path, ...args) };
      fs.unlink = (path, callback) => {
        if (armed && String(path).endsWith('.health.json')) queueMicrotask(() => callback(Object.assign(new Error('Injected cleanup failure'), { code: 'EACCES' })));
        else unlink(path, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording(), writer = recording.writers.get(recording.executionId);
      measureOperation({ category: 'cpu', name: 'runtime.health-cleanup' }, () => {});
      armed = true;
      await assert.rejects(writer.flush(), /Injected cleanup failure/);
      for (let index = 0; index < 5; index++) await assert.rejects(writer.flush(), /Injected cleanup failure/);
      assert.equal(healthCreations, 1, 'A blocked cleanup cannot grow a queue of temporary snapshots.');
      assert.ok(writer.health().failed >= 1);
      await assert.rejects(recording.close(), /did not close cleanly/);
      assert.equal(writer.health().closed, true);
      assert.equal(healthCreations, 1);
    `)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
