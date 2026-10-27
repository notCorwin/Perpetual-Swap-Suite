import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

const hooksURL = new URL('../../electron/services/operation-hooks.js', import.meta.url).href
const operationsURL = new URL('../../electron/services/operations.js', import.meta.url).href
const databaseURL = new URL('../../electron/services/recorded-database.js', import.meta.url).href
const networkURL = new URL('../../electron/services/network-operations.js', import.meta.url).href

async function execute(source, { beforeInstall = '' } = {}) {
  const prefix = `
    import assert from 'node:assert/strict';
    import { AsyncLocalStorage } from 'node:async_hooks';
    import { installOperationHooks } from ${JSON.stringify(hooksURL)};
    import { attachOperationSink, attachOperationJournalSink, configureOperationContext, configureOperationPropagation, withOperationSuppressed, measureOperation } from ${JSON.stringify(operationsURL)};
    const context = new AsyncLocalStorage();
    configureOperationPropagation({ get: () => context.getStore(), run: (value, operation) => context.run(value, operation) });
    configureOperationContext({ executionId: 'automatic-hooks', sessionId: 'fixture' }, () => { const value = process.threadCpuUsage(); return (value.user + value.system) / 1000; });
    const events = [];
    const journal = [];
    const unsubscribe = attachOperationSink(event => events.push(event));
    attachOperationJournalSink(event => journal.push(event));
    ${beforeInstall}
    const enabled = installOperationHooks();
    assert.deepEqual(installOperationHooks(), enabled, 'Installation is idempotent.');
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `${prefix}\n${source}`], {
      env: { ...process.env, PERPETUAL_SWAP_OPERATION_DIR: '', PERPETUAL_SWAP_SANDBOX: '1', PERPETUAL_SWAP_ALLOW_NETWORK: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24_000) })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`Automatic hook fixture failed (${code}): ${stderr}`)); return }
      try { resolve(JSON.parse(stdout)) } catch (error) { reject(new Error(`${error.message}: ${stdout}\n${stderr}`)) }
    })
  })
}

test('automatic hooks require async context propagation before mutating native APIs', async () => {
  const result = await execute(`
    console.log(JSON.stringify({ installed: enabled.length }));
  `, { beforeInstall: `
    import fs from 'node:fs';
    import { getOperationHookCapabilities } from ${JSON.stringify(hooksURL)};
    const originals = { read: fs.readFileSync, fetch: globalThis.fetch, socket: globalThis.WebSocket };
    const originalCapabilities = getOperationHookCapabilities();
    configureOperationPropagation(undefined);
    assert.throws(() => installOperationHooks(), /require async context propagation/);
    assert.equal(fs.readFileSync, originals.read);
    assert.equal(globalThis.fetch, originals.fetch);
    assert.equal(globalThis.WebSocket, originals.socket);
    assert.deepEqual(getOperationHookCapabilities(), originalCapabilities, 'A rejected installation leaves hooks and capabilities untouched.');
    configureOperationPropagation({ get: () => context.getStore(), run: (value, operation) => context.run(value, operation) });
  ` })
  assert.ok(result.installed > 0)
})

test('automatic hooks observe builtin I/O, native computation and raw SQLite without application adapters', async () => {
  const result = await execute(`
    import fs, { readFile as namedReadFile } from 'node:fs';
    import fsp from 'node:fs/promises';
    import crypto, { pbkdf2Sync, scrypt } from 'node:crypto';
    import { gzipSync, createGzip } from 'node:zlib';
    import sqlite, { DatabaseSync } from 'node:sqlite';
    import { promisify } from 'node:util';
    import { once } from 'node:events';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { databaseOperation, openRecordedDatabase } from ${JSON.stringify(databaseURL)};
    const directory = await fsp.mkdtemp(join(tmpdir(), 'perp-auto-hooks-'));
    const file = join(directory, 'private-name.txt');
    try {
      fs.writeFileSync(file, 'sensitive-payload');
      assert.equal(fs.readFileSync(file, 'utf8'), 'sensitive-payload');
      await new Promise((resolve, reject) => namedReadFile(file, (error, value) => {
        if (error) { reject(error); return; }
        assert.equal(value.toString(), 'sensitive-payload');
        fs.statSync(file); // Application callbacks must escape internal I/O suppression.
        resolve();
      }));
      assert.equal(await fsp.readFile(file, 'utf8'), 'sensitive-payload');
      const handle = await fsp.open(file, 'r');
      assert.equal((await handle.readFile()).toString(), 'sensitive-payload');
      await handle.close();
      let streamed = '';
      for await (const chunk of fs.createReadStream(file)) streamed += chunk;
      assert.equal(streamed, 'sensitive-payload');
      const before = events.length;
      await withOperationSuppressed(async () => { await fsp.readFile(file); fs.statSync(file); });
      assert.equal(events.length, before, 'Recorder suppression includes asynchronous filesystem work.');
      pbkdf2Sync('private-password', 'private-salt', 100, 32, 'sha256');
      await promisify(scrypt)('private-password', 'private-salt', 16);
      assert.equal(crypto.createHash('sha256').update('sensitive-payload').digest().length, 32);
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const input = Buffer.from('sensitive-payload');
      const signature = crypto.sign(null, input, privateKey);
      assert.equal(crypto.verify(null, input, publicKey, signature), true);
      assert.deepEqual(await promisify(crypto.sign)(null, input, privateKey), signature);
      assert.equal(await promisify(crypto.verify)(null, input, publicKey, signature), true);
      assert.throws(() => crypto.sign(null, input, () => {}));
      assert.throws(() => crypto.verify(null, input, publicKey, () => {}));
      for (const entry of journal.filter(event => ['crypto.sign', 'crypto.verify'].includes(event.name) && event.phase === 'start')) {
        assert.ok(journal.some(event => event.id === entry.id && event.phase === 'end'), 'Invalid function-valued key/signature arguments do not masquerade as callbacks.');
      }
      assert.ok(gzipSync('sensitive-payload').length > 0);
      const gzip = createGzip(); gzip.resume(); gzip.end('sensitive-payload'); await once(gzip, 'end');
      const raw = new DatabaseSync(':memory:');
      raw.exec('CREATE TABLE secrets (value TEXT); INSERT INTO secrets VALUES ("private-record")'.replaceAll('"', "'"));
      assert.equal(raw.prepare('SELECT value FROM secrets').get().value, 'private-record');
      assert.deepEqual([...raw.prepare('SELECT value FROM secrets').iterate()].map(row => row.value), ['private-record']);
      databaseOperation('fixture.native.group', () => {
        const statement = raw.prepare('SELECT value FROM secrets');
        assert.equal(statement.columns().length, 1);
        assert.equal([...statement.iterate()].length, 1);
      });
      assert.deepEqual(events.find(event => event.name === 'fixture.native.group').attributes, { calls: 3, queryCount: 1, rows: 1, changes: 0 });
      raw.close();
      const explicit = openRecordedDatabase(sqlite.DatabaseSync, ':memory:', {}, 'metadata');
      assert.equal(explicit.prepare('SELECT 42 AS value').get().value, 42);
      const tags = explicit.createTagStore();
      assert.equal(tags.get\`SELECT 43 AS value\`.value, 43);
      const session = explicit.createSession(); session.changeset(); session.close();
      await sqlite.backup(explicit, join(directory, 'copy.sqlite'));
      explicit.close();
      const descriptor = fs.openSync(file, 'r+');
      assert.equal(fs.writeSync(descriptor, Buffer.from('ab'), 0, 2, 0), 2);
      assert.equal(fs.readSync(descriptor, Buffer.alloc(2), 0, 2, 0), 2);
      const readResult = await promisify(fs.read)(descriptor, Buffer.alloc(3), 0, 3, 0);
      assert.equal(readResult.bytesRead, 3);
      await promisify(fs.write)(descriptor, Buffer.from('c'), 0, 1, 0);
      fs.closeSync(descriptor);
      assert.equal(events.find(event => event.name === 'fs.writeSync').attributes.bytes, 2);
      assert.equal(events.find(event => event.name === 'fs.readSync').attributes.bytes, 2);
      assert.ok(events.some(event => event.name === 'fs.read' && event.attributes.bytes === 3));
      assert.equal(events.find(event => event.name === 'fs.write').attributes.bytes, 1);
      assert.throws(() => fs.readFileSync(join(directory, 'missing.txt')));
      const io = events.filter(event => event.category === 'io');
      assert.equal(io.filter(event => event.name === 'fs.readFile').length, 1);
      assert.equal(io.filter(event => event.name === 'fs.statSync').length, 1);
      assert.ok(events.find(event => event.name === 'crypto.pbkdf2Sync').cpuTimeMS >= 0);
      assert.equal(events.find(event => event.name === 'crypto.scrypt').cpuTimeMS, undefined);
      assert.ok(events.find(event => event.name === 'sqlite.get').cpuTimeMS >= 0);
      assert.equal(events.filter(event => event.name === 'sqlite.open').length, 1, 'Centralized/default SQLite opens are not counted twice.');
      for (const name of ['sqlite.open', 'sqlite.prepare', 'sqlite.close', 'sqlite.session.close', 'sqlite.backup']) {
        const event = events.find(event => event.name === name);
        assert.equal(event.attributes.calls, 1, name);
        assert.equal(event.attributes.queryCount, 0, name);
        assert.equal(event.attributes.rows, 0, name);
      }
      for (const name of ['sqlite.exec', 'sqlite.get', 'sqlite.iterate']) {
        const event = events.find(event => event.name === name);
        assert.equal(event.attributes.calls, 1, name);
        assert.equal(event.attributes.queryCount, 1, name);
      }
      assert.doesNotMatch(JSON.stringify(events), /private-password|private-salt|sensitive-payload|private-record|private-name/);
    } finally { await fsp.rm(directory, { recursive: true, force: true }); }
    unsubscribe();
    console.log(JSON.stringify({ names: [...new Set(events.map(event => event.name))], errors: events.filter(event => event.status === 'error').length, enabled }));
  `)
  for (const name of ['fs.readFileSync', 'fs.readFile', 'fs.promises.readFile', 'fs.handle.readFile', 'fs.createReadStream', 'crypto.pbkdf2Sync', 'crypto.scrypt', 'crypto.hash.update', 'crypto.hash.digest', 'zlib.gzipSync', 'zlib.createGzip', 'sqlite.get', 'sqlite.iterate']) assert.ok(result.names.includes(name), name)
  assert.equal(result.errors, 3)
})

