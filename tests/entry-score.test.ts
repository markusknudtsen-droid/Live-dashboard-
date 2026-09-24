import test from "node:test";
import assert from "node:assert/strict";
import { updateTrailingStop } from "../src/trailing-stop.js";
import {
  adjustConfidence,
  checkRugGates,
  qualifiesForInstantBuy,
  DEFAULT_SCORE_WEIGHTS,
} from "../src/entry-score.js";

/* ------------------------------- trailing stop ------------------------------ */

const trail = { activateAtPercent: 15, distancePercent: 15 };

test("the trail stays disarmed below the activation gain", () => {
  const r = updateTrailingStop({
    entryPrice: 100,
    currentPrice: 110, // +10%, under the +15% arm threshold
    peakPrice: undefined,
    currentStopLoss: 67,
    ...trail,
  });
  assert.equal(r.armed, false);
  assert.equal(r.raised, false);
  assert.equal(r.stopLoss, 67, "the configured stop must still stand");
  assert.equal(r.peakPrice, 110);
});

test("the trail arms and raises the stop once the gain threshold is met", () => {
  const r = updateTrailingStop({
    entryPrice: 100,
    currentPrice: 120,
    peakPrice: undefined,
    currentStopLoss: 67,
    ...trail,
  });
  assert.equal(r.armed, true);
  assert.equal(r.raised, true);
  assert.equal(r.stopLoss, 102, "15% below the 120 peak");
});

test("the stop ratchets: a falling price never drags it back down", () => {
  const high = updateTrailingStop({
    entryPrice: 100,
    currentPrice: 120,
    peakPrice: undefined,
    currentStopLoss: 67,
    ...trail,
  });
  const later = updateTrailingStop({
    entryPrice: 100,
    currentPrice: 108,
    peakPrice: high.peakPrice,
    currentStopLoss: high.stopLoss,
    ...trail,
  });
  assert.equal(later.peakPrice, 120, "peak is remembered");
  assert.equal(later.stopLoss, 102, "stop held, not lowered");
  assert.equal(later.raised, false);
});

test("the Woobi scenario: +16% then collapse now exits in profit, not at -56%", () => {
  const entry = 0.0002669;
  const peak = entry * 1.163;
  const armed = updateTrailingStop({
    entryPrice: entry,
    currentPrice: peak,
    peakPrice: undefined,
    currentStopLoss: entry * 0.67,
    activateAtPercent: 15,
    distancePercent: 10,
  });
  assert.equal(armed.raised, true);
  const pnlIfStopped = ((armed.stopLoss - entry) / entry) * 100;
  assert.ok(pnlIfStopped > 4, `expected roughly +4.7% locked in, got ${pnlIfStopped.toFixed(2)}%`);
});

test("an armed position can never become a losing trade (breakeven floor)", () => {
  // peak*(1-d/100) lands below entry here: 1.163 * 0.85 = 0.9886. Without the
  // floor the trail would arm and still exit at a loss.
  const entry = 100;
  const r = updateTrailingStop({
    entryPrice: entry,
    currentPrice: entry * 1.163,
    peakPrice: undefined,
    currentStopLoss: 67,
    activateAtPercent: 15,
    distancePercent: 15,
  });
  assert.equal(r.armed, true);
  assert.equal(r.stopLoss, entry, "stop floors at entry, never below");
});

test("a nonsensical trail distance leaves the configured stop untouched", () => {
  for (const distancePercent of [0, -5, 100, 150, Number.NaN]) {
    const r = updateTrailingStop({
      entryPrice: 100,
      currentPrice: 200,
      peakPrice: undefined,
      currentStopLoss: 67,
      activateAtPercent: 15,
      distancePercent,
    });
    assert.equal(r.stopLoss, 67, `distance ${distancePercent} must not move the stop`);
  }
});

test("a bad price tick cannot corrupt or widen an existing stop", () => {
  for (const currentPrice of [0, -1, Number.NaN]) {
    const r = updateTrailingStop({
      entryPrice: 100,
      currentPrice,
      peakPrice: 120,
      currentStopLoss: 102,
      ...trail,
    });
    assert.equal(r.stopLoss, 102);
    assert.equal(r.raised, false);
  }
});

/* -------------------------------- modifiers -------------------------------- */

const neutral = {
  ageHours: 3,
  boostAmount: 0,
  hasXSocial: false,
  hasOtherSocial: false,
  hasPaidDexInfo: false,
};

test("a neutral candidate's confidence is unchanged", () => {
  const r = adjustConfidence(70, neutral);
  assert.equal(r.adjustedConfidence, 70);
  assert.equal(r.bonusApplied, 0);
  assert.equal(r.penaltyApplied, 0);
});

test("paid DexScreener info lifts 70 to 80 — the operator's worked example", () => {
  const r = adjustConfidence(70, { ...neutral, hasPaidDexInfo: true });
  assert.equal(r.adjustedConfidence, 80);
});

test("age modifiers apply in both directions", () => {
  assert.equal(adjustConfidence(70, { ...neutral, ageHours: 0.5 }).adjustedConfidence, 74);
  assert.equal(adjustConfidence(70, { ...neutral, ageHours: 9 }).adjustedConfidence, 62);
});

