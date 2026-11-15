import { readFileSync, writeFileSync } from 'node:fs'

// Keep a reachable title bar when a display is disconnected or its layout changes.
export function restoreWindowBounds(path, displays) {
  try {
    const bounds = JSON.parse(readFileSync(path, 'utf8'))
    if (!['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(bounds[key])) || bounds.width < 1200 || bounds.height < 640 || bounds.width > 32767 || bounds.height > 32767 || Math.abs(bounds.x) > 2147483647 || Math.abs(bounds.y) > 2147483647) return undefined
    const visible = displays.some(({ workArea }) =>
      bounds.x < workArea.x + workArea.width - 100 && bounds.x + bounds.width > workArea.x + 100 &&
      bounds.y >= workArea.y && bounds.y < workArea.y + workArea.height - 50)
    return visible ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined
  } catch {
    return undefined
  }
}

export function saveWindowBounds(path, window) {
  try {
    writeFileSync(path, JSON.stringify(window.getNormalBounds()))
  } catch (error) {
    console.error('Could not save window position and size:', error.message)
  }
}
