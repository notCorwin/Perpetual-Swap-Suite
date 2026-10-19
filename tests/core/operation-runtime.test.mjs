import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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
  const files = (await readdir(directory)).filter(file => file.endsWith('.jsonl'))
  return Promise.all(files.map(async file => ({
    events: (await readFile(join(directory, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    health: JSON.parse(await readFile(join(directory, file.replace(/\.jsonl$/, '.health.json')), 'utf8')),
  })))
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
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
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
    const { events, health } = recordings[0]
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
      const writeFileSync = fs.writeFileSync;
      let rejectHealth = false;
      fs.writeFileSync = (path, ...args) => {
        if (rejectHealth && String(path).endsWith('.health.json')) {
          rejectHealth = false;
          throw Object.assign(new Error('Injected health failure'), { code: 'ENOSPC' });
        }
        return writeFileSync(path, ...args);
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
