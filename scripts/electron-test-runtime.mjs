import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, openSync, writeSync } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { assertBackgroundTestLaunch } from '../electron/test-presentation.js'
import { trashPath } from './electron-delivery.mjs'

const execute = promisify(execFile)
const pending = new Map()
const policyVersion = 1
const activeLeases = new Map()
const cacheRootDefault = () => join(process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'perpetual-swap-suite', 'electron-test-runtime')

// A lease is published while the same per-bundle lock used by preparation is
// held. It prevents another process from retiring a replica still in use.
async function holdReplica(directory) {
  if (activeLeases.has(directory)) return
  const users = join(directory, '.users')
  await mkdir(users, { recursive: true })
  const path = join(users, `${process.pid}-${randomUUID()}`)
  await writeFile(path, '', { flag: 'wx' })
  activeLeases.set(directory, path)
  if (activeLeases.size === 1) process.once('exit', () => {
    const paths = [...activeLeases.values()]
    if (paths.length) {
      // Detached renderers can take a moment to exit after their owner; keep
      // an expiry grace marker even when the owner exits normally.
      for (const directory of activeLeases.keys()) {
        try {
          const fd = openSync(join(directory, '.last-release'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600)
          try { writeSync(fd, String(Date.now())) } finally { closeSync(fd) }
        } catch {}
      }
      const result = spawnSync('trash', ['-s', ...paths], { stdio: 'ignore' })
      if (result.status !== 0) console.error('Unable to move test runtime lease records to Trash.')
    }
  })
}

function processMayBeAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

async function hasPotentialUsers(directory) {
  const release = await lstat(join(directory, '.last-release')).catch(() => null)
  if (release && Date.now() - release.mtimeMs < 30_000) return true
  const users = join(directory, '.users')
  const entries = await readdir(users).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const entry of entries) {
    const match = /^(\d+)-[a-f0-9-]+$/.exec(entry)
    const lease = await lstat(join(users, entry)).catch(() => null)
    // Give detached test children time to exit after an owner crashes.
    if (!match || !lease || Date.now() - lease.mtimeMs < 30_000 || processMayBeAlive(Number(match[1]))) return true
  }
  return false
}

async function retireUnusedReplicas(cache, current) {
  for (const name of await readdir(cache)) {
    if (!/^[a-f0-9]{64}$/.test(name) || name === current) continue
    const directory = join(cache, name)
    const info = await lstat(directory).catch(() => null)
    if (!info?.isDirectory() || info.isSymbolicLink()) continue
    // The cache-wide kernel lock is held across preparation, lease creation,
    // and retirement, so a replica cannot acquire a new user while retiring.
    if (!await hasPotentialUsers(directory)) await trashPath(directory)
  }
}

// Metadata includes file inode/modify time, so replacing or changing a runtime/build
// invalidates reuse without repeatedly reading hundreds of MB of Electron code.
export async function fingerprintBundle(source) {
  const hash = createHash('sha256').update(`mac-test-policy:${policyVersion}\0${resolve(source)}\0`)
  const visit = async path => {
    const info = await lstat(path, { bigint: true })
    // clonefile can alter source ctime/flags, and Finder changes directory
    // timestamps. Neither changes the bytes in the source application.
    hash.update(`${relative(source, path)}\0${info.mode}\0`)
    if (info.isSymbolicLink()) hash.update(await readlink(path))
    else if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) if (name !== '.DS_Store') await visit(join(path, name))
    } else if (info.isFile()) hash.update(`${info.size}:${info.ino}:${info.dev}:${info.mtimeNs}\0`)
    else throw new Error(`Unsupported Electron bundle entry: ${path}`)
  }
  await visit(source)
  return hash.digest('hex')
}

async function appPlists(bundle) {
  const paths = []
  const visit = async path => {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return
    if (path.endsWith('.app')) paths.push(join(path, 'Contents', 'Info.plist'))
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await visit(join(path, entry.name))
  }
  await visit(bundle)
  return paths
}

export async function cloneBundle(source, destination, command = execute) {
  try { await command('/bin/cp', ['-cR', source, destination]) }
  catch {
    // APFS clone is cheap; ditto also supports non-APFS cache locations.
    await trashPath(destination)
    await command('/usr/bin/ditto', [source, destination])
  }
}

async function nativePrepare(source, destination, command) {
  await cloneBundle(source, destination, command)
  for (const plist of await appPlists(destination)) {
    const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
    const info = JSON.parse(stdout)
    info.LSBackgroundOnly = true
    info.LSUIElement = false
    if (info.CFBundleIdentifier) info.CFBundleIdentifier += '.background-tests'
    // Keep XML readable by the synchronous pre-spawn/main-process guard.
    await writeFile(plist, JSON.stringify(info))
    await command('/usr/bin/plutil', ['-convert', 'xml1', plist])
  }
  await command('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', destination])
}

