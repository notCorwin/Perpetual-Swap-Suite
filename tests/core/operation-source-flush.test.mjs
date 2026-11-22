import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtime = new URL('../../electron/services/operation-runtime.js', import.meta.url).href
const operations = new URL('../../electron/services/operations.js', import.meta.url).href
const journal = new URL('../../electron/services/operation-journal.js', import.meta.url).href

test('a journal timer is cancelled by the clock that created it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-operation-timer-owner-'))
  try {
    const source = `
      import assert from 'node:assert/strict';
      const nativeSetInterval = globalThis.setInterval, nativeClearInterval = globalThis.clearInterval;
      let checkpoint, originalIntervalClears = 0, wrongIntervalClears = 0;
      globalThis.setInterval = (callback, delay, ...args) => {
        const timer = nativeSetInterval(callback, delay, ...args);
        if (delay === 5000) checkpoint = timer;
        return timer;
      };
      globalThis.clearInterval = timer => {
        if (timer === checkpoint) originalIntervalClears++;
        return nativeClearInterval(timer);
      };
      const { initializeOperationRecording } = await import(${JSON.stringify(runtime)});
      const { measureOperation } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      await recording.flush();
      const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
      const scheduled = new Set(); let originalClears = 0, wrongClears = 0;
      globalThis.setTimeout = (callback, delay, ...args) => {
        const timer = nativeSet(callback, delay, ...args);
        if (delay === 250) scheduled.add(timer);
        return timer;
      };
      globalThis.clearTimeout = timer => {
        if (scheduled.has(timer)) originalClears++;
        return nativeClear(timer);
      };
      measureOperation({ category: 'cpu', name: 'fixture.timer-owner' }, () => 1);
      assert.equal(scheduled.size, 1);
      globalThis.clearTimeout = timer => {
        if (scheduled.has(timer)) wrongClears++;
        return nativeClear(timer);
      };
      globalThis.clearInterval = timer => {
        if (timer === checkpoint) wrongIntervalClears++;
        return nativeClearInterval(timer);
      };
      await recording.flush();
      assert.equal(originalClears, 1);
      assert.equal(wrongClears, 0);
      await recording.close();
      assert.equal(originalIntervalClears, 1);
      assert.equal(wrongIntervalClears, 0);
      globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear;
      globalThis.setInterval = nativeSetInterval; globalThis.clearInterval = nativeClearInterval;
    `
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_PARTICIPANT: '', PERPETUAL_SWAP_OPERATION_SESSION: 'timer-owner' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let diagnostics = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000) })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Timer ownership test failed (${code}): ${diagnostics}`)))
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('renderer source flush durably stores its exact journal without synchronizing another dirty writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-targeted-operation-flush-'))
  try {
    const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { isOperationJournal } from ${JSON.stringify(journal)};
      const opened = new Map(), open = fs.openSync, sync = fs.fdatasync;
      let forbiddenExecution, syncing = [];
      fs.openSync = function(path, ...args) { const fd = open.call(this, path, ...args); opened.set(fd, String(path)); return fd; };
      fs.fdatasync = (fd, callback) => {
        const path = opened.get(fd) ?? '';
        syncing.push(path);
        if (forbiddenExecution && path.includes(forbiddenExecution) && isOperationJournal(path)) {
          callback(new Error('An unrelated dirty journal was synchronized.')); return;
        }
        sync(fd, callback);
      };
      syncBuiltinESMExports();
      const { initializeOperationRecording, registerOperationParticipant, claimExternalOperationParticipant, flushExternalOperationSource } = await import(${JSON.stringify(runtime)});
      const { measureOperation, importOperationEvents } = await import(${JSON.stringify(operations)});
      const recording = initializeOperationRecording();
      const sourceIdentity = claimExternalOperationParticipant(registerOperationParticipant('renderer').id, 'renderer-source-flush');
      measureOperation({ category: 'cpu', name: 'fixture.dirty-main' }, () => 1);
      const event = (sequence, phase) => ({schemaVersion: 2, ...sourceIdentity, id: sourceIdentity.executionId + ':1', sequence,
        traceId: sourceIdentity.executionId + ':1', category: 'cpu', name: 'chart.geometry', startedAt: Date.now(),
        durationMS: phase === 'start' ? 0 : 1, phase, status: phase === 'start' ? 'running' : 'ok', attributes: { inputRows: 96 }});
      assert.equal(importOperationEvents([event(1, 'start'), event(2, 'end')]).accepted, 2);
      forbiddenExecution = recording.executionId;
      await flushExternalOperationSource(sourceIdentity.executionId);
      const external = recording.writers.get(sourceIdentity.executionId).health();
      assert.equal(external.durableRecords, 2);
      assert.equal(external.pending, 0);
      assert.ok(recording.health().recorded > recording.health().durableRecords, 'The unrelated dirty writer is still owned by its independent checkpoint.');
      assert.ok(syncing.some(path => path.includes(sourceIdentity.executionId)));
      await assert.rejects(flushExternalOperationSource('unregistered-renderer'), /Unknown external/);
      await assert.rejects(flushExternalOperationSource(recording.executionId), /Unknown external/);
      forbiddenExecution = undefined;
      await recording.close();
      assert.equal(recording.health().recorded, recording.health().durableRecords);
    `
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: directory, PERPETUAL_SWAP_OPERATION_PARTICIPANT: '', PERPETUAL_SWAP_OPERATION_SESSION: 'targeted-source-flush' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let diagnostics = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000) })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Targeted source flush failed (${code}): ${diagnostics}`)))
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
