#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const outputDirectory = 'dist'
// The renderer is built by Node/TypeScript/Vite; auxiliary Python environments
// and delivery/log artifacts are not renderer inputs.
const ignoredRoots = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.build', 'artifacts', 'coverage', 'release', 'logs', outputDirectory, 'dist-ssr'])
const buildEnvironmentNames = new Set(['CI', 'NODE_ENV', 'NODE_OPTIONS', 'PUBLIC_URL'])
const buildEnvironmentPrefixes = ['BUILD_', 'ESBUILD_', 'TSC_', 'VITE_']
const digest = value => createHash('sha256').update(value).digest('hex')
const jsonDigest = value => digest(JSON.stringify(value))
const posix = value => value.split(sep).join('/')

function repoFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : []
}

function excludedPath(path) {
  const parts = path.split('/')
  return parts.some((part, index) => part === '.git' || part === 'node_modules' || part === '.DS_Store' || index === 0 && ignoredRoots.has(part))
}

async function workspacePaths(root, excludedPaths = []) {
  const paths = new Set(repoFiles(root).filter(path => !excludedPath(path)))
  const excluded = new Set(excludedPaths.map(path => posix(relative(root, path))))

  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (excludedPath(path)) continue
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else paths.add(path)
    }
  }

  await walk(root)
  return [...paths].filter(path => !excluded.has(path)).sort()
}

async function fileIdentity(root, path) {
  let info
  try { info = await lstat(join(root, path)) }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { path, state: 'missing' }
    throw error
  }

  if (info.isSymbolicLink()) {
    const target = await readlink(join(root, path))
    let content
    try { content = await readFile(join(root, path)) }
    catch (error) {
      if (error.code === 'EISDIR') throw new Error(`Build reuse cannot fingerprint a directory symlink: ${path}`)
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { path, state: 'dangling-symlink', target }
      throw error
    }
    return { path, state: 'symlink', target, size: content.byteLength, sha256: digest(content) }
  }

  if (!info.isFile()) return { path, state: 'non-file', mode: info.mode }
  const content = await readFile(join(root, path))
  return { path, state: 'file', size: content.byteLength, sha256: digest(content) }
}

async function fileTree(directory) {
  const entries = []
  async function walk(current, prefix = '') {
    let children
    try { children = await readdir(current, { withFileTypes: true }) }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Build output is missing: ${directory}`)
      throw error
    }
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name
      const absolute = join(current, child.name)
      if (child.isDirectory()) await walk(absolute, path)
      else if (child.isFile()) {
        const content = await readFile(absolute)
        entries.push({ path, size: content.byteLength, sha256: digest(content) })
      } else throw new Error(`Build output contains an unsupported filesystem entry: ${absolute}`)
    }
  }
  await walk(directory)
  if (!entries.length) throw new Error(`Build output is empty: ${directory}`)
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

function environmentIdentity(environment) {
  // This is the renderer build environment contract; test outputs and npm/GitHub step metadata are intentionally excluded.
  const selected = Object.fromEntries(Object.entries(environment)
    .filter(([name]) => buildEnvironmentNames.has(name) || buildEnvironmentPrefixes.some(prefix => name.startsWith(prefix)))
    .sort(([left], [right]) => left.localeCompare(right)))
  return { sha256: jsonDigest(selected), names: Object.keys(selected) }
}

export function buildToolchain({ nodeVersion = process.version, platformName = platform(), architecture = arch(), systemRelease = release(), npmVersion } = {}) {
  if (typeof npmVersion !== 'string' || !npmVersion.trim()) throw new TypeError('The npm version is required for a build reuse fingerprint.')
  return { node: nodeVersion, npm: npmVersion.trim(), platform: platformName, architecture, systemRelease }
}

export function readNpmVersion(root = projectRoot) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(executable, ['--version'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to determine npm version: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`)
  }
  return result.stdout.trim()
}

async function snapshot(root, { manifestPath, toolchain = buildToolchain({ npmVersion: readNpmVersion(root) }), environment = process.env } = {}) {
  const resolvedRoot = resolve(root)
  const resolvedManifest = manifestPath ? resolve(resolvedRoot, manifestPath) : null
  if (resolvedManifest && relative(join(resolvedRoot, outputDirectory), resolvedManifest) !== '..'
    && !relative(join(resolvedRoot, outputDirectory), resolvedManifest).startsWith(`..${sep}`)
    && !isAbsolute(relative(join(resolvedRoot, outputDirectory), resolvedManifest))) {
    throw new Error(`Build reuse manifest must be outside ${outputDirectory}/.`)
  }
  const paths = await workspacePaths(resolvedRoot, resolvedManifest ? [resolvedManifest] : []), inputs = []
  for (let index = 0; index < paths.length; index += 32) {
    inputs.push(...await Promise.all(paths.slice(index, index + 32).map(path => fileIdentity(resolvedRoot, path))))
  }
  const env = environmentIdentity(environment)
  const key = jsonDigest({ schemaVersion: 1, inputs, toolchain, environment: env.sha256 })
  return { key, inputs, toolchain, environment: env }
}

