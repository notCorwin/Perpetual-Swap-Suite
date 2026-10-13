export type SnapshotVersion = { revision: number; serviceSession?: string }

// Revisions are monotonic only within one collector process. Once a new
// session is accepted, late replies from retired processes cannot switch back.
export class SnapshotOrder {
  revision = -1
  serviceSession: string | undefined
  private retired = new Set<string>()

  isRetiredSession(session: string | undefined): boolean { return session !== undefined && this.retired.has(session) }

  isCurrent(value: SnapshotVersion): boolean {
    if (this.isRetiredSession(value.serviceSession)) return false
    return Boolean(value.serviceSession && value.serviceSession !== this.serviceSession) || value.revision >= this.revision
  }

  accept(value: SnapshotVersion): boolean {
    if (!this.isCurrent(value)) return false
    if (value.serviceSession && value.serviceSession !== this.serviceSession) {
      if (this.serviceSession) this.retired.add(this.serviceSession)
      this.serviceSession = value.serviceSession
      this.revision = -1
    }
    this.revision = value.revision
    return true
  }
}
