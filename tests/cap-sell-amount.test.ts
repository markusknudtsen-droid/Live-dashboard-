import test from "node:test";
import assert from "node:assert/strict";

// DRY_RUN doesn't affect capSellAmount (a pure function), but is required for
// the config module trader.ts imports to build without a real private key,
// matching the convention every other trader.ts test file uses.
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";

const { capSellAmount, fullExitSellAmount } = await import("../src/trader.js");

// The bug this guards: executeSellLocked/executeSellPartialLocked read
// getTokenAccountsByOwner and sold the WHOLE wallet balance of the mint, not
// just what the position itself bought. A manually-bought position sharing
// the wallet's mint got swept into the bot's own exit. 2026-09-17, $SOF: the
// bot's stop-loss sold the operator's manually-held tokens along with its own.

test("a manual holding sharing the wallet survives the bot's own sell (the SOF case)", () => {
  // Bot bought 100 tokens; operator separately bought 50 more of the same
  // mint into the same wallet. Wallet now holds 150.
  const walletRaw = 150_000_000n;
  const positionRaw = 100_000_000n;
  assert.equal(
    capSellAmount(walletRaw, positionRaw),
    100_000_000n,
    "must sell only what the bot's position recorded, not the whole wallet"
  );
});

test("selling never exceeds what the wallet actually holds, even if more was recorded", () => {
  // Recorded amount can exceed the live wallet balance if e.g. the operator
  // separately sold some by hand - never request more than exists.
  const walletRaw = 40_000_000n;
  const positionRaw = 100_000_000n;
  assert.equal(capSellAmount(walletRaw, positionRaw), 40_000_000n);
});

test("a position with no recorded amount sells NOTHING — it must not reach for the whole wallet", () => {
  // Fails closed. This wallet is also traded by hand, so an untracked position
  // cannot prove any of the balance is the bot's: returning the wallet total
  // here is how the operator's own $SOF was liquidated (2026-09-17). An
  // unsellable position is loud and fixable; selling someone else's coins is
  // neither.
  assert.equal(capSellAmount(75_000_000n, undefined), 0n);
  // True even when the wallet holds nothing, so the caller sees one consistent
  // "cannot size this sell" answer rather than two different zeroes.
  assert.equal(capSellAmount(0n, undefined), 0n);
});

test("recorded amount exactly matching the wallet balance sells all of it", () => {
  assert.equal(capSellAmount(60_000_000n, 60_000_000n), 60_000_000n);
});

test("a zero recorded amount (fully drawn down by prior partials) sells nothing", () => {
  assert.equal(capSellAmount(60_000_000n, 0n), 0n);
});

/* --------------------------- full exit sweeping --------------------------- */

const TOL = 5; // percent

test("a full exit sweeps the fill overage instead of stranding it as dust", () => {
  // The real case: COPPERCAT recorded ~80,000,000 raw but the fill landed
  // fractionally above the quote, and the old strict cap left 6 tokens behind.
  const recorded = 80_000_000n;
  const wallet = recorded + 6_070n; // ~0.008% over — pure rounding
  assert.equal(fullExitSellAmount(wallet, recorded, TOL), wallet, "must sell the whole balance, leaving nothing");
});

test("a wallet at or below the recorded amount sells everything it has", () => {
  // Nothing to protect: the bot owns all of it, and may own less than it
  // recorded if some was sold elsewhere.
  assert.equal(fullExitSellAmount(40_000_000n, 100_000_000n, TOL), 40_000_000n);
  assert.equal(fullExitSellAmount(60_000_000n, 60_000_000n, TOL), 60_000_000n);
});

test("exactly at the tolerance ceiling still sweeps", () => {
  const recorded = 100_000_000n;
  assert.equal(fullExitSellAmount(105_000_000n, recorded, TOL), 105_000_000n);
});

test("a balance beyond the tolerance is manually-held — sell only the position's share", () => {
  // This is the $SOF protection. A wallet holding far more than this position
  // ever bought means someone bought the same coin by hand.
  const recorded = 100_000_000n;
  assert.equal(fullExitSellAmount(105_000_001n, recorded, TOL), recorded, "just past the ceiling caps");
  assert.equal(fullExitSellAmount(500_000_000n, recorded, TOL), recorded, "a 5x balance is not rounding dust");
});

test("no recorded amount still fails closed on a full exit", () => {
  assert.equal(fullExitSellAmount(75_000_000n, undefined, TOL), 0n);
});

test("zero tolerance restores the strict cap exactly", () => {
  const recorded = 100_000_000n;
  assert.equal(fullExitSellAmount(100_000_001n, recorded, 0), recorded);
  assert.equal(fullExitSellAmount(recorded, recorded, 0), recorded);
});

test("a fractional tolerance percent survives the integer maths", () => {
  // 0.5% of 100_000_000 is 500_000 — a naive BigInt(percent/100) would floor
  // this to zero and silently disable the sweep.
  const recorded = 100_000_000n;
  assert.equal(fullExitSellAmount(100_400_000n, recorded, 0.5), 100_400_000n, "inside 0.5%");
  assert.equal(fullExitSellAmount(100_600_000n, recorded, 0.5), recorded, "outside 0.5%");
});
