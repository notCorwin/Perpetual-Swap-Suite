import { decodeChartWire } from '../electron/chart-wire.js'
import type { DesktopRequest, PresentationUpdate, RadarDesktop } from './desktop-contract.ts'

type DesktopTransport = {
  readonly nativeWindowControls: boolean
  readonly isSettingsWindow: boolean
  setSettingsCloseGuard(value: { dirty: boolean; busy: boolean }): void
  closeSettingsWindow(): Promise<void>
  request(value: unknown): Promise<unknown>
  subscribeNotifications(receiver: (channel: string, detail: unknown) => void): void
  subscribePresentation(receiver: (update: Omit<PresentationUpdate, 'snapshot'> & { snapshot?: unknown }) => void): void
}

declare global { interface Window { radarDesktopBootstrap: { connect(accept: (bridge: DesktopTransport) => void): void } } }

let transport: DesktopTransport | undefined
window.radarDesktopBootstrap.connect(bridge => { transport = bridge })
if (!transport) throw new Error('The desktop transport is unavailable.')
const bridge = transport
const chartRequest = (value: unknown) => value !== null && typeof value === 'object'
  && ['chartLocal', 'chartHistory', 'chartUniverse'].some(key => Object.hasOwn(value, key))

const decodeResponse = (value: DesktopRequest, result: unknown) => chartRequest(value) ? decodeChartWire(result) : result
const plainRequest = async (value: DesktopRequest) => decodeResponse(value, await bridge.request(value))

const deliverNotification = (channel: string, detail: unknown) => {
  window.dispatchEvent(new CustomEvent(channel.replace(':', '-'), {
    detail: channel === 'radar:chart-prepared' ? decodeChartWire(detail) : detail,
  }))
}
let presentation: PresentationUpdate = { epoch: 0, active: true, startedAt: 0 }
const presentationListeners = new Set<(update: PresentationUpdate) => void>()
bridge.subscribePresentation(update => {
  if (update.epoch < presentation.epoch) return
  presentation = { ...update, snapshot: update.snapshot === undefined ? undefined : decodeChartWire(update.snapshot) as PresentationUpdate['snapshot'] }
  if (presentationListeners.size) {
    try { for (const listener of presentationListeners) listener(presentation) }
    finally { const { snapshot: _snapshot, ...state } = presentation; presentation = state }
  }
})
bridge.subscribeNotifications(deliverNotification)

const desktop: RadarDesktop = {
  nativeWindowControls: bridge.nativeWindowControls,
  isSettingsWindow: bridge.isSettingsWindow,
  setSettingsCloseGuard: value => bridge.setSettingsCloseGuard(value),
  closeSettingsWindow: () => bridge.closeSettingsWindow(),
  subscribePresentation(receiver) {
    presentationListeners.add(receiver)
    try { receiver(presentation) }
    finally { const { snapshot: _snapshot, ...state } = presentation; presentation = state }
    return () => { presentationListeners.delete(receiver) }
  },
  request: plainRequest as RadarDesktop['request'],
}
Object.defineProperty(window, 'radarDesktop', { value: Object.freeze(desktop), enumerable: true })
