/**
 * Rug detection by watching the pool, not the price.
 *
 * A rug IS a liquidity removal. Before 2026-09-17 the bot only ever looked at
 * priceUsd on a held position, so it could not see a pool being drained — it
 * saw the price fall, then spent a 5-15s AI round-trip forming an opinion about
 * it. Schrodinger reached -98.28% that way: by the time the model answered,
 * there was nothing left to sell into.
 *
 * Liquidity arrives free. monitorPositions() already fetches the DexScreener
 * pair payload that carries `liquidity.usd` and discarded everything but the
 * price, so this costs no extra request and adds no latency to the exit path.
 */

export interface RugExitConfig {
  /** Exit when liquidity has fallen this far below its peak, in percent. */
  liquidityDropPercent: number;
  /**
   * Pools smaller than this are never tracked. On a $600 pool a single ordinary
   * swap moves liquidity tens of percent, so the drop signal is noise there and
   * would sell healthy positions at a spread loss.
   */
  minTrackedLiquidityUsd: number;
}

export const DEFAULT_RUG_EXIT: RugExitConfig = {
  liquidityDropPercent: 40,
  minTrackedLiquidityUsd: 1000,
};

export interface RugExitVerdict {
  exit: boolean;
  /** How far below peak the current reading sits, in percent. 0 when unknown. */
  dropPercent: number;
  /** Present only when exit is true. */
  reason?: string;
}

const NO_EXIT: RugExitVerdict = { exit: false, dropPercent: 0 };

/**
 * Whether a held position's pool has drained far enough below its own peak to
 * be treated as a rug in progress.
 *
 * An unreadable current value is NOT a drain. A failed or partial DexScreener
 * read is indistinguishable from a real removal if you coerce it to zero, and
 * coercing it would panic-sell every position on any API hiccup — a false
 * positive costs the spread, but firing on every blip bleeds continuously. A
 * *reported* zero is trusted, because that is the pool actually being gone.
 */
export function shouldExitOnLiquidityDrop(
  peakLiquidityUsd: number | undefined,
  currentLiquidityUsd: number | undefined,
  config: RugExitConfig = DEFAULT_RUG_EXIT
): RugExitVerdict {
  // Unknown current reading: cannot conclude anything. Never sell on ignorance.
  if (typeof currentLiquidityUsd !== "number" || !Number.isFinite(currentLiquidityUsd)) return NO_EXIT;
  if (currentLiquidityUsd < 0) return NO_EXIT;

  // No peak yet (first observation of this position) — nothing to compare to.
  if (typeof peakLiquidityUsd !== "number" || !Number.isFinite(peakLiquidityUsd)) return NO_EXIT;

  // Never tracked a pool this small, so never exit on one either.
  if (peakLiquidityUsd < config.minTrackedLiquidityUsd) return NO_EXIT;
  if (peakLiquidityUsd <= 0) return NO_EXIT;

  if (currentLiquidityUsd >= peakLiquidityUsd) return NO_EXIT;

  const dropPercent = ((peakLiquidityUsd - currentLiquidityUsd) / peakLiquidityUsd) * 100;
  if (dropPercent < config.liquidityDropPercent) return { exit: false, dropPercent };

  return {
    exit: true,
    dropPercent,
    reason:
      `liquidity fell ${dropPercent.toFixed(1)}% from peak ` +
      `($${Math.round(peakLiquidityUsd).toLocaleString("en-US")} -> ` +
      `$${Math.round(currentLiquidityUsd).toLocaleString("en-US")})`,
  };
}

/**
 * The running peak for a position, given a new reading. Only finite, positive
 * readings can raise it, so an API blip cannot poison the baseline that every
 * later drop is measured against.
 */
export function updatePeakLiquidity(
  peakLiquidityUsd: number | undefined,
  currentLiquidityUsd: number | undefined
): number | undefined {
  if (typeof currentLiquidityUsd !== "number" || !Number.isFinite(currentLiquidityUsd)) return peakLiquidityUsd;
  if (currentLiquidityUsd <= 0) return peakLiquidityUsd;
  if (typeof peakLiquidityUsd !== "number" || !Number.isFinite(peakLiquidityUsd)) return currentLiquidityUsd;
  return Math.max(peakLiquidityUsd, currentLiquidityUsd);
}
