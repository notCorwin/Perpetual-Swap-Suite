import type { ModelMessage } from 'ai'
import type { ChartImage } from './chart-capture.ts'

export const DEFAULT_ANALYSIS_MODEL = 'openai/gpt-6.1-sol'
export const ANALYSIS_PROMPTS = {
  long: {
    label: 'Chase long',
    question: 'Would you enter a long here? If so, where would you place a limit order and why? Otherwise, what confirmation would you wait for?',
    system: 'You analyze OKX USDT perpetual swap charts. Use the timeframe shown in the screenshot. Answer in concise English whether to enter a long, a suitable limit price and its rationale, or the confirmation to wait for. State what would invalidate the setup. Distinguish the forming candle from confirmed signals. Do not invent unreadable prices or missing information.',
  },
  short: {
    label: 'Chase short',
    question: 'Would you enter a short here? If so, where would you place a limit order and why? Otherwise, what confirmation would you wait for?',
    system: 'You analyze OKX USDT perpetual swap charts. Use the timeframe shown in the screenshot. Answer in concise English whether to enter a short, a suitable limit price and its rationale, or the confirmation to wait for. State what would invalidate the setup. Distinguish the forming candle from confirmed signals. Do not invent unreadable prices or missing information.',
  },
}
export type AnalysisDirection = keyof typeof ANALYSIS_PROMPTS
export type AnalysisSettings = { model: string; hasAPIKey: boolean }
export type AnalysisSettingsRequest = { action: 'read' } | { action: 'save'; model: string; apiKey: string } | { action: 'removeKey' }
export type AnalysisTurn = { id: string; question: string; text: string; status: 'streaming' | 'complete' | 'stopped' | 'error'; error: string }
export type AnalysisSession = {
  instId: string; direction: AnalysisDirection; model: string; image: ChartImage | null; capturedAt: number; rangeLabel: string; draft: string
  phase: 'capturing' | 'ready' | 'streaming' | 'error' | 'stopped'; error: string; turns: AnalysisTurn[]
}
export type AnalysisRunner = (input: { model: string; instructions: string; messages: ModelMessage[]; signal: AbortSignal }, onText: (text: string) => void) => Promise<void>
export type AnalysisSnapshot = ChartImage & { capturedAt: number; rangeLabel: string }

export function analysisMessages(session: AnalysisSession, index: number): ModelMessage[] {
  if (!session.image) throw new Error('Start a new analysis to capture a chart.')
  const messages: ModelMessage[] = [{ role: 'user', content: [
    { type: 'text', text: ANALYSIS_PROMPTS[session.direction].question },
    { type: 'file', data: new URL(session.image.imageDataURL), mediaType: 'image/png' },
  ] }]
  for (let i = 0; i < index; i++) {
    const turn = session.turns[i]
    if (!turn.text.trim()) continue
    if (i > 0) messages.push({ role: 'user', content: turn.question })
    messages.push({ role: 'assistant', content: turn.text })
  }
  if (index > 0) messages.push({ role: 'user', content: session.turns[index].question })
  return messages
}

