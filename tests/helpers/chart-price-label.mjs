// Read the displayed quote, including its accessible label and direction.
// Install in both the current document and future reloads used by E2E fixtures.
export async function installChartPriceReader(page) {
  const install = () => {
    window.__chartPriceLabel = text => {
      const match = /^Price\s+([+-]?(?:\d[\d,]*)(?:\.\d+)?)\s+[↑↓]$/.exec(text?.trim() ?? '')
      if (!match) return null
      const value = Number(match[1].replaceAll(',', ''))
      return Number.isFinite(value) ? value : null
    }
  }
  await page.addInitScript(install)
  await page.evaluate(install)
}
