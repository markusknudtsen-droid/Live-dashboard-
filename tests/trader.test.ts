import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// Enable DRY_RUN before the config module is first loaded. In dry-run no
// SOLANA_PRIVATE_KEY is required; OPENROUTER_API_KEY is only set so building the
// config succeeds (these tests never call the AI analyzer).
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";

type TradeSignalT = import("../src/analyze.js").TradeSignal;
type TokenCandidateT = import("../src/scanner.js").TokenCandidate;

const {
  initTrader,
  getBalance,
  executeBuy,
  executeSell,
  evaluatePositionAtPrice,
  getActivePositions,
  getWalletAddress,
  setActivePositions,
  setTradeListener,
  MAX_CONCURRENT_POSITIONS,
} = await import("../src/trader.js");
type TradeEventT = import("../src/trader.js").TradeEvent;

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function makeSignal(overrides: Partial<TokenCandidateT> = {}): TradeSignalT {
  const token: TokenCandidateT = {
    address: MINT,
    symbol: "BONK",
    name: "Bonk",
    chainId: "solana",
    pairAddress: "pair1",
    priceUsd: 0.00002,
    priceChange5m: 1,
    priceChange1h: 5,
    priceChange6h: 10,
    priceChange24h: 20,
    volume24h: 1_000_000,
    volumeChange: 0,
    liquidityUsd: 500_000,
    marketCap: 100_000_000,
    txns24hBuys: 800,
    txns24hSells: 200,
    buyToSellRatio: 0.8,
    pairCreatedAt: Date.now() - 3_600_000,
    ageHours: 1,
    url: "https://dexscreener.com/solana/pair1",
    ...overrides,
  };
  return {
    token,
    confidence: 88,
    action: "BUY",
    reasoning: "test",
    entryPrice: token.priceUsd,
    stopLoss: token.priceUsd * 0.85,
    takeProfit: token.priceUsd * 1.5,
    positionSizeSol: 0.2,
    riskRewardRatio: 3,
    trendStrength: "strong_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "dog",
  };
}

// The trader keeps module-level state (wallet, paper balance, positions,
// listener). Reset it before every test so the suite is order-independent and
// individual tests can be run in isolation.
beforeEach(() => {
  initTrader();
  setActivePositions([]);
  setTradeListener(null);
});

test("DRY_RUN: initTrader creates a paper wallet with the fake starting balance and no private key", async () => {
  const { publicKey } = initTrader();
  assert.ok(publicKey.length > 30, "paper wallet has a public address");
  assert.equal(await getBalance(), 5, "paper balance equals PAPER_STARTING_BALANCE_SOL");
  setActivePositions([]);
});

test("DRY_RUN: a simulated buy debits the paper wallet and opens a position with a fake tx", async () => {
  setActivePositions([]);
  const before = await getBalance();
  const result = await executeBuy(makeSignal());
  assert.equal(result.success, true);
  assert.ok(result.txSignature?.startsWith("DRYRUN-"), "buy uses a simulated DRYRUN tx signature");
  assert.equal(await getBalance(), before - 0.2, "buy debits exactly the position size");
  assert.equal(getActivePositions().length, 1, "one open position after buy");
});

test("DRY_RUN: take-profit exit sells and settles proceeds back to the same wallet", async () => {
  setActivePositions([]);
  const walletAddr = getWalletAddress();
  const before = await getBalance();
  await executeBuy(makeSignal());
  const afterBuy = await getBalance();
  assert.ok(afterBuy < before);

  const position = getActivePositions()[0];
  // Price rips +60%, above the +50% take-profit level -> auto sell.
  await evaluatePositionAtPrice(position, position.entryPrice * 1.6);

  assert.equal(getActivePositions().length, 0, "position closed after take-profit");
  const after = await getBalance();
  // Proceeds = 0.2 * (1 + 0.60) = 0.32, so net vs the pre-buy balance is +0.12.
  assert.ok(Math.abs(after - (before + 0.12)) < 1e-9, "profit settled back to the wallet");
  assert.equal(getWalletAddress(), walletAddr, "wallet address never changes on a trade");
});

test("DRY_RUN: stop-loss exit sells at a loss but still returns proceeds to the same wallet", async () => {
  setActivePositions([]);
  const before = await getBalance();
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  // Price drops -20%, below the -15% stop-loss level -> auto sell.
  await evaluatePositionAtPrice(position, position.entryPrice * 0.8);

  assert.equal(getActivePositions().length, 0, "position closed after stop-loss");
  const after = await getBalance();
  // Proceeds = 0.2 * (1 - 0.20) = 0.16, so net vs the pre-buy balance is -0.04.
  assert.ok(Math.abs(after - (before - 0.04)) < 1e-9, "loss-adjusted proceeds settled back to the wallet");
});

