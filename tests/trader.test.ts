import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "../src/config.js";
import {
  initTrader,
  executeBuy,
  executeSell,
  getBalance,
  getActivePositions,
  setActivePositions,
} from "../src/trader.js";
import type { TradeSignal } from "../src/analyze.js";
import type { TokenCandidate } from "../src/scanner.js";

function makeCandidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    address: "So11111111111111111111111111111111111111112",
    symbol: "FAKE",
    name: "Fake Token",
    chainId: "solana",
    pairAddress: "pair-fake",
    priceUsd: 0.001,
    priceChange5m: 1,
    priceChange1h: 2,
    priceChange6h: 3,
    priceChange24h: 4,
    volume24h: 10000,
    volumeChange: 0,
    liquidityUsd: 5000,
    marketCap: 100000,
    txns24hBuys: 10,
    txns24hSells: 5,
    buyToSellRatio: 2,
    pairCreatedAt: Date.now(),
    ageHours: 1,
    url: "https://dexscreener.com/solana/pair-fake",
    ...overrides,
  };
}

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  const token = makeCandidate();
  return {
    token,
    confidence: 90,
    action: "BUY",
    reasoning: "test",
    entryPrice: token.priceUsd,
    stopLoss: token.priceUsd * 0.85,
    takeProfit: token.priceUsd * 1.5,
    positionSizeSol: 0.5,
    riskRewardRatio: 3,
    trendStrength: "strong",
    momentum: "high",
    riskLevel: "medium",
    narrative: "test",
    ...overrides,
  };
}

test("dry-run mode simulates buy/sell without real transactions", async () => {
  const originalDryRun = CONFIG.dryRun;
  const originalPaperBalance = CONFIG.paperStartingBalanceSol;
  const originalRpcUrl = CONFIG.solanaRpcUrl;

  CONFIG.dryRun = true;
  CONFIG.paperStartingBalanceSol = 5;
  // A Connection object is instantiated in initTrader() but never used to make
  // network calls in dry-run mode, so any syntactically valid RPC URL works here.
  CONFIG.solanaRpcUrl = "http://dry-run-placeholder.invalid";

  try {
    setActivePositions([]);
    initTrader();

    const startBalance = await getBalance();
    assert.equal(startBalance, 5);

    const signal = makeSignal({ positionSizeSol: 1 });
    const buyResult = await executeBuy(signal);

    assert.equal(buyResult.success, true);
    assert.ok(buyResult.txSignature?.startsWith("DRYRUN-"));

    const afterBuyBalance = await getBalance();
    assert.equal(afterBuyBalance, 4);
    assert.equal(getActivePositions().length, 1);

    const [position] = getActivePositions();
    // Simulate a take-profit price move by replacing the tracked position with
    // one that has +50% PnL, using the public setActivePositions API rather
    // than mutating the object returned by getActivePositions() (which is
    // documented as a defensive copy).
    const positionAtTakeProfit = { ...position, pnlPercent: 50 };
    setActivePositions([positionAtTakeProfit]);

    const sellResult = await executeSell(positionAtTakeProfit, "TAKE_PROFIT");
    assert.equal(sellResult.success, true);
    assert.ok(sellResult.txSignature?.startsWith("DRYRUN-"));

    const afterSellBalance = await getBalance();
    assert.equal(afterSellBalance, 5.5);
    assert.equal(getActivePositions().length, 0);
  } finally {
    setActivePositions([]);
    CONFIG.dryRun = originalDryRun;
    CONFIG.paperStartingBalanceSol = originalPaperBalance;
    CONFIG.solanaRpcUrl = originalRpcUrl;
  }
});

test("dry-run buy rejects when simulated balance is insufficient", async () => {
  const originalDryRun = CONFIG.dryRun;
  const originalPaperBalance = CONFIG.paperStartingBalanceSol;

  CONFIG.dryRun = true;
  CONFIG.paperStartingBalanceSol = 0.05;

  try {
    setActivePositions([]);
    initTrader();

    const signal = makeSignal({ positionSizeSol: 1 });
    const buyResult = await executeBuy(signal);

    assert.equal(buyResult.success, false);
    assert.match(buyResult.error ?? "", /Insufficient balance/);
    assert.equal(getActivePositions().length, 0);
  } finally {
    setActivePositions([]);
    CONFIG.dryRun = originalDryRun;
    CONFIG.paperStartingBalanceSol = originalPaperBalance;
  }
});
