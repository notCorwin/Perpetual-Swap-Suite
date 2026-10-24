import type { NativeMarketRow } from "./market-row.ts"

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
export function reconcileMarketRows<Row extends NativeMarketRow>(previous: Row[], incoming: Row[]): Row[] {
  const byID = new Map(previous.map(row => [row.instId, row]))
  const next = incoming.map(row => {
    const old = byID.get(row.instId)
    return old && equalValue(old, row) ? old : row
  })
  return previous.length === next.length && next.every((row, index) => row === previous[index]) ? previous : next
}

const REMOVAL_DELAY_MS = 30_000

// Qualification can briefly fail between live observations. Only list membership
// is buffered; incoming readings and the backend's qualification remain current.
export class MarketRowsBuffer<Row extends NativeMarketRow> {
  private rows: Row[] = []
  private removals = new Map<string, number>()
  private scope: string | undefined

  get nextRemovalAt(): number | null {
    return this.removals.size ? Math.min(...this.removals.values()) : null
  }

  update(incoming: Row[], now: number, scope: string): Row[] {
    if (scope !== this.scope) {
      this.rows = []
      this.removals.clear()
      this.scope = scope
    }
    const present = new Set(incoming.map(row => row.instId))
    for (const id of present) this.removals.delete(id)
    const next = [...incoming]
    for (const row of this.rows) {
      if (present.has(row.instId)) continue
      const deadline = this.removals.get(row.instId) ?? now + REMOVAL_DELAY_MS
      if (now < deadline) {
        this.removals.set(row.instId, deadline)
        next.push(row)
      } else this.removals.delete(row.instId)
    }
    this.rows = reconcileMarketRows(this.rows, next)
    return this.rows
  }

  expire(now: number): Row[] {
    this.rows = this.rows.filter(row => {
      const deadline = this.removals.get(row.instId)
      if (deadline === undefined || now < deadline) return true
      this.removals.delete(row.instId)
      return false
    })
    return this.rows
  }
}
