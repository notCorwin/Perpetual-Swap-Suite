import { parse } from '@babel/parser'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workerBoundary = 'electron/services/worker-operations.js'
const databaseBoundary = 'electron/services/recorded-database.js'
const isNode = value => value && typeof value === 'object' && typeof value.type === 'string'
function walk(value, visit) {
  if (Array.isArray(value)) { for (const child of value) walk(child, visit); return }
  if (!isNode(value)) return
  visit(value)
  for (const child of Object.values(value)) walk(child, visit)
}

// Native builtins cannot all be rebound by syncBuiltinESMExports (notably the
// named SQLite constructor). Keep those unhookable opens and child admission
// behind boundaries that register coverage before performing the operation.
export function inspectOperationBoundaries(source, file) {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const workers = new Set(['Worker']), databases = new Set(['DatabaseSync']), namespaces = new Map(), forks = new Set(['fork'])
  const errors = [], report = (node, message) => errors.push(`${file}:${node.loc?.start.line ?? 1}: ${message}`)
  walk(ast, node => {
    if (node.type !== 'ImportDeclaration') return
    const module = node.source.value
    for (const binding of node.specifiers) {
      const imported = binding.imported?.name
      if (module === 'node:worker_threads' && imported === 'Worker') workers.add(binding.local.name)
      if (module === 'node:sqlite' && imported === 'DatabaseSync') databases.add(binding.local.name)
      if (module === 'node:child_process' && imported === 'fork') forks.add(binding.local.name)
      if (binding.type !== 'ImportSpecifier') namespaces.set(binding.local.name, module)
    }
  })
  walk(ast, node => {
    if (node.type === 'NewExpression') {
      const callee = node.callee, name = callee.type === 'Identifier' ? callee.name : callee.property?.name ?? callee.property?.value
      if (file !== workerBoundary && (workers.has(name) || name === 'Worker')) report(node, 'Create workers through createOperationWorker so admission, delivery and missing participants are recorded.')
      if (file !== databaseBoundary && (databases.has(name) || name === 'DatabaseSync')) report(node, 'Open SQLite through openRecordedDatabase so named-import constructors cannot bypass recording.')
    }
    if (node.type === 'CallExpression' && file !== workerBoundary) {
      const callee = node.callee
      if (callee.type === 'Identifier' && forks.has(callee.name)
        || callee.type === 'MemberExpression' && (callee.property?.name ?? callee.property?.value) === 'fork'
          && (namespaces.get(callee.object?.name) === 'node:child_process' || callee.object?.name === 'childProcess')) {
        report(node, 'Fork application processes through createOperationProcess so unregistered child execution cannot disappear.')
      }
    }
  })
  return errors
}
export function checkOperationBoundaries(directory = root) {
  const visit = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name)
    if (entry.isDirectory()) return visit(file)
    if (!/\.(?:js|cjs|ts|tsx)$/.test(entry.name) || /(?:\.test\.|\.d\.ts$)/.test(entry.name)) return []
    return inspectOperationBoundaries(readFileSync(file, 'utf8'), relative(directory, file))
  })
  return ['electron', 'src'].flatMap(path => visit(join(directory, path)))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkOperationBoundaries()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Operation boundaries: recorded SQLite opens and registered worker/process admission.')
}
