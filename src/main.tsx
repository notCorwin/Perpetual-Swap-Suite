import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AnalysisSettingsDialog } from './AnalysisSettingsDialog'
import { installFloatingGlass } from './floating-glass'

const stopFloatingGlass = installFloatingGlass()
import.meta.hot?.dispose(stopFloatingGlass)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AnalysisSettingsDialog />
  </StrictMode>,
)
