import test from "node:test";
import assert from "node:assert/strict";

import { shouldExitOnLiquidityDrop, updatePeakLiquidity, DEFAULT_RUG_EXIT } from "../src/rug-exit.js";

test("a pool draining past the threshold is a rug exit", () => {
  const v = shouldExitOnLiquidityDrop(10_000, 4_000);
  assert.equal(v.exit, true);
  assert.equal(Math.round(v.dropPercent), 60);
  assert.match(v.reason!, /liquidity fell/);
});

test("a drop short of the threshold is not an exit, but still reports the drop", () => {
  const v = shouldExitOnLiquidityDrop(10_000, 7_000);
  assert.equal(v.exit, false);
  assert.equal(Math.round(v.dropPercent), 30);
});

test("exactly at the threshold exits (boundary is inclusive)", () => {
  const v = shouldExitOnLiquidityDrop(10_000, 6_000, { ...DEFAULT_RUG_EXIT, liquidityDropPercent: 40 });
  assert.equal(v.exit, true);
});

// The Schrodinger case: the pool is gone. A reported zero is the rug itself.
test("a pool reported at zero is the strongest possible exit signal", () => {
  const v = shouldExitOnLiquidityDrop(12_000, 0);
  assert.equal(v.exit, true);
  assert.equal(Math.round(v.dropPercent), 100);
});

// A failed/partial API read must never be coerced to zero — that would
// panic-sell every open position on any DexScreener hiccup.
test("an unreadable current liquidity is not treated as a drain", () => {
  for (const bad of [undefined, NaN, Infinity, null as unknown as number]) {
    assert.equal(shouldExitOnLiquidityDrop(10_000, bad).exit, false, `${String(bad)} must not exit`);
  }
});

test("no peak yet (first observation) never exits", () => {
  assert.equal(shouldExitOnLiquidityDrop(undefined, 100).exit, false);
  assert.equal(shouldExitOnLiquidityDrop(NaN, 100).exit, false);
});

// On a dust pool one ordinary swap moves liquidity tens of percent, so the
// signal is noise and would sell healthy positions at a spread loss.
test("pools below the minimum tracked size never trigger an exit", () => {
  const v = shouldExitOnLiquidityDrop(800, 10, { ...DEFAULT_RUG_EXIT, minTrackedLiquidityUsd: 1_000 });
  assert.equal(v.exit, false);
});

test("liquidity rising above peak is never an exit", () => {
  assert.equal(shouldExitOnLiquidityDrop(10_000, 25_000).exit, false);
});

test("updatePeakLiquidity keeps the high-water mark and ignores junk readings", () => {
  assert.equal(updatePeakLiquidity(undefined, 5_000), 5_000);
  assert.equal(updatePeakLiquidity(5_000, 9_000), 9_000);
  assert.equal(updatePeakLiquidity(9_000, 3_000), 9_000, "a dip must not lower the peak");
  assert.equal(updatePeakLiquidity(9_000, NaN), 9_000, "a bad read must not lower the peak");
  assert.equal(updatePeakLiquidity(9_000, undefined), 9_000);
  assert.equal(updatePeakLiquidity(9_000, 0), 9_000, "a zero read must not become the baseline");
});

// The peak is what every later drop is measured against, so a junk reading
// poisoning it would silently disable rug detection for that position.
test("a junk reading cannot poison the baseline used for later detection", () => {
  let peak: number | undefined;
  for (const reading of [10_000, NaN, 0, undefined, 9_500]) {
    peak = updatePeakLiquidity(peak, reading as number);
  }
  assert.equal(peak, 10_000);
  assert.equal(shouldExitOnLiquidityDrop(peak, 3_000).exit, true);
});
