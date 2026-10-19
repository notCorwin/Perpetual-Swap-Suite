import type { WebSocketFactory } from './realtime-market.js'

export function networkResource(input: string): string
export function networkByteLength(value: unknown): number | null
export function recordedWebSocketFactory(factory: WebSocketFactory, stream: string): WebSocketFactory
export function constructRecordedWebSocket<T extends object>(construct: () => T, url: string, attributes?: Record<string, string | number | boolean | null>): T