test('HTTP hooks preserve lazy body consumption, cancellation, callback contexts and one physical request per layer', async () => {
  const result = await execute(`
    import http, { get as namedGet } from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    let release;
    const server = http.createServer((request, response) => {
      if (request.url.startsWith('/held')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"answer":'); release = () => response.end('42}'); }
      else if (request.url === '/cancel') { response.write('first'); const timeout = setTimeout(() => response.end('last'), 100); response.on('close', () => clearTimeout(timeout)); }
      else if (request.url === '/post') { let bytes = 0; request.on('data', chunk => bytes += chunk.length); request.on('end', () => response.end(String(bytes))); }
      else response.end('sensitive-payload');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      const held = await fetch(origin + '/held?credential=private');
      assert.equal(held.bodyUsed, false);
      assert.equal(events.filter(event => event.name === 'fetch.request').length, 0, 'Headers do not finish the body operation.');
      const body = held.json(); release(); assert.deepEqual(await body, { answer: 42 });
      assert.equal(events.find(event => event.name === 'fetch.request').attributes.receivedBytes, 13);
      const cloned = await fetch(origin + '/clone'); const clone = cloned.clone();
      assert.equal(await clone.text(), 'sensitive-payload'); assert.equal(await cloned.text(), 'sensitive-payload');
      const bytes = await fetch(origin + '/bytes'); assert.equal((await bytes.arrayBuffer()).byteLength, 17);
      const streamed = await fetch(origin + '/stream'); let size = 0;
      for await (const chunk of streamed.body) size += chunk.byteLength;
      assert.equal(size, 17);
      const resumed = await fetch(origin + '/resume'); const iterator = resumed.body.values({ preventCancel: true });
      await iterator.next(); await iterator.return();
      const reader = resumed.body.getReader(); while (!(await reader.read()).done) {};
      const cancelled = await fetch(origin + '/cancel'); const cancelledReader = cancelled.body.getReader();
      await cancelledReader.read(); await cancelledReader.cancel();
      await new Promise((resolve, reject) => namedGet(origin + '/native', response => {
        response.resume(); response.once('end', () => {
          fetch(origin + '/nested').then(value => value.text()).then(resolve, reject);
        });
      }).on('error', reject));
      await new Promise((resolve, reject) => {
        const request = http.request(new URL(origin + '/post'), { method: 'POST' }, response => {
          let text = ''; response.on('data', value => text += value); response.once('end', () => { assert.equal(text, '5'); resolve(); });
        });
        let calls = 0; const listener = () => calls++;
        for (let index = 0; index < 2; index++) {
          request.once('fixture', listener); assert.equal(request.listeners('fixture')[0], listener);
          request.emit('fixture'); assert.equal(request.listenerCount('fixture'), 0);
        }
        request.on('fixture', listener); request.off('fixture', listener); assert.equal(request.listenerCount('fixture'), 0);
        request.on('fixture', listener); request.removeAllListeners('fixture'); assert.equal(request.listenerCount('fixture'), 0);
        request.emit('fixture'); assert.equal(calls, 2);
        request.once('error', reject); request.write('abc'); request.end('de');
      });
      const post = events.find(event => event.name === 'node.http.request' && event.resource.endsWith('/post'));
      assert.equal(post.attributes.sentBytes, 5); assert.equal(post.attributes.receivedBytes, 1); assert.equal(post.attributes.method, 'POST');
      const blocked = error => error.code === 'SANDBOX_NETWORK_BLOCKED';
      await assert.rejects(fetch('https://no-outbound.invalid/?key=private'), blocked);
      assert.throws(() => http.get('http://no-outbound.invalid/'), blocked);
      assert.throws(() => https.request('https://no-outbound.invalid/'), blocked);
      assert.throws(() => net.connect(443, 'no-outbound.invalid'), blocked);
      assert.throws(() => tls.connect(443, { host: 'no-outbound.invalid' }), blocked);
      assert.throws(() => new WebSocket('wss://no-outbound.invalid/'), blocked);
      const successful = events.filter(event => event.name === 'fetch.request' && event.status === 'ok');
      assert.equal(successful.length, 6);
      assert.equal(events.filter(event => event.name === 'fetch.request' && event.status === 'cancelled').length, 1);
      assert.equal(events.filter(event => event.name === 'node.http.request' && event.status === 'ok').length, 2);
      assert.equal(events.filter(event => event.name === 'socket.connect' && event.status === 'ok').length, 0, 'HTTP/fetch connections do not create duplicate TCP operations.');
      assert.doesNotMatch(JSON.stringify(events), /credential|sensitive-payload|key=private/);
    } finally { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    unsubscribe(); console.log(JSON.stringify({ network: events.filter(event => event.category === 'network').map(event => ({ name: event.name, status: event.status })) }));
  `)
  assert.ok(result.network.length >= 14)
})