test("X supersedes the generic social bonus rather than stacking with it", () => {
  const x = adjustConfidence(70, { ...neutral, hasXSocial: true, hasOtherSocial: true });
  assert.equal(x.adjustedConfidence, 73, "X only: +3, not +4");
  const other = adjustConfidence(70, { ...neutral, hasOtherSocial: true });
  assert.equal(other.adjustedConfidence, 71, "non-X only: +1");
});

test("stacked marketing signals cannot carry a mediocre coin over the line", () => {
  const everything = adjustConfidence(50, {
    ageHours: 0.5,
    boostAmount: 500,
    hasXSocial: true,
    hasOtherSocial: true,
    hasPaidDexInfo: true,
  });
  // Uncapped this would be +27; the cap holds it to +15.
  assert.equal(everything.bonusApplied, DEFAULT_SCORE_WEIGHTS.maxTotalBonus);
  assert.equal(everything.adjustedConfidence, 65);
  assert.ok(everything.adjustedConfidence < 80, "must not reach the buy threshold on marketing alone");
});

test("penalties are not capped", () => {
  const r = adjustConfidence(82, {
    ageHours: 20,
    boostAmount: 500,
    hasXSocial: true,
    hasOtherSocial: false,
    hasPaidDexInfo: true,
  });
  assert.equal(r.penaltyApplied, 8);
  assert.equal(r.adjustedConfidence, 89);
});

test("confidence is clamped to the 0..100 range", () => {
  assert.equal(adjustConfidence(98, { ...neutral, hasPaidDexInfo: true }).adjustedConfidence, 100);
  assert.equal(adjustConfidence(2, { ...neutral, ageHours: 50 }).adjustedConfidence, 0);
});

/* -------------------------------- rug gates -------------------------------- */

test("thin liquidity fails the gate outright", () => {
  const r = checkRugGates({ liquidityUsd: 4200, marketCapUsd: 20000 });
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /liquidity/);
});

/* ------------------------------- instant buy ------------------------------- */

const instantOn = 500;
const healthy = { liquidityUsd: 9000, marketCapUsd: 20000 };

test("a 500 boost on a healthy pair triggers the instant buy", () => {
  const r = qualifiesForInstantBuy({ ...healthy, boostAmount: 500 }, instantOn);
  assert.equal(r.buy, true);
  assert.match(r.reason, /rug gates passed/);
});

test("a boost below the threshold does not trigger it", () => {
  assert.equal(qualifiesForInstantBuy({ ...healthy, boostAmount: 499 }, instantOn).buy, false);
  assert.equal(qualifiesForInstantBuy({ ...healthy, boostAmount: 0 }, instantOn).buy, false);
});

test("a huge boost still cannot buy through a failing rug gate", () => {
  const thin = qualifiesForInstantBuy(
    { liquidityUsd: 900, marketCapUsd: 20000, boostAmount: 5000 },
    instantOn
  );
  assert.equal(thin.buy, false, "thin liquidity must veto even a 5000 boost");
  assert.match(thin.reason, /rug gate blocked it/);
});

test("the threshold is configurable", () => {
  const at100 = qualifiesForInstantBuy({ ...healthy, boostAmount: 120 }, 100);
  assert.equal(at100.buy, true);
});

test("exactly at the liquidity floor passes", () => {
  assert.equal(checkRugGates({ liquidityUsd: 5000, marketCapUsd: 10000 }).pass, true);
});

/* ------------------------------ boost tiers ------------------------------- */

test("a strong boost (>=100) earns the strong bonus, not the moderate one", () => {
  const r = adjustConfidence(70, { ...neutral, boostAmount: 500 });
  assert.equal(r.adjustedConfidence, 80, "+10 strong tier");
  assert.ok(r.reasons.some((x) => /boost >= 100/.test(x)));
});

test("a moderate boost (30-99) earns +6 — the weaker version of the same signal", () => {
  const r = adjustConfidence(70, { ...neutral, boostAmount: 50 });
  assert.equal(r.adjustedConfidence, 76);
  assert.ok(r.reasons.some((x) => /boost >= 30/.test(x)));
});

test("the tiers are mutually exclusive — a boost is never counted twice", () => {
  const strong = adjustConfidence(70, { ...neutral, boostAmount: 250 });
  assert.equal(strong.bonusApplied, 10, "10, not 16");
});

test("a boost below the moderate threshold earns nothing", () => {
  assert.equal(adjustConfidence(70, { ...neutral, boostAmount: 29 }).adjustedConfidence, 70);
  assert.equal(adjustConfidence(70, { ...neutral, boostAmount: 0 }).adjustedConfidence, 70);
});

test("tier boundaries are inclusive at 30 and 100", () => {
  assert.equal(adjustConfidence(70, { ...neutral, boostAmount: 30 }).adjustedConfidence, 76);
  assert.equal(adjustConfidence(70, { ...neutral, boostAmount: 99 }).adjustedConfidence, 76);
  assert.equal(adjustConfidence(70, { ...neutral, boostAmount: 100 }).adjustedConfidence, 80);
});
