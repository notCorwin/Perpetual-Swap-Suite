import assert from 'node:assert/strict'
import test from 'node:test'
import { ANALYSIS_PROMPTS, ChartAnalysisStore, DEFAULT_ANALYSIS_MODEL, type AnalysisRunner } from './chart-analysis.ts'
import { createAnalysisRunner } from './analysis-service.ts'
import { createGatewayFetch, type GatewayBridge, type GatewayEvent } from './gateway-fetch.ts'

const snapshot = async () => ({ imageDataURL: 'data:image/png;base64,AA==', width: 1200, height: 800, capturedAt: 1234, rangeLabel: 'Oct 8 – Oct 12' })
const settings = async () => ({ model: DEFAULT_ANALYSIS_MODEL, hasAPIKey: true })

test('analysis and follow-ups keep the snapshot, model, and successful context per contract', async () => {
  const requests: Parameters<AnalysisRunner>[0][] = []
  const store = new ChartAnalysisStore(async (request, text) => { requests.push(request); text('等待确认。') }, settings)
  await store.analyze('BTC', snapshot)
  store.draft('BTC', '确认条件是什么？')
  await store.analyze('ETH', snapshot)
  assert.equal(store.get('BTC')?.draft, '确认条件是什么？')
  await store.send('BTC', store.get('BTC')!.draft)
  const messages = requests.at(-1)!.messages
  assert.equal(requests.at(-1)!.model, DEFAULT_ANALYSIS_MODEL)
  assert.equal(messages.length, 3)
  assert.equal(messages[1].content, '等待确认。')
  assert.equal(messages[2].content, '确认条件是什么？')
  const first = messages[0].content as { type: string; text?: string; data?: URL }[]
  assert.equal(first[0].text, ANALYSIS_PROMPTS.long.question)
  assert.equal(first[1].data?.href, (await snapshot()).imageDataURL)
  assert.equal(store.get('BTC')?.draft, '')
  await store.analyze('BTC', snapshot)
  assert.equal(store.get('BTC')?.turns.length, 1)
  assert.equal(requests.at(-1)!.messages.length, 1)
})

test('short analysis keeps its direction through follow-ups, retries, and other contracts', async () => {
  const requests: Parameters<AnalysisRunner>[0][] = []
  const store = new ChartAnalysisStore(async (request, text) => {
    requests.push(request); text('等待反弹确认。')
    if (requests.length === 3) throw new Error('Stream interrupted.')
  }, settings)
  await store.analyze('BTC', snapshot, 'short')
  await store.analyze('ETH', snapshot)
  await store.send('BTC', '反弹到哪里再开空？')
  await store.retry('BTC')
  assert.equal(store.get('BTC')?.direction, 'short')
  assert.equal(store.get('ETH')?.direction, 'long')
  assert.equal(store.get('BTC')?.turns.length, 2)
  assert.equal(store.get('BTC')?.phase, 'ready')
  assert.match(requests[1].instructions, /追多/)
  for (const request of [requests[0], requests[2], requests[3]]) {
    assert.match(request.instructions, /是否追空/)
    assert.doesNotMatch(request.instructions, /追多/)
    const first = request.messages[0].content as { type: string; text?: string }[]
    assert.equal(first[0].text, '你推荐我追空吗？如果追空，限价单开在哪个位置合适？如果不追，应该等待什么确认？')
  }
  assert.equal(requests[3].messages.at(-1)?.content, '反弹到哪里再开空？')
})

test('retry retains partial errors until retry and does not duplicate the question', async () => {
  let attempts = 0
  const store = new ChartAnalysisStore(async (_, text) => { text('部分'); if (++attempts === 1) throw new Error('Stream interrupted.'); text('完成') }, settings)
  await store.analyze('BTC', snapshot)
  assert.equal(store.get('BTC')?.turns[0].text, '部分')
  assert.equal(store.get('BTC')?.phase, 'error')
  await store.retry('BTC')
  assert.equal(attempts, 2)
  assert.equal(store.get('BTC')?.turns.length, 1)
  assert.equal(store.get('BTC')?.turns[0].text, '部分完成')
})

