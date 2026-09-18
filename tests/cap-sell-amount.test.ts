import test from "node:test";
import assert from "node:assert/strict";

// DRY_RUN doesn't affect capSellAmount (a pure function), but is required for
// the config module trader.ts imports to build without a real private key,
// matching the convention every other trader.ts test file uses.
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "5";
process.env.OPENROUTER_API_KEY = "test";

const { capSellAmount } = await import("../src/trader.js");

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

test("a position with no recorded amount (persisted before this field existed) falls back to the whole wallet balance", () => {
  assert.equal(capSellAmount(75_000_000n, undefined), 75_000_000n);
});

test("recorded amount exactly matching the wallet balance sells all of it", () => {
  assert.equal(capSellAmount(60_000_000n, 60_000_000n), 60_000_000n);
});

test("a zero recorded amount (fully drawn down by prior partials) sells nothing", () => {
  assert.equal(capSellAmount(60_000_000n, 0n), 0n);
});
