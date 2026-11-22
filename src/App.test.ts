import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { lazy } from 'react'
import { parse } from '@babel/parser'
import { reconcileMarketOrder, reconcileMarketRows } from './market-snapshot.ts'
import { CHART_PRIMARY_TIMEFRAME, DEFAULT_PREFERENCES, type Preferences } from './renderer-preferences.ts'
import { SnapshotOrder } from './snapshot-order.ts'
import { formatCurrentPrice } from './price-format.ts'
import { timeframeLabel } from './timeframe.ts'
import type { DataAudit, HistoryDownload, MarketSnapshot, PresentationUpdate, RankedMarketRow } from './desktop-contract.ts'

type View = {
  preferences: Preferences; rows: RankedMarketRow[]; turnoverOrder: string[]; ready: boolean; status: string; error: string
  selectedID: string | null
  globalAudit: DataAudit | null; globalDownload: HistoryDownload | null
  auditStatusUnavailable: boolean; downloadStatusUnavailable: boolean
  issues: { id: string; detail: string }[]
  receiveAudit(value: DataAudit): void
}
type Slot = { value?: unknown; dependencies?: unknown[]; cleanup?: void | (() => void) }

// Run the production hook body with injected IPC and hook scheduling. Strip only
// the JSX return so these behavior tests never create a DOM, window or Electron.
const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
const component = ast.program.body.find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'App')
assert.ok(component?.type === 'FunctionDeclaration')
const renderChart = component.body.body.find(node => node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.type === 'Identifier' && item.id.name === 'renderChart'))
assert.ok(renderChart)
const declarations = ast.program.body.filter(node => node.type === 'VariableDeclaration'
  && node.declarations.every(declaration => declaration.id.type === 'Identifier' && declaration.id.name !== 'MarketRowView'))
const logic = stripTypeScriptTypes([
  ...declarations.map(node => source.slice(node.start!, node.end!)),
  source.slice(component.start!, renderChart.start!),
  'return { preferences, rows, turnoverOrder, ready, status, error, selectedID, globalAudit, globalDownload, auditStatusUnavailable, downloadStatusUnavailable, issues, receiveAudit } }',
].join('\n'))

