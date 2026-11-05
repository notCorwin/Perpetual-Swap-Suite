import { decodeChartWire } from '../electron/chart-wire.js'
import type { DesktopRequest, OperationBridgeHooks, OperationSourceIdentity, OperationBatch, OperationAcknowledgment, RadarDesktop } from './desktop-contract.ts'
import type { OperationContext } from '../electron/services/operations.js'

type DesktopTransport = {
  readonly nativeWindowControls: boolean
  readonly operationRecording: boolean
  request(value: unknown, context?: OperationContext): Promise<unknown>
  subscribeNotifications(receiver: (channel: string, detail: unknown, context?: OperationContext) => void): void
  initializeOperations(flush: () => Promise<void>): Promise<OperationSourceIdentity>
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

const decodeResponse = (value: DesktopRequest, result: unknown) => chartRequest(value) ? decodeChartWire(result) : result
const plainRequest = async (value: DesktopRequest) => decodeResponse(value, await bridge.request(value))
const recordedRequest = async (value: DesktopRequest) => {
  const operation = operations?.beginRequest(Object.keys(value ?? {})[0] ?? 'invalid')
  try {
    const result = await bridge.request(value, operation?.context)
    const response = decodeResponse(value, result)
    if (operation) operations?.endRequest(operation.id, 'ok')
    return response
  } catch (error) {
    if (operation) operations?.endRequest(operation.id, 'error')
    throw error
  }
}

const deliverNotification = (channel: string, detail: unknown) => {
  window.dispatchEvent(new CustomEvent(channel.replace(':', '-'), {
    detail: channel === 'radar:chart-prepared' ? decodeChartWire(detail) : detail,
  }))
}
bridge.subscribeNotifications(bridge.operationRecording
  ? (channel, detail, context) => {
    if (operations) operations.receive(channel, context, () => deliverNotification(channel, detail))
    else deliverNotification(channel, detail)
  }
  : deliverNotification)

const desktop: RadarDesktop = {
  nativeWindowControls: bridge.nativeWindowControls,
  operationRecording: bridge.operationRecording,
  request: (bridge.operationRecording ? recordedRequest : plainRequest) as RadarDesktop['request'],
  initializeOperations(hooks) {
    if (!bridge.operationRecording) throw new Error('Operation recording is disabled for this renderer.')
    if (operations) throw new Error('Renderer recording is already initialized.')
    operations = hooks
    return bridge.initializeOperations(hooks.flush)
  },
  recordOperations: batch => bridge.recordOperations(batch),
  operationSourceFailure: value => bridge.operationSourceFailure(value),
}
Object.defineProperty(window, 'radarDesktop', { value: Object.freeze(desktop), enumerable: true })