async function lock(path) {
  const deadline = Date.now() + 60_000
  const handle = await open(path, 'a+', 0o600)
  try {
    for (;;) {
      const command = process.platform === 'darwin' ? '/usr/bin/lockf' : 'flock'
      const args = process.platform === 'darwin' ? ['-t', '0', '3'] : ['-n', '3']
      const acquired = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe', handle.fd], encoding: 'utf8' })
      if (acquired.error) throw acquired.error
      if (acquired.status === 0) return () => handle.close()
      if (Date.now() >= deadline) throw new Error(`Timed out preparing the guarded Electron bundle: ${path}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  } catch (error) { await handle.close(); throw error }
}

export async function prepareBackgroundApp({ sourceApp, executableName, cacheRoot,
  platform = process.platform, command = execute, prepare = nativePrepare, acquireLock = lock } = {}) {
  if (platform !== 'darwin') throw new Error('Background-only macOS bundles require macOS.')
  const managed = !cacheRoot
  cacheRoot ??= cacheRootDefault()
  const source = await realpath(sourceApp)
  const info = await lstat(source)
  if (!source.endsWith('.app') || !info.isDirectory()) throw new Error('A source .app bundle is required.')
  if (!executableName || basename(executableName) !== executableName) throw new Error('A bundle executable name is required.')
  await access(join(source, 'Contents', 'MacOS', executableName), constants.X_OK)
  const sourceFingerprint = await fingerprintBundle(source)
  const key = createHash('sha256').update(`${sourceFingerprint}\0${executableName}`).digest('hex')
  await mkdir(resolve(cacheRoot), { recursive: true })
  const rootPath = await realpath(cacheRoot)
  // Independent sources (e.g. development Electron and a packaged app) are
  // separate cache families: using one must not evict the other.
  const sourceKey = createHash('sha256').update(`${source}\0${executableName}`).digest('hex')
  const groupPath = managed ? join(rootPath, sourceKey) : rootPath
  if (managed) await mkdir(groupPath, { recursive: true })
  const directory = join(groupPath, key)
  const cacheRelative = relative(source, directory)
  if (cacheRelative !== '..' && !cacheRelative.startsWith('../')) throw new Error('The test cache must be outside the source bundle.')
  if (pending.has(directory)) return pending.get(directory)
  const task = (async () => {
    const release = await acquireLock(join(rootPath, '.lock'))
    const app = join(directory, basename(source)), executable = join(app, 'Contents', 'MacOS', executableName)
    const guardPath = join(directory, 'guard.json')
    const descriptor = { schemaVersion: 1, presentation: 'background-only-offscreen', sourceApp: source, sourceFingerprint, app, executable }
    const verify = async () => {
      const guard = JSON.parse(await readFile(guardPath, 'utf8'))
      if (JSON.stringify(guard) !== JSON.stringify(descriptor)) throw new Error('The cached test guard does not match the runtime/build.')
      assertBackgroundTestLaunch({ executable, platform, environment: { PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_USER_DATA: join(directory, 'preflight-profile'), PERPETUAL_SWAP_TEST_GUARD: guardPath } })
      await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
      return { ...descriptor, guardPath }
    }
    let staging
    try {
      let existing
      try {
        existing = await verify()
      } catch (error) {
        // Corrupt/incomplete replicas are disposable; source and production
        // bundles are never edited, re-signed, or launched by preparation.
        if (error.code !== 'ENOENT' && !await lstat(directory).catch(() => null)) throw error
        if (managed && await hasPotentialUsers(directory)) throw new Error('A test runtime currently in use failed verification; wait for active tests to exit before retrying.', { cause: error })
        await trashPath(directory)
      }
      if (existing) {
        // The source may have changed while this process waited for the cache
        // lock. Do not return the old replica under the obsolete fingerprint.
        if (await fingerprintBundle(source) !== sourceFingerprint) throw new Error('The source Electron bundle changed during preparation.')
        if (managed) await holdReplica(directory)
        if (managed) await retireUnusedReplicas(groupPath, key)
        return existing
      }
      staging = `${directory}.preparing-${randomUUID()}`
      await mkdir(staging)
      await prepare(source, join(staging, basename(source)), command)
      if (await fingerprintBundle(source) !== sourceFingerprint) throw new Error('The source Electron bundle changed during preparation.')
      await writeFile(join(staging, 'guard.json'), `${JSON.stringify(descriptor)}\n`)
      await rename(staging, directory)
      staging = undefined
      const prepared = await verify()
      if (managed) await holdReplica(directory)
      if (managed) await retireUnusedReplicas(groupPath, key)
      return prepared
    } finally {
      if (staging) await trashPath(staging)
      await release()
    }
  })()
  pending.set(directory, task)
  try {
    return await task
  } finally { pending.delete(directory) }
}

export async function prepareTestElectron(options = {}) {
  const packageDirectory = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
  const path = (await readFile(join(packageDirectory, 'path.txt'), 'utf8')).trim()
  if (path !== 'Electron.app/Contents/MacOS/Electron') throw new Error('Unsupported Electron package path; refusing an unguarded macOS test launch.')
  const prepared = await prepareBackgroundApp({ ...options, sourceApp: join(packageDirectory, 'dist', 'Electron.app'), executableName: 'Electron' })
  return { ...prepared, distOverride: dirname(prepared.app) }
}

export function backgroundTestEnvironment(prepared, environment = process.env) {
  if (!environment.PERPETUAL_SWAP_USER_DATA || !isAbsolute(environment.PERPETUAL_SWAP_USER_DATA)) throw new Error('An absolute isolated test profile path is required before launch.')
  const env = { ...environment, PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_TEST_GUARD: prepared.guardPath,
    ...(prepared.distOverride ? { ELECTRON_OVERRIDE_DIST_PATH: prepared.distOverride } : {}) }
  assertBackgroundTestLaunch({ executable: prepared.executable, environment: env, platform: 'darwin' })
  return env
}
