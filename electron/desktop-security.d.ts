export function isAllowedExternalURL(value: unknown): boolean
export type DesktopSecurity = Readonly<{
  isTrustedURL(value: unknown): boolean
  isAllowedNavigation(value: unknown): boolean
  isTrustedSender(event: unknown, mainWindow: unknown): boolean
  assertTrustedSender(event: unknown, mainWindow: unknown): void
  isAllowedExternalURL(value: unknown): boolean
}>
export function createDesktopSecurity(options?: { rendererURL?: string; rendererFile?: string }): DesktopSecurity
