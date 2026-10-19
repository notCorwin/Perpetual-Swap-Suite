import { parse } from '@babel/parser'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const workerBoundary = 'electron/services/worker-operations.js'
const databaseBoundary = 'electron/services/recorded-database.js'
const nativeBoundary = 'electron/services/operation-network-hooks.js'
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
  // Resolve static namespace/named/dynamic-import/require aliases before checking unsupported native paths.
  const bindings=new Map(),nativeModule=value=>['dgram','http2'].includes(value)?`node:${value}`:value
  const member=node=>node.computed?(node.property?.value??null):node.property?.name
  function reference(node) {
    if(!node)return undefined
    if(node.type==='AwaitExpression'||node.type==='TSAsExpression'||node.type==='TSNonNullExpression')return reference(node.argument??node.expression)
    if(node.type==='Identifier')return bindings.get(node.name)
    if(node.type==='ImportExpression')return nativeModule(node.source?.value)
    if(node.type==='MemberExpression'||node.type==='OptionalMemberExpression') {const owner=reference(node.object),key=member(node);return key==='pushStream'?`${owner??'http2-unsupported'}.pushStream`:owner&&key?`${owner}.${key}`:undefined}
    if(node.type==='CallExpression') {
      if(node.callee.type==='Import'||node.callee.type==='Identifier'&&node.callee.name==='require')return nativeModule(node.arguments[0]?.value)
      if(reference(node.callee)==='node:dgram.createSocket')return 'node:dgram.Socket#instance'
    }
    if(node.type==='NewExpression'&&reference(node.callee)==='node:dgram.Socket')return 'node:dgram.Socket#instance'
  }
  function bind(pattern,value) {
    if(!value)return
    if(pattern.type==='Identifier')bindings.set(pattern.name,value)
    if(pattern.type==='ObjectPattern')for(const property of pattern.properties)if(property.type==='ObjectProperty')bind(property.value,`${value}.${property.key.name??property.key.value}`)
  }
  walk(ast,node=>{if(node.type==='ImportDeclaration')for(const specifier of node.specifiers)bind(specifier.local,specifier.type==='ImportSpecifier'?`${nativeModule(node.source.value)}.${specifier.imported.name??specifier.imported.value}`:nativeModule(node.source.value))})
  for(let round=0;round<4;round++)walk(ast,node=>{if(node.type==='VariableDeclarator')bind(node.id,reference(node.init));if(node.type==='AssignmentExpression')bind(node.left,reference(node.right))})
  walk(ast,node=>{if(node.type==='VariableDeclarator'&&node.id.type==='ObjectPattern')for(const property of node.id.properties)if(property.type==='ObjectProperty'&&(property.key.name??property.key.value)==='pushStream')bind(property.value,'http2-unsupported.pushStream')})
  const unsupported=new Set(['node:dgram.Socket','node:http2.createServer','node:http2.createSecureServer'])
  const datagramMethods=new Set(['bind','addMembership','dropMembership','addSourceSpecificMembership','dropSourceSpecificMembership','setMulticastInterface'])
  walk(ast, node => {
    if(file!==nativeBoundary&&(node.type==='NewExpression'||node.type==='CallExpression'||node.type==='OptionalCallExpression')) {
      const api=reference(node.callee),key=node.callee?.type==='MemberExpression'||node.callee?.type==='OptionalMemberExpression'?member(node.callee):null
      if(unsupported.has(api)||api?.startsWith('node:dgram.Socket#instance.')&&datagramMethods.has(api.split('.').at(-1))
        ||api?.startsWith('node:dgram.Socket.prototype.')&&datagramMethods.has(api.split('.').at(-1))||key==='pushStream'||api?.endsWith('.pushStream')) {
        report(node,'Unsupported native UDP constructor/bind/multicast or HTTP2 server/push API: use an instrumented supported client API or add a verified recording boundary first.')
      }
    }
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
  else console.log('Operation boundaries: recorded SQLite, registered child execution, and supported native UDP/HTTP2 entry points.')
}
