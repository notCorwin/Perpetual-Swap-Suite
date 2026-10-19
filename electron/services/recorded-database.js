import { beginOperation, readOperationCPUTime } from './operations.js'

// A market command/transaction is one database operation. `calls` counts hooked
// database/statement API calls; `queryCount` counts execution API batches
// (exec/all/get/run/iterate), not parsed SQL statements within exec().
let group
const databases = new WeakMap()
const recordedConstructors = new WeakSet()
const recordedPrototypes = new WeakSet()
const recordedBackupFunctions = new WeakSet()
export function databaseOperation(name, operation, attributes = {}, resource) {
  if (group) return operation()
  const span = beginOperation({ category: 'database', name, resource, attributes })
  const cpu = readOperationCPUTime()
  const details = group = { calls: 0, queryCount: 0, rows: 0, changes: 0 }
  try { const result = typeof span.run === 'function' ? span.run(operation) : operation(); span.end({ attributes: details, ...(cpu === undefined ? {} : { cpuTimeMS: readOperationCPUTime() - cpu }) }); return result }
  catch (error) { span.end({ status: 'error', attributes: { ...details, errorName: error?.name ?? 'Error' }, ...(cpu === undefined ? {} : { cpuTimeMS: readOperationCPUTime() - cpu }) }); throw error }
  finally { group = undefined }
}

export function recordedDatabase(database, resource) {
  const existing = databases.get(database)
  if (existing) { if (resource) existing.resource = resource; return existing.proxy }
  const state = { database, resource: resource ?? 'sqlite', statements: new WeakMap(), invocationDepth: 0 }
  const invoke = (name, method, args, identity) => {
    const execution = name.split('.').at(-1)
    const operation = () => {
      if (group) {
        group.calls++
        if (['exec', 'all', 'get', 'run', 'iterate'].includes(execution)) group.queryCount++
      }
      let result
      state.invocationDepth++
      try { result = method(...args) } finally { state.invocationDepth-- }
      if (group) {
        group.rows += execution === 'all' && Array.isArray(result) ? result.length : execution === 'get' && result ? 1 : 0
        if (execution === 'run') group.changes += Number(result?.changes ?? 0)
      }
      return result
    }
    return group ? operation() : databaseOperation(`sqlite.${name}`, operation, { role: state.resource }, identity ?? state.resource)
  }
  const statementProxy = (statement, table, prefix = '') => {
    const known = state.statements.get(statement)
    if (known) return known
    const proxy = new Proxy(statement, { get(statementTarget, method) {
      const value = Reflect.get(statementTarget, method, statementTarget)
      if (typeof value !== 'function' || method === 'constructor') return value
      const identity = table ? `${state.resource}:${table}` : state.resource
      if (method === 'iterate') return (...args) => {
        const originGroup = group
        let span, iterator, finished = false
        const details = { calls: originGroup ? 0 : 1, queryCount: originGroup ? 0 : 1, rows: 0, changes: 0 }
        const start = () => span = beginOperation({ category: 'database', name: 'sqlite.iterate', resource: identity, attributes: { role: state.resource, ...(originGroup ? { measurement: 'iterator-consumption' } : {}) } })
        if (!originGroup) start()
        try { iterator = originGroup ? invoke('iterate', value.bind(statementTarget), args, identity) : Reflect.apply(value, statementTarget, args) }
        catch (error) { span?.end({ status: 'error', attributes: { ...details, errorName: error?.name ?? 'Error' } }); throw error }
        const iteratorView = new Proxy(iterator, { get(iteratorTarget, key) {
          const iteratorMethod = Reflect.get(iteratorTarget, key, iteratorTarget)
          if (key === Symbol.iterator) return () => iteratorView
          if (typeof iteratorMethod !== 'function') return iteratorMethod
          if (!['next', 'return', 'throw'].includes(key)) return iteratorMethod.bind(iteratorTarget)
          return (...values) => {
            // A lazy iterator may escape its synchronous group. Record that
            // later consumption separately rather than changing a closed event.
            const activeGroup = originGroup && group === originGroup ? originGroup : undefined
            if (!activeGroup && !span && !finished) start()
            try {
              const result = Reflect.apply(iteratorMethod, iteratorTarget, values)
              if (key === 'next' && !result.done) (activeGroup ?? details).rows++
              if (result?.done || key === 'return') { finished = true; span?.end({ attributes: details }) }
              return result
            } catch (error) { finished = true; span?.end({ status: 'error', attributes: { ...details, errorName: error?.name ?? 'Error' } }); throw error }
          }
        } })
        return iteratorView
      }
      return ['all', 'get', 'run', 'columns', 'close', 'clear', 'changeset', 'patchset'].includes(method) ? (...args) => invoke(`${prefix}${method}`, value.bind(statementTarget), args, identity) : value.bind(statementTarget)
    } })
    state.statements.set(statement, proxy)
    return proxy
  }
  const proxy = new Proxy(database, { get(target, key) {
    if (key === 'prepare') return sql => {
      // Only identifiers from a fixed schema are recorded. SQL text and literals
      // may contain paths or secrets and must never enter the journal.
      const tables = ['settings', 'analysis_settings', 'migrations', 'sync_tasks', 'audits', 'catalog', 'series', 'candles', 'statistics', 'replacements', 'indicator_checkpoints', 'migration_partitions', 'import_issues']
      const table = sql.match(/\b(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+)/i)?.[1]?.toLowerCase()
      const statement = invoke('prepare', target.prepare.bind(target), [sql])
      return statementProxy(statement, tables.includes(table) ? table : undefined)
    }
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function' || key === 'constructor') return value
    if (key === 'createTagStore' || key === 'createSession') return (...args) => statementProxy(invoke(key, value.bind(target), args), undefined, key === 'createSession' ? 'session.' : '')
    return ['open', 'exec', 'close', 'serialize', 'deserialize', 'applyChangeset', 'loadExtension'].includes(key) ? (...args) => invoke(key, value.bind(target), args) : value.bind(target)
  } })
  state.proxy = proxy
  databases.set(database, state)
  databases.set(proxy, state)
  return proxy
}

