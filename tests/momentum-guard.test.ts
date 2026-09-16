import test from "node:test";
import assert from "node:assert/strict";
import { isBearishSignal, shouldCloseHeldPosition } from "../src/momentum-guard.js";

test("a down trend is bearish regardless of momentum label", () => {
  assert.equal(isBearishSignal("moderate_down", "steady"), true);
  assert.equal(isBearishSignal("strong_down", "accelerating"), true);
});

test("reversing momentum is bearish even on an uptrend — a winner topping out", () => {
  assert.equal(isBearishSignal("strong_up", "reversing"), true);
  assert.equal(isBearishSignal("moderate_up", "reversing"), true);
});

test("an uptrend with non-reversing momentum is not bearish", () => {
  assert.equal(isBearishSignal("strong_up", "accelerating"), false);
  assert.equal(isBearishSignal("moderate_up", "steady"), false);
  assert.equal(isBearishSignal("moderate_up", "decelerating"), false);
});

test("neutral trend with steady momentum is not bearish", () => {
  assert.equal(isBearishSignal("neutral", "steady"), false);
});

// The instant-buy path builds a signal with trendStrength/momentum both
// "unknown" (see buildInstantBuySignal in index.ts). Not currently routed
// through this guard at all, but the type accepts arbitrary strings, so this
// locks in a safe default should that ever change.
test("the instant-buy placeholder value 'unknown' is never bearish", () => {
  assert.equal(isBearishSignal("unknown", "unknown"), false);
});

test("shouldCloseHeldPosition: low confidence closes even on a neutral trend read", () => {
  assert.equal(shouldCloseHeldPosition("neutral", "steady", 55, 55), true);
  assert.equal(shouldCloseHeldPosition("neutral", "steady", 56, 55), false);
});

test("shouldCloseHeldPosition: a bearish trend still closes regardless of confidence", () => {
  assert.equal(shouldCloseHeldPosition("strong_down", "steady", 90, 55), true);
});
