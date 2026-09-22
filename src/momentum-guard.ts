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

/** Trend labels that are bearish on their own, whatever momentum says. */
function isDownTrend(trendStrength: TrendStrength): boolean {
  return trendStrength === "moderate_down" || trendStrength === "strong_down";
}

function isUpTrend(trendStrength: TrendStrength): boolean {
  return trendStrength === "strong_up" || trendStrength === "moderate_up";
}

/**
 * True when the model's own read contradicts continuing to hold or enter.
 *
 * "reversing" is DIRECTIONLESS — it says a move is turning, not which way.
 * It only means "bearish" when there is an uptrend to turn out of, so it is
 * counted only alongside an up trend. Nothing is lost by scoping it: on a
 * down trend the trend label already returns true on its own, and that was
 * the original justification for treating it unconditionally.
 *
 * The case that justification missed is a NEUTRAL trend, where "reversing"
 * most often describes a coin turning back UP out of a dip — the bullish
 * read. KCAT, 2026-09-22: bought, dipped to -25.7%, averaged down, recovered
 * to roughly breakeven, and was then sold on trend=neutral momentum=reversing
 * while the model still rated it 65% (above the hold-exit floor). It pumped
 * immediately after, and the re-entry block kept the bot out of it.
 */
export function isBearishSignal(trendStrength: TrendStrength, momentum: Momentum): boolean {
  return isDownTrend(trendStrength) || (momentum === "reversing" && isUpTrend(trendStrength));
}

/**
 * Whether a SINGLE re-analysis reads bearish for a held position: either the
 * model's own trend/momentum reads bearish, or its confidence in the coin has
 * fallen to (or below) the operator's hold-exit floor. Either is sufficient
 * alone — a coin can lose conviction without yet reading as outright bearish.
 *
 * One of these no longer closes a position by itself; see the history rules.
 */
export function isBearishRead(
  trendStrength: TrendStrength,
  momentum: Momentum,
  confidence: number,
  lowConfidenceThreshold: number
): boolean {
  return isBearishSignal(trendStrength, momentum) || confidence <= lowConfidenceThreshold;
}

/**
 * How many recent reads are kept, and how many of them must be bearish to
 * close. Three-of-four, which is exactly the operator's rule: "3 bearish
 * scans in a row, or 2 bearish, 1 bullish, and bearish again".
 *
 *   B B B    -> 3 of the last 3/4  -> close
 *   B B U B  -> 3 of the last 4    -> close
 *   B U B U  -> 2 of the last 4    -> hold
 *
 * A single non-bearish read therefore does not wipe the tally, but it does
 * buy the position another scan, and a genuinely recovering coin pushes the
 * bearish reads out of the window entirely.
 */
export const BEARISH_HISTORY_WINDOW = 4;
export const BEARISH_READS_TO_CLOSE = 3;

/**
 * Append a read to a position's rolling history, keeping only the newest
 * BEARISH_HISTORY_WINDOW entries. Returns a new array; never mutates.
 */
export function recordBearishRead(history: boolean[] | undefined, bearish: boolean): boolean[] {
  return [...(history ?? []), bearish].slice(-BEARISH_HISTORY_WINDOW);
}

/**
 * Whether the accumulated reads justify closing.
 *
 * The point of requiring several is that the bot re-analyses a held position
 * every BEARISH_EXIT_RECHECK_MINUTES — at the configured 0.1 that is roughly
 * 360 independent model calls an hour, and closing on any one of them meant a
 * position survived only if EVERY call came back clean. That is not measuring
 * a reversal, it is sampling model noise until it produces a sell.
 */
export function shouldCloseOnBearishHistory(history: boolean[] | undefined): boolean {
  if (!history) return false;
  return history.filter(Boolean).length >= BEARISH_READS_TO_CLOSE;
}

/**
 * Whether a held position should be closed on re-analysis, given the read
 * history it has accumulated so far (the newest read included by the caller
 * via recordBearishRead).
 *
 * Price-based exits — stop loss, take-profit ladder, trailing stop, the
 * liquidity rug-exit — are unaffected and still fire immediately on their own
 * terms. This governs only the model-opinion exit.
 */
export function shouldCloseHeldPosition(history: boolean[] | undefined): boolean {
  return shouldCloseOnBearishHistory(history);
}
