// Overlapping phase windows share the same physical 5 ms process-memory scan.
// Boundary scans also update every active window so nested windows cannot hide peaks.
export function createMemorySampler({ read = () => process.memoryUsage(), schedule = setInterval, cancel = clearInterval } = {}) {
  const windows = new Set()
  let timer = null
  let reads = 0
  let scheduledSamples = 0

  function sample() {
    const memory = { ...read() }
    reads++
    for (const window of windows) {
      window.peakRSSBytes = Math.max(window.peakRSSBytes, memory.rss)
      window.peakHeapBytes = Math.max(window.peakHeapBytes, memory.heapUsed)
    }
    return memory
  }

  return {
    begin() {
      const initial = sample()
      const window = { peakRSSBytes: initial.rss, peakHeapBytes: initial.heapUsed }
      windows.add(window)
      if (timer === null) {
        timer = schedule(() => {
          if (windows.size === 0) return
          scheduledSamples++
          sample()
        }, 5)
        timer?.unref?.()
      }
      let result
      return {
        initial,
        end() {
          if (result) return result
          const final = sample()
          windows.delete(window)
          if (windows.size === 0) {
            cancel(timer)
            timer = null
          }
          result = { final, peakRSSBytes: window.peakRSSBytes, peakHeapBytes: window.peakHeapBytes }
          return result
        },
      }
    },
    snapshot() {
      return { intervalMS: 5, reads, scheduledSamples, activeWindows: windows.size, timerActive: timer !== null }
    },
  }
}
