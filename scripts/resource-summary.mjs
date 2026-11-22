const groups = ['combined', 'runtime', 'backend']
const finite = value => typeof value === 'number' && Number.isFinite(value)
const nonnegative = value => finite(value) && value >= 0
const nanoseconds = (object, key) => {
  const exact = object?.[`${key}Exact`]
  if (typeof exact === 'string' && /^\d+$/.test(exact)) {
    const value = Number(exact)
    return Number.isFinite(value) ? value : null
  }
  const value = object?.[key]
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

// Nearest-rank quantiles match the browser recorder.
export function percentile(values, fraction) {
  const sorted = values.filter(finite).toSorted((a, b) => a - b)
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null
}
const sum = values => values.reduce((total, value) => total + value, 0)

/** Only complete intervals contribute. Full-window totals require every interval. */
export function summarizeResources(resources) {
  const allSamples = Array.isArray(resources?.samples) ? resources.samples : []
  const starts = allSamples.flatMap((sample, index) => sample.boundary === 'start' ? [index] : [])
  const ends = allSamples.flatMap((sample, index) => sample.boundary === 'end' ? [index] : [])
  const hasBoundaries = starts.length > 0 || ends.length > 0
  const validBoundaries = starts.length === 1 && ends.length === 1 && ends[0] > starts[0]
  const samples = hasBoundaries ? (validBoundaries ? allSamples.slice(starts[0], ends[0] + 1) : []) : allSamples
  const intervals = samples.slice(1).map(sample => sample.interval)
  return Object.fromEntries(groups.map(group => {
    const validDuration = interval => {
      const ns = nanoseconds(interval, 'elapsedNs')
      return ns !== null && ns > 0 ? ns : null
    }
    const allDurations = intervals.map(validDuration)
    const cpu = intervals.map((interval, index) => {
      const ns = nanoseconds(interval?.[group], 'cpuNs')
      return interval?.[group]?.complete === true && allDurations[index] !== null && ns !== null
        ? { ns, elapsed: allDurations[index] } : null
    }).filter(Boolean)
    const energy = intervals.map((interval, index) => {
      const ns = nanoseconds(interval?.[group], 'cpuEnergyNj')
      return interval?.[group]?.complete === true && allDurations[index] !== null && ns !== null
        ? { ns, elapsed: allDurations[index] } : null
    }).filter(Boolean)
    const footprints = samples.map(sample => {
      const total = sample.totals?.[group]
      return total?.complete === true && nonnegative(total.physicalFootprintBytes) ? total.physicalFootprintBytes / 1048576 : null
    }).filter(value => value !== null)
    const cpuComplete = intervals.length > 0 && cpu.length === intervals.length
    const energyComplete = intervals.length > 0 && energy.length === intervals.length
    const footprintComplete = samples.length > 0 && footprints.length === samples.length
    const elapsed = allDurations.every(value => value !== null) ? sum(allDurations) / 1e9 : null
    const cpuElapsed = sum(cpu.map(value => value.elapsed)) / 1e9
    const energyElapsed = sum(energy.map(value => value.elapsed)) / 1e9
    const coveredCpuSeconds = sum(cpu.map(value => value.ns)) / 1e9
    const coveredEnergyJoules = sum(energy.map(value => value.ns)) / 1e9
    const breakdown = Object.fromEntries(['cpuTimeNs', 'cpuEnergyNj', 'cpuCycles', 'cpuInstructions'].map(metric => {
      const parts = intervals.map(interval => interval?.[group]?.breakdown?.[metric])
      const validExact = value => typeof value === 'string' && /^\d+$/.test(value)
      const complete = parts.length > 0 && parts.every((part, index) => allDurations[index] !== null && part?.complete === true && ['totalExact', 'pCoreExact', 'eCoreExact'].every(key => validExact(part[key])) && BigInt(part.totalExact) === BigInt(part.pCoreExact) + BigInt(part.eCoreExact))
      const totalComplete = parts.length > 0 && parts.every((part, index) => allDurations[index] !== null && part?.totalComplete === true && validExact(part.totalExact))
      const exact = Object.fromEntries(['total', 'pCore', 'eCore'].map(key => [key + 'Exact', (key === 'total' ? totalComplete : complete) ? String(parts.reduce((value, part) => value + BigInt(part[key + 'Exact']), 0n)) : null]))
      const units = metric === 'cpuTimeNs' ? 'Seconds' : metric === 'cpuEnergyNj' ? 'Joules' : null
      const scaled = units ? Object.fromEntries(['total', 'pCore', 'eCore'].map(key => [key + units, exact[key + 'Exact'] !== null ? Number(exact[key + 'Exact']) / 1e9 : null])) : {}
      const watts = metric === 'cpuEnergyNj' ? Object.fromEntries(['total', 'pCore', 'eCore'].map(key => [key + 'MeanWatts', exact[key + 'Exact'] !== null && elapsed > 0 ? Number(exact[key + 'Exact']) / 1e9 / elapsed : null])) : {}
      return [metric, { complete, totalComplete, ...exact, ...scaled, ...watts }]
    }))
    return [group, {
      breakdown,
      cpuPercentOfOneCore: cpuComplete ? coveredCpuSeconds / cpuElapsed * 100 : null,
      cpuSeconds: cpuComplete ? coveredCpuSeconds : null,
      cpuEnergyJoules: energyComplete ? coveredEnergyJoules : null,
      cpuMeanWatts: energyComplete ? coveredEnergyJoules / energyElapsed : null,
      meanFootprintMiB: footprintComplete ? sum(footprints) / footprints.length : null,
      peakFootprintMiB: footprintComplete ? Math.max(...footprints) : null,
      coverage: {
        intervalCount: intervals.length, sampledSeconds: elapsed, boundaryStatus: hasBoundaries ? (validBoundaries ? 'explicit' : 'invalid') : 'periodic',
        unknownPids: [...new Set(intervals.flatMap(interval => interval?.[group]?.unknownPids ?? []))],
        disappearedPids: [...new Set(intervals.flatMap(interval => interval?.disappearedPids ?? []))],
        cpu: { complete: cpuComplete, intervals: cpu.length, seconds: cpuElapsed, coveredCpuSeconds: cpu.length ? coveredCpuSeconds : null },
        cpuEnergy: { complete: energyComplete, intervals: energy.length, seconds: energyElapsed, coveredCpuEnergyJoules: energy.length ? coveredEnergyJoules : null },
        footprint: { complete: footprintComplete, snapshots: footprints.length, totalSnapshots: samples.length },
        skippedSamples: resources?.skippedSamples ?? null,
      },
    }]
  }))
}

