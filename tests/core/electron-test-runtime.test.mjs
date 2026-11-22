import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertBackgroundTestLaunch, testWindowOptions } from '../../electron/test-presentation.js'
import { backgroundTestEnvironment, fingerprintBundle, prepareBackgroundApp } from '../../scripts/electron-test-runtime.mjs'
import { installTestLaunchGuard } from '../../scripts/electron-test-launch-register.mjs'
import { trashPath } from '../../scripts/electron-delivery.mjs'

const safePlist = '<plist><dict><key>LSBackgroundOnly</key><true/><key>LSUIElement</key><false/></dict></plist>'

test('shared replicas are reused and old fingerprints remain while another process holds a lease', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'perp-shared-runtime-'))
  const sourceApp = join(directory, 'Electron.app')
  await mkdir(join(sourceApp, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(sourceApp, 'Contents', 'Info.plist'), '<plist><dict/></plist>')
  await writeFile(join(sourceApp, 'Contents', 'MacOS', 'Electron'), 'version one', { mode: 0o755 })
  const moduleUrl = new URL('../../scripts/electron-test-runtime.mjs', import.meta.url).href
  const script = `import { cp, writeFile } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import { prepareBackgroundApp } from ${JSON.stringify(moduleUrl)};
    let count = 0;
    const result = await prepareBackgroundApp({ sourceApp: process.env.TEST_SOURCE_APP, executableName: 'Electron', platform: 'darwin',
      command: async () => ({ stdout: '' }), prepare: async (from, to) => { count++; await cp(from, to, { recursive: true }); await writeFile(join(to, 'Contents', 'Info.plist'), ${JSON.stringify(safePlist)}); } });
    console.log('RESULT=' + JSON.stringify({ directory: dirname(result.app), count }));
    if (process.env.HOLD_TEST_RUNTIME === '1') await new Promise(resolve => process.stdin.once('data', resolve));`
  const launch = (hold, source = sourceApp) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: directory, XDG_CACHE_HOME: join(directory, '.cache'), TEST_SOURCE_APP: source, HOLD_TEST_RUNTIME: hold ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { output += chunk; const match = /^RESULT=(.+)$/m.exec(output); if (match) resolve(JSON.parse(match[1])) })
      child.stderr.on('data', chunk => { output += chunk })
      child.on('error', reject)
      child.on('close', code => { if (code !== 0) reject(new Error(output)) })
    })
    const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(output))) })
    return { child, ready, closed }
  }
  let first, peer
  try {
    first = launch(true)
    peer = launch(true)
    const [old, same] = await Promise.all([first.ready, peer.ready])
    assert.equal(same.directory, old.directory)
    assert.deepEqual([old.count, same.count].sort(), [0, 1], 'Concurrent preparations share one replica.')
    const alternateSource = join(directory, 'Packaged.app')
    await cp(sourceApp, alternateSource, { recursive: true })
    const alternateRun = launch(false, alternateSource), alternate = await alternateRun.ready
    await alternateRun.closed
    await utimes(join(alternate.directory, '.last-release'), 1, 1)
    await writeFile(join(sourceApp, 'Contents', 'MacOS', 'Electron'), 'version two', { mode: 0o755 })
    const second = launch(false), current = await second.ready
    await second.closed
    assert.notEqual(current.directory, old.directory)
    await access(old.directory)
    first.child.stdin.end('exit')
    await first.closed
    first = undefined
    await utimes(join(old.directory, '.last-release'), 1, 1)
    const third = launch(false), reused = await third.ready
    await third.closed
    assert.equal(reused.directory, current.directory)
    assert.equal(reused.count, 0, 'Unchanged Electron bundles reuse the guarded replica.')
    await access(old.directory)
    peer.child.stdin.end('exit')
    await peer.closed
    peer = undefined
    await utimes(join(old.directory, '.last-release'), 1, 1)
    const fourth = launch(false)
    await fourth.ready
    await fourth.closed
    await assert.rejects(access(old.directory), { code: 'ENOENT' })
    await access(dirname(current.directory))
    const alternateAgain = launch(false, alternateSource), alternateReused = await alternateAgain.ready
    await alternateAgain.closed
    assert.equal(alternateReused.directory, alternate.directory)
    assert.equal(alternateReused.count, 0, 'Different app sources keep independent reusable replicas.')
  } finally {
    if (first) { first.child.stdin.end('exit'); await first.closed.catch(() => {}) }
    if (peer) { peer.child.stdin.end('exit'); await peer.closed.catch(() => {}) }
    await trashPath(directory)
  }
})
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'perp-background-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sourceApp = join(directory, 'Electron.app'), cacheRoot = join(directory, 'cache')
  const executableName = 'Electron'
  await mkdir(join(sourceApp, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(sourceApp, 'Contents', 'Info.plist'), '<plist><dict/></plist>')
  await writeFile(join(sourceApp, 'Contents', 'MacOS', executableName), 'NOT A NATIVE EXECUTABLE')
  await chmod(join(sourceApp, 'Contents', 'MacOS', executableName), 0o755)
  const commands = [], preparations = []
  const options = { sourceApp, executableName, cacheRoot, platform: 'darwin',
    command: async (...args) => { commands.push(args); return { stdout: '' } },
    prepare: async (from, to) => {
      preparations.push([from, to])
      await cp(from, to, { recursive: true })
      await writeFile(join(to, 'Contents', 'Info.plist'), safePlist)
    } }
  return { directory, sourceApp, cacheRoot, options, preparations, commands }
}

