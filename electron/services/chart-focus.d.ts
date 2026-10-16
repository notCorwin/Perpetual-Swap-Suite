export class ChartFocus {
  beginSession(): number
  focus(instId: string, session: number, token: number): { ok: boolean; sequence: number }
  focusLegacy(instId: string): { ok: boolean; sequence: number }
}
