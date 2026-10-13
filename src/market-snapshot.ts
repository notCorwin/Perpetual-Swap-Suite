import type { NativeMarketRow } from "./rule-engine.ts"

function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equalValue(value, b[index]))
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalValue(left[key], right[key]))
}

// Bridge replies contain fresh objects, even when the native cache is unchanged.
// Preserve row identities so typing and menu state do not redraw every contract.
export function reconcileMarketRows(previous: NativeMarketRow[], incoming: NativeMarketRow[]): NativeMarketRow[] {
  const byID = new Map(previous.map(row => [row.instId, row]))
  const next = incoming.map(row => {
    const old = byID.get(row.instId)
    return old && equalValue(old, row) ? old : row
  })
  return previous.length === next.length && next.every((row, index) => row === previous[index]) ? previous : next
}

export function keepSnapshotValue<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous
  if (!previous || !incoming || typeof previous !== 'object' || typeof incoming !== 'object') return incoming
  const before = snapshotSignature(previous as object), after = snapshotSignature(incoming as object)
  return before === after ? previous : incoming
}

const snapshotSignatures = new WeakMap<object, string>()
function snapshotSignature(value: object): string {
  let signature = snapshotSignatures.get(value)
  if (signature === undefined) { signature = JSON.stringify(value); snapshotSignatures.set(value, signature) }
  return signature
}