test('preparation reuses one guarded replica concurrently, never mutating the original bundle', async t => {
  const { directory, sourceApp, options, preparations, commands } = await fixture(t)
  const original = await fingerprintBundle(sourceApp)
  const [first, second] = await Promise.all([prepareBackgroundApp(options), prepareBackgroundApp(options)])
  assert.equal(first.executable, second.executable)
  assert.equal(preparations.length, 1)
  assert.equal(await fingerprintBundle(sourceApp), original)
  assert.equal(await readFile(join(sourceApp, 'Contents', 'Info.plist'), 'utf8'), '<plist><dict/></plist>')
  const again = await prepareBackgroundApp(options)
  assert.equal(again.executable, first.executable)
  assert.equal(preparations.length, 1)
  assert.equal(commands.length, 2, 'Each reuse revalidates the cached signature before allowing a launch.')
  assert.ok(commands.every(([command, args]) => command === '/usr/bin/codesign' && args[0] === '--verify'))
  const environment = backgroundTestEnvironment(first, { PERPETUAL_SWAP_USER_DATA: join(directory, 'isolated-profile') })
  assert.doesNotThrow(() => assertBackgroundTestLaunch({ executable: first.executable, environment, platform: 'darwin' }))
  assert.equal(environment.PERPETUAL_SWAP_TEST_UI, 'background')
})

test('cache validity ignores clone ctime and directory metadata but detects file/build changes', async t => {
  const { sourceApp, options, preparations } = await fixture(t)
  const first = await prepareBackgroundApp(options)
  // Same-mode chmod changes ctime; APFS clonefile may do the same.
  await chmod(join(sourceApp, 'Contents', 'MacOS', 'Electron'), 0o755)
  await utimes(join(sourceApp, 'Contents'), 1, 2)
  await writeFile(join(sourceApp, '.DS_Store'), 'Finder state')
  assert.equal((await prepareBackgroundApp(options)).executable, first.executable)
  assert.equal(preparations.length, 1)
  await writeFile(join(sourceApp, 'Contents', 'MacOS', 'Electron'), 'changed runtime build')
  assert.notEqual((await prepareBackgroundApp(options)).executable, first.executable)
  assert.equal(preparations.length, 2)
})

test('a cached replica is not returned if its source changes while waiting for the cache lock', async t => {
  const { sourceApp, options, preparations } = await fixture(t)
  await prepareBackgroundApp(options)
  assert.equal(preparations.length, 1)
  let released = false
  await assert.rejects(prepareBackgroundApp({ ...options, acquireLock: async () => {
    await writeFile(join(sourceApp, 'Contents', 'MacOS', 'Electron'), 'new runtime while waiting')
    return async () => { released = true }
  } }), /source Electron bundle changed during preparation/)
  assert.equal(released, true)
  assert.equal(preparations.length, 1, 'An outdated replica must not be rebuilt or returned under the old fingerprint.')
  await prepareBackgroundApp(options)
  assert.equal(preparations.length, 2, 'A later request prepares the new fingerprint.')
})