test("DRY_RUN: a manual sell of an open position credits the paper wallet", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  const before = await getBalance();
  const result = await executeSell(position, "MANUAL");
  assert.equal(result.success, true);
  assert.ok(result.txSignature?.startsWith("DRYRUN-"));
  assert.ok((await getBalance()) > before, "manual sell returns funds to the wallet");
  assert.equal(getActivePositions().length, 0);
});

test("DRY_RUN: a paper buy for the entire balance succeeds (no fee buffer reserved)", async () => {
  setActivePositions([]);
  const balance = await getBalance(); // 5 paper SOL
  const result = await executeBuy({ ...makeSignal(), positionSizeSol: balance });
  assert.equal(result.success, true, "buying the full paper balance is allowed in dry-run");
  assert.equal(await getBalance(), 0);
});

test("evaluatePositionAtPrice ignores a position with an invalid entry price", async () => {
  setActivePositions([
    {
      tokenAddress: MINT,
      tokenSymbol: "BONK",
      chainId: "solana",
      entryPrice: 0, // corrupt/rehydrated position
      currentPrice: 0,
      amountSol: 0.2,
      stopLoss: 0,
      takeProfit: 0,
      entryTime: Date.now(),
      pnlPercent: 0,
      txSignature: "DRYRUN-x",
    },
  ]);
  const position = getActivePositions()[0];
  await assert.doesNotReject(() => evaluatePositionAtPrice(position, 0.00005));
  assert.equal(getActivePositions().length, 1, "no sell is triggered");
  assert.equal(Number.isNaN(getActivePositions()[0].pnlPercent), false, "PnL is not NaN");
});

test("DRY_RUN: a corrupted PnL below -100% cannot drive the paper balance negative", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  // Simulate a corrupted/rehydrated PnL: worse than a total loss.
  position.pnlPercent = -250;
  const before = await getBalance();
  const result = await executeSell(position, "MANUAL");
  assert.equal(result.success, true);
  const after = await getBalance();
  assert.equal(after, before, "proceeds are floored at 0 (PnL clamped to -100%)");
  assert.ok(after >= 0, "paper balance never goes negative");
});

test("a rejecting async trade listener never breaks the trade or the process", async () => {
  setActivePositions([]);
  setTradeListener(async () => {
    throw new Error("listener boom");
  });
  const result = await executeBuy(makeSignal());
  setTradeListener(null);
  assert.equal(result.success, true, "the buy still succeeds");
  assert.equal(getActivePositions().length, 1, "the position is still opened");
  // Let the rejected listener promise settle; an unhandled rejection here
  // would fail the test process.
  await new Promise((r) => setImmediate(r));
});

test("a registered trade listener receives BUY then SELL events for reporting", async () => {
  setActivePositions([]);
  const events: TradeEventT[] = [];
  setTradeListener((e) => events.push(e));

  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  await evaluatePositionAtPrice(position, position.entryPrice * 1.6); // take-profit -> sell

  setTradeListener(null);

  assert.equal(events.length, 2, "one BUY and one SELL emitted");
  assert.equal(events[0].type, "BUY");
  assert.equal(events[0].paper, true);
  assert.equal(events[0].confidence, 88);
  assert.equal(events[1].type, "SELL");
  assert.equal(events[1].reason, "TAKE_PROFIT");
  assert.ok((events[1].pnlPercent ?? 0) > 0, "sell event carries positive PnL");
  assert.ok(events[1].txSignature.startsWith("DRYRUN-"));
});

// index.ts runs the scan/analyze/buy cycle and position monitoring (which
// calls executeSell) on two independent schedules with no guard between
// them — only a trader-level lock inside executeBuy/executeSell can prevent
// them from interleaving. executeBuy has a real await point (getBalance())
// before it mutates state, but executeSell's DRY_RUN path has none — so
// without the lock, firing both without awaiting the first lets the sell's
// synchronous body run to completion (and emit its event) *before* the
// buy's continuation ever resumes, even though the buy was invoked first.
// That's the exact race: an operation invoked later completes and mutates
// shared state before an earlier, already-in-flight one does. With the
// lock, executeBuy claims it before yielding at getBalance(), so the sell
// queues behind it and both fire in call order.
test("executeBuy and executeSell fired without awaiting the first are serialized in call order, not interleaved", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const existingPosition = getActivePositions()[0];

  const events: TradeEventT[] = [];
  setTradeListener((e) => events.push(e));

  const buyPromise = executeBuy(makeSignal());
  const sellPromise = executeSell(existingPosition, "MANUAL");
  const [buyResult, sellResult] = await Promise.all([buyPromise, sellPromise]);

  setTradeListener(null);

  assert.equal(buyResult.success, true);
  assert.equal(sellResult.success, true);
  assert.equal(events.length, 2, "one BUY and one SELL emitted");
  assert.equal(events[0].type, "BUY", "the earlier-invoked buy must complete first, not be pre-empted by the sell");
  assert.equal(events[1].type, "SELL");
});

