/**
 * Boost freshness tracking.
 *
 * DexScreener's boost records carry no timestamp:
 *
 *   interface DexTokenBoost { chainId; tokenAddress; amount?; totalAmount? }
 *
 * So "this token is boosted" is knowable, but "this token was JUST boosted" is
 * not — not from the payload alone. The /token-boosts/latest feed is a rolling
 * list, and a token can sit in it long after the buying interest that the boost
 * bought has evaporated. An instant buy fired off that list alone is therefore
 * as likely to be buying a boost from three hours ago, on a coin already
 * rolling over, as a boost from ten seconds ago.
 *
 * The bot supplies the missing timestamp itself: it records when it FIRST saw
 * each token carrying a boost, and treats only that first sighting as the
 * boost event. Two consequences follow, and both are deliberate:
 *
 * - Everything present in the very first poll after startup is baselined as
 *   already-seen and never instant-bought. On a restart the whole feed looks
 *   "new" but none of it is; without a baseline the bot would buy the entire
 *   backlog, which is exactly what happened when TRONK and ULCAT were re-bought
 *   within ten seconds of a restart.
 * - A token whose boost AMOUNT increases is treated as a fresh event, since
 *   topping a boost up is a new purchase, not the old one persisting.
 *
 * Pure functions: the caller supplies the clock and owns the state.
 */

export interface SeenBoost {
  /** Highest boost amount observed for this token so far. */
  amount: number;
  /** When this boost level was first observed, epoch ms. */
  firstSeenAt: number;
}

/** token key -> sighting. Key is `${chainId}:${tokenAddress}`. */
export type BoostSightings = Map<string, SeenBoost>;

export interface BoostObservation {
  chainId: string;
  tokenAddress: string;
  boostAmount: number;
}

export interface FreshnessConfig {
  /**
   * How long after first sighting a boost still counts as actionable. Beyond
   * this the opportunity is stale and the instant buy declines it.
   */
  freshWindowSeconds: number;
}

export const DEFAULT_FRESHNESS: FreshnessConfig = { freshWindowSeconds: 120 };

export function boostKey(chainId: string, tokenAddress: string): string {
  return `${chainId}:${tokenAddress}`;
}

export interface ObserveResult {
  /** Tokens whose boost is newly observed at this poll. */
  newlyBoosted: BoostObservation[];
  /** Updated sightings to carry into the next poll. */
  sightings: BoostSightings;
}

/**
 * Fold a poll's boost list into the sighting record.
 *
 * `isBaseline` marks the first poll of a run: everything is recorded, nothing
 * is reported as newly boosted.
 */
export function observeBoosts(
  observations: BoostObservation[],
  sightings: BoostSightings,
  now: number,
  isBaseline: boolean
): ObserveResult {
  const next: BoostSightings = new Map(sightings);
  const newlyBoosted: BoostObservation[] = [];

  for (const o of observations) {
    if (!o.tokenAddress) continue;
    const key = boostKey(o.chainId, o.tokenAddress);
    const prior = next.get(key);

    // Unseen, or boosted harder than when last seen: either way this is a boost
    // purchase the bot has not yet acted on.
    if (!prior || o.boostAmount > prior.amount) {
      next.set(key, { amount: o.boostAmount, firstSeenAt: now });
      if (!isBaseline) newlyBoosted.push(o);
    }
  }

  return { newlyBoosted, sightings: next };
}

/**
 * Whether a token's boost is still inside its actionable window.
 *
 * Unknown tokens return false: never having seen the boost arrive is not
 * evidence that it just arrived.
 */
export function isBoostFresh(
  chainId: string,
  tokenAddress: string,
  sightings: BoostSightings,
  now: number,
  config: FreshnessConfig = DEFAULT_FRESHNESS
): boolean {
  const seen = sightings.get(boostKey(chainId, tokenAddress));
  if (!seen) return false;
  const ageSeconds = (now - seen.firstSeenAt) / 1000;
  return ageSeconds >= 0 && ageSeconds <= config.freshWindowSeconds;
}

/** Drop sightings far past any usable window so the map cannot grow unbounded. */
export function pruneSightings(
  sightings: BoostSightings,
  now: number,
  config: FreshnessConfig = DEFAULT_FRESHNESS
): BoostSightings {
  const cutoffMs = Math.max(config.freshWindowSeconds * 1000 * 10, 60 * 60 * 1000);
  const next: BoostSightings = new Map();
  for (const [k, v] of sightings) {
    if (now - v.firstSeenAt < cutoffMs) next.set(k, v);
  }
  return next;
}
