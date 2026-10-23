import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBackgroundTestLaunch } from '../electron/test-presentation.js'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const pending = new Map()
const policyVersion = 1

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
    await rm(destination, { recursive: true, force: true })
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
  for (;;) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      return () => rm(path, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = Number(await readFile(path, 'utf8').catch(() => ''))
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0) } catch (failure) { if (failure.code === 'ESRCH') { await rm(path, { force: true }); continue } }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out preparing the guarded Electron bundle: ${path}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
}

export async function prepareBackgroundApp({ sourceApp, executableName, cacheRoot = join(root, '.build', 'electron-test-runtime'),
  platform = process.platform, command = execute, prepare = nativePrepare } = {}) {
  if (platform !== 'darwin') throw new Error('Background-only macOS bundles require macOS.')
  const source = await realpath(sourceApp)
  const info = await lstat(source)
  if (!source.endsWith('.app') || !info.isDirectory()) throw new Error('A source .app bundle is required.')
  if (!executableName || basename(executableName) !== executableName) throw new Error('A bundle executable name is required.')
  await access(join(source, 'Contents', 'MacOS', executableName), constants.X_OK)
  const sourceFingerprint = await fingerprintBundle(source)
  const key = createHash('sha256').update(`${sourceFingerprint}\0${executableName}`).digest('hex')
  await mkdir(resolve(cacheRoot), { recursive: true })
  const directory = join(await realpath(cacheRoot), key)
  const cacheRelative = relative(source, directory)
  if (cacheRelative !== '..' && !cacheRelative.startsWith('../')) throw new Error('The test cache must be outside the source bundle.')
  if (pending.has(directory)) return pending.get(directory)
  const task = (async () => {
    const release = await lock(`${directory}.lock`)
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
      try { return await verify() } catch (error) {
        // Corrupt/incomplete replicas are disposable; source and production
        // bundles are never edited, re-signed, or launched by preparation.
        if (error.code !== 'ENOENT' && !await lstat(directory).catch(() => null)) throw error
      }
      await rm(directory, { recursive: true, force: true })
      staging = `${directory}.preparing-${randomUUID()}`
      await mkdir(staging)
      await prepare(source, join(staging, basename(source)), command)
      if (await fingerprintBundle(source) !== sourceFingerprint) throw new Error('The source Electron bundle changed during preparation.')
      await writeFile(join(staging, 'guard.json'), `${JSON.stringify(descriptor)}\n`)
      await rename(staging, directory)
      staging = undefined
      return await verify()
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true })
      await release()
    }
  })()
  pending.set(directory, task)
  try { return await task } finally { pending.delete(directory) }
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