// The trader lock only serializes execution — it doesn't stop two callers
// from resolving the SAME still-open position (e.g. via a lookup like
// getActivePositions().find(), the way mcp-server.ts's memebot_paper_sell
// tool does) before either of them calls executeSell. Without a post-lock
// membership re-check, the second, stale call would settle the same
// position a second time — crediting the paper wallet twice for one close.
test("two concurrent executeSell calls for the same position settle it only once", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  const balanceBeforeSell = await getBalance();

  // Simulate two callers that both resolved the same position reference
  // before either reached executeSell (as two overlapping MCP tool calls
  // for the same token_address would), by calling it twice with the same
  // object without awaiting the first.
  const [first, second] = await Promise.all([
    executeSell(position, "MANUAL"),
    executeSell(position, "MANUAL"),
  ]);

  const results = [first, second];
  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);
  assert.equal(successes.length, 1, "exactly one of the two duplicate calls actually settles the position");
  assert.equal(failures.length, 1, "the other is rejected as a stale/duplicate request");
  assert.match(failures[0].error ?? "", /already closed/i);

  assert.equal(getActivePositions().length, 0, "the position is removed exactly once");
  const expectedProceeds = position.amountSol * (1 + position.pnlPercent / 100);
  const balanceAfterSell = await getBalance();
  assert.ok(
    Math.abs(balanceAfterSell - (balanceBeforeSell + expectedProceeds)) < 1e-9,
    "the paper wallet is credited exactly once, not twice"
  );
});

// Callers (index.ts's runCycle, mcp-server.ts's memebot_paper_buy) each
// check activePositions.length against MAX_CONCURRENT_POSITIONS before ever
// calling executeBuy, but that check happens outside the trader lock —
// concurrent callers (overlapping MCP tool calls, in particular) can all
// pass it before any of them has actually opened a position. Only a
// re-check made after acquiring the lock is atomic with the buy itself.
test("concurrent executeBuy calls never open more than MAX_CONCURRENT_POSITIONS positions", async () => {
  setActivePositions([]);

  // Fire more buys than the limit allows, all "concurrently" (without
  // awaiting any of them first) — simulating overlapping MCP tool calls
  // that each independently saw room before any of them actually bought.
  const attempts = MAX_CONCURRENT_POSITIONS + 2;
  const results = await Promise.all(Array.from({ length: attempts }, () => executeBuy(makeSignal())));

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);
  assert.equal(successes.length, MAX_CONCURRENT_POSITIONS, "exactly the limit's worth of buys succeed");
  assert.equal(failures.length, attempts - MAX_CONCURRENT_POSITIONS, "the rest are rejected");
  for (const failure of failures) {
    assert.match(failure.error ?? "", /Max concurrent positions/);
  }
  assert.equal(getActivePositions().length, MAX_CONCURRENT_POSITIONS, "the open-position count never exceeds the limit");
});

// executeSell's markPriceUsd parameter marks the position to a caller-given
// exit price INSIDE the lock, atomically with settlement — mcp-server.ts's
// memebot_paper_sell tool used to mutate position.currentPrice/pnlPercent
// itself, outside the lock, before calling executeSell. Two concurrent
// calls for the same position with different prices shared that one
// mutable object: whichever call's mutation landed last (not necessarily
// the one that reached the lock first) is what the first call's queued
// settlement would have used, silently settling it at a price it never
// reported back to its caller.
test("a duplicate concurrent sell with a different price cannot change what the first sell actually settles at", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal()); // entryPrice = 0.00002 (see makeSignal)
  const position = getActivePositions()[0];

  const priceUp = position.entryPrice * 1.5; // +50%
  const priceDown = position.entryPrice * 0.5; // -50%

  const [first, second] = await Promise.all([
    executeSell(position, "MANUAL", priceUp),
    executeSell(position, "MANUAL", priceDown),
  ]);

  const successes = [first, second].filter((r) => r.success);
  const failures = [first, second].filter((r) => !r.success);
  assert.equal(successes.length, 1, "only the first-queued call actually settles");
  assert.equal(failures.length, 1, "the second is rejected as a stale duplicate, its price never applied");
  assert.match(failures[0].error ?? "", /already closed/i);

  // The one call that settled must have used ITS OWN price (+50%, since it
  // was invoked — and so queued — first), never the other call's -50%.
  assert.ok(Math.abs((successes[0].pnlPercent ?? 0) - 50) < 1e-6, "settled PnL matches the first call's own price, not the second's");
});

