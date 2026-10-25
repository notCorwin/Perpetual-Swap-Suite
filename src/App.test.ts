import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { parse } from '@babel/parser'
import { reconcileMarketOrder, reconcileMarketRows } from './market-snapshot.ts'
import { DEFAULT_PREFERENCES, type Preferences } from './renderer-preferences.ts'
import { SnapshotOrder } from './snapshot-order.ts'
import type { MarketSnapshot, RankedMarketRow } from './desktop-contract.ts'
import type { RadarTimeframe } from './timeframe.ts'

type View = {
  preferences: Preferences; rows: RankedMarketRow[]; turnoverOrder: string[]; ready: boolean; status: string; error: string
  selectedID: string | null
  savePreferences(values: Partial<Preferences>): Promise<void>
  changeTimeframe(timeframe: RadarTimeframe): void
}
type Slot = { value?: unknown; dependencies?: unknown[]; cleanup?: void | (() => void) }

// Run the production hook body with injected IPC and hook scheduling. Strip only
// the JSX return so these behavior tests never create a DOM, window or Electron.
const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
const component = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'App')
assert.ok(component?.type === 'FunctionDeclaration')
const renderReturn = component.body.body.at(-1)
assert.ok(renderReturn?.type === 'ReturnStatement')
const declarations = ast.program.body.filter(node => node.type === 'VariableDeclaration'
  && node.declarations.every(declaration => declaration.id.type === 'Identifier' && declaration.id.name !== 'MarketRowView'))
const logic = stripTypeScriptTypes([
  ...declarations.map(node => source.slice(node.start!, node.end!)),
  source.slice(component.start!, renderReturn.start!),
  'return { preferences, rows, turnoverOrder, ready, status, error, selectedID, savePreferences, changeTimeframe } }',
].join('\n'))

function fixture(snapshotFailure = false) {
  const slots: Slot[] = [], effects: (() => void)[] = []
  let cursor = 0, dirty = true, rendered: View, timers = 0, now = 0
  const pendingTimers = new Map<number, { callback: () => void; at: number }>()
  const snapshotRequests: { sinceRevision: number; serviceSession?: string }[] = []
  const universeRequests: unknown[][] = []
  const state = {
    preferences: structuredClone(DEFAULT_PREFERENCES), revision: 1, snapshotFailure, serviceSession: 'fixture',
    metadata: { loading: false, catalogSource: 'live', error: '' } as Pick<MarketSnapshot, 'loading' | 'catalogSource' | 'error' | 'catalogProgress'>,
    rows: [{ instId: 'BTC-USDT-SWAP', lastPrice: 100, rankingChange: 2, rankingAsOf: 900_000, turnover24hUSDT: 100 }] as RankedMarketRow[],
    afterUpdate: undefined as undefined | (() => Promise<void>),
  }
  const window = Object.assign(new EventTarget(), {
    setTimeout(callback: () => void, delay: number) { const id = ++timers; pendingTimers.set(id, { callback, at: now + delay }); return id },
    clearTimeout(id: number) { pendingTimers.delete(id) },
    radarDesktop: { async request(command: {
      preferences?: { action: string; values?: Partial<Preferences> }
      snapshot?: { sinceRevision: number; serviceSession?: string }
    }) {
      if (command.preferences) {
        if (command.preferences.action === 'update') {
          state.preferences = { ...state.preferences, ...command.preferences.values }
          await state.afterUpdate?.()
        }
        return structuredClone(state.preferences)
      }
      const query = command.snapshot!
      snapshotRequests.push(query)
      if (state.snapshotFailure) throw new Error('Worker unavailable')
      const metadata = { revision: state.revision, serviceSession: state.serviceSession, ...state.metadata }
      return query.sinceRevision === state.revision && query.serviceSession === state.serviceSession ? { ...metadata, unchanged: true }
        : { ...metadata, rows: structuredClone(state.rows), turnoverOrder: state.rows.map(row => row.instId).toReversed(), updatedAt: 1 }
    } },
  })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  function slot() { return slots[cursor++] ?? (slots[cursor - 1] = {}) }
  const changed = (previous: unknown[] | undefined, next: unknown[]) => !previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]))
  const environment = {
    window, document, DEFAULT_PREFERENCES, SnapshotOrder, reconcileMarketRows, reconcileMarketOrder,
    performance: { now: () => now },
    chartController: { ingestPrepared() {}, getSnapshot: () => ({}), setUniverse: (...args: unknown[]) => { universeRequests.push(args) } },
    useSettingsSection: () => null,
    useRef<T>(initial: T) { const current = slot(); return current.value ??= { current: initial } },
    useState<T>(initial: T) {
      const current = slot()
      if (!('value' in current)) current.value = typeof initial === 'function' ? (initial as () => T)() : initial
      return [current.value, (value: T | ((previous: T) => T)) => {
        const next = typeof value === 'function' ? (value as (previous: T) => T)(current.value as T) : value
        if (!Object.is(current.value, next)) { current.value = next; dirty = true }
      }]
    },
    useMemo<T>(calculate: () => T, dependencies: unknown[]) {
      const current = slot()
      if (changed(current.dependencies, dependencies)) { current.value = calculate(); current.dependencies = dependencies }
      return current.value
    },
    useCallback<T>(callback: T, dependencies: unknown[]) { return environment.useMemo(() => callback, dependencies) },
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, read: () => unknown) {
      environment.useEffect(() => subscribe(() => { dirty = true }), [subscribe])
      return read()
    },
    useEffect(setup: () => void | (() => void), dependencies: unknown[]) {
      const current = slot()
      if (changed(current.dependencies, dependencies)) {
        current.dependencies = dependencies
        effects.push(() => { if (current.cleanup) current.cleanup(); current.cleanup = setup() })
      }
    },
  }
  const render = new Function(...Object.keys(environment), `${logic}\nreturn App`)(...Object.values(environment)) as () => View
  return {
    state, snapshotRequests, universeRequests,
    get view() { return rendered },
    get timers() { return timers },
    get pendingTimers() { return pendingTimers.size },
    advance(milliseconds: number) {
      now += milliseconds
      for (const [id, timer] of pendingTimers) if (timer.at <= now) { pendingTimers.delete(id); timer.callback() }
    },
    fireTimerEarly() {
      const [id, timer] = pendingTimers.entries().next().value!
      pendingTimers.delete(id); timer.callback()
    },
    notify() { window.dispatchEvent(new Event('radar-market-changed')) },
    async flush() {
      for (let pass = 0; pass < 8; pass++) {
        if (dirty) {
          cursor = 0; dirty = false; rendered = render()
          effects.splice(0).forEach(effect => effect())
        }
        await new Promise(resolve => setImmediate(resolve))
      }
      assert.equal(dirty, false, 'The production hooks must settle without an update loop.')
    },
    close() { for (const current of slots) if (current.cleanup) current.cleanup() },
  }
}

