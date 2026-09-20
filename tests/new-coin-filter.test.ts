import test from "node:test";
import assert from "node:assert/strict";
import { passesNewCoinFilter, passesInitialFilter, type TokenCandidate } from "../src/scanner.js";
import { buildConfig } from "../src/config.js";

function candidate(over: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    address: "MintAddr111111111111111111111111111111111",
    symbol: "NEW",
    name: "New Token",
    chainId: "solana",
    pairAddress: "Pair11111111111111111111111111111111111111",
    priceUsd: 0.001,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange6h: 0,
    priceChange24h: 0,
    volume24h: 0,
    volumeChange: 0,
    liquidityUsd: 9000,
    marketCap: 50_000,
    txns24hBuys: 10,
    txns24hSells: 5,
    buyToSellRatio: 0.66,
    pairCreatedAt: Date.now(),
    ageHours: 0.5,
    url: "https://dexscreener.com/solana/x",
    hasXSocial: false,
    hasOtherSocial: false,
    hasPaidDexInfo: false,
    ...over,
  };
}

test("the standard filter structurally excludes a brand-new coin", () => {
  // The bug this whole change exists for: volume24h is a TRAILING figure, so a
  // 30-minute-old token cannot have $10k of it regardless of how it is trading.
  const fresh = candidate({ ageHours: 0.5, volume24h: 4000, priceChange5m: 60 });
  assert.equal(passesInitialFilter(fresh), false, "confirms new coins were invisible before");
});

test("a fresh, liquid, fast-moving coin passes the new-coin filter", () => {
  const c = candidate({ ageHours: 0.5, liquidityUsd: 9000, priceChange5m: 40 });
  assert.equal(passesNewCoinFilter(c, 6, 5000, 15), true);
});

test("liquidity stays a hard requirement — it decides whether you can exit", () => {
  const thin = candidate({ ageHours: 0.5, liquidityUsd: 900, priceChange5m: 90 });
  assert.equal(passesNewCoinFilter(thin, 6, 5000, 15), false);
});

test("a flat or falling new coin does not qualify on freshness alone", () => {
  assert.equal(passesNewCoinFilter(candidate({ priceChange5m: 2, priceChange1h: 1 }), 6, 5000, 15), false);
  assert.equal(passesNewCoinFilter(candidate({ priceChange5m: -30, priceChange1h: -40 }), 6, 5000, 15), false);
});

test("either short window can carry the momentum test", () => {
  assert.equal(passesNewCoinFilter(candidate({ priceChange5m: 20, priceChange1h: 0 }), 6, 5000, 15), true);
  assert.equal(passesNewCoinFilter(candidate({ priceChange5m: 0, priceChange1h: 25 }), 6, 5000, 15), true);
});

test("an old coin is not a new coin, however well it is moving", () => {
  const old = candidate({ ageHours: 40, priceChange5m: 80 });
  assert.equal(passesNewCoinFilter(old, 6, 5000, 15), false);
});

test("new-coin scanning is off unless enabled, and its knobs are configurable", () => {
  assert.equal(buildConfig({}).watchNewCoins, false);
  assert.equal(buildConfig({ WATCH_NEW_COINS: "true" }).watchNewCoins, true);
  assert.equal(buildConfig({}).newCoinMaxAgeHours, 6);
  assert.equal(buildConfig({ NEW_COIN_MAX_AGE_HOURS: "2" }).newCoinMaxAgeHours, 2);
});

test("analysis cap and cache TTL are configurable, defaulting to prior behaviour", () => {
  assert.equal(buildConfig({}).maxCandidatesPerCycle, 5, "5 was the hardcoded slice");
  assert.equal(buildConfig({ MAX_CANDIDATES_PER_CYCLE: "12" }).maxCandidatesPerCycle, 12);
  assert.equal(buildConfig({ ANALYSIS_CACHE_MINUTES: "0" }).analysisCacheMinutes, 0, "0 disables reuse");
});
