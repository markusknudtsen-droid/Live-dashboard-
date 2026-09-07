import test from "node:test";
import assert from "node:assert/strict";
import { updateTrailingStop } from "../src/trailing-stop.js";
import { buildConfig } from "../src/config.js";

/**
 * The exit decision lives in trader.ts, welded to the network and the trade
 * lock. Mirrored here so the rule itself is pinned: with the trail armed and
 * LET_WINNERS_RUN on, the fixed take-profit must not close the position, while
 * the stop-loss always may.
 */
function chooseExit(opts: {
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailArmed: boolean;
  letWinnersRun: boolean;
}): "STOP_LOSS" | "TAKE_PROFIT" | null {
  const defer = opts.letWinnersRun && opts.trailArmed;
  if (opts.currentPrice <= opts.stopLoss) return "STOP_LOSS";
  if (!defer && opts.currentPrice >= opts.takeProfit) return "TAKE_PROFIT";
  return null;
}

test("today's behaviour: a fixed take-profit closes a running position", () => {
  const exit = chooseExit({
    currentPrice: 152.9,
    stopLoss: 137.61,
    takeProfit: 150,
    trailArmed: true,
    letWinnersRun: false,
  });
  assert.equal(exit, "TAKE_PROFIT", "this is the OTC exit at +52.90%");
});

test("with LET_WINNERS_RUN the armed trail keeps the position open past the target", () => {
  const exit = chooseExit({
    currentPrice: 152.9,
    stopLoss: 137.61,
    takeProfit: 150,
    trailArmed: true,
    letWinnersRun: true,
  });
  assert.equal(exit, null, "OTC would have kept running");
});

test("the stop-loss is never deferred — downside is always capped", () => {
  const exit = chooseExit({
    currentPrice: 137.0,
    stopLoss: 137.61,
    takeProfit: 150,
    trailArmed: true,
    letWinnersRun: true,
  });
  assert.equal(exit, "STOP_LOSS");
});

test("an unarmed trail leaves the fixed take-profit in force", () => {
  // A position that gapped straight past the target without the trail arming
  // still needs an exit; deferring to a trail that is not managing anything
  // would leave it unprotected.
  const exit = chooseExit({
    currentPrice: 155,
    stopLoss: 67,
    takeProfit: 150,
    trailArmed: false,
    letWinnersRun: true,
  });
  assert.equal(exit, "TAKE_PROFIT");
});

test("the armed trail still exits once momentum breaks", () => {
  // Ran to 200, trail 10% below peak = 180, price falls back to 179.
  const trail = updateTrailingStop({
    entryPrice: 100,
    currentPrice: 200,
    peakPrice: undefined,
    currentStopLoss: 137.61,
    activateAtPercent: 15,
    distancePercent: 10,
  });
  assert.equal(trail.stopLoss, 180);
  const exit = chooseExit({
    currentPrice: 179,
    stopLoss: trail.stopLoss,
    takeProfit: 150,
    trailArmed: true,
    letWinnersRun: true,
  });
  assert.equal(exit, "STOP_LOSS", "exits at +80% instead of the +50% target");
});

test("LET_WINNERS_RUN defaults off, so existing behaviour is unchanged", () => {
  assert.equal(buildConfig({}).letWinnersRun, false);
  assert.equal(buildConfig({ LET_WINNERS_RUN: "true" }).letWinnersRun, true);
});
