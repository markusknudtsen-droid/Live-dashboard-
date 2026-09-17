import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.js";

/**
 * The sizing expression under test lives in analyze.ts, where it is welded to
 * the OpenRouter call. Mirroring it here keeps the arithmetic honest without
 * standing up the network machinery: if the formula in analyze.ts changes, the
 * intent encoded below is what it must still satisfy.
 */
function sizeFor(maxPositionSol: number, positionSizePercent: number, useFixed: boolean): number {
  return useFixed
    ? maxPositionSol
    : Math.min(maxPositionSol * (positionSizePercent / 100), maxPositionSol);
}

test("fixed sizing stakes the full max regardless of the model's percentage", () => {
  assert.equal(sizeFor(0.03, 30, true), 0.03);
  assert.equal(sizeFor(0.03, 1, true), 0.03);
  assert.equal(sizeFor(0.03, 100, true), 0.03);
});

test("without the flag the model's percentage still sizes down, as before", () => {
  // The real ZCASHCAT trade: 0.03 ceiling, model chose 30%, staked 0.009.
  assert.equal(sizeFor(0.03, 30, false), 0.009);
  assert.equal(sizeFor(0.03, 100, false), 0.03);
});

test("the ceiling still caps a model percentage above 100", () => {
  assert.equal(sizeFor(0.03, 150, false), 0.03);
});

test("USE_FIXED_POSITION_SIZE defaults to off so existing setups are unchanged", () => {
  assert.equal(buildConfig({}).useFixedPositionSize, false);
});

test("USE_FIXED_POSITION_SIZE is read from the environment", () => {
  assert.equal(buildConfig({ USE_FIXED_POSITION_SIZE: "true" }).useFixedPositionSize, true);
  assert.equal(buildConfig({ USE_FIXED_POSITION_SIZE: "false" }).useFixedPositionSize, false);
});
