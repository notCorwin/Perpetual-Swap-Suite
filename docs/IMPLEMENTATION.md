# Improvement implementation

The [improvement plan](IMPROVEMENT_PLAN.md) is being implemented in independently verified batches. The plan's initial audit remains a record of the original baseline, not a description of the current implementation.

| Batch | Scope | Verification |
| --- | --- | --- |
| 1 | One canonical full-history indicator calculation for lists/charts; arithmetic BOLL; base-quantity VWAP; flat RSI=50; unavailable zero baselines; formula-version invalidation | 139 core tests, 16 Electron E2E, production build and lint passed. macOS installation smoke is required before pushing this batch. |
| 2 | Transaction settings, durable source sync, ingestion validation and manual integrity audit | In progress |
| 3 | Independently configurable liquidity filters, finite eligibility leases and independent 15m ranking | Pending |
| 4 | WebSocket candle lifecycle and reconnect gap repair | Pending |
| 5 | Base UI default components, two-column workspace, global scaling and English interface | In progress in an isolated checkout |
| 6 | Desktop protocol, PR/release gates, installed artifact smoke and dependency cleanup | In progress in an isolated checkout |

The selected business conventions are documented in [INDICATORS.md](INDICATORS.md). The default requested history coverage is 30 days; ranking uses completed native 5m closes with a 15-minute lookback. User preferences will make these ranges adjustable.
