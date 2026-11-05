import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build, version as viteVersion } from 'vite'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const outDir = join(root, 'artifacts/runtime-comparison/frontend-off')
const manifestPath = join(root, 'artifacts/runtime-comparison/frontend-off.manifest.json')
const original = join(root, 'src/operation-telemetry.ts')
const shim = fileURLToPath(new URL('./telemetry-off.ts', import.meta.url))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const portable = path => path.split(root + sep).join('').split(sep).join('/')
const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))

async function fileHashes(paths) {
  const result = {}
  for (const path of [...new Set(paths)].sort()) {
    const data = await readFile(path)
    result[portable(path)] = { sha256: sha256(data), bytes: data.length }
  }
  return sorted(result)
}

async function filesUnder(directory) {
  const files = []
  async function visit(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(path)
      else if (entry.isSymbolicLink() && (await stat(path)).isFile()) files.push(path)
    }
  }
  await visit(directory)
  return files
}

/** Build only the renderer-telemetry-off variant; return the written manifest. */
export async function buildFrontendOff() {
  const watched = new Set(), modules = {}, aliases = new Set()
  let buildEnvironment
  const plugin = {
    name: 'runtime-comparison-telemetry-off',
    enforce: 'pre',
    configResolved(config) {
      // Keep environment values private while making changes visible in the fingerprint.
      buildEnvironment = { mode: config.mode, base: config.base, node: process.version, vite: viteVersion,
        environmentSHA256: sha256(JSON.stringify(sorted(config.env))) }
    },
    async resolveId(source, importer) {
      if (!importer || !/(?:^|\/)operation-telemetry(?:\.ts)?(?:\?.*)?$/.test(source)) return null
      const resolved = await this.resolve(source, importer, { skipSelf: true })
      if (resolved && resolved.id.split('?')[0] === original) {
        aliases.add(portable(importer.split('?')[0]))
        return shim
      }
      return null
    },
    load(id) {
      const path = id.split('?')[0]
      if (isAbsolute(path)) watched.add(path)
      return null
    },
    transform(code, id) {
      // These are the exact module contents observed by the pre-transform plugin,
      // including virtual modules. Actual input file bytes are hashed separately.
      modules[portable(id)] = { sha256: sha256(code), bytes: Buffer.byteLength(code) }
      const path = id.split('?')[0]
      if (isAbsolute(path)) watched.add(path)
    },
  }
  await build({ root, configFile: join(root, 'vite.config.ts'), mode: 'production', plugins: [plugin],
    build: { outDir, emptyOutDir: true }, logLevel: 'silent' })
  if (!aliases.size || Object.keys(modules).some(id => id.split('?')[0] === portable(original))) {
    throw new Error('The renderer telemetry module was not exclusively replaced by the comparison shim.')
  }
  for (const path of ['index.html', 'vite.config.ts', 'package.json', 'package-lock.json',
    'experiments/runtime-comparison/frontend-build.mjs', 'experiments/runtime-comparison/telemetry-off.ts',
    '.env', '.env.local', '.env.production', '.env.production.local']) {
    const file = join(root, path)
    try { if ((await stat(file)).isFile()) watched.add(file) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  for (const file of await filesUnder(join(root, 'src'))) watched.add(file)
  for (const file of await filesUnder(join(root, 'public'))) watched.add(file)
  const existing = []
  for (const file of watched) {
    try { if ((await stat(file)).isFile()) existing.push(file) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const sources = { files: await fileHashes(existing), transformedModules: sorted(modules), buildEnvironment }
  const outputFiles = await fileHashes(await filesUnder(outDir))
  const manifest = { schemaVersion: 1, variant: 'renderer-telemetry-off',
    outputDirectory: portable(outDir), manifestPath: portable(manifestPath),
    alias: { from: portable(original), to: portable(shim), importers: [...aliases].sort() },
    sourceFingerprint: { algorithm: 'sha256', sha256: sha256(JSON.stringify(sources)), ...sources },
    frontend: { algorithm: 'sha256', sha256: sha256(JSON.stringify(outputFiles)), files: outputFiles },
    fingerprintMethod: 'SHA-256 of compact JSON for the sorted file/module maps and environment metadata; files are individually SHA-256 hashed. The manifest is outside the output directory.' }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildFrontendOff().then(manifest => process.stdout.write(`${JSON.stringify(manifest)}\n`), error => {
    console.error(`Frontend comparison build failed: ${error.message}`)
    process.exitCode = 1
  })
}
