// Bus subcommand: query-cap
// Surfaces a real CapReadout (headers > dashboard > estimate) so agents stop
// guessing usage cap state from heuristics. Closes the heuristic-vs-data gap
// caught 2026-05-18 when an agent self-estimated 75-85% but actual was 11%/3%.

import { getCurrentCap, type CapReadout } from './cap-readout.js';

export type QueryCapOptions = {
  agent?: string;
};

/**
 * Resolve a CapReadout for the requested agent. The source-layer module
 * (cap-readout.ts) owns the headers → dashboard → estimate fallback chain;
 * this function is a thin orchestration wrapper so the CLI and tests share
 * one entry point.
 */
export async function queryCap(opts: QueryCapOptions = {}): Promise<CapReadout> {
  return getCurrentCap({ agent: opts.agent });
}
