// Read the displayed signed percentage and direction.
// Install in both the current document and future reloads used by E2E fixtures.
export async function installChartPriceReader(page) {
  const install = () => {
    window.__chartPriceLabel = text => {
      const match = /^([+-]?(?:\d[\d,]*)(?:\.\d+)?)%\s+[↑↓]$/.exec(text?.trim() ?? '')
      if (!match) return null
      const value = Number(match[1].replaceAll(',', ''))
      return Number.isFinite(value) ? value : null
    }
  }
  await page.addInitScript(install)
  await page.evaluate(install)
}