test('raw TCP and native WebSocket hooks retain receivers and injected adapter deduplication', async () => {
  const result = await execute(`
    import http from 'node:http';
    import net from 'node:net';
    import { createHash } from 'node:crypto';
    import { recordedWebSocketFactory } from ${JSON.stringify(networkURL)};
    import { getOperationContext, runWithOperationContext } from ${JSON.stringify(operationsURL)};
    import { isOperationSuppressed } from ${JSON.stringify(operationsURL)};
    import { isOperationHookSuppressed, withOperationHookSuppressed } from ${JSON.stringify(hooksURL)};
    const connectionContext = { traceId: 'socket-trace', parentId: 'socket-parent', scenarioId: 'socket-scenario' };
    const applicationContext = { traceId: 'callback-trace', parentId: 'callback-parent', scenarioId: 'callback-scenario' };
    const observerScopes = [];
    const restorationTasks = [];
    const stopObserving = attachOperationSink(event => {
      if (event.name === 'websocket.receive') observerScopes.push({ context: getOperationContext(), network: isOperationHookSuppressed('network') });
    });
    const server = http.createServer((_request, response) => response.end('ok'));
    server.on('upgrade', (request, socket) => {
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
      let pending = Buffer.alloc(0);
      socket.on('data', chunk => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2) {
          const length = pending[1] & 127, offset = 2 + (pending[1] & 128 ? 4 : 0);
          if (length >= 126 || pending.length < offset + length) return;
          const opcode = pending[0] & 15;
          pending = pending.subarray(offset + length);
          if (opcode === 8) socket.end(Buffer.from([136, 2, 3, 232]));
          else if (opcode === 1) socket.write(Buffer.from([129, 2, 111, 107]));
        }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      await new Promise((resolve, reject) => {
        const socket = runWithOperationContext(connectionContext, () => recordedWebSocketFactory(url => new WebSocket(url), 'fixture')(origin.replace('http:', 'ws:') + '/socket?credential=private'));
        assert.ok(socket instanceof WebSocket);
        const beforeSuppressed = events.length;
        withOperationSuppressed(() => socket.dispatchEvent(new MessageEvent('message', { data: 'suppressed' })));
        assert.equal(events.length, beforeSuppressed, 'Observer context restoration preserves invocation-time recording suppression.');
        let fixtures = 0; const fixture = () => fixtures++;
        for (let index = 0; index < 2; index++) { socket.addEventListener('fixture', fixture, { once: true }); socket.dispatchEvent(new Event('fixture')); }
        socket.addEventListener('fixture', fixture); socket.removeEventListener('fixture', fixture); socket.dispatchEvent(new Event('fixture')); assert.equal(fixtures, 2);
        const restored = function (event) {
          restorationTasks.push((async () => {
            assert.equal(this, socket);
            assert.deepEqual(getOperationContext(), applicationContext);
            assert.equal(isOperationSuppressed(), event.expectedSuppressed);
            assert.equal(isOperationHookSuppressed('io'), true);
            assert.equal(isOperationHookSuppressed('network'), event.expectedSuppressed);
            if (event.expectedStore) assert.equal(context.getStore(), event.expectedStore, 'Matching IDs and domains retain the invocation context.');
            if (event.expectedLane) assert.equal(context.getStore().lane, event.expectedLane);
            await Promise.resolve();
            assert.deepEqual(getOperationContext(), applicationContext);
            assert.equal(isOperationSuppressed(), event.expectedSuppressed);
            assert.equal(isOperationHookSuppressed('network'), event.expectedSuppressed);
            assert.equal(isOperationHookSuppressed('io'), true);
          })());
        };
        runWithOperationContext(applicationContext, () => withOperationHookSuppressed('io', () => {
          const expectedStore = context.getStore();
          withOperationSuppressed(() => socket.addEventListener('scope-fixture', restored));
          socket.dispatchEvent(Object.assign(new Event('scope-fixture'), { expectedSuppressed: false, expectedStore }));
        }));
        const dispatch = expectedSuppressed => socket.dispatchEvent(Object.assign(new Event('scope-fixture'), { expectedSuppressed, expectedLane: 'dispatch-lane' }));
        context.run({ traceId: 'foreign-trace', parentId: 'foreign-parent', scenarioId: 'foreign-scenario', lane: 'dispatch-lane' }, () => {
          withOperationHookSuppressed('network', () => dispatch(false));
          withOperationSuppressed(() => withOperationHookSuppressed('network', () => dispatch(true)));
        });
        assert.equal(isOperationHookSuppressed('network'), false);
        assert.equal(isOperationHookSuppressed('io'), false);
        socket.addEventListener('open', () => socket.send('sensitive-payload'));
        const message = function (event) {
          assert.equal(this, socket, 'Application property callbacks retain the native receiver.');
          assert.equal(event.data, 'ok');
          assert.deepEqual(getOperationContext(), applicationContext);
          assert.equal(isOperationHookSuppressed('network'), false, 'Application callbacks escape native network suppression.');
          assert.equal(isOperationHookSuppressed('io'), true, 'Application callbacks restore unrelated registered hook scopes.');
          fetch(origin + '/after-message').then(response => response.text()).then(() => socket.close(), reject);
        };
        runWithOperationContext(applicationContext, () => withOperationHookSuppressed('io', () => { socket.onmessage = message; }));
        assert.equal(socket.onmessage, message);
        socket.addEventListener('close', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      await Promise.all(restorationTasks);
      assert.equal(restorationTasks.length, 3);
      assert.equal(events.filter(event => event.name === 'websocket.connect').length, 1);
      assert.equal(events.filter(event => event.name === 'websocket.send').length, 1);
      assert.equal(events.filter(event => event.name === 'websocket.receive').length, 1);
      assert.equal(events.filter(event => event.name === 'websocket.closed').length, 1);
      for (const event of events.filter(event => ['websocket.receive', 'websocket.closed'].includes(event.name))) {
        assert.equal(event.durationMS, 0, 'Already-delivered native events record their observation time without timing the recorder.');
        assert.equal(event.status, 'ok');
        const phases = journal.filter(entry => entry.id === event.id);
        assert.deepEqual(phases.map(entry => entry.phase), ['start', 'end']);
        assert.equal(phases[0].startedAt, phases[1].startedAt);
        assert.equal(phases[0].startedAt, event.startedAt);
      }
      for (const name of ['websocket.connect', 'websocket.send', 'websocket.close']) {
        const timed = events.filter(event => event.name === name);
        assert.equal(timed.length, 1);
        assert.ok(timed[0].durationMS > 0, name + ' still measures the real native operation.');
      }
      assert.equal(events.filter(event => event.name === 'fetch.request').length, 1, 'WebSocket callbacks restore application hook context.');
      assert.deepEqual(observerScopes, [{ context: connectionContext, network: true }], 'Internal observers retain connection IDs and native transport scopes.');
      for (const key of ['traceId', 'parentId', 'scenarioId']) {
        assert.equal(events.find(event => event.name === 'websocket.receive')[key], connectionContext[key]);
        assert.equal(events.find(event => event.name === 'fetch.request')[key], applicationContext[key]);
      }
      const tcp = net.createServer(socket => { socket.on('data', () => {}); socket.end('fixture'); });
      await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
      await new Promise((resolve, reject) => {
        const socket = net.connect(tcp.address().port, '127.0.0.1', () => socket.write('sensitive-payload'));
        socket.on('data', chunk => assert.equal(chunk.toString(), 'fixture'));
        socket.once('error', reject); socket.once('close', resolve);
      });
      await new Promise(resolve => tcp.close(resolve));
      assert.equal(events.filter(event => event.name === 'socket.connect').length, 1);
      assert.equal(events.filter(event => event.name === 'socket.write').length, 1);
      assert.ok(events.some(event => event.name === 'socket.receive' && event.attributes.bytes === 7));
      assert.doesNotMatch(JSON.stringify(events), /credential|sensitive-payload/);
    } finally { await new Promise(resolve => server.close(resolve)); }
    stopObserving(); unsubscribe(); console.log(JSON.stringify({ names: events.filter(event => event.category === 'network').map(event => event.name) }));
  `)
  assert.ok(result.names.includes('websocket.closed'))
  assert.ok(result.names.includes('socket.closed'))
})

