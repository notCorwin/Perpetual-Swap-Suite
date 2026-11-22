import './desktop-bridge.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initializeOperationTelemetry } from './operation-telemetry'
import SettingsLoadError from './SettingsLoadError'

await Promise.all([
  initializeOperationTelemetry(),
  document.fonts.load('400 12px "Ubuntu Mono"'),
  document.fonts.load('700 12px "Ubuntu Mono"'),
])

// The bridge must exist before any UI module subscribes at module scope.
// Optional chunks can otherwise move those subscribers ahead of this entry.
const { default: App } = window.radarDesktop.isSettingsWindow
  ? await import('./SettingsWindow.tsx').catch(() => ({ default: SettingsLoadError }))
  : await import('./App.tsx')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
