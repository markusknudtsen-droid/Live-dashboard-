import assert from "node:assert/strict";
import { test } from "node:test";
import { addDevTrade, parseDevLedger, summariseDevTrades, type DevLedger } from "../src/dev-trade-ledger.js";

const trade = (pnlPercent: number, at = 1) => ({ mint: `m${at}`, symbol: "AAA", pnlPercent, at });

test("summary counts wins and averages pnl", () => {
  const s = summariseDevTrades([trade(50), trade(-20), trade(0)]);
  assert.deepEqual(s, { trades: 3, wins: 1, avgPnlPercent: 10 });
});

test("unknown creator has no summary", () => {
  assert.equal(summariseDevTrades(undefined), undefined);
  assert.equal(summariseDevTrades([]), undefined);
});

test("addDevTrade keeps only the newest 20 per creator and does not mutate", () => {
  let ledger: DevLedger = {};
  const first = addDevTrade(ledger, "C1", trade(1, 0));
  assert.deepEqual(ledger, {});
  ledger = first;
  for (let i = 1; i < 30; i++) ledger = addDevTrade(ledger, "C1", trade(i, i));
  assert.equal(ledger.C1.length, 20);
  assert.equal(ledger.C1[19].at, 29);
});

test("parseDevLedger drops malformed entries and survives junk", () => {
  assert.deepEqual(parseDevLedger("not json"), {});
  const parsed = parseDevLedger(JSON.stringify({ C1: [trade(5), { mint: 1 }], C2: "x" }));
  assert.deepEqual(Object.keys(parsed), ["C1"]);
  assert.equal(parsed.C1.length, 1);
});
