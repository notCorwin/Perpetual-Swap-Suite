import { evaluateMarketOpportunity as evaluateSharedMarketOpportunity } from "../electron/services/market-metrics.js"
import type {
  OpportunityComponents as SharedOpportunityComponents,
  OpportunityDirection as SharedOpportunityDirection,
  OpportunityInput as SharedOpportunityInput,
  OpportunityResult as SharedOpportunityResult,
  OpportunitySetup as SharedOpportunitySetup,
  OpportunityStatus as SharedOpportunityStatus,
} from "../electron/services/market-metrics.js"

export type OpportunityDirection = SharedOpportunityDirection
export type OpportunitySetup = SharedOpportunitySetup
export type OpportunityStatus = SharedOpportunityStatus
export type OpportunityInput = SharedOpportunityInput
export type OpportunityComponents = SharedOpportunityComponents
export type OpportunityResult = SharedOpportunityResult

export const OPPORTUNITY_DESCRIPTION = "Live 1h opportunity ranking: Candidate, Watch, Overheated, then Incomplete. Long and Short use the same directional rules. Scores may change before the hour closes. Open a score for its setup, scoring breakdown and reasons."

export const opportunityStatusRank: Record<OpportunityStatus, number> = {
  Candidate: 3, Watch: 2, Overheated: 1, Incomplete: 0,
}

// The runtime and type contract live in the Electron-safe ESM module, so the
// main-process list projection and renderer cannot drift into separate scores.
export function evaluateMarketOpportunity(input: OpportunityInput): OpportunityResult {
  return evaluateSharedMarketOpportunity(input)
}
