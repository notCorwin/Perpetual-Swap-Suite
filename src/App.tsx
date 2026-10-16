import { useEffect, useState } from 'react'

type Snapshot = {
  status: string
  markets: unknown[]
  selectedInstrument: string | null
  error?: string | null
}

declare global {
  interface Window {
    webkit?: { messageHandlers: { suite: { postMessage(value: unknown): Promise<Snapshot> } } }
  }
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() => window.webkit ? null : {
    status: 'Browser preview', markets: [], selectedInstrument: 'BTC-USDT-SWAP',
  })
  const [error, setError] = useState('')

  useEffect(() => {
    const bridge = window.webkit?.messageHandlers.suite
    if (!bridge) return
    void bridge.postMessage({ method: 'snapshot' }).then(setSnapshot).catch(cause => setError(String(cause)))
  }, [])

  return <main className="foundation">
    <div className="traffic-lights-space" />
    <p className="eyebrow">PERPETUAL SWAP SUITE</p>
    <h1>New market workspace</h1>
    <p>The SQLite, Radar, and Research architecture has been removed.</p>
    <dl>
      <div><dt>Native service</dt><dd>{snapshot?.status ?? 'Connecting'}</dd></div>
      <div><dt>Selected contract</dt><dd>{snapshot?.selectedInstrument ?? '—'}</dd></div>
      <div><dt>Loaded markets</dt><dd>{snapshot?.markets.length ?? 0}</dd></div>
      <div><dt>Storage</dt><dd>DuckDB + Parquet</dd></div>
    </dl>
    {(error || snapshot?.error) && <p className="error">{error || snapshot?.error}</p>}
  </main>
}
