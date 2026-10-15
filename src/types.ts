export type Timeframe = '5m' | '15m' | '30m' | '1H' | '4H' | '1D'

export type Candle = {
  instrument: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volumeContracts: number
  volumeBase: number | null
  volumeQuote: number | null
  confirmed: boolean
}

export type Instrument = {
  id: string
  baseCurrency: string
  quoteCurrency: string
  settlementCurrency: string
  contractValue: number
  contractValueCurrency: string
  tickSize: number
  lotSize: number
  listedAt: number | null
  state: string
}

export type LiquidityReading = {
  spreadPercent: number | null
  bidDepthUSDT: number | null
  askDepthUSDT: number | null
  buySlippagePercent: number | null
  sellSlippagePercent: number | null
}

export type MarketSummary = {
  instrument: Instrument
  last: number | null
  change24hPercent: number | null
  volume24hUSDT: number | null
  openInterestUSDT: number | null
  fundingRatePercent: number | null
  liquidity: LiquidityReading
  eligible: boolean
  missingRequirements: string[]
  updatedAt: number
}

export type DataCoverage = {
  instrument: string
  from: number | null
  through: number | null
  candleCount: number
  gaps: number
}

export type AppSettings = {
  settlementCurrencies: string[]
  spreadLimitPercent: number
  depthRangePercent: number
  minimumSideDepthUSDT: number
  slippageLimitPercent: number
  slippageNotionalUSDT: number
  minimumVolume24hUSDT: number
  minimumOpenInterestUSDT: number
  volumeStabilityEnabled: boolean
  maximumHourlyVolumeRatio: number
  initialCapitalUSDT: number
  leverage: number
  takeProfitMarginPercent: number
  stopLossMarginPercent: number
  takerFeePercent: number
  slippageTicks: number
  selectedTimeframe: Timeframe
  selectedInstrument: string
  backgroundEnabled: boolean
  launchAtLogin: boolean
  appearance: 'system' | 'light' | 'dark'
  automaticUpdatesEnabled: boolean
  aiBaseURL: string
  aiModel: string
}

export type WorkspaceSnapshot = {
  markets: MarketSummary[]
  selectedInstrument: string | null
  candles: Candle[]
  formingCandle: Candle | null
  coverage: DataCoverage | null
  settings: AppSettings
  status: string
  error: string | null
  updatedAt: number
}

export type ValidationReport = {
  checkedFiles: number
  invalidFiles: string[]
  duplicateCandles: number
  checkedAt: number
}
