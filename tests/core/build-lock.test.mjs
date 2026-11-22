import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildLockPath, withBuildLock } from '../../scripts/build-lock.mjs'
import { trashPath } from '../../scripts/electron-delivery.mjs'

const lockModule = new URL('../../scripts/build-lock.mjs', import.meta.url).href
const deliveryModule = new URL('../../scripts/electron-delivery.mjs', import.meta.url).href
const attempt = (root, environment = process.env) => spawnSync(process.execPath, ['--input-type=module', '-e',
  `import {withBuildLock} from ${JSON.stringify(lockModule)}; await withBuildLock(process.argv[1], async () => {})`, root], { encoding: 'utf8', env: environment })

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'perpetual-build-lock-test-'))
  const lock = await buildLockPath(root)
  t.after(async () => { await trashPath(root); await trashPath(lock) })
  return root
}

test('concurrent builds fail before they can touch the shared outputs', async t => {
  const root = await fixture(t)
  await withBuildLock(root, async () => {
    const result = attempt(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Another build or packaging operation/)
    const sandbox = attempt(root, { ...process.env, TMPDIR: root, TMP: root, TEMP: root })
    assert.notEqual(sandbox.status, 0)
    assert.match(sandbox.stderr, /Another build or packaging operation/)
  })
  assert.equal(attempt(root).status, 0)
})

test('an orphaned build child retains the kernel lock until it exits', async t => {
  const root = await fixture(t)
  const program = `import {withBuildLock} from ${JSON.stringify(lockModule)};
    import {run} from ${JSON.stringify(deliveryModule)};
    await withBuildLock(process.argv[1], () => run(process.execPath, ['-e', 'console.log("child-ready"); setTimeout(()=>{}, 1500)']))`
  const owner = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL') })
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('Build child did not start.')), 5000)
    owner.once('error', reject)
    owner.stdout.on('data', data => { if (String(data).includes('child-ready')) { clearTimeout(timer); resolveReady() } })
  })
  owner.kill('SIGKILL')
  await new Promise(resolveExit => owner.once('exit', resolveExit))
  const held = attempt(root)
  assert.notEqual(held.status, 0)
  assert.match(held.stderr, /Another build or packaging operation/)
  await new Promise(resolveClose => owner.once('close', resolveClose))
  assert.equal(attempt(root).status, 0)
})
