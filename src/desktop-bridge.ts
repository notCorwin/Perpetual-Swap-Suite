import { decodeChartWire } from '../electron/chart-wire.js'
import type { DesktopRequest, OperationBridgeHooks, OperationSourceIdentity, OperationBatch, OperationAcknowledgment, RadarDesktop } from './desktop-contract.ts'
import type { OperationContext } from '../electron/services/operations.js'

type DesktopTransport = {
  readonly nativeWindowControls: boolean
  request(value: unknown, context?: OperationContext): Promise<unknown>
  initializeOperations(hooks: OperationBridgeHooks): Promise<OperationSourceIdentity>
  recordOperations(batch: OperationBatch): Promise<OperationAcknowledgment>
  operationSourceFailure(value: { executionId: string; reason: string; omitted: number }): Promise<void>
}

declare global { interface Window { radarDesktopBootstrap: { connect(accept: (bridge: DesktopTransport) => void): void } } }

let transport: DesktopTransport | undefined
window.radarDesktopBootstrap.connect(bridge => { transport = bridge })
if (!transport) throw new Error('The desktop transport is unavailable.')
const bridge = transport
let operations: OperationBridgeHooks | undefined
const chartRequest = (value: unknown) => value !== null && typeof value === 'object'
  && ['chartWindow', 'chartLocal', 'chartHistory', 'chartUniverse'].some(key => Object.hasOwn(value, key))

const request = async (value: DesktopRequest) => {
  const operation = operations?.beginRequest(Object.keys(value ?? {})[0] ?? 'invalid')
  try {
    const result = await bridge.request(value, operation?.context)
    const response = chartRequest(value) ? decodeChartWire(result) : result
    if (operation) operations?.endRequest(operation.id, 'ok')
    return response
  } catch (error) {
    if (operation) operations?.endRequest(operation.id, 'error')
    throw error
  }
}

const desktop: RadarDesktop = {
  nativeWindowControls: bridge.nativeWindowControls,
  request: request as RadarDesktop['request'],
  initializeOperations(hooks) {
    operations = hooks
    return bridge.initializeOperations({ ...hooks, receive: (channel, detail, context) => {
      hooks.receive(channel, detail, context, channel === 'radar:chart-prepared' ? decodeChartWire : undefined)
    } })
  },
  recordOperations: batch => bridge.recordOperations(batch),
  operationSourceFailure: value => bridge.operationSourceFailure(value),
}
Object.defineProperty(window, 'radarDesktop', { value: Object.freeze(desktop), enumerable: true })
