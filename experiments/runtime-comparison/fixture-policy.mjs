import { workerData } from 'node:worker_threads'
// Reuse the existing finite archive source, without its unrelated integrity
// audit. Measuring a partially cancelled audit would compare unequal work.
if (workerData?.testMode && process.env.RADAR_COMPARE_DOWNLOAD_ONLY === '1') {
  const { MarketService } = await import('../../electron/services/market-service.js')
  const audit = MarketService.prototype.dataAuditRequest
  MarketService.prototype.dataAuditRequest = function (request) {
    if (request.action === 'start') return Promise.resolve({ phase: 'idle', comparisonAuditExcluded: true })
    return audit.call(this, request)
  }
}
