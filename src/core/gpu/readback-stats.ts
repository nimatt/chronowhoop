// Moved to src/core/stats/latency-stats.ts — the math is GPU-agnostic and the
// /lab pipeline-cost readout consumes it too. Re-exported here so existing
// gpu/cpu-pipeline/diag importers keep working.
export * from '../stats/latency-stats'
