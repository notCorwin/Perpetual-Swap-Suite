import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeBuildReuseManifest, verifyBuildReuseManifest } from '../../scripts/build-artifact-reuse.mjs'
import { preparePackagedRenderer } from '../../scripts/package-electron.mjs'
import { runAcceptance } from '../../scripts/test-acceptance.mjs'

const revision = 'a'.repeat(40)
const workspace = async t => {
  const root = await mkdtemp(join(tmpdir(), 'packaged-acceptance-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('acceptance requires an explicitly chosen output directory', async () => {
  let executions = 0
  for (const options of [{}, { report: '/tmp/report.json' }]) await assert.rejects(runAcceptance({ ...options, app: '/candidate.app', revision }, {
    sandbox: async () => { executions++ },
  }), /--output/)
  assert.equal(executions, 0)
})

test('acceptance writes results at the explicit output and optional report', async t => {
  const root = await workspace(t)
  for (const options of [{ output: 'results' }, { output: 'results', report: 'report.json' }]) {
    const expected = join(root, options.output)
    const result = await runAcceptance({ root, ...options, app: '/candidate.app', revision }, {
      sandbox: async ({ args, output }) => {
        assert.equal(output, join(expected, 'sandbox'))
        const smoke = args[args.indexOf('--report') + 1]
        assert.equal(smoke, join(expected, 'smoke.json'))
        await writeFile(smoke, JSON.stringify({ ok: true, revision }))
        return { exitCode: 0, directory: output }
      },
    })
    assert.equal(result.ok, true)
    assert.equal(JSON.parse(await readFile(join(root, options.report ?? 'results/result.json'), 'utf8')).ok, true)
  }
  await assert.rejects(readFile(join(root, 'artifacts', 'acceptance', 'result.json')), { code: 'ENOENT' })
})

for (const change of ['source', 'output']) test(`packaging rejects a stale renderer ${change} without silently rebuilding`, async t => {
  const root = await workspace(t), manifestPath = join(root, 'artifacts/renderer.json')
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'src/index.js'), 'export const price = 1\n')
  await writeFile(join(root, 'dist/index.html'), '<main>one</main>')
  const toolchain = { node: 'test', npm: 'test', platform: 'darwin', architecture: 'arm64', systemRelease: 'test' }
  const options = { root, manifestPath, toolchain, environment: {} }
  await writeBuildReuseManifest(options)
  await writeFile(join(root, change === 'source' ? 'src/index.js' : 'dist/index.html'), 'changed')
  let builds = 0
  await assert.rejects(preparePackagedRenderer({ root, reuseBuildManifest: manifestPath }, {
    verify: () => verifyBuildReuseManifest(options), execute: async () => { builds++ },
  }), /Build reuse rejected/)
  assert.equal(builds, 0)
})

test('a packaging failure prevents smoke execution and produces a failed report', async t => {
  const root = await workspace(t), report = join(root, 'result.json')
  let executions = 0
  await assert.rejects(runAcceptance({ root, report, output: 'results' }, {
    readRevision: async () => revision,
    packageApp: async () => { throw new Error('Packaging inputs changed') },
    sandbox: async () => { executions++ },
  }), /Packaging inputs changed/)
  assert.equal(executions, 0)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.ok, false)
  assert.match(result.error, /Packaging inputs changed/)
})

test('a sandbox recording failure cannot be hidden by a passing smoke report', async t => {
  const root = await workspace(t), report = join(root, 'result.json')
  await assert.rejects(runAcceptance({ root, report, output: 'results', app: '/candidate.app', revision }, {
    packageApp: async () => { assert.fail('Explicit artifacts must not trigger packaging.') },
    sandbox: async ({ args }) => {
      await writeFile(args[args.indexOf('--report') + 1], JSON.stringify({ ok: true, revision }))
      return { exitCode: 1, directory: join(root, 'recordings') }
    },
  }), /Packaged acceptance failed/)
  assert.equal(JSON.parse(await readFile(report, 'utf8')).ok, false)
})

test('an explicit artifact must report the complete expected revision before acceptance passes', async t => {
  const root = await workspace(t), report = join(root, 'result.json')
  await assert.rejects(runAcceptance({ root, report, output: 'results', app: '/candidate.app', revision }, {
    sandbox: async ({ args }) => {
      await writeFile(args[args.indexOf('--report') + 1], JSON.stringify({ ok: true, revision: 'b'.repeat(40) }))
      return { exitCode: 0, directory: join(root, 'recordings') }
    },
  }), /expected revision/)
  const result = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(result.ok, false)
  assert.match(result.artifactSelection, /current workspace equivalence not asserted/)
})

test('ambiguous artifact selection and abbreviated revisions cannot start packaging or smoke', async () => {
  let executions = 0
  const dependencies = { packageApp: async () => { executions++ }, sandbox: async () => { executions++ } }
  await assert.rejects(runAcceptance({ app: '/candidate.app', revision, reuseBuildManifest: 'renderer.json' }, dependencies), /cannot be combined/)
  await assert.rejects(runAcceptance({ revision: 'abcdef0' }, dependencies), /full expected Git revision/)
  assert.equal(executions, 0)
})
