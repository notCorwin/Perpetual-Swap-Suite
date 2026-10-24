import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { parse } from '@babel/parser'
import { compareRankingChange } from './market-ranking.ts'
import { reconcileMarketRows } from './market-snapshot.ts'
import { DEFAULT_PREFERENCES, type Preferences } from './renderer-preferences.ts'
import { SnapshotOrder } from './snapshot-order.ts'
import type { RankedMarketRow } from './desktop-contract.ts'
import type { RadarTimeframe } from './timeframe.ts'

type View = {
  preferences: Preferences; rows: RankedMarketRow[]; ready: boolean; status: string; error: string
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
  'return { preferences, rows, ready, status, error, savePreferences, changeTimeframe } }',
].join('\n'))

function fixture(snapshotFailure = false) {
  const slots: Slot[] = [], effects: (() => void)[] = []
  let cursor = 0, dirty = true, rendered: View, timers = 0
  const snapshotRequests: { timeframe: RadarTimeframe; sinceRevision: number }[] = []
  const universeRequests: unknown[][] = []
  const state = {
    preferences: structuredClone(DEFAULT_PREFERENCES), revision: 1, snapshotFailure,
    rows: [{ instId: 'BTC-USDT-SWAP', rankingChange: 2, turnover24hUSDT: 100 }] as RankedMarketRow[],
    afterUpdate: undefined as undefined | (() => Promise<void>),
  }
  const window = Object.assign(new EventTarget(), {
    setTimeout() { timers++; return 1 },
    radarDesktop: { async request(command: {
      preferences?: { action: string; values?: Partial<Preferences> }
      snapshot?: { timeframe: RadarTimeframe; sinceRevision: number }
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
      const metadata = { revision: state.revision, serviceSession: 'fixture', timeframe: query.timeframe, error: '', loading: false, catalogSource: 'live' }
      return query.sinceRevision === state.revision ? { ...metadata, unchanged: true }
        : { ...metadata, rows: structuredClone(state.rows), updatedAt: 1 }
    } },
  })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  function slot() { return slots[cursor++] ?? (slots[cursor - 1] = {}) }
  const changed = (previous: unknown[] | undefined, next: unknown[]) => !previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]))
  const environment = {
    window, document, DEFAULT_PREFERENCES, SnapshotOrder, compareRankingChange, reconcileMarketRows,
    clearTimeout() {},
    chartController: { ingestPrepared() {}, getSnapshot: () => ({}), setUniverse: (...args: unknown[]) => { universeRequests.push(args) } },
    useSettingsSection: () => null,
    useRef<T>(initial: T) { const current = slot(); return current.value ??= { current: initial } },
    useState<T>(initial: T) {
      const current = slot()
      if (!('value' in current)) current.value = initial
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

test('timeframe switches request their rows even at an unchanged collector revision', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  app.view.changeTimeframe('1H')
  await app.flush()
  assert.deepEqual(app.snapshotRequests.map(value => [value.timeframe, value.sinceRevision]), [['15m', -1], ['1H', -1]])
  assert.equal(app.view.preferences.chartTimeframe, '1H')
  assert.equal(app.view.ready, true)
})

test('local snapshot failures wait for a data-service notification without timed retry', async context => {
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
  assert.equal(app.view.ready, true)
})
