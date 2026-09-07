import test from "node:test";
import assert from "node:assert/strict";
import {
  observeBoosts,
  isBoostFresh,
  pruneSightings,
  boostKey,
  type BoostSightings,
} from "../src/boost-tracker.js";
import { checkRugGates, DEFAULT_RUG_GATES } from "../src/entry-score.js";

const NOW = 1_757_260_000_000;
const obs = (addr: string, boostAmount = 500) => ({ chainId: "solana", tokenAddress: addr, boostAmount });

test("the first poll baselines everything and buys nothing", () => {
  const r = observeBoosts([obs("A"), obs("B")], new Map(), NOW, true);
  assert.equal(r.newlyBoosted.length, 0, "a restart must not buy the existing backlog");
  assert.equal(r.sightings.size, 2, "but they are recorded");
});

test("a token appearing after the baseline is newly boosted", () => {
  const base = observeBoosts([obs("A")], new Map(), NOW, true);
  const next = observeBoosts([obs("A"), obs("B")], base.sightings, NOW + 30_000, false);
  assert.deepEqual(
    next.newlyBoosted.map((o) => o.tokenAddress),
    ["B"],
    "only B is new; A was already there"
  );
});

test("a token still sitting in the feed is not re-reported", () => {
  const base = observeBoosts([obs("A")], new Map(), NOW, true);
  const again = observeBoosts([obs("A")], base.sightings, NOW + 60_000, false);
  assert.equal(again.newlyBoosted.length, 0);
});

test("a boost top-up counts as a fresh event", () => {
  const base = observeBoosts([obs("A", 100)], new Map(), NOW, true);
  const up = observeBoosts([obs("A", 500)], base.sightings, NOW + 60_000, false);
  assert.equal(up.newlyBoosted.length, 1, "topping a boost up is a new purchase");
  assert.equal(up.sightings.get(boostKey("solana", "A"))?.amount, 500);
});

test("freshness expires after the window", () => {
  const { sightings } = observeBoosts([obs("A")], new Map(), NOW, false);
  const cfg = { freshWindowSeconds: 120 };
  assert.equal(isBoostFresh("solana", "A", sightings, NOW + 60_000, cfg), true, "60s: fresh");
  assert.equal(isBoostFresh("solana", "A", sightings, NOW + 121_000, cfg), false, "121s: stale");
});

test("the operator's scenario: a boost seen 20 minutes ago is not actionable", () => {
  const { sightings } = observeBoosts([obs("OLD")], new Map(), NOW, false);
  const twentyMinutesLater = NOW + 20 * 60_000;
  assert.equal(isBoostFresh("solana", "OLD", sightings, twentyMinutesLater, { freshWindowSeconds: 120 }), false);
});

test("a token never observed is never fresh", () => {
  assert.equal(isBoostFresh("solana", "GHOST", new Map(), NOW), false);
});

test("pruneSightings bounds the map without dropping usable entries", () => {
  const s: BoostSightings = new Map([
    ["solana:new", { amount: 500, firstSeenAt: NOW - 1000 }],
    ["solana:ancient", { amount: 500, firstSeenAt: NOW - 48 * 3600 * 1000 }],
  ]);
  const pruned = pruneSightings(s, NOW, { freshWindowSeconds: 120 });
  assert.equal(pruned.has("solana:new"), true);
  assert.equal(pruned.has("solana:ancient"), false);
});

/* --------------------------- market cap ceiling --------------------------- */

const gates = { ...DEFAULT_RUG_GATES, maxMarketCapUsd: 1_500_000 };

test("a coin above the market cap ceiling is rejected", () => {
  const r = checkRugGates({ liquidityUsd: 50_000, marketCapUsd: 2_400_000, topHolderPercent: 5 }, gates);
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /market cap/);
});

test("a coin at or below the ceiling passes", () => {
  assert.equal(
    checkRugGates({ liquidityUsd: 50_000, marketCapUsd: 1_500_000, topHolderPercent: 5 }, gates).pass,
    true
  );
});

test("a zero ceiling disables the check, preserving prior behaviour", () => {
  const off = { ...DEFAULT_RUG_GATES, maxMarketCapUsd: 0 };
  assert.equal(
    checkRugGates({ liquidityUsd: 50_000, marketCapUsd: 900_000_000, topHolderPercent: 5 }, off).pass,
    true
  );
});