function fixture(snapshotFailure = false) {
  const slots: Slot[] = [], effects: (() => void)[] = []
  let cursor = 0, dirty = true, rendered: View, timers = 0
  const snapshotRequests: { sinceRevision: number; serviceSession?: string }[] = []
  const jobRequests: string[] = []
  const universeRequests: unknown[][] = []
  const state = {
    preferences: structuredClone(DEFAULT_PREFERENCES), revision: 1, snapshotFailure, serviceSession: 'fixture',
    metadata: { loading: false, catalogSource: 'live', error: '', realtimeState: 'live' } as Pick<MarketSnapshot, 'loading' | 'catalogSource' | 'error' | 'catalogProgress' | 'realtimeState'>,
    rows: [{ instId: 'BTC-USDT-SWAP', tickSz: '0.1', lastPrice: 100, rankingChange: 2, rankingAsOf: 900_000, turnover24hUSDT: 100 }] as RankedMarketRow[],
    afterUpdate: undefined as undefined | (() => Promise<void>),
    beforeUpdate: undefined as undefined | (() => Promise<void>),
    beforeSnapshot: undefined as undefined | (() => Promise<void>),
    beforeJobs: undefined as undefined | (() => Promise<void>),
    jobsFail: false,
    audit: { revision: 1, serviceSession: 'fixture', phase: 'running', progress: { completed: 1, total: 3 }, issues: [], error: '' } as DataAudit,
    download: { revision: 1, serviceSession: 'fixture', phase: 'running', progress: { checked: 1, total: 3 } } as HistoryDownload,
  }
  const window = Object.assign(new EventTarget(), {
    setTimeout() { return ++timers },
    clearTimeout() {},
    radarDesktop: { async request(command: {
      preferences?: { action: string; values?: Partial<Preferences> }
      snapshot?: { sinceRevision: number; serviceSession?: string }
      dataAudit?: { action: string }; historyDownload?: { action: string }
      statusLog?: unknown
    }) {
      if (command.statusLog) return { ok: true }
      if (command.preferences) {
        if (command.preferences.action === 'update') {
          await state.beforeUpdate?.()
          state.preferences = { ...state.preferences, ...command.preferences.values }
          await state.afterUpdate?.()
        }
        return structuredClone(state.preferences)
      }
      if (command.dataAudit || command.historyDownload) {
        const name = command.dataAudit ? 'audit' : 'download'
        jobRequests.push(name)
        const result = structuredClone(state[name])
        await state.beforeJobs?.()
        if (state.jobsFail) throw new Error('Worker unavailable')
        return result
      }
      const query = command.snapshot!
      snapshotRequests.push(query)
      if (state.snapshotFailure) throw new Error('Worker unavailable')
      const metadata = { revision: state.revision, serviceSession: state.serviceSession, ...state.metadata }
      const result = query.sinceRevision === state.revision && query.serviceSession === state.serviceSession ? { ...metadata, unchanged: true }
        : { ...metadata, rows: structuredClone(state.rows), turnoverOrder: state.rows.map(row => row.instId).toReversed(), updatedAt: 1 }
      await state.beforeSnapshot?.()
      return result
    } },
  })
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  let presentation: PresentationUpdate = { epoch: 0, active: true, startedAt: 0 }
  const transitions = new Set<(value: PresentationUpdate) => void>()
  function slot() { return slots[cursor++] ?? (slots[cursor - 1] = {}) }
  const changed = (previous: unknown[] | undefined, next: unknown[]) => !previous || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]))
  const environment = {
    lazy,
    window, document, CHART_PRIMARY_TIMEFRAME, DEFAULT_PREFERENCES, SnapshotOrder, reconcileMarketRows, reconcileMarketOrder, formatCurrentPrice, timeframeLabel,
    chartController: { ingestPrepared() {}, setPresentationActive() {}, getSnapshot: () => ({}), setUniverse: (...args: unknown[]) => { universeRequests.push(args) } },
    usePresentation: () => presentation,
    getPresentation: () => presentation,
    subscribePresentationTransition: (listener: (value: PresentationUpdate) => void) => { transitions.add(listener); listener(presentation); return () => { transitions.delete(listener) } },
    waitForPresentation: () => Promise.resolve(),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
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
    useEffect(setup: () => void | (() => void), dependencies: unknown[]) {
      const current = slot()
      if (changed(current.dependencies, dependencies)) {
        current.dependencies = dependencies
        effects.push(() => { if (current.cleanup) current.cleanup(); current.cleanup = setup() })
      }
    },
    useLayoutEffect(setup: () => void | (() => void), dependencies: unknown[]) { environment.useEffect(setup, dependencies) },
  }
  const scope = { ...environment, chartCoordinator: environment.chartController, ingestPreparedChart: environment.chartController.ingestPrepared }
  const render = new Function(...Object.keys(scope), `${logic}\nreturn App`)(...Object.values(scope)) as () => View
  return {
    state, snapshotRequests, universeRequests, jobRequests,
    get view() { return rendered },
    get timers() { return timers },
    notify() { window.dispatchEvent(new Event('radar-market-changed')) },
    notifyPreferences() { window.dispatchEvent(new CustomEvent('radar-preferences-changed', { detail: structuredClone(state.preferences) })) },
    notifyJob(name: 'audit' | 'download') { window.dispatchEvent(new CustomEvent(name === 'audit' ? 'radar-audit-changed' : 'radar-history-download-changed', { detail: structuredClone(state[name]) })) },
    present(update: PresentationUpdate) { presentation = update; for (const listener of transitions) listener(update); dirty = true },
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

test('initial job status reads reuse newer pushed snapshots and never poll', async context => {
  const app = fixture(); context.after(() => app.close())
  const releases: (() => void)[] = []
  app.state.beforeJobs = () => new Promise<void>(resolve => { releases.push(resolve) })
  await app.flush()
  assert.deepEqual(app.jobRequests.sort(), ['audit', 'download'])
  app.state.audit = { ...app.state.audit, serviceSession: 'replacement', revision: 2, phase: 'completed' }
  app.notifyJob('audit')
  await app.flush()
  releases.forEach(release => release())
  await app.flush()
  assert.equal(app.view.globalAudit?.revision, 2)
  assert.equal(app.view.globalAudit?.serviceSession, 'replacement')
  assert.equal(app.view.globalAudit?.phase, 'completed')
  assert.equal(app.view.globalDownload?.revision, 1)
  assert.equal(app.jobRequests.length, 2)
})

test('job status failures remain visible until a later authoritative update', async context => {
  const app = fixture(); context.after(() => app.close())
  app.state.jobsFail = true
  await app.flush()
  assert.equal(app.view.auditStatusUnavailable, true)
  assert.equal(app.view.downloadStatusUnavailable, true)
  app.view.receiveAudit(app.state.audit)
  await app.flush()
  assert.equal(app.view.auditStatusUnavailable, false)
  assert.equal(app.view.downloadStatusUnavailable, true)
  const obsolete = { ...app.state.audit, revision: 0 }
  app.view.receiveAudit(obsolete)
  await app.flush()
  assert.equal(app.view.globalAudit?.serviceSession, 'fixture')
})

test('a settings preference notification preserves active market state', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  const rows = app.view.rows, requests = app.snapshotRequests.length, universes = app.universeRequests.length
  app.state.preferences = { ...app.state.preferences, historyDays: 90 }
  app.notifyPreferences()
  await app.flush()
  assert.equal(app.view.preferences.historyDays, 90)
  assert.equal(app.view.rows, rows)
  assert.equal(app.view.ready, true)
  assert.equal(app.view.status, 'Live')
  assert.equal(app.snapshotRequests.length, requests)
  assert.equal(app.universeRequests.length, universes)
  assert.equal(app.timers, 0)
})