function manifestPathFrom(root, value) {
  if (!value) throw new Error('Provide --manifest <path>.')
  return resolve(root, value)
}

async function publishManifest(resolvedRoot, path, inputs) {
  const outputs = await fileTree(join(resolvedRoot, outputDirectory))
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    build: inputs,
    output: { directory: outputDirectory, files: outputs, sha256: jsonDigest(outputs) },
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
  return manifest
}

export async function writeBuildReuseManifest({ root = projectRoot, manifestPath, toolchain, environment = process.env } = {}) {
  const resolvedRoot = resolve(root)
  const path = manifestPathFrom(resolvedRoot, manifestPath)
  const inputs = await snapshot(resolvedRoot, { manifestPath: path, toolchain, environment })
  return publishManifest(resolvedRoot, path, inputs)
}

export async function verifyBuildReuseManifest({ root = projectRoot, manifestPath, toolchain, environment = process.env } = {}) {
  const resolvedRoot = resolve(root)
  const path = manifestPathFrom(resolvedRoot, manifestPath)
  let manifest
  try { manifest = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { throw new Error(`Build reuse manifest is unavailable or invalid (${path}): ${error.message}`) }
  if (manifest?.schemaVersion !== 1 || !manifest.build?.key || !Array.isArray(manifest.output?.files)) {
    throw new Error(`Build reuse manifest has an unsupported or incomplete schema: ${path}`)
  }

  const current = await snapshot(resolvedRoot, { manifestPath: path, toolchain, environment })
  if (current.key !== manifest.build.key) throw new Error('Build reuse rejected: source, lockfile, environment, or toolchain changed after the renderer build.')
  const outputs = await fileTree(join(resolvedRoot, outputDirectory))
  if (jsonDigest(outputs) !== manifest.output.sha256 || JSON.stringify(outputs) !== JSON.stringify(manifest.output.files)) {
    throw new Error('Build reuse rejected: renderer build output changed or is incomplete.')
  }
  return manifest
}

export function runBuildAndWriteManifest({ root = projectRoot, manifestPath, command, toolchain, environment = process.env } = {}) {
  if (!Array.isArray(command) || command.length < 1 || command.some(value => typeof value !== 'string' || !value)) {
    throw new Error('Build command is required after --.')
  }
  const resolvedRoot = resolve(root)
  const path = manifestPathFrom(resolvedRoot, manifestPath)
  const dist = join(resolvedRoot, outputDirectory)
  const relativeManifest = relative(dist, path)
  if (relativeManifest === '' || (!relativeManifest.startsWith(`..${sep}`) && relativeManifest !== '..' && !isAbsolute(relativeManifest))) {
    throw new Error(`Build reuse manifest must be outside ${outputDirectory}/.`)
  }

  return (async () => {
    await rm(path, { force: true })
    await rm(dist, { recursive: true, force: true })
    const before = await snapshot(resolvedRoot, { manifestPath: path, toolchain, environment })
    const result = spawnSync(command[0], command.slice(1), { cwd: resolvedRoot, env: environment, stdio: 'inherit' })
    if (result.error || result.status !== 0) {
      throw new Error(`Build command failed${result.error ? `: ${result.error.message}` : ` with exit code ${result.status}`}.`)
    }
    const after = await snapshot(resolvedRoot, { manifestPath: path, toolchain, environment })
    if (before.key !== after.key) {
      const original = new Map(before.inputs.map(input => [input.path, JSON.stringify(input)]))
      const current = new Map(after.inputs.map(input => [input.path, JSON.stringify(input)]))
      const changed = [...new Set([...original.keys(), ...current.keys()])].filter(path => original.get(path) !== current.get(path))
      throw new Error(`Build inputs changed while the renderer was being built; refusing to write a reusable manifest. Changed inputs: ${changed.slice(0, 20).join(', ') || 'environment or toolchain'}`)
    }
    // Preserve the exact snapshot proven to match the original build inputs.
    return publishManifest(resolvedRoot, path, after)
  })()
}

function parseOptions(args, allowCommand) {
  let manifestPath
  let command
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--manifest' && args[index + 1]) manifestPath = args[++index]
    else if (value === '--' && allowCommand) { command = args.slice(index + 1); break }
    else throw new Error(`Unknown build reuse option: ${value}`)
  }
  return { manifestPath, command }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, ...args] = process.argv.slice(2)
    if (!['build', 'verify'].includes(operation)) throw new Error('Usage: node scripts/build-artifact-reuse.mjs build|verify --manifest <path> [-- COMMAND ARGS...]')
    const { manifestPath, command } = parseOptions(args, operation === 'build')
    if (operation === 'build') {
      await runBuildAndWriteManifest({ manifestPath, command })
      console.log(`Recorded renderer build validity: ${manifestPath}`)
    } else {
      await verifyBuildReuseManifest({ manifestPath })
      console.log(`Renderer build validity confirmed: ${manifestPath}`)
    }
  } catch (error) {
    console.error(error.stack ?? error.message)
    process.exitCode = 1
  }
}
