import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AnalysisSettingsDialog } from './AnalysisSettingsDialog'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AnalysisSettingsDialog />
  </StrictMode>,
)
