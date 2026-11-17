// Display spacing is independent from these bounded source-window buckets.
export const CHART_MAX_WINDOW_BARS = 1536
export const validChartWindowBars = count => Number.isInteger(count) && count >= 96 && count <= CHART_MAX_WINDOW_BARS && (count - 96) % 48 === 0
