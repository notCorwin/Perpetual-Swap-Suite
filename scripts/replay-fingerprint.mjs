import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const code = /\.(?:js|mjs|cjs|ts|tsx|c|h|m|json)$/
const excluded = new Set(['node_modules', 'artifacts', '.build', '.git'])
export async function replayHarnessFingerprint() {
  const files = {}
  const add = async path => { files[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex') }
  const visit = async directory => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && code.test(entry.name)) await add(path)
    }
  }
  for (const directory of ['scripts', 'tests/helpers', 'experiments/runtime-comparison']) await visit(directory)
  for (const path of ['package.json', 'package-lock.json']) await add(path)
  const ordered = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)))
  return { scope: 'Code-file superset of scripts, tests/helpers and experiments/runtime-comparison, plus package manifests; build artifacts and dependencies excluded.',
    sha256: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'), files: ordered }
}