test('span contexts inherit invocation hook domains and global suppression across asynchronous siblings', async () => {
  const result = await execute(`
    import { beginOperation, getOperationContext, isOperationSuppressed } from ${JSON.stringify(operationsURL)};
    import { isOperationHookSuppressed, withOperationHookSuppressed } from ${JSON.stringify(hooksURL)};
    const span = beginOperation({ category: 'cpu', name: 'test.domain-inheritance' });
    const ids = { ...span.context }, seen = [];
    const check = (domain, suppressed) => {
      assert.deepEqual(getOperationContext(), ids);
      assert.equal(isOperationSuppressed(), suppressed);
      for (const candidate of ['io', 'network', 'cpu', 'database']) assert.equal(isOperationHookSuppressed(candidate), suppressed || candidate === domain);
      assert.deepEqual(Object.keys(getOperationContext()).sort(), Object.keys(ids).sort());
      assert.deepEqual(Object.getOwnPropertySymbols(getOperationContext()), [], 'Internal domains never cross the public identity boundary.');
    };
    await Promise.all(['io', 'network', undefined].map(domain => {
      const invoke = () => span.run(async () => {
        check(domain, false);
        await Promise.resolve();
        check(domain, false);
        withOperationHookSuppressed('cpu', () => {
          const previous = context.getStore();
          withOperationHookSuppressed('cpu', () => assert.equal(context.getStore(), previous, 'An already suppressed domain reuses its context.'));
          assert.equal(isOperationHookSuppressed('cpu'), true);
          assert.equal(isOperationHookSuppressed('network'), domain === 'network');
        });
        check(domain, false);
        seen.push(domain ?? 'none');
      });
      return domain ? withOperationHookSuppressed(domain, invoke) : invoke();
    }));
    await withOperationSuppressed(() => withOperationHookSuppressed('io', () => span.run(async () => {
      check('io', true); await Promise.resolve(); check('io', true);
    })));
    await span.run(async () => { check(undefined, false); await Promise.resolve(); check(undefined, false); });
    assert.equal(isOperationSuppressed(), false);
    assert.equal(isOperationHookSuppressed('io'), false);
    assert.equal(isOperationHookSuppressed('network'), false);
    assert.deepEqual(span.context, ids);
    span.end();
    assert.equal(events.filter(event => event.name === 'test.domain-inheritance').length, 1);
    unsubscribe(); console.log(JSON.stringify({ siblings: seen.sort() }));
  `)
  assert.deepEqual(result.siblings, ['io', 'network', 'none'])
})

