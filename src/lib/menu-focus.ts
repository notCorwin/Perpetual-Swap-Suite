// Radix restores focus after the closing animation. A menu opened in the
// meantime must keep its focus instead of being dismissed by that restoration.
export function preserveNewMenuFocus(event: Event) {
  const next = document.activeElement?.closest('[data-slot="popover-content"][data-state="open"], [data-slot="select-content"][data-state="open"]')
  if (next && next !== event.target) event.preventDefault()
}
