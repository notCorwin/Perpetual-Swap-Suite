import './desktop-bridge.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import SettingsLoadError from './SettingsLoadError'
import { RootErrorBoundary, WorkspaceLoadError } from './WorkspaceErrorBoundary'

await Promise.all([
  document.fonts.load('400 12px "Ubuntu Mono"').catch(() => []),
  document.fonts.load('700 12px "Ubuntu Mono"').catch(() => []),
])

// The bridge must exist before any UI module subscribes at module scope.
// Optional chunks can otherwise move those subscribers ahead of this entry.
const { default: App } = window.radarDesktop.isSettingsWindow
  ? await import('./SettingsWindow.tsx').catch(() => ({ default: SettingsLoadError }))
  : await import('./App.tsx').catch(() => ({ default: WorkspaceLoadError }))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
