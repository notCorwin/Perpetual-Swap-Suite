import { parse } from '@babel/parser'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const entrypoints = ['src/operation-telemetry.ts', 'src/chart-geometry.ts']

// Serving and source verification use the same runtime dependency graph.
export async function loadRendererModules(root, entries = entrypoints) {
  root = resolve(root)
  const modules = new Map(), hashes = new Map(), visited = new Set()
  const visit = async file => {
    const name = relative(root, file)
    if (isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`)) throw new Error(`Renderer module escapes the project: ${file}`)
    if (visited.has(file)) return
    visited.add(file)
    const source = await readFile(file, 'utf8')
    const code = file.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source
    const url = `/${name.split(sep).join('/')}`
    modules.set(url, code)
    hashes.set(url.slice(1), createHash('sha256').update(source).digest('hex'))
    const dependencies = new Set()
    const walk = node => {
      if (!node || typeof node !== 'object') return
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
        const specifier = node.source.value
        if (typeof specifier !== 'string' || !specifier.startsWith('.')) throw new Error(`Renderer benchmark requires a static relative import in ${name}`)
        dependencies.add(resolve(dirname(file), specifier))
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object') walk(value)
      }
    }
    walk(parse(code, { sourceType: 'module' }))
    await Promise.all([...dependencies].map(visit))
  }
  await Promise.all(entries.map(file => visit(resolve(root, file))))
  return { modules, hashes: Object.fromEntries([...hashes].sort(([left], [right]) => left.localeCompare(right, 'en'))) }
}
