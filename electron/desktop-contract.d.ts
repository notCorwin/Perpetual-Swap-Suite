import type { DesktopRequest } from '../src/desktop-contract.ts'
export class DesktopRequestError extends Error {
  constructor(path: string, expectation: string)
  readonly code: 'INVALID_DESKTOP_REQUEST'
}
export function parseDesktopRequest(value: unknown, options?: { allowE2E?: boolean }): DesktopRequest | { e2e: Record<string, unknown> }
