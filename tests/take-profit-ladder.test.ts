import test from "node:test";
import assert from "node:assert/strict";
import { parseLadder, nextLadderRung, describeLadder } from "../src/take-profit-ladder.js";

test("parseLadder reads gain:sell pairs and sorts them", () => {
  const rungs = parseLadder("100:50,40:50,250:100");
  assert.deepEqual(rungs, [
    { gainPercent: 40, sellFraction: 0.5 },
    { gainPercent: 100, sellFraction: 0.5 },
    { gainPercent: 250, sellFraction: 1 },
  ]);
  assert.equal(describeLadder(rungs), "+40%→50%, +100%→50%, +250%→100%");
});

test("parseLadder returns [] for anything unusable, so the bot falls back rather than stops", () => {
  for (const spec of [undefined, "", "   ", "garbage", "40", ":50", "40:", "0:50", "-10:50", "40:0", "40:101"]) {
    assert.deepEqual(parseLadder(spec), [], `expected [] for ${JSON.stringify(spec)}`);
  }
  // A partly-valid spec keeps only the usable rungs rather than failing whole.
  assert.deepEqual(parseLadder("40:50,junk,100:25"), [
    { gainPercent: 40, sellFraction: 0.5 },
    { gainPercent: 100, sellFraction: 0.25 },
  ]);
  // Duplicate gains cannot produce two rungs that fire at the same price.
  assert.deepEqual(parseLadder("40:50,40:90"), [{ gainPercent: 40, sellFraction: 0.5 }]);
});

test("nextLadderRung fires only once the gain clears a rung", () => {
  const rungs = parseLadder("40:50,100:50");
  assert.equal(nextLadderRung(39.9, rungs, 0), null);
  const first = nextLadderRung(40, rungs, 0);
  assert.equal(first?.rung.gainPercent, 40, "inclusive at exactly the rung");
  assert.equal(first?.rungsConsumed, 1);
});

test("already-taken rungs never fire again", () => {
  const rungs = parseLadder("40:50,100:50");
  // At +45% with rung 1 banked, nothing more is due until +100%.
  assert.equal(nextLadderRung(45, rungs, 1), null);
  assert.equal(nextLadderRung(100, rungs, 1)?.rung.gainPercent, 100);
  // Ladder exhausted.
  assert.equal(nextLadderRung(5000, rungs, 2), null);
});

test("a gap straight past two rungs banks once, at the higher rung", () => {
  // A memecoin can jump +40% -> +260% between two 10s ticks. Firing each rung
  // on consecutive ticks would sell three times into the same spike; taking
  // the highest cleared rung sells once and marks them all consumed.
  const rungs = parseLadder("40:50,100:50,250:50");
  const step = nextLadderRung(260, rungs, 0);
  assert.equal(step?.rung.gainPercent, 250);
  assert.equal(step?.rungsConsumed, 3, "all three rungs are consumed by the jump");
  assert.equal(nextLadderRung(260, rungs, 3), null, "and nothing fires afterwards");
});

test("a loss or a non-finite gain never triggers a rung", () => {
  const rungs = parseLadder("40:50");
  assert.equal(nextLadderRung(-30, rungs, 0), null);
  assert.equal(nextLadderRung(Number.NaN, rungs, 0), null);
  assert.equal(nextLadderRung(Number.POSITIVE_INFINITY, rungs, 0), null);
});

test("an empty ladder is inert", () => {
  assert.equal(nextLadderRung(999, [], 0), null);
});