test('no-op and audit-only preference saves retain the active market loading state', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  const rows = app.view.rows, requests = app.snapshotRequests.length, universes = app.universeRequests.length
  await app.view.savePreferences({})
  await app.flush()
  await app.view.savePreferences({ historyDays: 90 })
  await app.flush()
  assert.equal(app.view.rows, rows)
  assert.equal(app.view.ready, true)
  assert.equal(app.view.status, 'Live')
  assert.equal(app.snapshotRequests.length, requests)
  assert.equal(app.universeRequests.length, universes)
  assert.equal(app.timers, 0)
})

test('a market notification arriving before the preference response stays authoritative', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  let release = () => {}
  app.state.afterUpdate = async () => {
    app.state.rows = [{ ...app.state.rows[0], instId: 'ETH-USDT-SWAP' }]
    app.state.revision++
    app.notify()
    await new Promise<void>(resolve => { release = resolve })
  }
  const saving = app.view.savePreferences({ liquidity: { ...app.view.preferences.liquidity, spread: { enabled: false, maxPercent: 0.05 } } })
  await app.flush()
  assert.equal(app.view.rows[0]?.instId, 'ETH-USDT-SWAP')
  const rows = app.view.rows
  release(); await saving; await app.flush()
  assert.equal(app.view.rows, rows)
  assert.equal(app.view.ready, true)
  assert.equal(app.snapshotRequests.length, 2)
  assert.equal(app.snapshotRequests[1].sinceRevision, 1)
})

test('all qualified rows are immediately visible without any chart render receipts', async context => {
  const app = fixture(); context.after(() => app.close())
  app.state.rows.push({ ...app.state.rows[0], instId: 'ETH-USDT-SWAP', rankingChange: 9 })
  await app.flush()
  assert.deepEqual(app.view.rows.map(row => row.instId), ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], 'Backend order is authoritative, even while charts are cold.')
  assert.deepEqual(app.view.turnoverOrder, ['ETH-USDT-SWAP', 'BTC-USDT-SWAP'], 'Volume navigation consumes the backend order.')
  assert.equal(app.view.selectedID, 'BTC-USDT-SWAP')
  assert.equal(app.timers, 0)
})