test('injected WebSocket observers retain private connection IDs and live dispatch suppression', async () => {
  const result = await execute(`
    import { recordedWebSocketFactory } from ${JSON.stringify(networkURL)};
    import { getOperationContext } from ${JSON.stringify(operationsURL)};
    import { isOperationHookSuppressed, withOperationHookSuppressed } from ${JSON.stringify(hooksURL)};
    class Socket extends EventTarget {
      readyState = 1;
      send() {}
      close() { this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, wasClean: true })); }
    }
    const registered = { traceId: 'connection-trace', parentId: 'connection-parent', scenarioId: 'connection-scenario', lane: 'registered' };
    const expected = { traceId: registered.traceId, parentId: registered.parentId, scenarioId: registered.scenarioId };
    const socket = context.run(registered, () => recordedWebSocketFactory(() => new Socket(), 'injected')('ws://127.0.0.1/feed'));
    registered.traceId = 'mutated-trace'; registered.parentId = 'mutated-parent'; registered.scenarioId = 'mutated-scenario';
    const observations = [];
    const stop = attachOperationSink(event => {
      if (event.name === 'websocket.receive') observations.push({ ids: getOperationContext(), lane: context.getStore().lane,
        network: isOperationHookSuppressed('network'), io: isOperationHookSuppressed('io') });
    });
    const incoming = () => socket.dispatchEvent(new MessageEvent('message', { data: 'ok' }));
    const foreign = { traceId: 'foreign-trace', parentId: 'foreign-parent', scenarioId: 'foreign-scenario', lane: 'dispatch' };
    context.run(foreign, () => withOperationHookSuppressed('network', () => withOperationHookSuppressed('io', incoming)));
    assert.deepEqual(observations, [{ ids: expected, lane: 'dispatch', network: true, io: true }]);
    assert.deepEqual(foreign, { traceId: 'foreign-trace', parentId: 'foreign-parent', scenarioId: 'foreign-scenario', lane: 'dispatch' });
    const beforeSuppressed = events.length;
    context.run(foreign, () => withOperationSuppressed(incoming));
    assert.equal(events.length, beforeSuppressed);
    context.run(foreign, incoming);
    assert.deepEqual(observations[1], { ids: expected, lane: 'dispatch', network: false, io: false });
    assert.equal(events.filter(event => event.name === 'websocket.receive').length, 2);
    const beforeError = performance.timeOrigin + performance.now();
    context.run(foreign, () => withOperationSuppressed(() => socket.dispatchEvent(new Event('error'))));
    assert.equal(events.filter(event => event.name === 'websocket.error').length, 0);
    context.run(foreign, () => socket.dispatchEvent(new Event('error')));
    const afterError = performance.timeOrigin + performance.now();
    const error = events.find(event => event.name === 'websocket.error');
    assert.equal(error.status, 'error');
    assert.ok(error.startedAt >= beforeError && error.startedAt <= afterError, 'Instant records use the absolute dispatch observation time.');
    socket.close();
    const beforeRemoved = events.length;
    incoming();
    assert.equal(events.length, beforeRemoved, 'Close removes the exact owned observer identities.');
    const closed = events.find(event => event.name === 'websocket.closed');
    for (const key of ['traceId', 'parentId', 'scenarioId']) assert.equal(closed[key], expected[key]);
    assert.equal(events.length, 6, 'One connection, two receives, one error, one close call and one closed event.');
    assert.equal(journal.length, 12, 'Every operation retains both lifecycle records.');
    assert.equal(closed.status, 'ok');
    for (const event of events.filter(event => ['websocket.receive', 'websocket.error', 'websocket.closed'].includes(event.name))) {
      assert.equal(event.durationMS, 0);
      assert.equal(event.cpuTimeMS, undefined);
      for (const key of ['traceId', 'parentId', 'scenarioId']) assert.equal(event[key], expected[key]);
      const phases = journal.filter(entry => entry.id === event.id);
      assert.deepEqual(phases.map(entry => [entry.phase, entry.durationMS]), [['start', 0], ['end', 0]]);
      assert.equal(phases[0].startedAt, phases[1].startedAt);
    }
    stop(); unsubscribe(); console.log(JSON.stringify({ observed: observations.length }));
  `)
  assert.equal(result.observed, 2)
})


test('SQLite capability readback detects replaced native constructor without contaminating other processes', async () => {
  const result=await execute(`
    import sqlite, { DatabaseSync as OriginalNamedConstructor } from 'node:sqlite';
    import { getOperationHookCapabilities, getInstalledOperationHooks } from ${JSON.stringify(hooksURL)};
    const installed=sqlite.DatabaseSync;
    const capability=()=>getOperationHookCapabilities().find(entry=>entry.api==='node:sqlite.DatabaseSync');
    assert.equal(capability().enabled,true);
    sqlite.DatabaseSync=OriginalNamedConstructor;
    assert.equal(capability().enabled,false);
    assert.equal(capability().reason,'hook-replaced-after-installation');
    assert.equal(getInstalledOperationHooks().includes('sqlite'),false);
    sqlite.DatabaseSync=installed;
    assert.equal(capability().enabled,true);
    console.log(JSON.stringify({restored:capability().enabled}));
  `)
  assert.equal(result.restored,true)
})
