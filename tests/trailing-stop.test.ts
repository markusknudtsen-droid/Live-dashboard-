import test from "node:test";
import assert from "node:assert/strict";
import { updateTrailingStop } from "../src/trailing-stop.js";

const base = { entryPrice: 100, currentStopLoss: 0, activateAtPercent: 10, distancePercent: 8 };

test("below activation, the trail does not arm", () => {
  const r = updateTrailingStop({ ...base, currentPrice: 105, peakPrice: undefined });
  assert.equal(r.armed, false);
});

test("a modest runner (just past activation) still gets the full distance", () => {
  // Peak +12%, well under the 3x-activation tier (30%): full 8% distance.
  const r = updateTrailingStop({ ...base, currentPrice: 112, peakPrice: 112 });
  assert.ok(Math.abs(r.stopLoss - 112 * 0.92) < 1e-6, `expected ~103.04, got ${r.stopLoss}`);
});

test("a big runner (3x activation) gets half the distance — keeps more of the peak", () => {
  // Peak +30% (== 3x activation of 10%): distance halves to 4%.
  const r = updateTrailingStop({ ...base, currentPrice: 130, peakPrice: 130 });
  assert.ok(Math.abs(r.stopLoss - 130 * 0.96) < 1e-6, `expected ~124.8, got ${r.stopLoss}`);
});

test("a huge runner (6x activation) gets a quarter the distance", () => {
  // Peak +60% (== 6x activation): distance quarters to 2%.
  const r = updateTrailingStop({ ...base, currentPrice: 160, peakPrice: 160 });
  assert.ok(Math.abs(r.stopLoss - 160 * 0.98) < 1e-6, `expected ~156.8, got ${r.stopLoss}`);
});

test("tightened distance still never drops below the breakeven floor", () => {
  // Peak barely above the 3x tier — tightened distance still can't beat entry.
  const r = updateTrailingStop({ ...base, currentPrice: 130.5, peakPrice: 130.5 });
  assert.ok(r.stopLoss >= 100, `stop ${r.stopLoss} must never floor below entry 100`);
});

test("the tier is based on the PEAK, not the current price — a pullback from a big run keeps the tight distance", () => {
  // Position ran to +60% (peak recorded), then pulled back to +45% current.
  // The stop should already be sitting from the peak's tight 2% distance
  // (156.8), which is now above current price (145) — this call must not
  // widen it back out just because price receded.
  const r = updateTrailingStop({ ...base, currentPrice: 145, peakPrice: 160, currentStopLoss: 156.8 });
  assert.equal(r.raised, false);
  assert.equal(r.stopLoss, 156.8);
});

test("activateAtPercent of 0 (edge case) never divides by zero — falls back to full distance", () => {
  const r = updateTrailingStop({ ...base, activateAtPercent: 0, currentPrice: 150, peakPrice: 150 });
  assert.ok(Number.isFinite(r.stopLoss));
});