export function openRecordedDatabase(Database, path, options, role) {
  return recordedDatabase(databaseOperation('sqlite.open', () => {
    if (!recordedConstructors.has(Database)) group.calls++
    return new Database(path, options ?? {})
  }, { role }), role)
}

/** Hook default/CommonJS constructors plus the shared prototype for named imports. */
export function installRecordedSQLite(sqlite) {
  const Database = sqlite?.DatabaseSync
  if (typeof Database !== 'function') return false
  if (recordedConstructors.has(Database)) return true
  // node:sqlite named ESM exports are not rebound by syncBuiltinESMExports in
  // Node 24. Prototype hooks still catch queries through those constructors.
  if (!recordedPrototypes.has(Database.prototype)) {
    recordedPrototypes.add(Database.prototype)
    for (const method of ['prepare', 'open', 'exec', 'close', 'serialize', 'deserialize', 'applyChangeset', 'loadExtension', 'createTagStore', 'createSession']) {
      const original = Database.prototype[method]
      if (typeof original !== 'function') continue
      Object.defineProperty(Database.prototype, method, { ...Object.getOwnPropertyDescriptor(Database.prototype, method), value: function (...args) {
        const existing = databases.get(this)
        if (existing?.invocationDepth) return Reflect.apply(original, this, args)
        const proxy = recordedDatabase(this)
        return Reflect.apply(proxy[method], proxy, args)
      } })
    }
  }
  const HookedDatabase = new Proxy(Database, { construct(target, args, newTarget) {
    const database = databaseOperation('sqlite.open', () => { group.calls++; return Reflect.construct(target, args, newTarget === HookedDatabase ? target : newTarget) }, { role: 'sqlite' })
    return recordedDatabase(database)
  } })
  recordedConstructors.add(HookedDatabase)
  sqlite.DatabaseSync = HookedDatabase
  const backup = sqlite.backup
  if (typeof backup === 'function' && !recordedBackupFunctions.has(backup)) {
    const recordedBackup = function (...args) {
      const span = beginOperation({ category: 'database', name: 'sqlite.backup' })
      const attributes = { calls: 1, queryCount: 0, rows: 0, changes: 0 }
      if (databases.has(args[0])) args[0] = databases.get(args[0]).database
      try {
        return Promise.resolve(span.run(() => Reflect.apply(backup, this, args))).then(result => { span.end({ attributes }); return result }, error => {
          span.end({ status: 'error', attributes: { ...attributes, errorName: error?.name ?? 'Error' } }); throw error
        })
      } catch (error) { span.end({ status: 'error', attributes: { ...attributes, errorName: error?.name ?? 'Error' } }); throw error }
    }
    recordedBackupFunctions.add(recordedBackup)
    sqlite.backup = recordedBackup
  }
  return true
}
