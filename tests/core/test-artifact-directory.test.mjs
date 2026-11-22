import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { trashPath } from '../../scripts/electron-delivery.mjs'

const execute = promisify(execFile)
const script = "import {testArtifactDirectory} from './scripts/test-artifact-directory.mjs'; console.log(testArtifactDirectory())"
const env = { ...process.env, PERPETUAL_SWAP_SANDBOX_REPORT_DIR: '', PERPETUAL_SWAP_SANDBOX_WORK_DIR: '' }

test('default process artifacts use private temporary storage and are cleaned on exit', async () => {
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], { env })
  await assert.rejects(access(stdout.trim()), { code: 'ENOENT' })
})

test('sandbox reports are kept in explicit output, otherwise within the run workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'perp-artifact-test-'))
  t.after(() => trashPath(root))
  const work = join(root, 'work'), report = join(root, 'report')
  const selected = async overrides => (await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, ...overrides } })).stdout.trim()
  assert.equal(await selected({ PERPETUAL_SWAP_SANDBOX_WORK_DIR: work }), join(work, 'process-witness'))
  assert.equal(await selected({ PERPETUAL_SWAP_SANDBOX_WORK_DIR: work, PERPETUAL_SWAP_SANDBOX_REPORT_DIR: report }), join(report, 'process-witness'))
})
