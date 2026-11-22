export type RankedInstrument = { instId: string; rankingChange: number | null }

/** Absolute change descending; unavailable last; ties use code-point ID order. */
export function compareRanking(left: RankedInstrument, right: RankedInstrument): number
