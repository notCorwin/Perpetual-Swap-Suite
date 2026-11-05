/** App-wide activation. Epochs fence asynchronous catch-up and old documents. */
export class PresentationLifecycle {
  constructor({ active, pause, resume, publish, failed = console.error, now = Date.now }) {
    this.desiredActive = active
    this.state = { epoch: 0, active, startedAt: now() }
    this.pause = pause; this.resume = resume; this.publish = publish; this.failed = failed; this.now = now
    this.pending = Promise.resolve(this.state)
  }
  getState() { return this.state }
  setActive(active, { refresh = false } = {}) {
    if (typeof active !== 'boolean') throw new TypeError('App activation must be a boolean.')
    if (!refresh && active === this.desiredActive) return this.pending
    this.desiredActive = active
    const state = this.state = { epoch: this.state.epoch + 1, active: false, startedAt: this.now() }
    this.publish(state)
    // Pause admission synchronously, before any asynchronous backend work.
    const paused = this.pause(state.epoch)
    this.pending = (async () => {
      await paused
      if (!active || state !== this.state) return this.state
      const snapshot = await this.resume(state.epoch)
      if (state !== this.state || !this.desiredActive) return this.state
      // Encoding and delivery are part of the barrier. Failed delivery must
      // leave both the renderer and the backend paused.
      this.publish({ ...state, active: true, snapshot })
      this.state = { ...state, active: true }
      return this.state
    })().catch(async error => {
      if (state.epoch === this.state.epoch) {
        try { await this.pause(state.epoch) } catch (pauseError) { this.failed('Could not pause interface preparation:', pauseError) }
        if (state.epoch !== this.state.epoch) return this.state
        this.state = { ...state, error: 'The latest view could not be synchronized. Switch away and return to retry.' }
        this.publish(this.state)
        this.failed('Could not resume the application interface:', error)
      }
      return this.state
    })
    return this.pending
  }
}
