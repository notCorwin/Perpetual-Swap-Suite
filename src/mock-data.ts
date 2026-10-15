import type { AppSettings, Candle, MarketSummary, WorkspaceSnapshot } from './types'

const now = Math.floor(Date.now() / 300_000) * 300_000
const marketSeeds = [
  ['BTC', 67_842.4, 2.81, 2_810_000_000, 1_420_000_000],
  ['ETH', 3_842.18, -1.24, 1_940_000_000, 812_000_000],
  ['SOL', 184.62, 5.72, 684_000_000, 247_000_000],
  ['XRP', 0.9124, 0.83, 322_000_000, 119_000_000],
  ['DOGE', 0.1821, -2.11, 218_000_000, 88_000_000],
  ['AVAX', 42.19, 3.16, 94_000_000, 37_000_000],
  ['LINK', 22.73, -0.48, 82_000_000, 31_000_000],
  ['SUI', 3.812, 8.34, 74_000_000, 29_000_000],
] as const

const markets: MarketSummary[] = marketSeeds.map(([base, last, change, volume, oi], index) => ({
  instrument: {
    id: `${base}-USDT-SWAP`, baseCurrency: base, quoteCurrency: 'USDT', settlementCurrency: 'USDT',
    contractValue: base === 'BTC' ? 0.01 : 1, contractValueCurrency: base,
    tickSize: last > 100 ? 0.1 : 0.0001, lotSize: 1, listedAt: now - 500 * 86_400_000, state: 'live',
  },
  last, change24hPercent: change, volume24hUSDT: volume, openInterestUSDT: oi, fundingRatePercent: 0.01,
  liquidity: {
    spreadPercent: 0.012 + index * 0.003, bidDepthUSDT: 388_000 - index * 19_000,
    askDepthUSDT: 402_000 - index * 21_000, buySlippagePercent: 0.031 + index * 0.004,
    sellSlippagePercent: 0.029 + index * 0.004,
  },
  eligible: index < 6, missingRequirements: index < 6 ? [] : ['Order book depth'], updatedAt: Date.now(),
}))

const candles: Candle[] = Array.from({ length: 260 }, (_, index) => {
  const wave = Math.sin(index / 11) * 920 + Math.cos(index / 27) * 430
  const open = 64_000 + index * 14 + wave
  const close = open + Math.sin(index * 1.73) * 210
  return {
    instrument: 'BTC-USDT-SWAP', timestamp: now - (259 - index) * 300_000,
    open, high: Math.max(open, close) + 90 + Math.abs(Math.sin(index)) * 130,
    low: Math.min(open, close) - 90 - Math.abs(Math.cos(index)) * 120, close,
    volumeContracts: 1_900 + Math.abs(Math.sin(index / 5)) * 5_200,
    volumeBase: null, volumeQuote: 38_000_000 + index * 80_000, confirmed: true,
  }
})

export const mockSettings: AppSettings = {
  settlementCurrencies: ['USDT'], spreadLimitPercent: 0.05, depthRangePercent: 0.5,
  minimumSideDepthUSDT: 100_000, slippageLimitPercent: 0.1, slippageNotionalUSDT: 100_000,
  minimumVolume24hUSDT: 30_000_000, minimumOpenInterestUSDT: 5_000_000,
  volumeStabilityEnabled: false, maximumHourlyVolumeRatio: 2, initialCapitalUSDT: 300,
  leverage: 10, takeProfitMarginPercent: 10, stopLossMarginPercent: 10,
  takerFeePercent: 0.05, slippageTicks: 1, selectedTimeframe: '5m',
  selectedInstrument: 'BTC-USDT-SWAP', backgroundEnabled: true, launchAtLogin: false,
  appearance: 'dark', automaticUpdatesEnabled: true, aiBaseURL: 'https://api.openai.com/v1', aiModel: '',
}

export const mockSnapshot: WorkspaceSnapshot = {
  markets, selectedInstrument: 'BTC-USDT-SWAP', candles,
  formingCandle: { ...candles.at(-1)!, timestamp: now + 300_000, confirmed: false },
  coverage: { instrument: 'BTC-USDT-SWAP', from: candles[0].timestamp, through: candles.at(-1)!.timestamp, candleCount: candles.length, gaps: 0 },
  settings: mockSettings, status: 'Browser preview', error: null, updatedAt: Date.now(),
}