// evaluatePositionAtPrice() (used by monitorPositions() and
// mcp-server.ts's memebot_check_exits) mutates position.currentPrice/
// pnlPercent itself, same as memebot_paper_sell used to, before ever
// reaching executeSell. Two concurrent evaluations of the SAME position —
// e.g. two overlapping memebot_check_exits calls covering the same token —
// both mutate that shared object; without passing each call's own price
// through as executeSell's markPriceUsd, the call that actually wins the
// lock and settles could still use whatever price the OTHER, later
// call's mutation left behind, mislabeling the exit reason/PnL.
test("concurrent evaluatePositionAtPrice calls settle at the winning call's own price, not the other's", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal()); // entryPrice = 0.00002, stopLoss = *0.85, takeProfit = *1.5
  const position = getActivePositions()[0];

  const events: TradeEventT[] = [];
  setTradeListener((e) => events.push(e));

  // Both prices independently trigger an exit — a take-profit and a
  // stop-loss — so whichever call is rejected as a stale duplicate would,
  // pre-fix, still have been able to leave its price behind for the
  // winner to settle at.
  const takeProfitPrice = position.entryPrice * 1.6; // +60%, past the +50% take-profit level
  const stopLossPrice = position.entryPrice * 0.5; // -50%, past the -15% stop-loss level

  await Promise.all([
    evaluatePositionAtPrice(position, takeProfitPrice),
    evaluatePositionAtPrice(position, stopLossPrice),
  ]);

  setTradeListener(null);

  assert.equal(events.length, 1, "only the first-invoked (lock-winning) evaluation actually settles");
  assert.equal(events[0].type, "SELL");
  assert.equal(events[0].reason, "TAKE_PROFIT", "settled under the first call's own exit reason");
  assert.ok(Math.abs((events[0].pnlPercent ?? 0) - 60) < 1e-6, "settled PnL matches the first call's own price, not the second's");
});

// scheduleNextTraderTask() checks sellQueue before buyQueue, so a queued
// sell always runs before an earlier-queued buy once the lock frees up —
// exits are safety-critical and shouldn't wait behind a merely-queued buy.
// The "fired without awaiting the first" test above only exercises the
// empty-queue case (one buy acquiring a free lock before a sell is even
// queued); this exercises the actual priority ordering: hold the lock with
// one buy, queue a second buy first and a sell second behind it, and
// confirm the sell still executes before that second buy despite being
// queued later.
test("a queued sell runs before an earlier-queued buy once the lock frees up", async () => {
  setActivePositions([]);
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];

  const events: TradeEventT[] = [];
  setTradeListener((e) => events.push(e));

  const buy1 = executeBuy(makeSignal()); // acquires the free lock first
  const buy2 = executeBuy(makeSignal()); // queued behind buy1, in buyQueue
  const sell = executeSell(position, "MANUAL"); // queued behind buy1 too, but in sellQueue — invoked AFTER buy2

  const [buy1Result, buy2Result, sellResult] = await Promise.all([buy1, buy2, sell]);

  setTradeListener(null);

  assert.equal(buy1Result.success, true);
  assert.equal(buy2Result.success, true);
  assert.equal(sellResult.success, true);
  assert.equal(events.length, 3, "one BUY, one SELL, one BUY");
  assert.equal(events[0].type, "BUY", "buy1, already holding the lock, settles first");
  assert.equal(events[1].type, "SELL", "the queued sell runs before buy2, despite being invoked/queued later");
  assert.equal(events[2].type, "BUY", "buy2 only runs once the higher-priority sell ahead of it releases the lock");
});

