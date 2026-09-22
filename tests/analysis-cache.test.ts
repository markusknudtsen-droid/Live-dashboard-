import test from "node:test";
import assert from "node:assert/strict";

import { rememberVerdict, recallVerdict, type AnalysisCache } from "../src/analysis-cache.js";
import type { TradeSignal } from "../src/analyze.js";
import type { TokenCandidate } from "../src/scanner.js";

const ADDRESS = "So11111111111111111111111111111111111111112";

function token(): TokenCandidate {
  return {
    address: ADDRESS,
    symbol: "TEST",
    name: "Test Coin",
    chainId: "solana",
    pairAddress: "pair-1",
    priceUsd: 0.0001,
    priceChange5m: 0,
    priceChange1h: 0,
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
    url: "https://example.invalid",
    hasXSocial: false,
    hasOtherSocial: false,
    hasPaidDexInfo: false,
  };
}

function signal(confidence: number): TradeSignal {
  return {
    token: token(),
    confidence,
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
  };
}

/** What the modifier passes in runCycle() do: assign straight onto the signal. */
function applyModifiers(s: TradeSignal): void {
  s.confidence = Math.min(100, s.confidence + 8); // entry score
  s.confidence = Math.min(100, s.confidence + 15); // dev reputation
  s.positionSizeSol = 0.2; // confidence tiering
}

test("a cached verdict is not corrupted by modifiers mutating the analysed signal", () => {
  const cache: AnalysisCache = new Map();
  const analysed = signal(62);

  rememberVerdict(cache, analysed, 1_000);
  applyModifiers(analysed); // exactly what runCycle does right after caching

  const recalled = recallVerdict(cache, ADDRESS, 1_500, 60_000);
  assert.equal(recalled?.confidence, 62, "the cache holds the model's verdict, not the boosted one");
  assert.equal(recalled?.positionSizeSol, 0.1, "tiering does not leak into the cache either");
});

test("confidence does not compound across cycles of reuse", () => {
  const cache: AnalysisCache = new Map();
  rememberVerdict(cache, signal(62), 0);

  // Five cycles of the same coin resurfacing and being re-modified. Before the
  // fix each cycle reused the previous cycle's boosted number as its baseline,
  // so this climbed 62 -> 85 -> 100 and stuck there.
  let last = 0;
  for (let cycle = 1; cycle <= 5; cycle++) {
    const reused = recallVerdict(cache, ADDRESS, cycle * 1_000, 60_000);
    assert.ok(reused, `cycle ${cycle} reused the verdict`);
    assert.equal(reused.confidence, 62, `cycle ${cycle} starts from the model's verdict`);
    applyModifiers(reused);
    last = reused.confidence;
  }
  assert.equal(last, 85, "a reused coin lands on the same score every cycle, never higher");
});

test("mutating a recalled verdict cannot reach back into the cache", () => {
  const cache: AnalysisCache = new Map();
  rememberVerdict(cache, signal(70), 0);

  const first = recallVerdict(cache, ADDRESS, 100, 60_000);
  first!.confidence = 100;

  assert.equal(recallVerdict(cache, ADDRESS, 200, 60_000)?.confidence, 70);
});

test("a verdict past its TTL is not reused", () => {
  const cache: AnalysisCache = new Map();
  rememberVerdict(cache, signal(62), 0);

  assert.ok(recallVerdict(cache, ADDRESS, 59_999, 60_000), "inside the TTL");
  assert.equal(recallVerdict(cache, ADDRESS, 60_000, 60_000), undefined, "exactly at the TTL is expired");
  assert.equal(recallVerdict(cache, ADDRESS, 60_001, 60_000), undefined, "past the TTL");
});

test("a TTL of zero or less disables reuse entirely", () => {
  const cache: AnalysisCache = new Map();
  rememberVerdict(cache, signal(62), 0);

  assert.equal(recallVerdict(cache, ADDRESS, 1, 0), undefined);
  assert.equal(recallVerdict(cache, ADDRESS, 1, -1), undefined);
});

test("an unknown mint has no verdict", () => {
  const cache: AnalysisCache = new Map();
  assert.equal(recallVerdict(cache, "never-seen", 1, 60_000), undefined);
});
