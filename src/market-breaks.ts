export type BreakEvent = {
  status: "event"
  hour: number
  hoursAgo: number
  priorHour: number
  priorAgeHours: number
  priorPrice: number
  live: boolean
}

export type BreakResult = BreakEvent | { status: "none" | "insufficient-history" | "loading" }
export type BreakDirection = "high" | "low"
