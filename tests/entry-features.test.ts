import test from "node:test";
import assert from "node:assert/strict";

import { buildEntryFeatures, isEntryGate, recordConfidenceBonus } from "../src/entry-features.js";
import type { TradeSignal } from "../src/analyze.js";
import type { TokenCandidate } from "../src/scanner.js";
import type { RugCheckReport } from "../src/rugcheck.js";

function token(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    address: "So11111111111111111111111111111111111111112",
    symbol: "TEST",
    name: "Test Coin",
    chainId: "solana",
    pairAddress: "pair-1",
    priceUsd: 0.0001,
    priceChange5m: 4,
    priceChange1h: 12,
    priceChange6h: 0,
    priceChange24h: 0,
    volume24h: 91_000,
    volumeChange: 0,
    liquidityUsd: 12_500,
    marketCap: 48_000,
    txns24hBuys: 30,
    txns24hSells: 10,
    buyToSellRatio: 3,
    pairCreatedAt: 0,
    ageHours: 3.2,
    boostAmount: 30,
    url: "https://example.invalid",
    hasXSocial: true,
    hasOtherSocial: false,
    hasPaidDexInfo: true,
    ...overrides,
  };
}

function signal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    token: token(),
    confidence: 88,
    action: "BUY",
    reasoning: "test",
    entryPrice: 0.0001,
    stopLoss: 0.00007,
    takeProfit: 0.00015,
    positionSizeSol: 0.1,
    riskRewardRatio: 1.5,
    trendStrength: "strong",
    momentum: "rising",
    riskLevel: "medium",
    narrative: "dog",
    ...overrides,
  };
}

const rugCheck: RugCheckReport = {
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  totalHolders: 140,
  hasHolderData: true,
  devHoldingPct: 4,
  insiderHoldingPct: 2,
  bundlerHoldingPct: 1,
  scoreNormalised: 50,
  scoreRaw: 10_001,
  rugged: false,
  dangerRisks: ["Large Amount of LP Unlocked"],
};

test("entry features carry the market state the trade log was missing", () => {
  const f = buildEntryFeatures(signal());

  assert.equal(f.marketCapUsd, 48_000);
  assert.equal(f.liquidityUsd, 12_500);
  assert.equal(f.ageHours, 3.2);
  assert.equal(f.boostAmount, 30);
  assert.equal(f.buyToSellRatio, 3);
  assert.equal(f.hasXSocial, true);
  assert.equal(f.trendStrength, "strong");
  assert.equal(f.finalConfidence, 88);
});

test("a buy with no context defaults to the ai gate and records no rugcheck", () => {
  const f = buildEntryFeatures(signal());
  assert.equal(f.gate, "ai");
  assert.equal(f.rugCheck, undefined, "absent means the buy was never RugCheck-screened");
  assert.equal(f.confidenceBonuses, undefined, "an empty bonus map is omitted, not stored as {}");
});

test("the gate override wins over the context, for add-on buys", () => {
  const s = signal({ entryContext: { gate: "instant-buy" } });
  assert.equal(buildEntryFeatures(s, "add-on").gate, "add-on");
  assert.equal(buildEntryFeatures(s).gate, "instant-buy", "without an override the context stands");
});

test("the raw rugcheck score survives the summary — it is the real discriminator", () => {
  // A raw 10001 normalises to 50, which passes a "normalised <= 50" bar by an
  // exact zero margin. Recording only the normalised score would hide that.
  const f = buildEntryFeatures(signal({ entryContext: { rugCheck } }));

  assert.equal(f.rugCheck?.scoreRaw, 10_001);
  assert.equal(f.rugCheck?.scoreNormalised, 50);
  assert.equal(f.rugCheck?.dangerRiskCount, 1);
  assert.equal(f.rugCheck?.hasHolderData, true);
  assert.equal(f.rugCheck?.totalHolders, 140);
});

test("confidence provenance separates model judgement from stacked bonuses", () => {
  const s = signal({ confidence: 62, entryContext: { confidenceBeforeModifiers: 62 } });

  recordConfidenceBonus(s, "entryScore", 8);
  recordConfidenceBonus(s, "devReputation", 15);
  recordConfidenceBonus(s, "telegram", 0); // no-op: a zero delta is not a bonus
  s.confidence = 85;

  const f = buildEntryFeatures(s);
  assert.equal(f.confidenceBeforeModifiers, 62);
  assert.equal(f.finalConfidence, 85);
  assert.deepEqual(f.confidenceBonuses, { entryScore: 8, devReputation: 15 });
});

test("repeated bonuses from the same modifier accumulate rather than overwrite", () => {
  const s = signal();
  recordConfidenceBonus(s, "entryScore", 5);
  recordConfidenceBonus(s, "entryScore", 3);
  assert.deepEqual(buildEntryFeatures(s).confidenceBonuses, { entryScore: 8 });
});

test("isEntryGate accepts only known gates", () => {
  for (const gate of ["ai", "instant-buy", "fresh-launch", "add-on", "unknown"]) {
    assert.equal(isEntryGate(gate), true, `${gate} is a gate`);
  }
  for (const junk of ["", "AI", "sql", 1, null, undefined, {}]) {
    assert.equal(isEntryGate(junk), false, `${String(junk)} is not a gate`);
  }
});
