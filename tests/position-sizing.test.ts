import test from "node:test";
import assert from "node:assert/strict";
import { parsePositionTiers, sizeForConfidence, describeTiers } from "../src/position-sizing.js";

const TIERS = parsePositionTiers("65:0.1,80:0.15");
const FALLBACK = 0.15;

test("parsePositionTiers reads confidence:sol pairs and sorts them", () => {
  assert.deepEqual(parsePositionTiers("80:0.15,65:0.1"), [
    { minConfidence: 65, sol: 0.1 },
    { minConfidence: 80, sol: 0.15 },
  ]);
  assert.equal(describeTiers(TIERS), "65%+ → 0.1 SOL, 80%+ → 0.15 SOL");
});

test("parsePositionTiers returns [] for anything unusable, so sizing falls back", () => {
  for (const spec of [undefined, "", "   ", "junk", "65", ":0.1", "65:", "0:0.1", "-5:0.1", "101:0.1", "65:0", "65:-1"]) {
    assert.deepEqual(parsePositionTiers(spec), [], `expected [] for ${JSON.stringify(spec)}`);
  }
  // A partly-valid spec keeps the usable tiers rather than failing whole.
  assert.deepEqual(parsePositionTiers("65:0.1,junk,80:0.15"), [
    { minConfidence: 65, sol: 0.1 },
    { minConfidence: 80, sol: 0.15 },
  ]);
  // Duplicate thresholds cannot produce two tiers at the same confidence.
  assert.deepEqual(parsePositionTiers("65:0.1,65:0.5"), [{ minConfidence: 65, sol: 0.1 }]);
});

test("the operator's actual ladder: 65%+ stakes 0.1, 80%+ stakes 0.15", () => {
  assert.equal(sizeForConfidence(65, TIERS, FALLBACK), 0.1, "inclusive at exactly 65");
  assert.equal(sizeForConfidence(72, TIERS, FALLBACK), 0.1);
  assert.equal(sizeForConfidence(79.9, TIERS, FALLBACK), 0.1);
  assert.equal(sizeForConfidence(80, TIERS, FALLBACK), 0.15, "inclusive at exactly 80");
  assert.equal(sizeForConfidence(100, TIERS, FALLBACK), 0.15);
});

test("below every tier falls back rather than refusing to size", () => {
  // MIN_CONFIDENCE decides whether to trade; if something passed that filter
  // but sits under the lowest tier, it still needs a stake.
  assert.equal(sizeForConfidence(64, TIERS, FALLBACK), FALLBACK);
  assert.equal(sizeForConfidence(0, TIERS, FALLBACK), FALLBACK);
});

test("no tiers configured leaves the existing flat size untouched", () => {
  assert.equal(sizeForConfidence(95, [], 0.42), 0.42);
});

test("a non-finite confidence cannot pick a tier", () => {
  assert.equal(sizeForConfidence(Number.NaN, TIERS, FALLBACK), FALLBACK);
  assert.equal(sizeForConfidence(Number.POSITIVE_INFINITY, TIERS, FALLBACK), 0.15, "Infinity clears every tier");
});

test("the highest cleared tier wins, not the first", () => {
  const three = parsePositionTiers("50:0.05,65:0.1,80:0.15");
  assert.equal(sizeForConfidence(90, three, FALLBACK), 0.15);
  assert.equal(sizeForConfidence(70, three, FALLBACK), 0.1);
  assert.equal(sizeForConfidence(55, three, FALLBACK), 0.05);
});
