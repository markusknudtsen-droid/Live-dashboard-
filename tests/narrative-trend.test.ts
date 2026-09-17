import test from "node:test";
import assert from "node:assert/strict";
import { extractBucket, trendBonus, pruneBucketExits, DEFAULT_TREND } from "../src/narrative-trend.js";

const NOW = 1_700_000_000_000;
const win = (bucket: string, agoMs = 0) => ({ bucket, pnlPercent: 25, exitedAt: NOW - agoMs });
const loss = (bucket: string, agoMs = 0) => ({ bucket, pnlPercent: -30, exitedAt: NOW - agoMs });

test("matches a bucket anywhere in symbol or name", () => {
  assert.equal(extractBucket("SPACECAT"), "cat");
  assert.equal(extractBucket("Some Pepe Coin"), "pepe");
  assert.equal(extractBucket("QQQ random"), null);
});

test("more specific keyword wins where two could match", () => {
  assert.equal(extractBucket("DOGE"), "doge");
  assert.equal(extractBucket("SHIBINU"), "shib");
});

test("no bucket means no bonus", () => {
  assert.equal(trendBonus(null, [win("cat"), win("cat"), win("cat")], NOW).bonus, 0);
});

test("a hot bucket earns the bonus", () => {
  const r = trendBonus("cat", [win("cat"), win("cat"), win("cat")], NOW);
  assert.equal(r.bonus, DEFAULT_TREND.bonus);
  assert.match(r.reason ?? "", /"cat" trending: 3\/3/);
});

test("one lucky trade is not a trend", () => {
  assert.equal(trendBonus("cat", [win("cat")], NOW).bonus, 0);
});

test("a losing bucket earns nothing, never a penalty", () => {
  const r = trendBonus("dog", [loss("dog"), loss("dog"), win("dog")], NOW);
  assert.equal(r.bonus, 0);
});

test("other buckets' results do not count toward this one", () => {
  assert.equal(trendBonus("cat", [win("dog"), win("dog"), win("dog")], NOW).bonus, 0);
});

test("exits outside the window are ignored", () => {
  const stale = DEFAULT_TREND.windowMs + 1;
  const exits = [win("cat", stale), win("cat", stale), win("cat", stale)];
  assert.equal(trendBonus("cat", exits, NOW).bonus, 0);
  assert.equal(pruneBucketExits(exits, NOW).length, 0);
  assert.equal(pruneBucketExits([win("cat"), win("cat", stale)], NOW).length, 1);
});
