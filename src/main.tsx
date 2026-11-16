import './desktop-bridge.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initializeOperationTelemetry } from './operation-telemetry'

await initializeOperationTelemetry()

// The bridge must exist before any UI module subscribes at module scope.
// Optional chunks can otherwise move those subscribers ahead of this entry.
const { default: App } = await import('./App.tsx')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
