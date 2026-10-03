import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DRY_RUN = "true";
process.env.OPENROUTER_API_KEY = "test";

const { parseCurveState } = await import("../src/bonding-curve.js");
const { shouldRecord } = await import("../src/fresh-coin-recorder.js");
const { collectFreshCoins, summariseFresh } = await import("../scripts/fresh-report.js");

/** A live BondingCurve as read from mainnet 2026-10-03: a fresh coin with 0.0049 SOL really deposited. */
function curve(opts: { complete?: boolean; realSol?: bigint; vSol?: bigint; vTokens?: bigint; length?: number } = {}): Uint8Array {
  const data = Buffer.alloc(opts.length ?? 141);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(data, 0);
  data.writeBigUInt64LE(opts.vTokens ?? 1_072_823_403_612_355n, 8);
  data.writeBigUInt64LE(opts.vSol ?? 30_004_938_270n, 16);
  data.writeBigUInt64LE(792_923_403_612_355n, 24);
  data.writeBigUInt64LE(opts.realSol ?? 4_938_270n, 32);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  data[48] = opts.complete ? 1 : 0;
  return data;
}

test("parseCurveState reads reserves and prices a fresh curve at about 28 SOL market cap", () => {
  const s = parseCurveState(curve());
  assert.ok(s);
  assert.equal(s.complete, false);
  assert.ok(Math.abs(s.realSol - 0.00493827) < 1e-9);
  assert.ok(s.marketCapSol !== null && s.marketCapSol > 27 && s.marketCapSol < 29);
});

test("a graduated curve has no implied market cap, and non-curves are rejected", () => {
  const done = parseCurveState(curve({ complete: true, realSol: 0n, vSol: 0n, vTokens: 0n }));
  assert.equal(done?.complete, true);
  assert.equal(done?.marketCapSol, null);
  const wrong = Buffer.from(curve());
  wrong[0] = 0;
  assert.equal(parseCurveState(wrong), undefined);
  assert.equal(parseCurveState(new Uint8Array(20)), undefined);
});

test("shouldRecord samples one in N but always records a known creator", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => shouldRecord(n, 4, false)), [false, false, false, true, false, false, false, true]);
  assert.equal(shouldRecord(1, 4, true), true);
});

const L = (o: object) => JSON.stringify(o);

test("collectFreshCoins joins a coin's lines, and summariseFresh buckets by real SOL at 30s", () => {
  const lines = [
    L({ type: "launch", mint: "WIN" }),
    L({ type: "snap", mint: "WIN", h: 30, realSol: 2, marketCapSol: 30, complete: false }),
    L({ type: "snap", mint: "WIN", h: 300, realSol: 20, marketCapSol: 90, complete: false }),
    L({ type: "dex", mint: "WIN", h: 300, listed: true }),
    L({ type: "auth", mint: "WIN", mintAuthorityDisabled: true, freezeAuthorityDisabled: true }),
    L({ type: "launch", mint: "DUD" }),
    L({ type: "snap", mint: "DUD", h: 30, realSol: 3, marketCapSol: 30, complete: false }),
    L({ type: "snap", mint: "DUD", h: 300, realSol: 0.2, marketCapSol: 10, complete: false }),
    L({ type: "dex", mint: "DUD", h: 300, listed: false }),
    L({ type: "snap", mint: "ORPHAN", h: 30, realSol: 1, marketCapSol: 1 }),
    "garbage",
  ];
  const coins = collectFreshCoins(lines);
  assert.equal(coins.length, 2, "a snap with no launch line is ignored");
  const [g] = summariseFresh(coins);
  assert.equal(g.group, "c 1-5");
  assert.equal(g.coins, 2);
  assert.equal(g.readable, 2);
  assert.equal(g.doubledPct, 50);
  assert.equal(g.halvedPct, 50);
  assert.equal(g.listedPct, 50);
  assert.equal(g.revokedPct, 100, "only coins with an auth reading count");
});
