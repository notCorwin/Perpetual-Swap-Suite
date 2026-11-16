import assert from 'node:assert/strict'
import { isBuiltin } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from '@babel/parser'

export function assertRuntimeImports(source, file) {
  const visit = node => {
    if (!node || typeof node !== 'object') return
    const dependency = node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ImportExpression' ? node.source
      : node.type === 'CallExpression' && node.callee?.name === 'require' ? node.arguments[0] : undefined
    if (dependency) {
      assert.equal(dependency.type, 'StringLiteral', `${file}: runtime dependencies must be explicit before excluding node_modules.`)
      const name = dependency.value
      assert.ok(name.startsWith('.') || name === 'electron' || isBuiltin(name), `${file}: ${name} requires a packaging rule; node_modules is excluded.`)
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child)
  }
  visit(parse(source, { sourceType: 'unambiguous' }))
}

export async function assertDesktopImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await assertDesktopImports(path)
    else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) assertRuntimeImports(await readFile(path, 'utf8'), path)
  }
}

export function assertPackagedEntries(entries) {
  assert.ok(entries.includes('/dist/index.html'), 'The renderer entry must be packaged.')
  assert.ok(entries.some(path => path.startsWith('/dist/assets/') && path.endsWith('.js')), 'The renderer bundles must be packaged.')
  assert.ok(entries.every(path => !/(?:^|\/)node_modules(?:\/|$)|\.app(?:\/|$)/.test(path)), 'Do not package unused frontend dependencies or recursively embed Electron build output.')
}