test('a market notification alongside a preference notification stays authoritative', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  app.state.rows = [{ ...app.state.rows[0], instId: 'ETH-USDT-SWAP' }]
  app.state.revision++
  app.notify()
  app.state.preferences = { ...app.state.preferences, historyDays: 90 }
  app.notifyPreferences()
  await app.flush()
  assert.equal(app.view.rows[0]?.instId, 'ETH-USDT-SWAP')
  assert.equal(app.view.preferences.historyDays, 90)
  assert.equal(app.view.ready, true)
  assert.equal(app.snapshotRequests.length, 2)
  assert.equal(app.snapshotRequests[1].sinceRevision, 1)
})

test('an old market request cannot replace the resume snapshot or the retained selection', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  let release!: () => void
  app.state.rows = [{ ...app.state.rows[0], lastPrice: 101 }]
  app.state.revision++
  app.state.beforeSnapshot = () => new Promise<void>(resolve => { release = resolve })
  app.notify(); await app.flush()
  app.present({ epoch: 1, active: false, startedAt: 1 })
  await app.flush()
  assert.equal(app.view.rows[0].lastPrice, 100)
  const snapshot = {
    market: { ...app.state.metadata, revision: 3, serviceSession: app.state.serviceSession, rows: [{ ...app.state.rows[0], lastPrice: 102 }], turnoverOrder: ['BTC-USDT-SWAP'], updatedAt: 2 },
    preferences: app.state.preferences, frames: [], audit: app.state.audit, download: app.state.download,
  } as unknown as PresentationUpdate['snapshot']
  app.present({ epoch: 2, active: true, startedAt: 2, snapshot })
  await app.flush()
  assert.equal(app.view.rows[0].lastPrice, 102)
  assert.equal(app.view.selectedID, 'BTC-USDT-SWAP')
  release(); await app.flush()
  assert.equal(app.view.rows[0].lastPrice, 102)
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

test('a chart retained across idle survives later qualification updates without inventing list rows', async context => {
  const app = fixture(); context.after(() => app.close())
  await app.flush()
  app.present({ epoch: 1, active: false, startedAt: 1 })
  app.state.rows = [{ ...app.state.rows[0], instId: 'ETH-USDT-SWAP' }]
  app.state.revision++
  const market = { ...app.state.metadata, rows: app.state.rows, turnoverOrder: [], revision: app.state.revision, serviceSession: app.state.serviceSession, updatedAt: 1 }
  app.present({ epoch: 2, active: true, startedAt: 2, snapshot: { market, frames: [], preferences: app.state.preferences, audit: app.state.audit, download: app.state.download } })
  await app.flush()
  app.state.revision++; app.notify(); await app.flush()
  assert.equal(app.view.selectedID, 'BTC-USDT-SWAP')
  assert.deepEqual(app.view.rows.map(row => row.instId), ['ETH-USDT-SWAP'])
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
  assert.equal(app.timers, 1, 'The error notification schedules its dismissal.')
  await app.flush()
  assert.equal(app.snapshotRequests.length, 1, 'Dismissal does not poll market snapshots.')
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
