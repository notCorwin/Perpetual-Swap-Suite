import { Component, type ErrorInfo, type ReactNode } from 'react'

export function WorkspaceLoadError() {
  return <main className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
    <h1 className="text-base font-medium">Workspace unavailable</h1>
    <p className="max-w-md text-sm text-muted-foreground">The workspace encountered an unexpected error. Reload the window to try again.</p>
    <button type="button" className="rounded-md border px-3 py-1 text-sm" onClick={() => window.location.reload()}>Reload</button>
  </main>
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled workspace error:', error, info.componentStack)
  }
  render() { return this.state.failed ? <WorkspaceLoadError /> : this.props.children }
}
