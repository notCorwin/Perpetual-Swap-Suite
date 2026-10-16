import type { SuiteReading } from './suite-types.ts'

export type SignalTiming = 'both' | 'confirmed' | 'provisional'
export type RadarSignal = { instrument: string; confirmed?: SuiteReading; provisional?: SuiteReading }

export function phaseMatches(reading: SuiteReading | undefined): boolean {
  return reading?.universe === 'true' && reading.phases.bullishSetup?.result === 'true'
}

// A phase and its Universe must come from the same evaluated hour. Never gate a
// forming signal with the previous close, or mix readings from different rules.
export function radarSignals(confirmed: SuiteReading[], provisional: SuiteReading[], strategyID: string, revision: number, timing: SignalTiming = 'both'): RadarSignal[] {
  const signals = new Map<string, RadarSignal>()
  for (const [source, readings] of [['confirmed', confirmed], ['provisional', provisional]] as const) {
    if (timing !== 'both' && timing !== source) continue
    for (const reading of readings) {
      if (reading.strategyID !== strategyID || reading.revision !== revision) continue
      const signal = signals.get(reading.instrument) ?? { instrument: reading.instrument }
      signal[source] = reading; signals.set(reading.instrument, signal)
    }
  }
  return [...signals.values()]
}

export function signalMatches(signal: RadarSignal): boolean {
  return phaseMatches(signal.confirmed) || phaseMatches(signal.provisional)
}

export function signalIsUnknown(signal: RadarSignal): boolean {
  return [signal.confirmed, signal.provisional].some(reading => reading && (
    reading.universe === 'unknown' || reading.universe === 'true' &&
    (reading.phases.bullishSetup?.result ?? 'unknown') === 'unknown'
  ))
}