// The bug this feature closes: "Already in position for X, skipping." was
// unconditional in index.ts - no signal, however bullish, could ever top up a
// held position. executeAddOn is the mechanics half of the fix.
test("executeAddOn tops up a held position: sums SOL, blends the entry price, re-anchors stop/take-profit", async () => {
  const { executeAddOn } = await import("../src/trader.js");

  await executeBuy(makeSignal()); // entryPrice 0.00002, 0.2 SOL
  const position = getActivePositions()[0];

  // The operator's own example: down 18% from entry.
  const dipPrice = position.entryPrice * 0.82;
  const addOnSignal = makeSignal({ priceUsd: dipPrice });
  const result = await executeAddOn(position, addOnSignal, 0.05);

  assert.equal(result.success, true);
  assert.equal(position.amountSol, 0.25, "0.2 original + 0.05 add-on");
  assert.equal(position.addOnTaken, true);

  // Weighted average: 0.2 SOL-worth at the original price, 0.05 SOL-worth at
  // the dip price (DRY_RUN has no real token quantity, so quantity is SOL/price).
  const oldQty = 0.2 / 0.00002;
  const newQty = 0.05 / dipPrice;
  const expectedEntry = (oldQty * 0.00002 + newQty * dipPrice) / (oldQty + newQty);
  assert.ok(Math.abs(position.entryPrice - expectedEntry) < 1e-12, "entry price is the SOL-weighted average, not a simple average");
  assert.ok(position.entryPrice < 0.00002, "blended entry must move toward the dip, not stay at the original price");
  assert.ok(position.entryPrice > dipPrice, "blended entry must not fall all the way to the dip price either");

  // Levels re-derived from the NEW entry, not carried over stale from the
  // original buy - same principle as the fill-price re-anchoring fix.
  assert.ok(Math.abs(position.stopLoss - position.entryPrice * 0.67) < 1e-9);
  assert.ok(Math.abs(position.takeProfit - position.entryPrice * 1.5) < 1e-9);
});

test("executeAddOn refuses a second add-on on the same position", async () => {
  const { executeAddOn } = await import("../src/trader.js");
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];

  const first = await executeAddOn(position, makeSignal(), 0.05);
  assert.equal(first.success, true);

  const second = await executeAddOn(position, makeSignal(), 0.05);
  assert.equal(second.success, false);
  assert.match(second.error!, /already used/i);
  assert.equal(position.amountSol, 0.25, "the refused second attempt must not have added anything");
});

test("executeAddOn refuses to top up a position that already closed", async () => {
  const { executeAddOn } = await import("../src/trader.js");
  await executeBuy(makeSignal());
  const position = getActivePositions()[0];
  await executeSell(position, "TAKE_PROFIT", position.entryPrice * 1.5);

  const result = await executeAddOn(position, makeSignal(), 0.05);
  assert.equal(result.success, false);
  assert.match(result.error!, /already closed/i);
});

test("weightedAverageEntryPrice: a simple worked example", async () => {
  const { weightedAverageEntryPrice } = await import("../src/trader.js");
  // 100 units at $1, then 100 more at $0.50 -> average $0.75, not $1 or $0.50.
  assert.equal(weightedAverageEntryPrice(100, 1, 100, 0.5), 0.75);
  // Buying nothing more must not move the price.
  assert.equal(weightedAverageEntryPrice(100, 1, 0, 999), 1);
  // Zero old quantity (defensive - should not occur in practice) falls back cleanly.
  assert.equal(weightedAverageEntryPrice(0, 1, 100, 2), 2);
});

test("trailIsArmed gates the AI-bearish winner exemption on peak gain, not current price", async () => {
  const { trailIsArmed } = await import("../src/trader.js");
  const { CONFIG } = await import("../src/config.js");
  const arm = CONFIG.trailingStopActivatePercent;

  const at = (entryPrice: number, peakPrice: number) =>
    trailIsArmed({ entryPrice, peakPrice } as Parameters<typeof trailIsArmed>[0]);

  // Below the activation gain the trail has not armed: the AI exit still rules.
  assert.equal(at(1, 1 + (arm / 100) * 0.99), false);
  // Just past the activation gain it arms, so the winner is spared. (Not tested
  // exactly AT the threshold: 1 + 15/100 - 1 is 0.1499...  in binary floating
  // point, so that would assert on float representation, not on behaviour.)
  assert.equal(at(1, 1 + (arm / 100) * 1.01), true);
  // Well past it, obviously armed.
  assert.equal(at(1, 5), true);
  // A never-set peak defaults to entry: not armed.
  assert.equal(trailIsArmed({ entryPrice: 1 } as Parameters<typeof trailIsArmed>[0]), false);
  // Garbage entry price cannot arm the exemption.
  assert.equal(at(0, 100), false);
});
