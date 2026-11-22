// Read the displayed signed percentage.
// Install in both the current document and future reloads used by E2E fixtures.
export async function installChartPriceReader(page) {
  const install = () => {
    window.__chartPriceLabel = text => {
      const match = /^([+-]?\d+\.\d{2})%$/.exec(text?.trim() ?? '')
      if (!match) return null
      const value = Number(match[1])
      return Number.isFinite(value) ? value : null
    }
  }
  await page.addInitScript(install)
  await page.evaluate(install)
}