test('corrupt guard/plist or signature is rejected before spawn, and a later preparation repairs the replica', async t => {
  const { directory, options, preparations } = await fixture(t)
  const prepared = await prepareBackgroundApp(options)
  const environment = backgroundTestEnvironment(prepared, { PERPETUAL_SWAP_USER_DATA: join(directory, 'isolated-profile') })
  let spawned = 0
  const target = { spawn() { spawned++; return 'spawned' } }
  installTestLaunchGuard(target, 'darwin')
  assert.throws(() => target.spawn(prepared.executable, [], { env: { PERPETUAL_SWAP_TEST_UI: 'background' } }), /isolated test profile/)
  assert.equal(spawned, 0)
  assert.throws(() => target.spawn(prepared.executable, [], { env: { ...environment, PERPETUAL_SWAP_TEST_GUARD: '' } }), /pre-launch background guard is missing/)
  assert.equal(spawned, 0)
  assert.throws(() => target.spawn(join(options.sourceApp, 'Contents', 'MacOS', 'Electron'), [], { env: environment }), /not the prepared test replica/)
  assert.equal(spawned, 0)
  await writeFile(join(prepared.app, 'Contents', 'Info.plist'), safePlist.replace('<true/>', '<false/>'))
  assert.throws(() => target.spawn(prepared.executable, [], { env: environment }), /LSBackgroundOnly must be true before process launch/)
  assert.equal(spawned, 0)
  await prepareBackgroundApp(options)
  assert.equal(preparations.length, 2)
  assert.equal(target.spawn(prepared.executable, [], { env: environment }), 'spawned')
  assert.equal(spawned, 1, 'Only a complete preflight may reach even the injected spawn.')
  const badSignature = { ...options, command: async () => { throw new Error('invalid code signature') } }
  await assert.rejects(prepareBackgroundApp(badSignature), /invalid code signature/)
})

test('failed bundle preparation publishes no launchable guard and releases its lock', async t => {
  const { options, cacheRoot } = await fixture(t)
  await assert.rejects(prepareBackgroundApp({ ...options, prepare: async () => { throw new Error('injected preparation failure') } }), /injected preparation failure/)
  assert.deepEqual(await readdir(cacheRoot), ['.lock'], 'Only the stable kernel lock file remains after a failed preparation.')
  const prepared = await prepareBackgroundApp(options)
  assert.ok(prepared.guardPath)
})

test('background UI retains a real frameless offscreen renderer and cannot focus or throttle it', () => {
  const { webPreferences, ...window } = testWindowOptions(true)
  assert.deepEqual(window, { show: false, focusable: false, frame: false })
  assert.deepEqual(webPreferences, { offscreen: true, backgroundThrottling: false })
  assert.equal(testWindowOptions(false).webPreferences.offscreen, false)
})

test('an ordinary Node sandbox command never prepares Electron or accepts a raw app launch', async t => {
  const { directory } = await fixture(t)
  const runner = fileURLToPath(new URL('../../scripts/test-sandbox.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [runner, 'command', '--allow-empty', '--output', directory, '--', 'node', '-e', 'console.log("node-only-command")'],
    { encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELECTRON_OVERRIDE_DIST_PATH: '/missing-unsafe-runtime' } })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /node-only-command/)
  assert.doesNotMatch(result.stdout, /background-only bundle/)
  let spawned = false
  const target = { spawn() { spawned = true } }
  installTestLaunchGuard(target, 'darwin')
  assert.throws(() => target.spawn('/Applications/Any.app/Contents/MacOS/Any', [], { env: { PERPETUAL_SWAP_USER_DATA: '/isolated' } }), /pre-launch background guard is missing/)
  assert.equal(spawned, false)
})

test('Electron embedded Node measurements do not require a graphical test replica', () => {
  let spawned = 0
  const target = { spawn() { spawned++; return 'node-only' } }
  installTestLaunchGuard(target, 'darwin')
  const executable = '/runtime/Electron.app/Contents/MacOS/Electron'
  assert.equal(target.spawn(executable, ['--input-type=module'], { env: { ELECTRON_RUN_AS_NODE: '1' } }), 'node-only')
  assert.equal(spawned, 1)
  assert.throws(() => target.spawn(executable, [], { env: { PERPETUAL_SWAP_USER_DATA: '/isolated' } }), /pre-launch background guard is missing/)
  assert.equal(spawned, 1, 'The same executable still requires preflight in application mode.')
})
