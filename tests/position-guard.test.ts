import test from "node:test";
import assert from "node:assert/strict";
import {
  reconcilePositions,
  canReenter,
  recordExit,
  pruneExits,
  DEFAULT_REENTRY,
  recordBuy,
  buyCountFor,
  exceedsMaxBuys,
  type RecentExit,
  type TokenBuyCount,
} from "../src/position-guard.js";

const MINUTE = 60_000;
const NOW = 1_757_260_000_000;

const pos = (symbol: string, tokenAddress: string) => ({ tokenSymbol: symbol, tokenAddress });

/* ----------------------------- reconciliation ----------------------------- */

test("positions the wallet still holds are kept", () => {
  const { keep, drop } = reconcilePositions(
    [pos("KEEP", "mintA"), pos("ALSO", "mintB")],
    [
      { mint: "mintA", amount: 1000 },
      { mint: "mintB", amount: 0.5 },
    ]
  );
  assert.equal(keep.length, 2);
  assert.equal(drop.length, 0);
});

test("phantom positions are dropped — the wallet is the authority", () => {
  const { keep, drop } = reconcilePositions(
    [pos("REAL", "mintA"), pos("PHANTOM", "mintGone")],
    [{ mint: "mintA", amount: 10 }]
  );
  assert.deepEqual(
    keep.map((p) => p.tokenSymbol),
    ["REAL"]
  );
  assert.deepEqual(
    drop.map((p) => p.tokenSymbol),
    ["PHANTOM"]
  );
});

test("a zero-balance token account counts as not held", () => {
  // Selling leaves the account behind with a zero balance; treating that as
  // held would keep exactly the phantom this check exists to remove.
  const { drop } = reconcilePositions([pos("SOLD", "mintA")], [{ mint: "mintA", amount: 0 }]);
  assert.equal(drop.length, 1);
});

test("an empty wallet drops everything — callers must not pass a failed lookup", () => {
  const { keep, drop } = reconcilePositions([pos("A", "m1"), pos("B", "m2")], []);
  assert.equal(keep.length, 0);
  assert.equal(drop.length, 2);
});

test("the observed incident: three positions, wallet holds none", () => {
  const { keep, drop } = reconcilePositions(
    [pos("zcatfone", "FZpn"), pos("TRONK", "CTAL"), pos("ULCAT", "Y8ky")],
    []
  );
  assert.equal(keep.length, 0, "none are backed by the wallet");
  assert.equal(drop.length, 3, "all three would have been dropped instead of looping");
});

/* ------------------------------- re-entry -------------------------------- */

const exitedAt = (minutesAgo: number, wasLoss = true): RecentExit => ({
  tokenAddress: "mintX",
  tokenSymbol: "TRONK",
  exitedAt: NOW - minutesAgo * MINUTE,
  wasLoss,
});

test("a token never traded may be entered", () => {
  assert.equal(canReenter("mintNew", [], NOW).allowed, true);
});

test("a token exited inside the cooldown is blocked", () => {
  const v = canReenter("mintX", [exitedAt(5)], NOW);
  assert.equal(v.allowed, false);
  assert.match(v.reason ?? "", /cooldown left/);
});

test("the cooldown expires", () => {
  assert.equal(canReenter("mintX", [exitedAt(61)], NOW).allowed, true);
});

test("the re-buy incident: exited seconds ago, re-entry refused", () => {
  // TRONK and ULCAT were both re-bought within 10 seconds of a restart.
  const v = canReenter("mintX", [exitedAt(0.16)], NOW);
  assert.equal(v.allowed, false);
});

test("blockLosersForRun keeps a losing token blocked past the cooldown", () => {
  const cfg = { ...DEFAULT_REENTRY, blockLosersForRun: true };
  const loss = canReenter("mintX", [exitedAt(600, true)], NOW, cfg);
  assert.equal(loss.allowed, false);
  assert.match(loss.reason ?? "", /exited at a loss/);

  const win = canReenter("mintX", [exitedAt(600, false)], NOW, cfg);
  assert.equal(win.allowed, true, "a profitable exit is only time-limited");
});

test("a zero cooldown allows immediate re-entry", () => {
  const cfg = { cooldownMinutes: 0, blockLosersForRun: false };
  assert.equal(canReenter("mintX", [exitedAt(0)], NOW, cfg).allowed, true);
});

test("the most recent exit governs", () => {
  const exits: RecentExit[] = [exitedAt(600), { ...exitedAt(2), wasLoss: false }];
  assert.equal(canReenter("mintX", exits, NOW).allowed, false, "the 2-minute-old exit wins");
});

test("recordExit replaces the previous record rather than appending forever", () => {
  let exits: RecentExit[] = [];
  for (let i = 0; i < 5; i++) {
    exits = recordExit(exits, { ...exitedAt(1), exitedAt: NOW + i });
  }
  assert.equal(exits.length, 1);
  assert.equal(exits[0].exitedAt, NOW + 4, "keeps the newest");
});

test("pruneExits drops records that can no longer block anything", () => {
  const exits = [exitedAt(5), { ...exitedAt(500), tokenAddress: "old" }];
  assert.equal(pruneExits(exits, NOW).length, 1);
});

test("pruneExits keeps losses for the whole run when configured", () => {
  const cfg = { ...DEFAULT_REENTRY, blockLosersForRun: true };
  const exits = [{ ...exitedAt(5000, true), tokenAddress: "loser" }];
  assert.equal(pruneExits(exits, NOW, cfg).length, 1, "an old loss must survive pruning");
});

/* ------------------------------ max buy count ----------------------------- */

// Real incident, 2026-09-09: CARDCAT was bought 10 times in one session. A
// cooldown only ever delays a re-entry; nothing previously counted it.
test("a token never bought has a count of 0", () => {
  assert.equal(buyCountFor([], "A"), 0);
});

test("recordBuy starts a new token at 1 and increments an existing one", () => {
  let counts: TokenBuyCount[] = [];
  counts = recordBuy(counts, "A", "CARDCAT");
  assert.equal(buyCountFor(counts, "A"), 1);
  counts = recordBuy(counts, "A", "CARDCAT");
  counts = recordBuy(counts, "A", "CARDCAT");
  assert.equal(buyCountFor(counts, "A"), 3);
});

test("recordBuy tracks each token independently", () => {
  let counts: TokenBuyCount[] = [];
  counts = recordBuy(counts, "A", "CARDCAT");
  counts = recordBuy(counts, "B", "Laptop");
  counts = recordBuy(counts, "A", "CARDCAT");
  assert.equal(buyCountFor(counts, "A"), 2);
  assert.equal(buyCountFor(counts, "B"), 1);
});

test("exceedsMaxBuys blocks at the cap, boundary inclusive", () => {
  let counts: TokenBuyCount[] = [];
  counts = recordBuy(counts, "A", "CARDCAT");
  counts = recordBuy(counts, "A", "CARDCAT");
  assert.equal(exceedsMaxBuys(counts, "A", 3), false, "2 buys so far, cap is 3: still allowed");
  counts = recordBuy(counts, "A", "CARDCAT");
  assert.equal(exceedsMaxBuys(counts, "A", 3), true, "3rd buy recorded: the 4th is blocked");
});

test("a maxBuys of 0 disables the check entirely", () => {
  let counts: TokenBuyCount[] = [];
  for (let i = 0; i < 50; i++) counts = recordBuy(counts, "A", "CARDCAT");
  assert.equal(exceedsMaxBuys(counts, "A", 0), false);
});

test("a token never bought never exceeds any cap", () => {
  assert.equal(exceedsMaxBuys([], "A", 3), false);
});
