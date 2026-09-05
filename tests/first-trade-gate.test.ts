import test from "node:test";
import assert from "node:assert/strict";
import {
  describeGateState,
  maxNewEntries,
  resolveFirstTradeValidation,
  shouldSkipNewEntries,
} from "../src/first-trade-gate.js";

test("shouldSkipNewEntries: gate=null with no open positions allows the validation trade", () => {
  assert.equal(shouldSkipNewEntries(null, 0).skip, false);
});

test("shouldSkipNewEntries: gate=null with a pending validation trade blocks more entries", () => {
  const decision = shouldSkipNewEntries(null, 1);
  assert.equal(decision.skip, true);
  assert.match(decision.reason ?? "", /waiting/i);
});

test("shouldSkipNewEntries: gate=false blocks entries indefinitely", () => {
  const decision = shouldSkipNewEntries(false, 0);
  assert.equal(decision.skip, true);
  assert.match(decision.reason ?? "", /not profitable/i);
});

test("shouldSkipNewEntries: gate=true never blocks (normal trading resumed)", () => {
  assert.equal(shouldSkipNewEntries(true, 0).skip, false);
  assert.equal(shouldSkipNewEntries(true, 2).skip, false);
});

test("maxNewEntries: gate=null with 0 open positions allows exactly one (the validation trade)", () => {
  assert.equal(maxNewEntries(null, 3, 0), 1);
});

test("maxNewEntries: gate=true behaves like normal maxConcurrentPositions math", () => {
  assert.equal(maxNewEntries(true, 3, 0), 3);
  assert.equal(maxNewEntries(true, 3, 2), 1);
  assert.equal(maxNewEntries(true, 3, 3), 0);
});

test("maxNewEntries: gate=false allows zero new entries", () => {
  assert.equal(maxNewEntries(false, 3, 0), 0);
});

test("resolveFirstTradeValidation: a BUY event never resolves the gate", () => {
  assert.equal(resolveFirstTradeValidation({ type: "BUY" }, null), null);
});

test("resolveFirstTradeValidation: a profitable SELL passes the gate", () => {
  assert.equal(resolveFirstTradeValidation({ type: "SELL", pnlPercent: 12.5 }, null), true);
});

test("resolveFirstTradeValidation: a break-even or losing SELL fails the gate", () => {
  assert.equal(resolveFirstTradeValidation({ type: "SELL", pnlPercent: 0 }, null), false);
  assert.equal(resolveFirstTradeValidation({ type: "SELL", pnlPercent: -33 }, null), false);
});

test("resolveFirstTradeValidation: a missing pnlPercent is treated as non-positive (fails safe)", () => {
  assert.equal(resolveFirstTradeValidation({ type: "SELL" }, null), false);
});

test("resolveFirstTradeValidation: once resolved, later SELLs never change the gate", () => {
  assert.equal(resolveFirstTradeValidation({ type: "SELL", pnlPercent: -50 }, true), true);
  assert.equal(resolveFirstTradeValidation({ type: "SELL", pnlPercent: 50 }, false), false);
});

test("describeGateState: human-readable summaries", () => {
  assert.match(describeGateState(null), /awaiting/i);
  assert.match(describeGateState(true), /passed/i);
  assert.match(describeGateState(false), /FAILED/);
});
