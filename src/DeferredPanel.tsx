import { Component, Suspense, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

type Props = { name: string; onClose: () => void; children: ReactNode; className?: string }

// A missing optional chunk must leave the market workspace usable.
export class DeferredPanel extends Component<Props, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    const { name, onClose, children, className } = this.props
    const pending = <section className={className} aria-label={name}>
      <p role={this.state.failed ? 'alert' : 'status'} className="mb-3 text-muted-foreground">{this.state.failed ? `${name} could not load. Restart the app to try again.` : `Loading ${name.toLowerCase()}…`}</p>
      <Button variant="outline" size="sm" onClick={onClose}>Close {name.toLowerCase()}</Button>
    </section>
    return this.state.failed ? pending : <Suspense fallback={pending}>{children}</Suspense>
  }
}
