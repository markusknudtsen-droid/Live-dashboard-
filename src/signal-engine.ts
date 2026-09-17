/**
 * Deterministic, offline heuristic signal engine.
 *
 * Mirrors the AI analyzer's output shape (confidence 0-100 -> BUY/WATCH/SKIP)
 * using only arithmetic on the token's own metrics, so it works with no API
 * keys and no network access, always returns the same score for the same
 * inputs, and can be verified by hand. It powers the MCP server's analysis
 * tool and matches the simulated engine on the MemeScope Command Center site.
 *
 * Scoring (all contributions are added to a base of 50, then the total is
 * rounded and clamped to [0, 100]):
 *   - Buy pressure:  (buyRatio - 0.5) * 80        -> -40 .. +40
 *   - Vol/liquidity: min(vol24h / liq, 5) * 3     ->   0 .. +15
 *                    (0 when liquidity is not a positive finite number)
 *   - Momentum:      +2 if 5m > 0, +3 if 1h > 0, +3 if 6h > 0, +2 if 24h > 0
 *   - Freshness:     +8 if age <= 24h, +4 if age <= 72h, else 0
 *   - Boost:         +5 if the token has a DexScreener boost
 *
 * Action mapping: confidence >= 80 -> BUY, >= 60 -> WATCH, else SKIP.
 * Position sizing (strict tiers): >= 85 -> 0.3 SOL, >= 80 -> 0.2, >= 70 -> 0.1.
 */

export interface SignalMetrics {
  priceUsd: number;
  volume24h: number;
  liquidityUsd: number;
  txns24hBuys: number;
  txns24hSells: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  ageHours: number;
  boostAmount?: number;
}

export interface HeuristicSignal {
  confidence: number;
  action: "BUY" | "WATCH" | "SKIP";
  buyToSellRatio: number;
  positionSizeSol: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  breakdown: {
    base: number;
    buyPressure: number;
    volumeLiquidity: number;
    momentum: number;
    freshness: number;
    boost: number;
  };
}

/** Confidence tiers used for strict paper position sizing (SOL per trade). */
export const SIZE_TIERS: Array<{ minConfidence: number; positionSizeSol: number }> = [
  { minConfidence: 85, positionSizeSol: 0.3 },
  { minConfidence: 80, positionSizeSol: 0.2 },
  { minConfidence: 70, positionSizeSol: 0.1 },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function positionSizeForConfidence(confidence: number): number {
  for (const tier of SIZE_TIERS) {
    if (confidence >= tier.minConfidence) return tier.positionSizeSol;
  }
  return 0;
}

/**
 * Score a token's metrics into a deterministic trade signal.
 * stopLossPercent / takeProfitPercent express the exit distances from entry
 * (e.g. 15 and 50 -> stop at -15%, take profit at +50%).
 */
export function scoreSignal(
  metrics: SignalMetrics,
  stopLossPercent: number,
  takeProfitPercent: number
): HeuristicSignal {
  const totalTxns = metrics.txns24hBuys + metrics.txns24hSells;
  const buyRatio = totalTxns > 0 ? metrics.txns24hBuys / totalTxns : 0.5;

  const buyPressure = (buyRatio - 0.5) * 80;
  // Turnover only counts when liquidity is a known positive number — a
  // zero/invalid-liquidity token must not collect maximum turnover points.
  const volumeLiquidity =
    Number.isFinite(metrics.liquidityUsd) && metrics.liquidityUsd > 0
      ? Math.min(metrics.volume24h / metrics.liquidityUsd, 5) * 3
      : 0;
  const momentum =
    (metrics.priceChange5m > 0 ? 2 : 0) +
    (metrics.priceChange1h > 0 ? 3 : 0) +
    (metrics.priceChange6h > 0 ? 3 : 0) +
    (metrics.priceChange24h > 0 ? 2 : 0);
  const freshness = metrics.ageHours <= 24 ? 8 : metrics.ageHours <= 72 ? 4 : 0;
  const boost = (metrics.boostAmount ?? 0) > 0 ? 5 : 0;

  const confidence = clamp(Math.round(50 + buyPressure + volumeLiquidity + momentum + freshness + boost), 0, 100);
  const action: HeuristicSignal["action"] = confidence >= 80 ? "BUY" : confidence >= 60 ? "WATCH" : "SKIP";

  return {
    confidence,
    action,
    buyToSellRatio: buyRatio,
    positionSizeSol: positionSizeForConfidence(confidence),
    stopLossPrice: metrics.priceUsd * (1 - stopLossPercent / 100),
    takeProfitPrice: metrics.priceUsd * (1 + takeProfitPercent / 100),
    breakdown: {
      base: 50,
      buyPressure,
      volumeLiquidity,
      momentum,
      freshness,
      boost,
    },
  };
}