/// A process-local store shared by all market chart entry points. No chart,
/// draft, or generated answer is written to local storage or the database.
export class ChartAnalysisStore {
  private sessions = new Map<string, AnalysisSession>()
  private operations = new Map<string, AbortController>()
  private listeners = new Set<() => void>()
  private nextTurn = 0
  private runner: AnalysisRunner
  private settings: () => Promise<AnalysisSettings>
  constructor(runner: AnalysisRunner, settings: () => Promise<AnalysisSettings>) { this.runner = runner; this.settings = settings }
  get = (id: string) => this.sessions.get(id) ?? null
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(id: string, session: AnalysisSession) {
    this.sessions.set(id, session); for (const listener of this.listeners) listener()
  }
  private update(id: string, update: (session: AnalysisSession) => AnalysisSession) {
    const session = this.get(id); if (session) this.publish(id, update(session))
  }
  draft(id: string, draft: string) { this.update(id, session => ({ ...session, draft })) }
  stop(id: string) {
    const operation = this.operations.get(id)
    if (!operation) return
    this.operations.delete(id); operation.abort(new DOMException('Request stopped.', 'AbortError'))
    this.update(id, session => ({ ...session, phase: 'stopped', error: '', turns: session.turns.map(turn => turn.status === 'streaming' ? { ...turn, status: 'stopped' } : turn) }))
  }
  private current(id: string, operation: AbortController) { return this.operations.get(id) === operation && !operation.signal.aborted }
  async analyze(id: string, capture: () => Promise<AnalysisSnapshot>, direction: AnalysisDirection = 'long') {
    this.stop(id)
    const operation = new AbortController()
    this.operations.set(id, operation)
    this.publish(id, { instId: id, direction, model: DEFAULT_ANALYSIS_MODEL, image: null, capturedAt: 0, rangeLabel: '', draft: '', phase: 'capturing', error: '', turns: [] })
    try {
      const settings = await this.settings()
      if (!this.current(id, operation)) return
      if (!settings.hasAPIKey) throw new Error('Configure a Gateway API Key to analyze charts.')
      const image = await capture()
      if (!this.current(id, operation)) return
      this.update(id, session => ({ ...session, model: settings.model, image, capturedAt: image.capturedAt, rangeLabel: image.rangeLabel }))
      await this.runTurn(id, ANALYSIS_PROMPTS[direction].question, operation)
    } catch (error) { this.fail(id, operation, error) }
    finally { if (this.current(id, operation)) this.operations.delete(id) }
  }
  async send(id: string, question: string) {
    const session = this.get(id)
    if (!session?.image || !question.trim() || this.operations.has(id)) return
    const operation = new AbortController(); this.operations.set(id, operation)
    this.draft(id, '')
    try { await this.runTurn(id, question.trim(), operation) }
    catch (error) { this.fail(id, operation, error) }
    finally { if (this.current(id, operation)) this.operations.delete(id) }
  }
  async retry(id: string) {
    const session = this.get(id), last = session?.turns.at(-1)
    if (!last || !['error', 'stopped'].includes(last.status) || this.operations.has(id)) return
    const operation = new AbortController(); this.operations.set(id, operation)
    try { await this.runTurn(id, last.question, operation, true) }
    catch (error) { this.fail(id, operation, error) }
    finally { if (this.current(id, operation)) this.operations.delete(id) }
  }
  private fail(id: string, operation: AbortController, error: unknown) {
    if (!this.current(id, operation)) return
    const message = error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Could not analyze this chart.'
    this.update(id, session => ({ ...session, phase: 'error', error: message, turns: session.turns.map(turn => turn.status === 'streaming' ? { ...turn, status: 'error', error: message } : turn) }))
  }
  private async runTurn(id: string, question: string, operation: AbortController, retry = false) {
    const session = this.get(id)!
    const turn: AnalysisTurn = { id: retry ? session.turns.at(-1)!.id : `turn-${++this.nextTurn}`, question, text: '', status: 'streaming', error: '' }
    const turns = retry ? [...session.turns.slice(0, -1), turn] : [...session.turns, turn]
    const next = { ...session, turns, phase: 'streaming' as const, error: '' }
    this.publish(id, next)
    await this.runner({ model: next.model, instructions: ANALYSIS_PROMPTS[next.direction].system, messages: analysisMessages(next, turns.length - 1), signal: operation.signal }, text => {
      if (this.current(id, operation)) this.update(id, value => ({ ...value, turns: value.turns.map(item => item.id === turn.id ? { ...item, text: item.text + text } : item) }))
    })
    if (!this.current(id, operation)) return
    if (!this.get(id)!.turns.at(-1)!.text.trim()) throw new Error('The model returned an empty answer. It will retry automatically; you can also choose another model.')
    this.update(id, value => ({ ...value, phase: 'ready', turns: value.turns.map(item => item.id === turn.id ? { ...item, status: 'complete' } : item) }))
  }
}
