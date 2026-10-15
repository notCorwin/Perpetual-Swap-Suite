import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { generateText } from 'ai'
import { Bot, KeyRound, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { aiCredentialStatus, nativeAIFetch, saveAIKey } from '../lib/bridge'
import type { AppSettings, BacktestReport, WorkspaceSnapshot } from '../types'

type Props = {
  snapshot: WorkspaceSnapshot
  report: BacktestReport | null
  onSaveSettings(settings: AppSettings): Promise<unknown>
}

export function AIAnalysis({ snapshot, report, onSaveSettings }: Props) {
  const [baseURL, setBaseURL] = useState(snapshot.settings.aiBaseURL)
  const [model, setModel] = useState(snapshot.settings.aiModel)
  const [key, setKey] = useState('')
  const [configured, setConfigured] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => { void aiCredentialStatus().then(status => setConfigured(status.configured)) }, [])

  const save = async () => {
    const status = key ? await saveAIKey(key) : { configured }
    await onSaveSettings({ ...snapshot.settings, aiBaseURL: baseURL, aiModel: model })
    setConfigured(status.configured)
    setKey('')
    return status.configured
  }
  const analyze = async () => {
    setPending(true); setError(''); setResult('')
    try {
      const ready = await save()
      if (!ready) throw new Error('Save an API key before running analysis.')
      if (!model.trim()) throw new Error('Enter an OpenAI-compatible model name.')
      const provider = createOpenAICompatible({ name: 'perpetual-swap-suite', baseURL, apiKey: 'native-bridge', fetch: nativeAIFetch })
      const market = snapshot.markets.find(item => item.instrument.id === snapshot.selectedInstrument)
      const response = await generateText({
        model: provider(model),
        maxOutputTokens: 1_200,
        prompt: `Analyze this perpetual swap market and the optional backtest. Focus on entry quality, liquidation risk, and contradictory evidence. Do not give financial advice.\n\n${JSON.stringify({ market, timeframe: snapshot.settings.selectedTimeframe, candles: snapshot.candles.slice(-200), formingCandle: snapshot.formingCandle, backtest: report }, null, 2)}`,
      })
      setResult(response.text)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }

  return <div className="ai-panel">
    <div className="panel-title"><div><span className="section-kicker">OPENAI COMPATIBLE</span><h2>Chart analysis</h2></div><Bot size={17} /></div>
    <label className="ai-field"><span>Base URL</span><Input value={baseURL} onChange={event => setBaseURL(event.target.value)} /></label>
    <label className="ai-field"><span>Model</span><Input placeholder="Model name" value={model} onChange={event => setModel(event.target.value)} /></label>
    <label className="ai-field"><span><KeyRound size={10} /> API key {configured && <small>Saved</small>}</span><Input type="password" placeholder={configured ? '•••••••• (unchanged)' : 'API key'} value={key} onChange={event => setKey(event.target.value)} /></label>
    <div className="ai-actions"><Button className="secondary-button" onClick={() => void save()}>Save</Button><Button className="primary-button" disabled={pending} onClick={() => void analyze()}><Sparkles size={11} />{pending ? 'Analyzing…' : 'Analyze market'}</Button></div>
    {error && <div className="inline-error">{error}</div>}
    {result ? <div className="ai-result">{result}</div> : <div className="empty-report"><p>Analysis uses the latest 200 chart bars, liquidity readings, and the current backtest report.</p><small>The API key is injected by the native gateway and is never returned to WebKit.</small></div>}
  </div>
}
