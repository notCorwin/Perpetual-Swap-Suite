import type { DesktopRequest } from '../src/desktop-contract.ts'
export class DesktopRequestError extends Error {
  constructor(path: string, expectation: string)
  readonly code: 'INVALID_DESKTOP_REQUEST'
}
/** Strictly validate one command; snapshot and resident-frame reads accept no demand fields. */
export function parseDesktopRequest(value: unknown, options?: { allowE2E?: boolean }): DesktopRequest | { e2e: Record<string, unknown> }
