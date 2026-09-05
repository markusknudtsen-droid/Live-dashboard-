/**
 * Optional "prove it first" gate for real-money runs (REQUIRE_PROFITABLE_FIRST_TRADE=true).
 *
 * When enabled, the bot opens exactly ONE position and waits for it to close
 * (stop-loss or take-profit) before opening any more. If that first trade's
 * realized PnL was positive, normal trading (up to maxConcurrentPositions)
 * resumes; if it wasn't, new entries stay paused indefinitely (existing
 * positions — there should be none — are still monitored).
 *
 * Pure functions only, so the gating decision itself is testable without the
 * trader/network/persistence machinery around it.
 */

/** null = not yet resolved, true = first trade was profitable, false = it wasn't. */
export type FirstTradeValidation = boolean | null;

export interface GateDecision {
  skip: boolean;
  reason?: string;
}

/**
 * Whether the cycle should skip opening any new positions this run, and why.
 * Only meaningful when the gate feature is enabled by the caller.
 */
export function shouldSkipNewEntries(gate: FirstTradeValidation, openPositions: number): GateDecision {
  if (gate === false) {
    return { skip: true, reason: "the first validation trade was not profitable; new entries stay paused" };
  }
  if (gate === null && openPositions >= 1) {
    return { skip: true, reason: "waiting for the first validation trade to close before considering more" };
  }
  return { skip: false };
}

/**
 * How many NEW positions may be opened this cycle under the gate.
 * Call only after shouldSkipNewEntries(...).skip is false.
 */
export function maxNewEntries(gate: FirstTradeValidation, maxConcurrentPositions: number, openPositions: number): number {
  if (gate === true) {
    return Math.max(0, maxConcurrentPositions - openPositions);
  }
  if (gate === null && openPositions === 0) {
    return 1; // exactly one validation trade, never more, until it resolves
  }
  return 0;
}

/**
 * Given a completed trade event, compute the next gate state. Only a SELL
 * resolves the gate (a BUY doesn't tell us anything about profitability yet),
 * and only the FIRST resolution counts — once set, the gate never changes
 * again for the life of this state.
 */
export function resolveFirstTradeValidation(
  event: { type: "BUY" | "SELL"; pnlPercent?: number },
  currentGate: FirstTradeValidation
): FirstTradeValidation {
  if (currentGate !== null) return currentGate;
  if (event.type !== "SELL") return currentGate;
  return (event.pnlPercent ?? 0) > 0;
}

export function describeGateState(gate: FirstTradeValidation): string {
  if (gate === null) return "awaiting first trade";
  return gate ? "passed — normal trading enabled" : "FAILED — new entries paused";
}
