/**
 * Position bookkeeping guards: wallet reconciliation and re-entry cooldown.
 *
 * Both exist because the bot's belief about what it held drifted from reality
 * and nothing corrected it.
 *
 * RECONCILIATION. state.json is the bot's only memory of open positions. When a
 * position leaves the wallet by any route the bot did not perform — an operator
 * selling manually, a sell that landed on-chain but whose confirmation was lost,
 * a second instance selling first — the entry stays. The bot then prices a coin
 * it does not own, hits the stop, calls executeSell, finds nothing to sell,
 * leaves the position in place and retries on the next tick. Observed: 306
 * consecutive stop-loss attempts on one phantom position. The wallet, not the
 * file, is the authority.
 *
 * RE-ENTRY COOLDOWN. Nothing in the bot remembered a coin it had already traded.
 * The moment a position closed, that coin was eligible again — so a token
 * carrying a live paid boost could be bought, stopped out, and bought straight
 * back on the next 15-second cycle for as long as the boost ran. Observed:
 * TRONK and ULCAT both re-entered within 10 seconds of a restart, on the same
 * boost that had already cost money.
 *
 * Pure functions only: callers supply wallet holdings and the clock.
 */

export interface HeldToken {
  mint: string;
  /** UI amount (decimal-adjusted). Zero or absent means not held. */
  amount: number;
}

export interface ReconcilablePosition {
  tokenAddress: string;
  tokenSymbol: string;
}

export interface ReconcileResult<T> {
  /** Positions the wallet actually backs. */
  keep: T[];
  /** Positions the wallet does not back, to be dropped. */
  drop: T[];
}

/**
 * Split persisted positions by whether the wallet actually holds the token.
 *
 * `heldTokens` must be the COMPLETE set of token accounts for the wallet. An
 * empty list is meaningful — the wallet holds nothing — and drops everything,
 * so a caller whose holdings fetch FAILED must skip reconciliation entirely
 * rather than pass an empty array and wrongly discard live positions.
 */
export function reconcilePositions<T extends ReconcilablePosition>(
  positions: T[],
  heldTokens: HeldToken[]
): ReconcileResult<T> {
  const heldMints = new Set(
    heldTokens.filter((t) => Number.isFinite(t.amount) && t.amount > 0).map((t) => t.mint)
  );

  const keep: T[] = [];
  const drop: T[] = [];
  for (const p of positions) {
    if (heldMints.has(p.tokenAddress)) keep.push(p);
    else drop.push(p);
  }
  return { keep, drop };
}

export interface RecentExit {
  tokenAddress: string;
  tokenSymbol: string;
  /** Unix epoch in milliseconds. */
  exitedAt: number;
  /** True when the position closed below entry. */
  wasLoss: boolean;
}

export interface ReentryConfig {
  /** Minutes after any exit during which the token cannot be re-entered. */
  cooldownMinutes: number;
  /**
   * When true, a token that exited at a loss is blocked for the rest of the run
   * rather than only for the cooldown window.
   */
  blockLosersForRun: boolean;
}

export const DEFAULT_REENTRY: ReentryConfig = {
  cooldownMinutes: 60,
  blockLosersForRun: false,
};

export interface ReentryVerdict {
  allowed: boolean;
  /** Why it was blocked. Absent when allowed. */
  reason?: string;
}

/**
 * Whether a token may be entered again, given what the bot has already exited.
 */
export function canReenter(
  tokenAddress: string,
  recentExits: RecentExit[],
  now: number,
  config: ReentryConfig = DEFAULT_REENTRY
): ReentryVerdict {
  // The most recent exit governs, so a stale record cannot outrank a newer one.
  let latest: RecentExit | undefined;
  for (const e of recentExits) {
    if (e.tokenAddress !== tokenAddress) continue;
    if (!latest || e.exitedAt > latest.exitedAt) latest = e;
  }
  if (!latest) return { allowed: true };

  if (config.blockLosersForRun && latest.wasLoss) {
    return { allowed: false, reason: `${latest.tokenSymbol} exited at a loss this run; re-entry blocked` };
  }

  const elapsedMinutes = (now - latest.exitedAt) / 60_000;
  if (Number.isFinite(elapsedMinutes) && elapsedMinutes < config.cooldownMinutes) {
    const remaining = Math.ceil(config.cooldownMinutes - elapsedMinutes);
    return {
      allowed: false,
      reason: `${latest.tokenSymbol} exited ${Math.floor(elapsedMinutes)}m ago; ${remaining}m of cooldown left`,
    };
  }

  return { allowed: true };
}

/**
 * Append an exit, replacing any earlier record for the same token so the list
 * cannot grow without bound as a token is traded repeatedly.
 */
export function recordExit(recentExits: RecentExit[], exit: RecentExit): RecentExit[] {
  return [...recentExits.filter((e) => e.tokenAddress !== exit.tokenAddress), exit];
}

/**
 * Drop exits that can no longer block anything, so the persisted list stays
 * small across long runs.
 */
export function pruneExits(
  recentExits: RecentExit[],
  now: number,
  config: ReentryConfig = DEFAULT_REENTRY
): RecentExit[] {
  if (config.blockLosersForRun) {
    // Losses must survive the whole run; only time-expired wins are pruned.
    return recentExits.filter((e) => e.wasLoss || now - e.exitedAt < config.cooldownMinutes * 60_000);
  }
  return recentExits.filter((e) => now - e.exitedAt < config.cooldownMinutes * 60_000);
}
