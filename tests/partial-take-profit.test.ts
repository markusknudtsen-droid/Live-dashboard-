import test from "node:test";
import assert from "node:assert/strict";

// Config is read once at module load, so these must be set before the dynamic
// import below. They mirror the operator's live .env: with LET_WINNERS_RUN on
// and the trailing stop armed, the fixed take-profit stands down and the trail
// owns the exit — which is exactly the state where the bot banked nothing on a
// spike and gave it back on the way down. A separate file from trader.test.ts
// because those tests assert the DEFAULT behaviour (both flags off).
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";
process.env.TRAILING_STOP_ENABLED = "true";
process.env.LET_WINNERS_RUN = "true";

type TradeSignalT = import("../src/analyze.js").TradeSignal;
type TokenCandidateT = import("../src/scanner.js").TokenCandidate;

const { initTrader, getBalance, executeBuy, evaluatePositionAtPrice, getActivePositions, setActivePositions } =
  await import("../src/trader.js");

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function makeSignal(): TradeSignalT {
  const token: TokenCandidateT = {
    address: MINT,
    symbol: "SPIKE",
    name: "Spike",
    chainId: "solana",
    priceUsd: 0.0001,
    liquidityUsd: 50_000,
    volume24h: 200_000,
    marketCap: 100_000,
    ageHours: 2,
    priceChange24h: 900,
    priceChange6h: 400,
    priceChange1h: 120,
    boostAmount: 0,
    hasXSocial: true,
    hasOtherSocial: false,
    hasPaidDexInfo: false,
  };
  return {
    token,
    confidence: 90,
    action: "BUY",
    reasoning: "test",
    entryPrice: token.priceUsd,
    stopLoss: token.priceUsd * 0.67,
    takeProfit: token.priceUsd * 1.5,
    positionSizeSol: 0.2,
    riskRewardRatio: 1.5,
    trendStrength: "strong_up",
    momentum: "accelerating",
    riskLevel: "high",
    narrative: "test",
  };
}

await initTrader();

/**
 * Arm the trailing stop first (a tick above the +15% activation), so
 * LET_WINNERS_RUN defers the fixed take-profit and the position is still open
 * when it reaches the partial threshold — the real production sequence.
 */
async function buyAndArm() {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  await evaluatePositionAtPrice(position, position.entryPrice * 1.2);
  return getActivePositions()[0];
}

test("a spike past the threshold banks half and leaves the rest running", async () => {
  const position = await buyAndArm();
  assert.equal(position.amountSol, 0.2, "full size before the partial");
  const before = await getBalance();

  await evaluatePositionAtPrice(position, position.entryPrice * 2.2); // +120%

  assert.equal(getActivePositions().length, 1, "position must stay open after a partial sale");
  const still = getActivePositions()[0];
  assert.ok(Math.abs(still.amountSol - 0.1) < 1e-9, "half the SOL still at risk");
  assert.equal(still.partialTakeProfitTaken, true);
  assert.equal(still.entryPrice, position.entryPrice, "cost basis per token unchanged by selling some");

  // Sold 0.1 SOL of exposure at +120% -> 0.22 SOL proceeds.
  assert.ok(Math.abs((await getBalance()) - (before + 0.22)) < 1e-9, "partial proceeds settled to the wallet");
});

test("the partial fires exactly once, however far it keeps running", async () => {
  const position = await buyAndArm();
  await evaluatePositionAtPrice(position, position.entryPrice * 2.2);
  const afterFirst = await getBalance();
  const held = getActivePositions()[0];

  await evaluatePositionAtPrice(held, held.entryPrice * 3);

  assert.ok(Math.abs((await getBalance()) - afterFirst) < 1e-9, "no second slice banked");
  assert.ok(Math.abs(getActivePositions()[0].amountSol - 0.1) < 1e-9, "size unchanged on the later tick");
});

test("a gain under the threshold banks nothing", async () => {
  const position = await buyAndArm();
  const before = await getBalance();

  await evaluatePositionAtPrice(position, position.entryPrice * 1.6); // +60%, under +100%

  assert.equal(getActivePositions().length, 1, "still open: the trail defers the fixed take-profit");
  assert.ok(Math.abs(getActivePositions()[0].amountSol - 0.2) < 1e-9, "nothing sold");
  assert.ok(!getActivePositions()[0].partialTakeProfitTaken);
  assert.ok(Math.abs((await getBalance()) - before) < 1e-9);
});

test("the trailing stop still closes the remainder after a partial", async () => {
  const position = await buyAndArm();
  await evaluatePositionAtPrice(position, position.entryPrice * 2.2);
  assert.equal(getActivePositions().length, 1);

  // Falls back through the trail (armed at a 2.2x peak, 10% back = 1.98x).
  await evaluatePositionAtPrice(getActivePositions()[0], position.entryPrice * 1.5);

  assert.equal(getActivePositions().length, 0, "the remainder exits on the trailing stop");
});

test("a stop-loss closes the whole position rather than banking a slice", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];

  await evaluatePositionAtPrice(position, position.entryPrice * 0.5);

  assert.equal(getActivePositions().length, 0, "stop-loss takes precedence and closes fully");
});
