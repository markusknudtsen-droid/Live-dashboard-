import test from "node:test";
import assert from "node:assert/strict";

// The SOI trade (2026-10-01) replayed on paper with the live exit settings: an
// 8% trail, a +40% first ladder rung selling half, and a 23% runner trail for
// what is left. Config is read at import, so set it first.
process.env.DRY_RUN = "true";
process.env.HARD_BUY_GATE_ENABLED = "false"; // synthetic tokens: the on-chain authority check is tested in buy-gate.test.ts
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";
process.env.TRAILING_STOP_ENABLED = "true";
process.env.LET_WINNERS_RUN = "true";
process.env.TRAILING_STOP_ACTIVATE_PERCENT = "20";
process.env.TRAILING_STOP_DISTANCE_PERCENT = "8";
process.env.TRAILING_STOP_RUNNER_DISTANCE_PERCENT = "23";
process.env.TAKE_PROFIT_LADDER = "40:50";

const { initTrader, executeBuy, evaluatePositionAtPrice, getActivePositions, setActivePositions } = await import(
  "../src/trader.js"
);

await initTrader();

const near = (a: number, b: number) => Math.abs(a / b - 1) < 1e-9;

test("after the first rung the rest trails a flat 23%, not 8%", async () => {
  setActivePositions([]);
  await executeBuy({
    token: {
      address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "SOI", name: "Soi", chainId: "solana",
      priceUsd: 1, liquidityUsd: 50_000, volume24h: 200_000, marketCap: 100_000, ageHours: 0.2,
      priceChange24h: 0, priceChange6h: 0, priceChange1h: 0, boostAmount: 0,
      hasXSocial: false, hasOtherSocial: false, hasPaidDexInfo: false,
    },
    confidence: 90, action: "BUY", reasoning: "test", entryPrice: 1, stopLoss: 0.67, takeProfit: 1.5,
    positionSizeSol: 0.05, riskRewardRatio: 1.5, trendStrength: "strong_up", momentum: "accelerating",
    riskLevel: "high", narrative: "test",
  } as never);
  const p = () => getActivePositions()[0];

  await evaluatePositionAtPrice(p(), 1.2); // arms the 8% trail
  await evaluatePositionAtPrice(p(), 1.45); // +45%: rung sells half, runner trail takes over
  assert.ok(near(p().stopLoss, 1.45 * 0.77), `stop reset to 23% below the peak, got ${p().stopLoss}`);
  assert.ok(near(p().amountSol, 0.025), "half sold");

  await evaluatePositionAtPrice(p(), 1.2); // would have closed under the old 8% stop (1.334)
  assert.equal(getActivePositions().length, 1, "the runner survives a pullback the 8% trail would not");

  await evaluatePositionAtPrice(p(), 2.0); // new peak, +100%
  assert.ok(near(p().stopLoss, 2.0 * 0.77), `flat 23% even at +100% (no tightening tiers), got ${p().stopLoss}`);

  await evaluatePositionAtPrice(p(), 1.5); // below 1.54
  assert.equal(getActivePositions().length, 0, "the runner exits on its own trail");
});
