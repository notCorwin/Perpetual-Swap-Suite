import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runBuildAndWriteManifest, verifyBuildReuseManifest, writeBuildReuseManifest } from '../../scripts/build-artifact-reuse.mjs'

const toolchain = { node: 'v24.22.0', npm: '12.2.0', platform: 'darwin', architecture: 'arm64', systemRelease: '24.0.0' }
const environment = { CI: 'true', NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=4096', TSC_COMPILE_ON_ERROR: 'true', VITE_PUBLIC_URL: '/app/' }

async function fixture(root) {
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'dist', 'assets'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"scripts":{"build":"vite build"}}\n')
  await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
  await writeFile(join(root, '.nvmrc'), '24.22.0\n')
  await writeFile(join(root, 'src', 'entry.tsx'), 'export const value = 1\n')
  await writeFile(join(root, 'dist', 'index.html'), '<script src="/assets/app.js"></script>\n')
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'const value = 1\n')
}

test('build reuse validates lock, toolchain, current inputs and the exact output file set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-reuse-'))
  const manifestPath = '.build/renderer.json'
  try {
    await fixture(root)
    await writeBuildReuseManifest({ root, manifestPath, toolchain, environment })
    await verifyBuildReuseManifest({ root, manifestPath, toolchain, environment })
    await mkdir(join(root, '.venv'), { recursive: true })
    await writeFile(join(root, '.venv', 'python-helper'), 'Auxiliary tooling is not a Vite input.')
    await writeFile(join(root, '.DS_Store'), 'Finder state must not invalidate a Node renderer build.')
    await verifyBuildReuseManifest({ root, manifestPath, toolchain, environment })
    await verifyBuildReuseManifest({ root, manifestPath, toolchain, environment: {
      ...environment,
      INIT_CWD: root,
      npm_lifecycle_event: 'test:e2e',
      npm_package_name: 'perp-radar',
      PERPETUAL_SWAP_RESOURCE_REPORT: 'artifacts/market-resources.json',
      PERPETUAL_SWAP_UI_VISUAL_OUTPUT: 'artifacts/workspace-visual',
    } })

    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n')
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /source, lockfile/)
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n')
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain,
      environment: { ...environment, VITE_PUBLIC_URL: '/changed/' } }), /source, lockfile/)
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain,
      environment: { ...environment, NODE_ENV: 'development' } }), /source, lockfile/)
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain,
      environment: { ...environment, NODE_OPTIONS: '--trace-warnings' } }), /source, lockfile/)

    await rm(join(root, 'src', 'entry.tsx'))
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /source, lockfile/)
    await writeFile(join(root, 'src', 'entry.tsx'), 'export const value = 1\n')

    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain: { ...toolchain, node: 'v24.23.0' }, environment }), /source, lockfile/)

    await writeFile(join(root, 'dist', 'assets', 'app.js'), 'const value = 2\n')
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /output changed or is incomplete/)
    await writeFile(join(root, 'dist', 'assets', 'app.js'), 'const value = 1\n')

    await rm(join(root, 'dist', 'index.html'))
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /output changed or is incomplete/)
    await writeFile(join(root, 'dist', 'index.html'), '<script src="/assets/app.js"></script>\n')

    await writeFile(join(root, 'dist', 'unexpected.js'), 'stale output\n')
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /output changed or is incomplete/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failed builds remove any previous reuse manifest and generated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-reuse-failed-'))
  const manifestPath = '.build/renderer.json'
  try {
    await fixture(root)
    await writeBuildReuseManifest({ root, manifestPath, toolchain, environment })
    await assert.rejects(runBuildAndWriteManifest({ root, manifestPath, toolchain, environment,
      command: [process.execPath, '-e', 'process.exit(17)'] }), /exit code 17/)
    await assert.rejects(access(join(root, manifestPath)), { code: 'ENOENT' })
    await assert.rejects(access(join(root, 'dist')), { code: 'ENOENT' })
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /unavailable or invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a successful build cannot bless source files changed while it was running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-reuse-changing-input-'))
  const manifestPath = '.build/renderer.json'
  try {
    await fixture(root)
    const script = `import { mkdir, writeFile } from 'node:fs/promises';
      await writeFile('src/entry.tsx', 'export const value = 2\\n');
      await mkdir('dist', { recursive: true });
      await writeFile('dist/index.html', '<main>built</main>\\n');`
    await assert.rejects(runBuildAndWriteManifest({ root, manifestPath, toolchain, environment,
      command: [process.execPath, '--input-type=module', '-e', script] }), /changed while the renderer was being built/)
    await assert.rejects(access(join(root, manifestPath)), { code: 'ENOENT' })
    await assert.rejects(verifyBuildReuseManifest({ root, manifestPath, toolchain, environment }), /unavailable or invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
