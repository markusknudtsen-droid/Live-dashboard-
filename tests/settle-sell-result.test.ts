import test from "node:test";
import assert from "node:assert/strict";

process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";
process.env.MAX_SELL_ATTEMPTS = "3";

const { settleSellResult, setActivePositions, getActivePositions, getFailedSellCount, setAbandonListener } =
  await import("../src/trader.js");

// The bug this guards: only the stop-loss exit counted failed sells, so a
// position whose tokens were gone (OPENGAP) was retried ~1,600 times through the
// rug-exit and AI-bearish exits. All exits now share settleSellResult.
const position = {
  tokenAddress: "So11111111111111111111111111111111111111112",
  tokenSymbol: "GHOST",
  chainId: "solana",
  entryPrice: 1,
  currentPrice: 1,
  amountSol: 0.1,
  stopLoss: 0.67,
  takeProfit: 1.5,
  entryTime: Date.now(),
  pnlPercent: 0,
  txSignature: "sig",
};
const fail = { success: false, error: "No token balance found" } as never;
const ok = { success: true } as never;

test("repeated failed exits abandon the position after MAX_SELL_ATTEMPTS, whatever path sold", () => {
  let abandoned = 0;
  setAbandonListener(() => (abandoned += 1));
  setActivePositions([position as never]);

  settleSellResult(position as never, fail);
  settleSellResult(position as never, fail);
  assert.equal(getActivePositions().length, 1, "still held below the cap");
  assert.equal(getFailedSellCount(position.tokenAddress), 2);

  settleSellResult(position as never, fail);
  assert.equal(getActivePositions().length, 0, "abandoned at the cap");
  assert.equal(abandoned, 1);
  assert.equal(getFailedSellCount(position.tokenAddress), 0, "count reset after abandoning");
  setAbandonListener(null);
});

test("a successful exit clears the failure count", () => {
  setActivePositions([position as never]);
  settleSellResult(position as never, fail);
  settleSellResult(position as never, ok);
  assert.equal(getFailedSellCount(position.tokenAddress), 0);
});
