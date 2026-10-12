export { cn } from "cn"

// Live polling pauses while the window is hidden, minimized or fully covered;
// the native monitor keeps collecting and notifying in the background.
export function pageVisible(): Promise<void> {
  if (document.visibilityState !== "hidden") return Promise.resolve()
  return new Promise(resolve => {
    const shown = () => {
      if (document.visibilityState === "hidden") return
      document.removeEventListener("visibilitychange", shown); resolve()
    }
    document.addEventListener("visibilitychange", shown)
  })
}
