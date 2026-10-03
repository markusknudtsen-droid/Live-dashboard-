import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeTrades, groupStats, parseTrades } from "../scripts/analyze-trades.js";

const L = (t: string, msg: string) => `[2026-09-17T${t}Z] [INFO] ${msg}`;

const LOG = [
  L("00:00:00.000", "🟢 ONLYX: BUY (92%) - Token is extremely fresh (0.4h old) with momentum"),
  L("00:00:05.000", "🛒 Executing BUY: ONLYX"),
  L("00:10:00.000", "💸 Executing SELL: ONLYX (STOP_LOSS)"),
  L("00:10:00.001", "PnL: -33.00%"),
  L("00:20:00.000", "🟢 FAIL: BUY (88%) - Token is fresh (3h old)"),
  L("00:20:01.000", "🛒 Executing BUY: FAIL"),
  L("00:20:01.100", "❌ Instant buy failed: Insufficient balance"),
  L("00:30:00.000", "💸 Executing SELL: FAIL (AI_BEARISH)"),
  L("00:30:00.001", "PnL: +5.00%"),
  "not a log line",
];

test("parseTrades joins sell to its entry signal and holds, and ignores failed buys as entries", () => {
  const [a, b] = parseTrades(LOG);
  assert.equal(a.symbol, "ONLYX");
  assert.equal(a.pnl, -33);
  assert.equal(a.reason, "STOP_LOSS");
  assert.equal(a.confidence, 92);
  assert.equal(a.ageHours, 0.4);
  assert.equal((a.exitAt - (a.entryAt as number)) / 60_000, 9 + 55 / 60);
  assert.equal(b.entryAt, undefined, "a failed buy never became an entry");
  assert.equal(b.confidence, undefined);
});

test("a symbol sold again with no new buy is a retry loop, not a trade", () => {
  const skipped = { repeatSells: 0 };
  const lines = [
    L("00:00:00.000", "🛒 Executing BUY: LOOP"),
    ...[1, 2, 3].flatMap((i) => [
      L(`00:0${i}:00.000`, "💸 Executing SELL: LOOP (LIQUIDITY_DRAIN)"),
      L(`00:0${i}:00.001`, "PnL: -82.00%"),
    ]),
    L("00:09:00.000", "🛒 Executing BUY: LOOP"),
    L("00:10:00.000", "💸 Executing SELL: LOOP (STOP_LOSS)"),
    L("00:10:00.001", "PnL: -10.00%"),
  ];
  const trades = parseTrades(lines, skipped);
  assert.equal(trades.length, 2);
  assert.equal(skipped.repeatSells, 2);
});

test("dedupeTrades drops the same sell seen in two log files", () => {
  const t = parseTrades(LOG);
  assert.equal(dedupeTrades([...t, ...t]).length, 2);
});

test("groupStats computes win rate, mean and median", () => {
  const t = parseTrades(LOG);
  const [g] = groupStats(t, () => "all");
  assert.equal(g.n, 2);
  assert.equal(g.winPct, 50);
  assert.equal(g.avgPnl, -14);
  assert.equal(g.medianPnl, -14);
});
