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
  /**
   * True when a stop closed it — the fixed stop-loss or a trailing stop, even
   * one that locked in a profit. Optional so exits persisted before this
   * existed still load (treated as not stopped).
   */
  stopped?: boolean;
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

  // A profitable exit is not a warning, it is the setup the operator wants to
  // take again — a coin that spiked, was banked, and dips back is a re-entry,
  // not a mistake to sit out. Only losses serve the cooldown. MAX_BUYS_PER_TOKEN
  // still caps how many times a single token can be entered in one run, so
  // dropping the timer here cannot turn into an unbounded loop on one coin.
  //
  // A STOPPED exit is different, even in profit: a trailing stop only fires
  // once the price has fallen well off its peak, so the coin is falling at the
  // moment it is sold. On 2026-09-24 ASSCAT and CMC were re-bought 17-59s
  // after profitable trailing exits and lost -51% and -39%. Those serve the
  // cooldown too; take-profit and ladder exits still re-enter freely.
  if (!latest.wasLoss && !latest.stopped) return { allowed: true };

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
  // Under blockLosersForRun, losses must survive the whole run.
  return recentExits.filter(
    (e) => (config.blockLosersForRun && e.wasLoss) || now - e.exitedAt < config.cooldownMinutes * 60_000
  );
}

/**
 * Per-run buy count per token, for MAX_BUYS_PER_TOKEN. Separate from the
 * cooldown above on purpose: a cooldown only ever delays a re-entry, so a
 * token whipsawing between a short cooldown and a fast stop-loss can still be
 * bought an unbounded number of times as the run goes on. This is the one
 * check in this file a cooldown of any length cannot satisfy — it counts
 * rather than times out. Real incident, 2026-09-09: CARDCAT was bought 10
 * times in one session.
 *
 * The caller holds this in memory only and does not persist it — the cap is
 * meant to stop a coin being re-bought into the same drop repeatedly within a
 * session, not to blacklist it permanently.
 */
export interface TokenBuyCount {
  tokenAddress: string;
  tokenSymbol: string;
  count: number;
}

/** Current count for a token, 0 if never bought. */
export function buyCountFor(buyCounts: TokenBuyCount[], tokenAddress: string): number {
  return buyCounts.find((b) => b.tokenAddress === tokenAddress)?.count ?? 0;
}

/** Increment (or start at 1) the count for a token, after a successful buy. */
export function recordBuy(buyCounts: TokenBuyCount[], tokenAddress: string, tokenSymbol: string): TokenBuyCount[] {
  const existing = buyCounts.find((b) => b.tokenAddress === tokenAddress);
  if (!existing) return [...buyCounts, { tokenAddress, tokenSymbol, count: 1 }];
  return buyCounts.map((b) => (b.tokenAddress === tokenAddress ? { ...b, count: b.count + 1 } : b));
}

/**
 * Whether a token has already hit its lifetime buy cap. maxBuys <= 0 disables
 * the check (unlimited), matching this codebase's convention elsewhere for a
 * zero/negative threshold meaning "off".
 */
export function exceedsMaxBuys(buyCounts: TokenBuyCount[], tokenAddress: string, maxBuys: number): boolean {
  if (maxBuys <= 0) return false;
  return buyCountFor(buyCounts, tokenAddress) >= maxBuys;
}

/**
 * Whether taking this candidate would consume a slot being held for a new
 * coin.
 *
 * The scan sources are ranked by volume and boost, both of which favour coins
 * that have ALREADY moved — so established coins reliably reach the buy loop
 * first and can occupy every slot before a small new coin is ever considered.
 * Reserving a slot is what makes room for the segment the small-cap gate was
 * built to trade; without it that gate rarely gets anything to judge.
 *
 * A qualifying (new) candidate is never blocked by its own reservation.
 */
export function blocksReservedNewCoinSlot(
  nonNewPositionCount: number,
  maxConcurrentPositions: number,
  reservedNewCoinSlots: number,
  candidateIsNewCoin: boolean
): boolean {
  if (candidateIsNewCoin) return false;
  if (reservedNewCoinSlots <= 0) return false;
  const slotsOpenToAnything = maxConcurrentPositions - reservedNewCoinSlots;
  return nonNewPositionCount >= slotsOpenToAnything;
}
