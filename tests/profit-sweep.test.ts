import test from "node:test";
import assert from "node:assert/strict";
import { decideSweep } from "../src/profit-sweep.js";

test("sweeps the full excess above the reserve when no cap is set", () => {
  const result = decideSweep({ balanceSol: 0.8, reserveSol: 0.5, minSweepSol: 0.1, maxSweepSol: 0 });
  assert.equal(result.shouldSweep, true);
  assert.ok(Math.abs(result.amountSol - 0.3) < 1e-9);
});

test("does nothing when balance is below the reserve", () => {
  const result = decideSweep({ balanceSol: 0.3, reserveSol: 0.5, minSweepSol: 0.1, maxSweepSol: 0 });
  assert.equal(result.shouldSweep, false);
  assert.equal(result.amountSol, 0);
  assert.match(result.reason ?? "", /below the 0\.1 SOL minimum/);
});

test("does nothing when excess is positive but below the minimum sweep size", () => {
  const result = decideSweep({ balanceSol: 0.55, reserveSol: 0.5, minSweepSol: 0.1, maxSweepSol: 0 });
  assert.equal(result.shouldSweep, false);
  assert.equal(result.amountSol, 0);
});

test("caps a single sweep at maxSweepSol when the excess is larger", () => {
  const result = decideSweep({ balanceSol: 5, reserveSol: 0.5, minSweepSol: 0.1, maxSweepSol: 0.2 });
  assert.equal(result.shouldSweep, true);
  assert.equal(result.amountSol, 0.2);
});

test("a zero maxSweepSol means unlimited, not zero", () => {
  const result = decideSweep({ balanceSol: 5, reserveSol: 0.5, minSweepSol: 0.1, maxSweepSol: 0 });
  assert.equal(result.shouldSweep, true);
  assert.equal(result.amountSol, 4.5);
});

test("exactly at the minimum sweeps (boundary is inclusive)", () => {
  // 0.75 and 0.5 are both exact in binary floating point (unlike 0.6/0.1),
  // so this actually lands ON the boundary instead of drifting a hair below it.
  const result = decideSweep({ balanceSol: 0.75, reserveSol: 0.5, minSweepSol: 0.25, maxSweepSol: 0 });
  assert.equal(result.shouldSweep, true);
  assert.ok(Math.abs(result.amountSol - 0.25) < 1e-9);
});

test("non-finite inputs never sweep", () => {
  assert.equal(decideSweep({ balanceSol: NaN, reserveSol: 0.5, minSweepSol: 0.1, maxSweepSol: 0 }).shouldSweep, false);
  assert.equal(decideSweep({ balanceSol: 1, reserveSol: Infinity, minSweepSol: 0.1, maxSweepSol: 0 }).shouldSweep, false);
});
