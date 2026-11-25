#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backgroundTestEnvironment, prepareTestElectron } from './electron-test-runtime.mjs'
import { buildRenderer } from './build-renderer.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const mode = process.argv[2] ?? 'unit'
const extra = process.argv.slice(3)

function listFiles(dir, suffix) {
  const full = join(root, dir)
  if (!existsSync(full)) return []
  return readdirSync(full).filter(f => f.endsWith(suffix)).sort().map(f => join(dir, f))
}

function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function unitTestFiles() {
  return [...listFiles('src', '.test.ts'), ...listFiles('tests/core', '.test.mjs')]
}

function findChangedTests() {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  const changed = new Set([
    ...git(['diff', '--name-only', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ])
  if (!changed.size) return { changed: [], tests: unitTestFiles() }

  // Build reverse import graph across src/ and electron/ and tests/core/
  const allFiles = []
  const walk = dir => {
    const full = join(root, dir)
    if (!existsSync(full)) return
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const rel = join(dir, entry.name)
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) allFiles.push(rel)
    }
  }
  walk('src'); walk('electron'); walk('tests/core'); walk('scripts')

  const importers = new Map()
  const importPattern = /(?:from|import)\s*\(?['"]([^'"]+)['"]\)?/g
  for (const file of allFiles) {
    const content = readFileSync(join(root, file), 'utf8')
    let match
    while ((match = importPattern.exec(content)) !== null) {
      const spec = match[1]
      if (!spec.startsWith('.') && !spec.startsWith('@/')) continue
      const base = spec.startsWith('@/') ? join(root, 'src', spec.slice(2)) : resolve(root, dirname(file), spec)
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, base.replace(/\.js$/, '.ts')]) {
        if (existsSync(candidate)) {
          const target = relative(root, candidate)
          if (!importers.has(target)) importers.set(target, new Set())
          importers.get(target).add(file)
          break
        }
      }
    }
  }

  const impacted = new Set()
  const queue = [...changed]
  while (queue.length) {
    const current = queue.shift()
    if (impacted.has(current)) continue
    impacted.add(current)
    for (const parent of importers.get(current) ?? []) queue.push(parent)
  }

  const allTests = unitTestFiles()
  const selected = allTests.filter(t => impacted.has(t))
  return { changed: [...changed], tests: selected.length ? selected : allTests }
}

if (mode === 'unit') {
  const files = extra.length ? extra : unitTestFiles()
  run(process.execPath, ['--experimental-strip-types', '--test-concurrency=4', '--test', ...files])
} else if (mode === 'fuzz') {
  run(process.execPath, ['--experimental-strip-types', '--test', 'tests/auto-fuzz.test.mjs', ...extra])
} else if (mode === 'changed') {
  const { changed, tests } = findChangedTests()
  console.log(`Changed files (${changed.length}): running ${tests.length} unit test file(s) + auto-fuzz...`)
  run(process.execPath, ['--experimental-strip-types', '--test-concurrency=4', '--test', ...tests])
  run(process.execPath, ['--experimental-strip-types', '--test', 'tests/auto-fuzz.test.mjs'])
} else if (mode === 'e2e') {
  const skipBuild = extra.includes('--no-build')
  const files = extra.filter(a => a !== '--no-build')
  const targets = files.length ? files : listFiles('tests/e2e', '.e2e.mjs')
  if (!skipBuild) await buildRenderer({ root })
  const userData = mkdtempSync(join(tmpdir(), 'perpetual-swap-e2e-'))
  try {
    let env = { ...process.env, PERPETUAL_SWAP_TEST_UI: 'background', PERPETUAL_SWAP_TEST_OWNER_PID: String(process.pid), PERPETUAL_SWAP_USER_DATA: userData }
    if (process.platform === 'darwin') {
      const guarded = await prepareTestElectron()
      env = backgroundTestEnvironment(guarded, env)
    }
    run(process.execPath, ['--experimental-strip-types', '--test-concurrency=1', '--test', ...targets], env)
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }
} else {
  console.error('Usage: node scripts/run-tests.mjs unit|fuzz|changed|e2e [files...]')
  process.exit(1)
}
