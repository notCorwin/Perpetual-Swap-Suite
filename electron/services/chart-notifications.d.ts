import type { PreparedChartNotification, PreparedChartResponse } from '../../src/chart-data.ts'

export class ChartNotificationEncoder {
  constructor(maxFrames?: number)
  readonly size: number
  encode(frame: PreparedChartResponse): PreparedChartNotification
}
