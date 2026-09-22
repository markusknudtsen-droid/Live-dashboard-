import test from "node:test";
import assert from "node:assert/strict";
import { passesFreshLaunchGate, toFreshCandidate } from "../src/fresh-launch.js";
import type { FreshLaunchCandidate, FreshLaunchConfig, FreshLaunchPool } from "../src/fresh-launch.js";

const CONFIG: FreshLaunchConfig = {
  maxAgeMinutes: 5,
  minLiquidityUsd: 4800,
  minBuyVolume5m: 1100,
  minOrganicBuyPercent: 45,
};

const NOW = Date.parse("2026-09-21T19:10:00Z");

/** A candidate that clears every bar; each test spoils exactly one thing. */
function good(overrides: Partial<FreshLaunchCandidate> = {}): FreshLaunchCandidate {
  return {
    address: "DtnVTRro7SwWJeDRyaQHbn8CdCUq3yqHpot9TZiXpump",
    symbol: "FRESH",
    name: "Fresh Token",
    priceUsd: 0.000006,
    marketCapUsd: 6000,
    liquidityUsd: 5200,
    ageMinutes: 2,
    buyVolume5m: 1500,
    organicBuyPercent: 60,
    mintDisabled: true,
    freezeDisabled: true,
    ...overrides,
  };
}

test("a fresh launch clearing every bar passes", () => {
  const v = passesFreshLaunchGate(good(), CONFIG);
  assert.equal(v.pass, true, v.reason);
});

test("each bar rejects on its own, and says which one", () => {
  const cases: Array<[Partial<FreshLaunchCandidate>, RegExp]> = [
    [{ ageMinutes: 5.1 }, /old \(max 5m\)/],
    [{ mintDisabled: false }, /mint authority/],
    [{ freezeDisabled: false }, /freeze authority/],
    [{ liquidityUsd: 4799 }, /liquidity \$4799 < \$4800/],
    [{ buyVolume5m: 1099 }, /5m buy volume \$1099 < \$1100/],
    [{ organicBuyPercent: 44.9 }, /organic buys 44\.9% < 45%/],
  ];
  for (const [spoil, expected] of cases) {
    const v = passesFreshLaunchGate(good(spoil), CONFIG);
    assert.equal(v.pass, false, `should have failed with ${JSON.stringify(spoil)}`);
    assert.match(v.reason, expected);
  }
});

test("thresholds are inclusive at exactly the bar", () => {
  // Exactly at the limit must pass, or the configured number means something
  // subtly different from what the operator set.
  assert.equal(passesFreshLaunchGate(good({ ageMinutes: 5 }), CONFIG).pass, true);
  assert.equal(passesFreshLaunchGate(good({ liquidityUsd: 4800 }), CONFIG).pass, true);
  assert.equal(passesFreshLaunchGate(good({ buyVolume5m: 1100 }), CONFIG).pass, true);
  assert.equal(passesFreshLaunchGate(good({ organicBuyPercent: 45 }), CONFIG).pass, true);
});

test("toFreshCandidate reads a real Jupiter pool shape", () => {
  const pool: FreshLaunchPool = {
    id: "pool1",
    createdAt: "2026-09-21T19:08:00Z", // 2 minutes before NOW
    liquidity: 5200.5,
    baseAsset: {
      id: "MintAddress111",
      symbol: "FRESH",
      name: "Fresh Token",
      usdPrice: 0.000006,
      mcap: 6000,
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
      stats5m: { buyVolume: 2000, buyOrganicVolume: 1200, sellVolume: 300 },
    },
  };

  const c = toFreshCandidate(pool, NOW);
  assert.ok(c);
  assert.equal(c.address, "MintAddress111");
  assert.equal(c.ageMinutes, 2);
  assert.equal(c.liquidityUsd, 5200.5);
  assert.equal(c.buyVolume5m, 2000);
  assert.equal(c.organicBuyPercent, 60); // 1200 / 2000
  assert.equal(c.mintDisabled, true);
  assert.equal(c.freezeDisabled, true);
});

test("missing authority flags are NOT treated as safe", () => {
  // This path buys with no model and no rug check, so absent data must fail
  // closed. An audit block that simply omits the flags is the common case on a
  // token minutes old.
  const pool: FreshLaunchPool = {
    createdAt: "2026-09-21T19:09:00Z",
    liquidity: 9000,
    baseAsset: {
      id: "Mint2",
      symbol: "NOAUDIT",
      usdPrice: 0.001,
      audit: {},
      stats5m: { buyVolume: 5000, buyOrganicVolume: 5000 },
    },
  };

  const c = toFreshCandidate(pool, NOW);
  assert.ok(c);
  assert.equal(c.mintDisabled, false);
  assert.equal(c.freezeDisabled, false);
  assert.equal(passesFreshLaunchGate(c, CONFIG).pass, false);
});

test("absent organic volume reads as 0%, not as a pass", () => {
  const pool: FreshLaunchPool = {
    createdAt: "2026-09-21T19:09:00Z",
    liquidity: 9000,
    baseAsset: {
      id: "Mint3",
      symbol: "NOORG",
      usdPrice: 0.001,
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
      stats5m: { buyVolume: 5000 }, // buyOrganicVolume missing entirely
    },
  };

  const c = toFreshCandidate(pool, NOW);
  assert.ok(c);
  assert.equal(c.organicBuyPercent, 0);
  const v = passesFreshLaunchGate(c, CONFIG);
  assert.equal(v.pass, false);
  assert.match(v.reason, /organic buys 0\.0%/);
});

test("unusable pools are dropped rather than guessed at", () => {
  const base = { id: "M", symbol: "X", usdPrice: 0.001 };
  // No createdAt -> age unknowable.
  assert.equal(toFreshCandidate({ liquidity: 9000, baseAsset: base }, NOW), null);
  // No price -> cannot size a position or set exits.
  assert.equal(
    toFreshCandidate({ createdAt: "2026-09-21T19:09:00Z", liquidity: 9000, baseAsset: { id: "M", symbol: "X" } }, NOW),
    null
  );
  // No liquidity figure at all.
  assert.equal(toFreshCandidate({ createdAt: "2026-09-21T19:09:00Z", baseAsset: base }, NOW), null);
  // No baseAsset.
  assert.equal(toFreshCandidate({ createdAt: "2026-09-21T19:09:00Z", liquidity: 9000 }, NOW), null);
  // A pool timestamped in the future is corrupt, not brand new.
  assert.equal(
    toFreshCandidate({ createdAt: "2026-09-21T19:20:00Z", liquidity: 9000, baseAsset: base }, NOW),
    null
  );
});

test("zero buy volume cannot divide its way to a passing organic share", () => {
  const pool: FreshLaunchPool = {
    createdAt: "2026-09-21T19:09:30Z",
    liquidity: 9000,
    baseAsset: {
      id: "Mint4",
      symbol: "QUIET",
      usdPrice: 0.001,
      audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true },
      stats5m: { buyVolume: 0, buyOrganicVolume: 0 },
    },
  };
  const c = toFreshCandidate(pool, NOW);
  assert.ok(c);
  assert.equal(Number.isFinite(c.organicBuyPercent), true, "must not be NaN from 0/0");
  assert.equal(c.organicBuyPercent, 0);
  assert.equal(passesFreshLaunchGate(c, CONFIG).pass, false);
});
