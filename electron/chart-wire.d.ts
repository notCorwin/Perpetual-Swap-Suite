/** Serialize chart data without losing own undefined fields or exceptional numbers. */
export function encodeChartWire(value: unknown): string
/** Parse one versioned chart wire value, rejecting malformed envelopes and exceptions. */
export function decodeChartWire<T = unknown>(wire: unknown): T
