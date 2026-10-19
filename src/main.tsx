import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AnalysisSettingsDialog } from './AnalysisSettingsDialog'
import { initializeOperationTelemetry } from './operation-telemetry'

initializeOperationTelemetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AnalysisSettingsDialog />
  </StrictMode>,
)
