import type { PreparedChartNotification, PreparedChartResponse } from '../../src/chart-data.ts'

export class ChartNotificationEncoder {
  encode(frame: PreparedChartResponse): PreparedChartNotification
}
