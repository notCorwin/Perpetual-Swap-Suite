import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fingerprintInputs, installApp } from '../../scripts/electron-delivery.mjs'

test('packaging fingerprints ignore Finder metadata while detecting changed application inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-swap-fingerprint-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of ['electron', 'dist/assets']) await mkdir(join(root, path), { recursive: true })
  for (const path of ['package.json', 'package-lock.json', 'electron/main.js', 'dist/assets/chart.js']) await writeFile(join(root, path), path)
  const fingerprint = await fingerprintInputs(root)
  for (const path of ['electron/.DS_Store', 'dist/.DS_Store', 'dist/assets/.DS_Store']) await writeFile(join(root, path), 'Finder state')
  assert.equal(await fingerprintInputs(root), fingerprint)
  await writeFile(join(root, 'dist/.DS_Store'), 'Updated Finder state')
  assert.equal(await fingerprintInputs(root), fingerprint)
  await writeFile(join(root, 'dist/assets/chart.js'), 'Updated chart')
  assert.notEqual(await fingerprintInputs(root), fingerprint)
})

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-swap-install-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidate.app')
  const destination = join(root, 'installed.app')
  for (const [path, value] of [[candidate, 'new'], [destination, 'old']]) {
    await mkdir(path)
    await writeFile(join(path, 'revision'), value)
  }
  return {
    root, candidate, destination, revision: 'new',
    copy: (from, to) => cp(from, to, { recursive: true }),
    validate: async (path, revision) => assert.equal(await readFile(join(path, 'revision'), 'utf8'), revision),
    smoke: async path => ({ executable: path }),
  }
}

test('a rejected candidate never changes the installed app', async t => {
  const options = await setup(t)
  options.smoke = async () => { throw new Error('Candidate preload failed') }
  await assert.rejects(installApp(options), /Candidate preload failed/)
  assert.equal(await readFile(join(options.destination, 'revision'), 'utf8'), 'old')
  assert.deepEqual((await readdir(options.root)).sort(), ['candidate.app', 'installed.app'])
})

test('a corrupted staged copy leaves the old app intact', async t => {
  const options = await setup(t)
  options.copy = async (from, to) => {
    await cp(from, to, { recursive: true })
    await writeFile(join(to, 'revision'), 'corrupt')
  }
  await assert.rejects(installApp(options))
  assert.equal(await readFile(join(options.destination, 'revision'), 'utf8'), 'old')
  assert.deepEqual((await readdir(options.root)).sort(), ['candidate.app', 'installed.app'])
})

test('installed smoke failure restores the previous app', async t => {
  const options = await setup(t)
  options.smoke = async path => {
    if (path === options.destination) throw new Error('Installed worker failed')
  }
  await assert.rejects(installApp(options), /Installed worker failed/)
  assert.equal(await readFile(join(options.destination, 'revision'), 'utf8'), 'old')
  assert.deepEqual((await readdir(options.root)).sort(), ['candidate.app', 'installed.app'])
})

test('delivery validates before replacement and smokes the real destination', async t => {
  const options = await setup(t)
  const calls = []
  const validate = options.validate
  options.validate = async (path, revision) => {
    calls.push(['validate', path])
    if (path !== options.destination) assert.equal(await readFile(join(options.destination, 'revision'), 'utf8'), 'old')
    await validate(path, revision)
  }
  options.smoke = async path => { calls.push(['smoke', path]); return { executable: path } }
  const report = await installApp(options)
  assert.deepEqual(calls.map(([kind]) => kind), ['validate', 'smoke', 'validate', 'validate', 'smoke'])
  assert.equal(report.executable, options.destination)
  assert.equal(await readFile(join(options.destination, 'revision'), 'utf8'), 'new')
  assert.deepEqual((await readdir(options.root)).sort(), ['candidate.app', 'installed.app'])
})
