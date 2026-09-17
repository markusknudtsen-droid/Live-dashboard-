/**
 * Trend-following bonus: is this candidate's name in a keyword bucket that has
 * been WINNING recently?
 *
 * "Cats are running today" is a real edge in this market and nothing in the bot
 * could see it — every other modifier (entry-score, dev-reputation, telegram)
 * judges a coin in isolation. This is the only signal derived from the bot's
 * own realised results.
 *
 * In-memory only, and that is deliberate: it follows buyCounts/boostSightings
 * in index.ts. A meta's win rate is a same-session observation — yesterday's
 * hot bucket is often today's dead one — so resetting on restart is correct
 * behaviour, not a missing feature.
 *
 * Pure functions only: the caller supplies the clock and the exit history.
 */

/**
 * Substring-matched against symbol + name, lowercased. Ordered: first hit
 * wins, so the more specific token goes first where two could both match
 * ("doge" before "dog", "shib" before "inu").
 *
 * ponytail: flat keyword list, not a taxonomy. Add words when a meta the bot
 * actually trades keeps getting missed — not speculatively.
 */
const KEYWORDS = [
  "doge", "dog", "shib", "inu", "cat", "kitty", "pepe", "frog", "elon", "trump",
  "moon", "wojak", "chad", "baby", "bonk", "wif",
];

/** The bucket a coin belongs to, or null when nothing matches. */
export function extractBucket(text: string): string | null {
  const haystack = text.toLowerCase();
  return KEYWORDS.find((k) => haystack.includes(k)) ?? null;
}

export interface BucketExit {
  bucket: string;
  pnlPercent: number;
  exitedAt: number;
}

export interface TrendConfig {
  bonus: number;
  /** Closed trades needed in the window before the bucket means anything. */
  minSamples: number;
  minWinRatePercent: number;
  windowMs: number;
}

/**
 * ponytail: fixed, not env-configurable. These are the knobs to expose if the
 * bucket ever needs tuning; until then they are config nobody sets.
 */
export const DEFAULT_TREND: TrendConfig = {
  bonus: 10,
  minSamples: 3,
  minWinRatePercent: 60,
  windowMs: 4 * 60 * 60 * 1000,
};

/** Drop exits too old to count, so the in-memory list stays bounded. */
export function pruneBucketExits(
  exits: BucketExit[],
  now: number,
  config: TrendConfig = DEFAULT_TREND
): BucketExit[] {
  return exits.filter((e) => now - e.exitedAt < config.windowMs);
}

/**
 * The confidence nudge for a candidate in `bucket`, given what recently closed.
 *
 * Withholds the bonus below minSamples rather than acting on one lucky trade —
 * same rule as every other optional signal here: an unproven bucket earns
 * nothing, and never scores negative.
 */
export function trendBonus(
  bucket: string | null,
  exits: BucketExit[],
  now: number,
  config: TrendConfig = DEFAULT_TREND
): { bonus: number; reason?: string } {
  if (!bucket) return { bonus: 0 };

  const recent = exits.filter((e) => e.bucket === bucket && now - e.exitedAt < config.windowMs);
  if (recent.length < config.minSamples) return { bonus: 0 };

  const wins = recent.filter((e) => e.pnlPercent > 0).length;
  if ((wins / recent.length) * 100 < config.minWinRatePercent) return { bonus: 0 };

  return {
    bonus: config.bonus,
    reason: `+${config.bonus} "${bucket}" trending: ${wins}/${recent.length} recent wins`,
  };
}
