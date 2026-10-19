import type { WebSocketFactory } from './realtime-market.js'

export function networkResource(input: string): string
export function recordedWebSocketFactory(factory: WebSocketFactory, stream: string): WebSocketFactory
