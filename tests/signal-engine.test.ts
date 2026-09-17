import test from "node:test";
import assert from "node:assert/strict";
import { scoreSignal, positionSizeForConfidence, type SignalMetrics } from "../src/signal-engine.js";

function metrics(overrides: Partial<SignalMetrics> = {}): SignalMetrics {
  return {
    priceUsd: 1,
    volume24h: 0,
    liquidityUsd: 100_000,
    txns24hBuys: 0,
    txns24hSells: 0,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange6h: 0,
    priceChange24h: 0,
    ageHours: 100,
    boostAmount: 0,
    ...overrides,
  };
}

test("neutral metrics score the 50 base: SKIP with no boost/momentum/freshness", () => {
  const signal = scoreSignal(metrics(), 15, 50);
  // No txns -> ratio 0.5 -> +0; vol 0 -> +0; momentum 0; age 100h -> +0; no boost.
  assert.equal(signal.confidence, 50);
  assert.equal(signal.action, "SKIP");
  assert.equal(signal.buyToSellRatio, 0.5);
});

test("strong metrics clamp at 100 and select the top size tier", () => {
  const signal = scoreSignal(
    metrics({
      volume24h: 1_000_000,
      liquidityUsd: 500_000,
      txns24hBuys: 800,
      txns24hSells: 200,
      priceChange5m: 1,
      priceChange1h: 1,
      priceChange6h: 1,
      priceChange24h: 1,
      ageHours: 12,
      boostAmount: 500,
    }),
    15,
    50
  );
  // 50 + 24 + 6 + 10 + 8 + 5 = 103 -> 100
  assert.equal(signal.confidence, 100);
  assert.equal(signal.action, "BUY");
  assert.equal(signal.positionSizeSol, 0.3);
});

test("stop-loss and take-profit prices derive from the percentages", () => {
  const signal = scoreSignal(metrics({ priceUsd: 2 }), 15, 50);
  assert.equal(signal.stopLossPrice, 1.7);
  assert.equal(signal.takeProfitPrice, 3);
});

test("action thresholds: 80 -> BUY, 60-79 -> WATCH, <60 -> SKIP", () => {
  // Craft exact confidences via buy ratio only (no other contributions).
  // conf = 50 + (ratio - 0.5) * 80
  const buy = scoreSignal(metrics({ txns24hBuys: 875, txns24hSells: 125 }), 15, 50); // ratio .875 -> +30 -> 80
  assert.equal(buy.confidence, 80);
  assert.equal(buy.action, "BUY");

  const watch = scoreSignal(metrics({ txns24hBuys: 625, txns24hSells: 375 }), 15, 50); // ratio .625 -> +10 -> 60
  assert.equal(watch.confidence, 60);
  assert.equal(watch.action, "WATCH");

  const skip = scoreSignal(metrics({ txns24hBuys: 600, txns24hSells: 400 }), 15, 50); // ratio .6 -> +8 -> 58
  assert.equal(skip.confidence, 58);
  assert.equal(skip.action, "SKIP");
});

test("zero/invalid liquidity earns no turnover points instead of the maximum", () => {
  // High volume but NO liquidity: without the guard this scored min(vol/1, 5)*3
  // = +15 — maximum turnover credit for the riskiest possible input.
  const zeroLiq = scoreSignal(metrics({ volume24h: 1_000_000, liquidityUsd: 0 }), 15, 50);
  assert.equal(zeroLiq.confidence, 50, "no turnover contribution when liquidity is 0");
  assert.equal(zeroLiq.breakdown.volumeLiquidity, 0);

  const negativeLiq = scoreSignal(metrics({ volume24h: 1_000_000, liquidityUsd: -5 }), 15, 50);
  assert.equal(negativeLiq.breakdown.volumeLiquidity, 0);

  const realLiq = scoreSignal(metrics({ volume24h: 1_000_000, liquidityUsd: 500_000 }), 15, 50);
  assert.equal(realLiq.breakdown.volumeLiquidity, 6, "positive liquidity still earns turnover points");
});

test("size tiers map confidence to 0.3 / 0.2 / 0.1 / 0 SOL", () => {
  assert.equal(positionSizeForConfidence(90), 0.3);
  assert.equal(positionSizeForConfidence(85), 0.3);
  assert.equal(positionSizeForConfidence(84), 0.2);
  assert.equal(positionSizeForConfidence(80), 0.2);
  assert.equal(positionSizeForConfidence(79), 0.1);
  assert.equal(positionSizeForConfidence(70), 0.1);
  assert.equal(positionSizeForConfidence(69), 0);
});