test('price updates refresh rows without rebuilding chart membership or equal navigation order', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  const universes = app.universeRequests.length, turnoverOrder = app.view.turnoverOrder
  app.state.rows = [{ ...app.state.rows[0], lastPrice: 101 }]
  app.state.revision++; app.notify(); await app.flush()
  assert.equal(app.view.rows[0].lastPrice, 101)
  assert.equal(app.view.turnoverOrder, turnoverOrder)
  assert.equal(app.universeRequests.length, universes)
  app.state.rows = [{ ...app.state.rows[0], instId: 'ETH-USDT-SWAP' }]
  app.state.revision++; app.notify(); await app.flush()
  assert.equal(app.view.selectedID, 'ETH-USDT-SWAP')
  assert.ok(app.universeRequests.length > universes)
})

test('switching every chart timeframe preserves the list and never reloads its snapshot', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  const rows = app.view.rows, requests = app.snapshotRequests.length
  for (const timeframe of ['1H', '5m', '15m'] as const) {
    app.view.changeTimeframe(timeframe)
    await app.flush()
    assert.equal(app.view.preferences.chartTimeframe, timeframe)
    assert.equal(app.view.rows, rows)
    assert.equal(app.view.selectedID, 'BTC-USDT-SWAP')
    assert.equal(app.view.status, 'Live')
    assert.equal(app.snapshotRequests.length, requests)
  }
  assert.deepEqual(app.snapshotRequests, [{ sinceRevision: -1, serviceSession: undefined }])
})

test('backend exclusion is applied immediately without a renderer grace period', async context => {
  const app = fixture(); context.after(() => app.close())
  app.state.rows.push({ ...app.state.rows[0], instId: 'ETH-USDT-SWAP' })
  await app.flush()
  app.state.rows = [app.state.rows[1]]
  app.state.revision++; app.notify(); await app.flush()
  assert.deepEqual(app.view.rows.map(row => row.instId), ['ETH-USDT-SWAP'])
  assert.equal(app.view.selectedID, 'ETH-USDT-SWAP')
  assert.equal(app.timers, 0, 'The renderer does not schedule qualification work.')
  app.state.rows = []; app.state.revision++; app.notify(); await app.flush()
  assert.deepEqual(app.view.rows, [])
  assert.equal(app.view.selectedID, null)
})

test('an unverified empty snapshot retains only the current chart, never invented list rows', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  app.state.rows = []
  app.state.metadata = { loading: true, catalogSource: 'live', error: '', catalogProgress: { total: 1, completed: 0, verified: 0, failed: 0, unknown: 0, pending: 1 } }
  app.state.revision++; app.notify(); await app.flush()
  assert.deepEqual(app.view.rows, [])
  assert.equal(app.view.selectedID, 'BTC-USDT-SWAP')
  app.state.metadata = { loading: false, catalogSource: 'live', error: '' }
  app.state.revision++; app.notify(); await app.flush()
  assert.equal(app.view.selectedID, null)
})

test('unchanged notifications and equal snapshots preserve row identities', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  const rows = app.view.rows
  app.notify(); await app.flush()
  assert.equal(app.view.rows, rows)
  app.state.revision++; app.notify(); await app.flush()
  assert.equal(app.view.rows, rows)
  app.state.rows = [{ ...app.state.rows[0], lastPrice: 102 }]
  app.state.revision++; app.notify(); await app.flush()
  assert.notEqual(app.view.rows, rows)
  assert.equal(app.view.rows[0].lastPrice, 102)
  assert.deepEqual(app.snapshotRequests.map(request => request.sinceRevision), [-1, 1, 1, 2])
})

test('local snapshot failures wait for a backend notification without polling', async context => {
  const app = fixture(true); context.after(() => app.close())
  await app.flush()
  assert.equal(app.view.status, 'Unavailable')
  assert.equal(app.snapshotRequests.length, 1)
  assert.equal(app.timers, 0)
  app.state.snapshotFailure = false
  app.notify(); await app.flush()
  assert.equal(app.snapshotRequests.length, 2)
  assert.equal(app.view.status, 'Live')
  assert.equal(app.view.error, '')
})

test('a new backend session can replace an older higher revision', async context => {
  const app = fixture(); context.after(() => app.close())
  app.state.revision = 20; await app.flush()
  app.state.serviceSession = 'restarted'; app.state.revision = 1
  app.state.rows = [{ ...app.state.rows[0], instId: 'ETH-USDT-SWAP' }]
  app.notify(); await app.flush()
  assert.deepEqual(app.view.rows.map(row => row.instId), ['ETH-USDT-SWAP'])
  assert.equal(app.view.selectedID, 'ETH-USDT-SWAP')
})
