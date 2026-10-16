export class ChartFocus {
  constructor() {
    this.nextSession = 0
    this.nextSequence = 0
    this.current = { session: null, token: -1, instId: null, sequence: -1 }
  }

  beginSession() {
    const session = ++this.nextSession
    this.current = { session, token: -1, instId: null, sequence: ++this.nextSequence }
    return session
  }

  focus(instId, session, token) {
    const current = this.current
    if (typeof instId !== 'string' || !instId || !Number.isSafeInteger(session) || !Number.isSafeInteger(token)
      || session !== current.session || token < current.token || token === current.token && current.instId !== instId) return { ok: false, sequence: current.sequence }
    if (token !== current.token || instId !== current.instId) this.current = { session, token, instId, sequence: ++this.nextSequence }
    return { ok: true, sequence: this.current.sequence }
  }

  focusLegacy(instId) {
    if (this.current.session === null) this.beginSession()
    return this.focus(instId, this.current.session, this.current.token + 1)
  }
}