test('stop and replacement ignore late tokens and late snapshots', async () => {
  let release: () => void = () => {}, late: (text: string) => void = () => {}
  let requestSignal: AbortSignal | undefined
  const store = new ChartAnalysisStore(async (request, text) => { requestSignal = request.signal; late = text; text('部分'); await new Promise<void>(resolve => { release = resolve }) }, settings)
  const pending = store.analyze('BTC', snapshot)
  await new Promise(resolve => setImmediate(resolve))
  store.stop('BTC'); late('旧内容'); release(); await pending
  assert.equal(requestSignal?.aborted, true)
  assert.equal(store.get('BTC')?.turns[0].text, '部分')
  assert.equal(store.get('BTC')?.phase, 'stopped')
  let finishCapture: (image: Awaited<ReturnType<typeof snapshot>>) => void = () => {}
  const capturing = store.analyze('ETH', () => new Promise(resolve => { finishCapture = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  store.stop('ETH'); finishCapture(await snapshot()); await capturing
  assert.equal(store.get('ETH')?.image, null)
})

test('follow-ups can refer to visible partial answers after interruption', async () => {
  const requests: Parameters<AnalysisRunner>[0][] = []
  const store = new ChartAnalysisStore(async (request, text) => {
    requests.push(request); text('回踩区间'); if (requests.length === 1) throw new Error('Connection interrupted.')
  }, settings)
  await store.analyze('BTC', snapshot)
  await store.send('BTC', '解释这个区间')
  assert.equal(requests[1].messages[1].content, '回踩区间')
  assert.equal(requests[1].messages[2].content, '解释这个区间')
})

test('missing credentials and empty output produce actionable errors', async () => {
  let captures = 0
  const missing = new ChartAnalysisStore(async () => {}, async () => ({ model: DEFAULT_ANALYSIS_MODEL, hasAPIKey: false }))
  await missing.analyze('BTC', async () => { captures++; return snapshot() })
  assert.equal(captures, 0)
  assert.match(missing.get('BTC')!.error, /Configure a Gateway API Key/)
  const empty = new ChartAnalysisStore(async () => {}, settings)
  await empty.analyze('BTC', snapshot)
  assert.match(empty.get('BTC')!.error, /empty answer/)
})

function nativeFixture(status: number, data: string, interrupted = false, beforeTerminal?: Promise<void>) {
  const events = new EventTarget(), bodies: string[] = [], cancelled: string[] = []
  const bridge = { async postMessage(request: { gatewayFetch?: { id: string; body: string }; cancelGatewayFetch?: string }) {
    if (request.cancelGatewayFetch) { cancelled.push(request.cancelGatewayFetch); return { ok: true } }
    const { id, body } = request.gatewayFetch!
    bodies.push(body)
    setTimeout(async () => {
      const bytes = new TextEncoder().encode(data)
      // Deliberately split every multibyte Chinese character and SSE frame.
      for (const byte of bytes) events.dispatchEvent(new CustomEvent('radar-gateway-stream', { detail: { id, type: 'data', base64: btoa(String.fromCharCode(byte)) } satisfies GatewayEvent }))
      if (beforeTerminal) await beforeTerminal
      events.dispatchEvent(new CustomEvent('radar-gateway-stream', { detail: { id, type: interrupted ? 'error' : 'end', message: 'Gateway stream interrupted.' } satisfies GatewayEvent }))
    }, 0)
    return { status, headers: { 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' } }
  } } as GatewayBridge
  return { fetch: createGatewayFetch(bridge, events), bodies, cancelled, events }
}

const delta = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ id: 'response', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`
for (const direction of ['long', 'short'] as const) test(`actual compatible SDK serializes ${direction} image and instructions and decodes native UTF-8 SSE`, async () => {
  const native = nativeFixture(200, delta('等待') + delta('确认。') + delta('', 'stop') + 'data: [DONE]\n\n')
  const store = new ChartAnalysisStore(createAnalysisRunner(native.fetch), settings)
  await store.analyze('BTC', snapshot, direction)
  assert.equal(store.get('BTC')?.turns[0].text, '等待确认。')
  assert.equal(store.get('BTC')?.phase, 'ready')
  const body = JSON.parse(native.bodies[0])
  assert.equal(body.model, DEFAULT_ANALYSIS_MODEL)
  assert.equal(body.messages[0].content, ANALYSIS_PROMPTS[direction].system)
  assert.equal(body.messages[1].content[0].text, ANALYSIS_PROMPTS[direction].question)
  assert.equal(body.messages[1].content[1].image_url.url, (await snapshot()).imageDataURL)
  assert.equal(native.bodies.length, 1)
})

test('SDK preserves partial text on network and incomplete SSE failures without automatic retry', { timeout: 5_000 }, async () => {
  for (const interrupted of [false, true]) {
    let releaseTerminal = () => {}
    const beforeTerminal = new Promise<void>(resolve => { releaseTerminal = resolve })
    const native = nativeFixture(200, delta('部分回答'), interrupted, interrupted ? beforeTerminal : undefined)
    const runner = createAnalysisRunner(native.fetch)
    const store = new ChartAnalysisStore((input, onText) => runner(input, text => {
      onText(text)
      // Network failure follows a visible partial answer, rather than racing SDK transforms.
      releaseTerminal()
    }), settings)
    await store.analyze('BTC', snapshot)
    assert.equal(store.get('BTC')?.phase, 'error')
    assert.equal(store.get('BTC')?.turns[0].text, '部分回答')
    assert.equal(native.bodies.length, 1)
  }
})

test('HTTP errors remain visible and cancellation settles even before native headers arrive', async () => {
  const native = nativeFixture(401, JSON.stringify({ error: { message: 'Invalid Gateway API Key', type: 'authentication_error' } }))
  const store = new ChartAnalysisStore(createAnalysisRunner(native.fetch), settings)
  await store.analyze('BTC', snapshot)
  assert.match(store.get('BTC')!.error, /Invalid Gateway API Key/)
  assert.equal(native.bodies.length, 1)
  let cancelled = false
  const fetch = createGatewayFetch({ postMessage(request: object) {
    if ('cancelGatewayFetch' in request) { cancelled = true; return Promise.resolve({ ok: true }) }
    return new Promise(() => {})
  } } as GatewayBridge, new EventTarget())
  const abort = new AbortController()
  const pending = fetch('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', body: '{}', signal: abort.signal })
  await new Promise(resolve => setImmediate(resolve)); abort.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
})
