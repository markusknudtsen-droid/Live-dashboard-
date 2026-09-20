/**
 * Trailing stop-loss.
 *
 * The fixed take-profit is all-or-nothing: a position that runs to +16% and
 * then collapses pays out nothing, because it never touched +50%. That is
 * exactly what happened to Woobi (+16.30% then stopped out at -56.09%) and to
 * ZCASHCAT (+9.80% then -59.49%). A trailing stop converts part of an unrealised
 * gain into a floor that cannot be given back.
 *
 * Design notes:
 * - The trail only ARMS once the position has reached activateAtPercent. Below
 *   that the original stop-loss stands, so a position is never stopped out
 *   tighter than the operator configured just for wobbling near entry.
 * - The stop only ever moves UP. Ratcheting down would let a falling price drag
 *   the floor with it, which is the opposite of a stop.
 * - Peak tracking lives on the position itself so it survives a restart via the
 *   persisted state, rather than in process memory that a crash loses.
 *
 * Pure functions only: no clock, no network, no logging.
 */

export interface TrailingStopInputs {
  entryPrice: number;
  currentPrice: number;
  /** Highest price seen so far for this position, or undefined on first sight. */
  peakPrice: number | undefined;
  /** The stop currently in force. */
  currentStopLoss: number;
  /** Gain (percent) the position must reach before the trail arms. */
  activateAtPercent: number;
  /** How far (percent) below the peak the trailed stop sits. */
  distancePercent: number;
}

export interface TrailingStopResult {
  /** New peak to persist on the position. */
  peakPrice: number;
  /** The stop to enforce from now on — never below currentStopLoss. */
  stopLoss: number;
  /** True when this call moved the stop up. */
  raised: boolean;
  /** True once the position has reached the activation threshold. */
  armed: boolean;
}

function isPositive(n: number | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * A big winner should give back LESS of its peak, not the same flat slice a
 * modest one does. Measured live 2026-09-17: positions that only ever reached
 * +10-15% (barely past a typical activation threshold) locked as little as
 * +5-10% before the trail caught them — the flat 8% distance ate most of a
 * thin gain. Positions that ran to +100%+ kept the bulk of it, because the
 * same flat 8% is a much smaller bite out of a much bigger number.
 *
 * ponytail: two hardcoded tiers (half distance at 3x activation, quarter at
 * 6x), not a configurable curve — nobody has asked to tune the multipliers
 * themselves, only for big runners to give back less. Revisit if that changes.
 */
function effectiveDistance(peakGainPercent: number, activateAtPercent: number, distancePercent: number): number {
  if (activateAtPercent > 0) {
    if (peakGainPercent >= activateAtPercent * 6) return distancePercent / 4;
    if (peakGainPercent >= activateAtPercent * 3) return distancePercent / 2;
  }
  return distancePercent;
}

/**
 * Compute the peak and stop for a position at a new price.
 *
 * Returns the stop unchanged (raised: false) whenever the numbers are unusable,
 * so a bad price tick can never widen or corrupt an existing stop.
 */
export function updateTrailingStop(input: TrailingStopInputs): TrailingStopResult {
  const { entryPrice, currentPrice, currentStopLoss, activateAtPercent, distancePercent } = input;

  if (!isPositive(entryPrice) || !isPositive(currentPrice)) {
    return {
      peakPrice: isPositive(input.peakPrice) ? input.peakPrice : entryPrice,
      stopLoss: currentStopLoss,
      raised: false,
      armed: false,
    };
  }

  const priorPeak = isPositive(input.peakPrice) ? input.peakPrice : entryPrice;
  const peakPrice = Math.max(priorPeak, currentPrice);

  // A distance of 0 would place the stop exactly at the peak and sell on the
  // next tick; a distance >= 100 would put it at or below zero. Neither is a
  // usable trail, so leave the configured stop alone.
  if (!Number.isFinite(distancePercent) || distancePercent <= 0 || distancePercent >= 100) {
    return { peakPrice, stopLoss: currentStopLoss, raised: false, armed: false };
  }

  const peakGainPercent = ((peakPrice - entryPrice) / entryPrice) * 100;
  const armed = Number.isFinite(activateAtPercent) && peakGainPercent >= activateAtPercent;
  if (!armed) {
    return { peakPrice, stopLoss: currentStopLoss, raised: false, armed: false };
  }

  // Breakeven floor. peak * (1 - d/100) can still land BELOW entry: arming at
  // +16.3% with a 15% trail gives 1.163 * 0.85 = 0.9886 * entry, so the trail
  // would arm and still exit at a loss — the exact outcome it exists to
  // prevent. Once a position has proven itself by reaching the activation
  // gain, it must never be allowed to become a losing trade.
  const distance = effectiveDistance(peakGainPercent, activateAtPercent, distancePercent);
  const trailed = Math.max(peakPrice * (1 - distance / 100), entryPrice);

  // Ratchet: only ever raise. Also never at or above the current price, which
  // would trigger an exit at a level the market has not actually reached.
  if (trailed > currentStopLoss && trailed < currentPrice) {
    return { peakPrice, stopLoss: trailed, raised: true, armed: true };
  }

  return { peakPrice, stopLoss: currentStopLoss, raised: false, armed: true };
}
