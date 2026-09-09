/**
 * Shared bearish-momentum read, used on both sides of a trade: it blocks a
 * new BUY (including a cooldown-exempt new-coin re-entry) and triggers a SELL
 * on a position already held. One definition, so "the model thinks this is
 * turning bearish" means the same thing whichever direction it's applied.
 *
 * Built from a real incident on 2026-09-09: with NEW_COIN_COOLDOWN_EXEMPT on,
 * Laptop was bought, stopped out, and bought right back into the same coin
 * three times in under 25 minutes — the last re-entry lasted 6 seconds before
 * a -36% stop. The model already computes trendStrength/momentum on every
 * analysis call; nothing previously read them for anything but display.
 *
 * Pure — the caller supplies the model's own enum output.
 */

export type TrendStrength = "strong_up" | "moderate_up" | "neutral" | "moderate_down" | "strong_down" | string;
export type Momentum = "accelerating" | "steady" | "decelerating" | "reversing" | string;

/**
 * True when the model's own read contradicts continuing to hold or enter.
 *
 * "reversing" counts regardless of trendStrength: on an uptrend it means
 * topping out (exactly the moment a held winner turns), and on a downtrend it
 * is redundant with the trend label anyway, so there is no case where
 * ignoring it is more correct than checking it.
 */
export function isBearishSignal(trendStrength: TrendStrength, momentum: Momentum): boolean {
  return trendStrength === "moderate_down" || trendStrength === "strong_down" || momentum === "reversing";
}
