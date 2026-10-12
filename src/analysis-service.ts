import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { ChartAnalysisStore, type AnalysisSettingsRequest, type AnalysisRunner } from './chart-analysis.ts'
import { createGatewayFetch } from './gateway-fetch.ts'

export const requestAnalysisSettings = (request: AnalysisSettingsRequest) => window.webkit.messageHandlers.radar.postMessage({ analysisSettings: request })

export function createAnalysisRunner(nativeFetch: typeof fetch): AnalysisRunner {
  const provider = createOpenAICompatible({ name: 'openai', baseURL: 'https://ai-gateway.vercel.sh/v1', fetch: nativeFetch })
  return async (input, onText) => {
    const result = streamText({ model: provider(input.model), instructions: input.instructions, messages: input.messages, abortSignal: input.signal, maxRetries: 0, streamRetries: 0, onError: () => {} })
    let finished = false
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') onText(part.text)
      else if (part.type === 'error') throw part.error
      else if (part.type === 'finish') {
        if (part.finishReason === 'length') throw new Error('The model reached its output limit. Retry or choose another model.')
        finished = true
      }
    }
    input.signal.throwIfAborted()
    if (!finished) throw new Error('Gateway stream interrupted. Retry to generate the answer again.')
  }
}

export const chartAnalysis = new ChartAnalysisStore(createAnalysisRunner((input, init) => createGatewayFetch(window.webkit.messageHandlers.radar, window)(input, init)), () => requestAnalysisSettings({ action: 'read' }))
