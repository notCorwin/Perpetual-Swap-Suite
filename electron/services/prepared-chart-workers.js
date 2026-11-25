import { Worker } from 'node:worker_threads'
import { seriesKey } from './prepared-chart-helpers.js'

export const preparedChartWorkerMethods = {
  calculate(candles, intervalMS, priority = 'foreground', checkpoint = null) {
    if (this.closed) return Promise.reject(new Error('Prepared chart data service is closed.'))
    const id = ++this.nextCalculation
    return new Promise((resolve, reject) => {
      this.calculations.set(id, { id, candles, intervalMS, checkpoint, priority, resolve, reject })
      this.calculationQueue.push(id); this.drainCalculations()
    })
  },

  drainCalculations() {
    if (this.closed) return
    while (this.workers.length < this.workerLimit && this.workers.length < this.calculationQueue.length + this.workers.filter(slot => slot.busy !== null).length) {
      const slot = { worker: new Worker(new URL('./prepared-chart-worker.js', import.meta.url)), busy: null }
      slot.worker.unref()
      slot.worker.on('message', ({ id, bars, state, error }) => {
        const pending = this.calculations.get(id)
        if (!pending) return
        this.calculations.delete(id); slot.busy = null; slot.worker.unref()
        if (error) pending.reject(new Error(error)); else {
          pending.resolve({ bars, state })
          const key = pending.candles[0] && seriesKey(pending.candles[0].instrument, pending.candles[0].timeframe)
          const residents = new Set([...this.series.values(), ...[...this.universe.keys()].map(key => this.liveStates.get(key)).filter(Boolean)])
          for (const current of residents) if (current.key !== key && [...current.indicatorFailures?.values() ?? []].some(value => value.retryOn === 'worker-recovery')) {
            let recovered = false
            for (const target of [current, this.liveStates.get(current.key)].filter(Boolean)) for (const [hour, failure] of target.indicatorFailures ?? []) {
              if (failure.retryOn === 'worker-recovery') { target.indicatorFailures.delete(hour); recovered = true }
            }
            if (recovered) current.statusVersion = (current.statusVersion ?? 0) + 1
            setImmediate(() => { if (!this.closed) this.seed(current, this.universe.has(current.key) ? 'chartWarm' : 'background', this.universe.get(current.key)) }).unref?.()
          }
        }
        this.drainCalculations()
      })
      const failed = error => {
        if (!this.workers.includes(slot)) return
        const pending = this.calculations.get(slot.busy)
        if (pending) { this.calculations.delete(slot.busy); pending.reject(Object.assign(error, { code: 'PREPARED_CHART_WORKER_UNAVAILABLE' })) }
        this.workers = this.workers.filter(value => value !== slot)
        void slot.worker.terminate().catch(() => {})
        this.drainCalculations()
      }
      slot.worker.on('error', failed)
      slot.worker.on('exit', code => failed(new Error(`Prepared chart worker exited (${code}).`)))
      this.workers.push(slot)
      slot.worker.unref()
    }
    for (const slot of this.workers) {
      if (slot.busy !== null || !this.calculationQueue.length) continue
      const index = this.calculationQueue.findIndex(id => this.calculations.get(id)?.priority === 'foreground')
      const [id] = this.calculationQueue.splice(index < 0 ? 0 : index, 1), pending = this.calculations.get(id)
      slot.busy = id; slot.worker.ref()
      try { slot.worker.postMessage({ id, candles: pending.candles, intervalMS: pending.intervalMS, checkpoint: pending.checkpoint }) }
      catch (error) {
        this.calculations.delete(id); slot.busy = null; slot.worker.unref(); pending.reject(error)
        queueMicrotask(() => this.drainCalculations())
      }
    }
  },
}
