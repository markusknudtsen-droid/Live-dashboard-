/**
 * Stake the position according to how strongly the bot actually believes it.
 *
 * Until now every entry was the same size: USE_FIXED_POSITION_SIZE spends
 * exactly MAX_POSITION_SOL whether the signal scraped over the line or came in
 * at 100%. A tier ladder lets conviction set the stake — a marginal signal
 * risks less, a strong one risks more — without touching the confidence
 * threshold that decides whether to buy at all.
 *
 * The confidence read here is the FINAL one, after entry-score, dev-reputation,
 * Telegram and narrative-trend have all adjusted it, because that is the number
 * the buy decision itself is made on. Sizing off the raw model score would
 * disagree with the filter one line above it.
 *
 * Direction is not checked here: BEARISH_BUY_GUARD_ENABLED already refuses any
 * entry the model reads as trending down, so anything reaching this point is
 * already a bullish read.
 *
 * Pure — the caller supplies the confidence and the fallback.
 */

export interface PositionTier {
  /** Minimum final confidence, in percent, for this stake. */
  minConfidence: number;
  /** SOL to spend when this tier is the highest one cleared. */
  sol: number;
}

/**
 * Parse "65:0.1,80:0.15" into tiers — confidence percent : SOL to stake.
 *
 * Returns [] for anything unusable rather than throwing, so a typo falls back
 * to the existing flat sizing instead of stopping the bot. Sorted ascending
 * and deduped by threshold, so the caller's "highest cleared tier" scan cannot
 * depend on the order the operator typed.
 */
export function parsePositionTiers(spec: string | undefined): PositionTier[] {
  if (!spec || typeof spec !== "string") return [];
  const out: PositionTier[] = [];
  const seen = new Set<number>();

  for (const part of spec.split(",")) {
    const [rawConfidence, rawSol] = part.split(":");
    const minConfidence = Number(String(rawConfidence ?? "").trim());
    const sol = Number(String(rawSol ?? "").trim());
    if (!Number.isFinite(minConfidence) || minConfidence <= 0 || minConfidence > 100) continue;
    if (!Number.isFinite(sol) || sol <= 0) continue;
    if (seen.has(minConfidence)) continue;
    seen.add(minConfidence);
    out.push({ minConfidence, sol });
  }

  return out.sort((a, b) => a.minConfidence - b.minConfidence);
}

/**
 * The stake for a given confidence: the highest tier it clears, or
 * `fallbackSol` when it clears none (or no tiers are configured).
 *
 * Falling back rather than refusing matters — MIN_CONFIDENCE, not this, decides
 * whether a trade happens. If a signal passed that filter but sits below every
 * tier, it still deserves a size, and the old flat behaviour is the safe one.
 */
export function sizeForConfidence(confidence: number, tiers: PositionTier[], fallbackSol: number): number {
  if (!Number.isFinite(confidence) || tiers.length === 0) return fallbackSol;

  let chosen: PositionTier | undefined;
  for (const tier of tiers) {
    if (confidence >= tier.minConfidence) chosen = tier;
    else break;
  }
  return chosen ? chosen.sol : fallbackSol;
}

/** Human-readable tiers, for the startup banner. */
export function describeTiers(tiers: PositionTier[]): string {
  return tiers.map((t) => `${t.minConfidence}%+ → ${t.sol} SOL`).join(", ");
}
