import test from "node:test";
import assert from "node:assert/strict";
import {
  isBearishRead,
  isBearishSignal,
  recordBearishRead,
  shouldCloseHeldPosition,
} from "../src/momentum-guard.js";

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

// KCAT, 2026-09-22: bought, dipped to -25.7%, averaged down, recovered to
// roughly breakeven, then sold on trend=neutral momentum=reversing while the
// model still rated it 65% — above the hold-exit floor. It pumped immediately
// after. On a neutral trend "reversing" usually describes a coin turning back
// UP out of a dip, so it must not be read as bearish on its own.
test("reversing on a NEUTRAL trend is not bearish — it is usually a recovery", () => {
  assert.equal(isBearishSignal("neutral", "reversing"), false);
});

test("reversing on a down trend is still bearish, via the trend label itself", () => {
  assert.equal(isBearishSignal("moderate_down", "reversing"), true);
  assert.equal(isBearishSignal("strong_down", "reversing"), true);
});

test("isBearishRead counts a low-confidence read as bearish, even on a calm trend", () => {
  assert.equal(isBearishRead("neutral", "steady", 55, 55), true, "at the floor");
  assert.equal(isBearishRead("neutral", "steady", 56, 55), false, "just above it");
  assert.equal(isBearishRead("strong_down", "steady", 90, 55), true, "trend alone is enough");
});

test("recordBearishRead keeps only the newest four reads, newest last", () => {
  let history = recordBearishRead(undefined, true);
  assert.deepEqual(history, [true]);
  history = recordBearishRead(history, false);
  history = recordBearishRead(history, true);
  history = recordBearishRead(history, false);
  assert.deepEqual(history, [true, false, true, false]);
  history = recordBearishRead(history, true);
  assert.deepEqual(history, [false, true, false, true], "the oldest read drops out");
});

test("recordBearishRead does not mutate the array it is given", () => {
  const original = [true, false];
  const next = recordBearishRead(original, true);
  assert.deepEqual(original, [true, false], "input untouched");
  assert.deepEqual(next, [true, false, true]);
});

// The operator's rule, stated directly: "3 bearish scans in a row, or 2
// bearish, 1 bullish, and bearish again".
test("three bearish reads in a row close the position", () => {
  assert.equal(shouldCloseHeldPosition([true, true, true]), true);
});

test("two bearish, one bullish, then bearish again also closes", () => {
  assert.equal(shouldCloseHeldPosition([true, true, false, true]), true);
});

test("a single bearish read never closes on its own — the KCAT case", () => {
  assert.equal(shouldCloseHeldPosition([true]), false);
  assert.equal(shouldCloseHeldPosition([false, false, false, true]), false);
});

test("two bearish reads are not enough", () => {
  assert.equal(shouldCloseHeldPosition([true, true]), false);
  assert.equal(shouldCloseHeldPosition([true, false, true]), false);
});

test("alternating reads never accumulate to a close", () => {
  // B U B U — only two bearish inside the four-read window.
  assert.equal(shouldCloseHeldPosition([true, false, true, false]), false);
});

test("a recovering coin pushes old bearish reads out of the window", () => {
  let history: boolean[] = [];
  for (const bearish of [true, true]) history = recordBearishRead(history, bearish);
  assert.equal(shouldCloseHeldPosition(history), false, "two bearish so far");

  // Then it turns around and reads clean repeatedly.
  for (const bearish of [false, false, false, false]) history = recordBearishRead(history, bearish);
  assert.deepEqual(history, [false, false, false, false]);
  assert.equal(shouldCloseHeldPosition(history), false, "the earlier bearish reads aged out");
});

test("no history at all never closes", () => {
  assert.equal(shouldCloseHeldPosition(undefined), false);
  assert.equal(shouldCloseHeldPosition([]), false);
});
