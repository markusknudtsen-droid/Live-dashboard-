import test from "node:test";
import assert from "node:assert/strict";
import { canReenter, recordExit, pruneExits, type RecentExit } from "../src/position-guard.js";
import { buildConfig } from "../src/config.js";

const NOW = 1_757_260_000_000;
const STRICT = { cooldownMinutes: 60, blockLosersForRun: true };

/**
 * These pin the behaviour three separate bugs broke today. Each ended the same
 * way — the cooldown had no record of a coin that had just left — so each is
 * expressed as "the record exists and survives", not as a detail of who wrote it.
 */

test("an exit written to state survives a reload and still blocks re-entry", () => {
  // Simulates persist -> process restart -> loadState.
  let exits: RecentExit[] = [];
  exits = recordExit(exits, {
    tokenAddress: "mintVC",
    tokenSymbol: "VC",
    exitedAt: NOW - 60_000,
    wasLoss: true,
  });

  const serialized = JSON.stringify({ recentExits: exits });
  const reloaded = (JSON.parse(serialized).recentExits ?? []) as RecentExit[];

  const verdict = canReenter("mintVC", reloaded, NOW, STRICT);
  assert.equal(verdict.allowed, false, "a loss must stay blocked across a restart");
  assert.match(verdict.reason ?? "", /exited at a loss/);
});

test("an empty recentExits list blocks nothing — the failure mode that let VC back in", () => {
  assert.equal(canReenter("mintVC", [], NOW, STRICT).allowed, true);
});

test("a position abandoned after failed sells is recorded as a loss, not forgotten", () => {
  // The abandon path removes the position; without an exit record the token is
  // buyable again on the very next cycle.
  const exits = recordExit([], {
    tokenAddress: "mintGhost",
    tokenSymbol: "GHOST",
    exitedAt: NOW,
    wasLoss: true,
  });
  assert.equal(canReenter("mintGhost", exits, NOW, STRICT).allowed, false);
});

test("a position found missing mid-run is recorded, closing the manual-sell window", () => {
  const exits = recordExit([], {
    tokenAddress: "mintSoldByHand",
    tokenSymbol: "TESLASS",
    exitedAt: NOW,
    wasLoss: true,
  });
  assert.equal(canReenter("mintSoldByHand", exits, NOW, STRICT).allowed, false);
});

test("non-sale exits survive pruning under block-losers-for-run", () => {
  // Recorded as wasLoss:true precisely so a long-lived run cannot prune them.
  const old = [{ tokenAddress: "m", tokenSymbol: "OLD", exitedAt: NOW - 86_400_000, wasLoss: true }];
  assert.equal(pruneExits(old, NOW, STRICT).length, 1);
});

test("RECONCILE_EVERY_TICKS is configurable with a sane default", () => {
  assert.equal(buildConfig({}).reconcileEveryTicks, 20);
  assert.equal(buildConfig({ RECONCILE_EVERY_TICKS: "5" }).reconcileEveryTicks, 5);
});
