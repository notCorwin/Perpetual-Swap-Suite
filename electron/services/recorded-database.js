import { beginOperation, measureOperation } from './operations.js'

// A market command/transaction is one database operation, with exact statement
// counts. Per-row statements are accounted for without generating millions of
// redundant spans for one bulk write. Standalone metadata queries get a span.
let group
export function databaseOperation(name, operation, attributes = {}, resource) {
  if (group) return operation()
  const span = beginOperation({ category: 'database', name, resource, attributes })
  const details = group = { queryCount: 0, rows: 0, changes: 0 }
  try { const result = operation(); span.end({ attributes: details }); return result }
  catch (error) { span.end({ status: 'error', attributes: { ...details, errorName: error?.name ?? 'Error' } }); throw error }
  finally { group = undefined }
}

export function recordedDatabase(database, resource) {
  const invoke = (name, method, args, identity = resource) => {
    const operation = () => {
      if (group) group.queryCount++
      const result = method(...args)
      if (group) { group.rows += Array.isArray(result) ? result.length : name === 'get' && result ? 1 : 0; group.changes += Number(result?.changes ?? 0) }
      return result
    }
    return group ? operation() : databaseOperation(`sqlite.${name}`, operation, { role: resource }, identity)
  }
  return new Proxy(database, { get(target, key) {
    if (key === 'prepare') return sql => {
      // Only identifiers from a fixed schema are recorded. SQL text and literals
      // may contain paths or secrets and must never enter the journal.
      const tables = ['settings', 'analysis_settings', 'migrations', 'sync_tasks', 'audits', 'catalog', 'series', 'candles', 'statistics', 'replacements', 'indicator_checkpoints', 'migration_partitions', 'import_issues']
      const table = sql.match(/\b(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+)/i)?.[1]?.toLowerCase()
      const identity = tables.includes(table) ? `${resource}:${table}` : resource
      const statement = invoke('prepare', target.prepare.bind(target), [sql])
      return new Proxy(statement, { get(statementTarget, method) {
        const value = Reflect.get(statementTarget, method, statementTarget)
        if (typeof value !== 'function') return value
        return ['all', 'get', 'run'].includes(method) ? (...args) => invoke(method, value.bind(statementTarget), args, identity) : value.bind(statementTarget)
      } })
    }
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function') return value
    return ['exec', 'close'].includes(key) ? (...args) => invoke(key, value.bind(target), args) : value.bind(target)
  } })
}

export function openRecordedDatabase(Database, path, options, role) {
  return recordedDatabase(measureOperation({ category: 'database', name: 'sqlite.open', attributes: { role } }, () => new Database(path, options ?? {})), role)
}
