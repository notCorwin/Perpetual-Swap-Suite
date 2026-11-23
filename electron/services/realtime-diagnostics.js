// Keep server-provided close reasons and exception text out of persistent logs.
export function diagnosticReason(message) {
  if (message.startsWith('WebSocket closed (')) return 'socket_closed'
  if (message.startsWith('OKX WebSocket ')) return 'exchange_event'
  if (/^Public market (tickers|open-interest|books|trades) callback fell behind\.$/.test(message)) return 'callback_backlog'
  const reasons = {
    'WebSocket transport failed.': 'transport_error',
    'WebSocket connection timed out.': 'connect_timeout',
    'WebSocket subscription failed.': 'subscription_send_failed',
    'Candle subscription acknowledgement timed out.': 'subscription_ack_timeout',
    'Public market subscription acknowledgement timed out.': 'subscription_ack_timeout',
    'WebSocket pong timed out.': 'pong_timeout',
    'WebSocket heartbeat failed.': 'heartbeat_send_failed',
    'Reconnect recovery failed.': 'recovery_failed',
    'Candle message decoding fell behind.': 'decode_backlog',
    'Public market message decoding fell behind.': 'decode_backlog',
    'Candle processing fell behind.': 'callback_or_persistence_backlog',
    'Public market processing fell behind.': 'callback_backlog',
  }
  return reasons[message] ?? 'other'
}
