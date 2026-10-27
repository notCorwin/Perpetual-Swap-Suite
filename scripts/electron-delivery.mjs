import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const execute = promisify(execFile)
export const productName = 'Perpetual Swap Suite'

export async function fingerprintInputs(root) {
  const hash = createHash('sha256')
  const visit = async (path, relative) => {
    const info = await lstat(path)
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        // Finder metadata is not a packaging input and can change while an
        // output directory is open without changing the built application.
        if (name === '.DS_Store') continue
        if (relative === 'dist' && (/^mac(?:-|$)/.test(name) || name.startsWith('builder-') || /\.(?:dmg|zip|blockmap)$/.test(name))) continue
        await visit(join(path, name), `${relative}/${name}`)
      }
    } else if (info.isFile()) hash.update(relative).update('\0').update(await readFile(path)).update('\0')
    else throw new Error(`Unsupported packaging input: ${relative}`)
  }
  for (const path of ['electron', 'dist', 'package.json', 'package-lock.json']) await visit(join(root, path), path)
  return hash.digest('hex')
}

export async function quitInstalledApp(destination) {
  const executable = join(destination, 'Contents', 'MacOS', productName)
  const running = async () => {
    const { stdout } = await execute('ps', ['-axww', '-o', 'comm='])
    return stdout.split('\n').some(command => command.trim() === executable)
  }
  if (!await running()) return
  await execute('osascript', ['-e', 'on run argv\nset appPath to item 1 of argv\ntell application appPath to quit\nend run', destination], { timeout: 20_000 })
  const until = Date.now() + 20_000
  while (await running()) {
    if (Date.now() >= until) throw new Error('The installed app did not exit normally. Installation has not replaced it.')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
}

export async function run(command, args, options = {}) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${basename(command)} failed (${signal ?? code}).`)))
  })
}

export async function inspectApp(appPath, expectedRevision) {
  const app = resolve(appPath)
  const info = await lstat(app)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'The app must be a real directory.')
  const executable = join(app, 'Contents', 'MacOS', productName)
  await access(executable, constants.X_OK)
  await access(join(app, 'Contents', 'Resources', 'app.asar'), constants.R_OK)
  const metadata = JSON.parse(await readFile(join(app, 'Contents', 'Resources', 'build-revision.json'), 'utf8'))
  assert.match(metadata.revision ?? '', /^[0-9a-f]{40}$/i, 'Build metadata must contain the full Git revision.')
  assert.equal(metadata.schemaVersion, 1, 'Unsupported build metadata schema.')
  if (expectedRevision) assert.equal(metadata.revision, expectedRevision, 'The packaged revision differs from the expected revision.')
  const { stdout } = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', join(app, 'Contents', 'Info.plist')])
  assert.equal(stdout.trim(), productName)
  await execute('codesign', ['--verify', '--deep', '--strict', app])
  // CodeResources seals resources and nested code. Deep strict verification
  // plus identical main code/plist identifies the installed signed artifact.
  const identity = createHash('sha256')
  for (const path of [executable, join(app, 'Contents', 'Info.plist'), join(app, 'Contents', '_CodeSignature', 'CodeResources')]) {
    identity.update(await readFile(path)).update('\0')
  }
  return { app, executable, metadata, identity: identity.digest('hex') }
}

// Stage beside the destination, so the final renames stay on one filesystem.
// Verification can execute a guarded candidate replica, then check the exact
// signed installed artifact without launching the production app.
export async function installApp({ candidate, destination, revision, validate = inspectApp, verify, beforeReplace = async () => {}, copy = (from, to) => run('ditto', [from, to]) }) {
  assert.equal(typeof verify, 'function', 'An explicit candidate/installed verification contract is required.')
  candidate = resolve(candidate)
  destination = resolve(destination)
  assert.notEqual(candidate, destination, 'The candidate must differ from the installed app.')
  assert.ok(destination.endsWith('.app'), 'The installation destination must be an .app directory.')
  const candidateArtifact = await validate(candidate, revision)
  const candidateVerification = await verify(candidate, revision, { stage: 'candidate', artifact: candidateArtifact })
  await mkdir(dirname(destination), { recursive: true })
  const id = randomUUID()
  const staged = join(dirname(destination), `.${productName}.install-${id}.app`)
  const backup = join(dirname(destination), `.${productName}.backup-${id}.app`)
  let backedUp = false
  let replaced = false
  let verified = false
  try {
    await copy(candidate, staged)
    await validate(staged, revision)
    await beforeReplace(destination)
    try {
      const existing = await lstat(destination)
      assert.ok(existing.isDirectory() && !existing.isSymbolicLink(), 'The installed app must be a real directory.')
      await rename(destination, backup)
      backedUp = true
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await rename(staged, destination)
    replaced = true
    const installedArtifact = await validate(destination, revision)
    const report = await verify(destination, revision, { stage: 'installed', artifact: installedArtifact, candidateArtifact, candidateVerification })
    verified = true
    if (backedUp) await rm(backup, { recursive: true })
    return report
  } catch (error) {
    if (!verified) {
      if (replaced) await rm(destination, { recursive: true, force: true })
      if (backedUp) await rename(backup, destination)
    }
    throw error
  } finally {
    await rm(staged, { recursive: true, force: true })
  }
}
