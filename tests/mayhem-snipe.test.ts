import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buildConfig, validateConfig } from "../src/config.js";
import {
  ammValueLamports,
  decodeCurve,
  decodeMintAuthorities,
  detailsNeeded,
  detailsVerdict,
  evaluateCandidate,
  holdersFromLargest,
  ladderAction,
  liquidityUsd,
  noSellTimedOut,
  parseCreate,
  parseMayhemCreate,
  pollIntervalMs,
  quoteBuy,
  quoteSell,
  rugTriggered,
  top10Percent,
  withinSlippage,
  type CoinDetails,
  type CurveState,
  type LadderLeg,
  type SnipeRules,
} from "../src/mayhem-snipe.js";

const DISC = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const str = (s: string) => {
  const b = Buffer.from(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
};
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").toBytes();
const WSOL = new PublicKey("So11111111111111111111111111111111111111112").toBytes();
const MINT = new PublicKey(Buffer.alloc(32, 7)).toBase58();

/** A CreateEvent log line laid out per pump.fun's IDL (251 bytes after the uri). */
function createLine(o: { symbol?: string; mayhem?: number; quote?: Uint8Array; ts?: number } = {}): string {
  const body = Buffer.alloc(251);
  body.fill(7, 0, 32);
  body.writeBigInt64LE(BigInt(o.ts ?? 1_800_000_000), 128);
  body[200] = o.mayhem ?? 1;
  if (o.quote) Buffer.from(o.quote).copy(body, 202);
  return "Program data: " + Buffer.concat([DISC, str("Name"), str(o.symbol ?? "TOK"), str("uri"), body]).toString("base64");
}

/** A 141-byte BondingCurve account per the IDL. */
function curveData(
  o: Partial<{ vTok: bigint; vSol: bigint; rTok: bigint; rSol: bigint; supply: bigint; complete: number; mayhem: number; quote: Uint8Array }> = {}
): Buffer {
  const b = Buffer.alloc(141);
  b.writeBigUInt64LE(o.vTok ?? 1_073_000_000_000_000n, 8);
  b.writeBigUInt64LE(o.vSol ?? 30_000_000_000n, 16);
  b.writeBigUInt64LE(o.rTok ?? 793_100_000_000_000n, 24);
  b.writeBigUInt64LE(o.rSol ?? 0n, 32);
  b.writeBigUInt64LE(o.supply ?? 1_000_000_000_000_000n, 40);
  b[48] = o.complete ?? 0;
  b[81] = o.mayhem ?? 1;
  if (o.quote) Buffer.from(o.quote).copy(b, 83);
  return b;
}
const curve = (o: Parameters<typeof curveData>[0] = {}): CurveState => decodeCurve(curveData(o))!;
const SOL = 1_000_000_000n;
const RULES: SnipeRules = { minLiquidityUsd: 200, buyDeadlineMs: 15_000 };

test("parses a mayhem, SOL-quoted creation: mint, chain time, sanitised symbol", () => {
  const r = parseMayhemCreate(["Program log: x", createLine({ symbol: "Ev il!$", ts: 1_800_000_123 })]);
  assert.ok(r);
  assert.equal(r.mint, MINT);
  assert.equal(r.symbol, "Evil$");
  assert.equal(r.chainTimeMs, 1_800_000_123_000);
  assert.equal(r.mayhem, true);
});

test("ignores non-mayhem, other-quote, truncated and junk events; accepts a WSOL quote", () => {
  assert.equal(parseMayhemCreate([createLine({ mayhem: 0 })]), null);
  assert.equal(parseMayhemCreate([createLine({ quote: USDC })]), null);
  assert.ok(parseMayhemCreate([createLine({ quote: WSOL })]));
  assert.equal(parseMayhemCreate(["Program data: AAAA", "Program log: hi", "Program data: !!!"]), null);
  const cut = createLine().slice(0, 120);
  assert.equal(parseMayhemCreate([cut]), null);
});

test("parseCreate also returns ordinary (non-mayhem) launches, flagged, but still only SOL-quoted ones", () => {
  const plain = parseCreate([createLine({ mayhem: 0, symbol: "PLAIN" })]);
  assert.ok(plain);
  assert.equal(plain.mayhem, false);
  assert.equal(plain.symbol, "PLAIN");
  assert.equal(plain.mint, MINT);
  assert.equal(parseCreate([createLine({ mayhem: 0, quote: USDC })]), null);
  assert.equal(parseCreate([createLine({ mayhem: 1 })])?.mayhem, true);
});

test("decodes a curve account and rejects a short one", () => {
  const c = decodeCurve(curveData({ rSol: 3n * SOL, mayhem: 1, complete: 0 }));
  assert.ok(c);
  assert.equal(c.rSol, 3n * SOL);
  assert.equal(c.supply, 1_000_000_000_000_000n);
  assert.equal(c.mayhem, true);
  assert.equal(c.complete, false);
  assert.equal(c.quoteIsSol, true);
  assert.equal(decodeCurve(curveData({ quote: USDC }))?.quoteIsSol, false);
  assert.equal(decodeCurve(Buffer.alloc(50)), null);
  assert.equal(decodeCurve(null), null);
});

test("mint and freeze authority are read from the mint account (None = revoked)", () => {
  const mintData = (o: { mint?: number; freeze?: number } = {}) => {
    const b = Buffer.alloc(82);
    b.writeUInt32LE(o.mint ?? 0, 0);
    b.writeUInt32LE(o.freeze ?? 0, 46);
    return b;
  };
  assert.deepEqual(decodeMintAuthorities(mintData()), { mintDisabled: true, freezeDisabled: true });
  assert.deepEqual(decodeMintAuthorities(mintData({ mint: 1 })), { mintDisabled: false, freezeDisabled: true });
  assert.deepEqual(decodeMintAuthorities(mintData({ freeze: 1 })), { mintDisabled: true, freezeDisabled: false });
  assert.equal(decodeMintAuthorities(Buffer.alloc(40)), null);
  assert.equal(decodeMintAuthorities(undefined), null);
  // Token-2022 mints are longer (extensions) but share the first 82 bytes.
  assert.deepEqual(decodeMintAuthorities(Buffer.concat([mintData(), Buffer.alloc(120)])), { mintDisabled: true, freezeDisabled: true });
});

test("with no fee a buy then sell on the post-trade curve returns the stake", () => {
  const c = curve({ rSol: 5n * SOL });
  const stake = SOL / 20n; // 0.05 SOL
  const tokens = quoteBuy(c, stake, 0n);
  assert.ok(tokens > 0n);
  const after: CurveState = { ...c, vTok: c.vTok - tokens, vSol: c.vSol + stake, rTok: c.rTok - tokens, rSol: c.rSol + stake };
  const out = quoteSell(after, tokens, 0n);
  assert.ok(out <= stake && stake - out <= 2n, `round trip drifted: ${stake} -> ${out}`);
});

test("the fee costs about 2.5% over a round trip, and a sell is capped by the curve's real SOL", () => {
  const c = curve({ rSol: 5n * SOL });
  const stake = SOL / 20n;
  const tokens = quoteBuy(c, stake, 125n);
  const ratio = Number(quoteSell(c, tokens, 125n)) / Number(stake);
  assert.ok(ratio > 0.96 && ratio < 0.99, `ratio ${ratio}`);
  const thin = curve({ rSol: 1_000_000n }); // 0.001 SOL of real liquidity
  assert.ok(quoteSell(thin, 500_000_000_000_000n, 0n) <= 1_000_000n, "cannot pay out more SOL than the curve holds");
  assert.equal(quoteBuy(c, 0n, 125n), 0n);
});

test("slippage tolerance is a min-out: exactly 60% worse still fills, a hair more does not", () => {
  assert.equal(withinSlippage(100n, 40n, 60), true);
  assert.equal(withinSlippage(100n, 39n, 60), false);
  assert.equal(withinSlippage(100n, 150n, 60), true, "a better fill is always fine");
  assert.equal(withinSlippage(100n, 100n, 0), true);
  assert.equal(withinSlippage(100n, 99n, 0), false);
});

test("liquidity is real SOL in USD", () => {
  assert.equal(liquidityUsd(2n * SOL, 150), 300);
});

test("decision: waits below the liquidity bar, buys at or above it, and honours the deadline", () => {
  const t0 = 1_000_000;
  const half = curve({ rSol: SOL / 2n }); // 0.5 SOL * $200 = $100
  assert.equal(evaluateCandidate(half, t0, t0 + 3_000, 200, RULES).action, "wait");
  const late = evaluateCandidate(half, t0, t0 + 16_000, 200, RULES);
  assert.equal(late.action, "skip");
  assert.match(late.reason, /< \$200 at the deadline/);

  const rich = curve({ rSol: (3n * SOL) / 2n }); // $300
  assert.equal(evaluateCandidate(rich, t0, t0 + 5_000, 200, RULES).action, "buy");
  assert.equal(evaluateCandidate(rich, t0, t0 + 15_000, 200, RULES).action, "buy", "exactly at the deadline still counts");
  assert.match(evaluateCandidate(rich, t0, t0 + 16_000, 200, RULES).reason, /only after the 15s deadline/);

  assert.equal(evaluateCandidate(curve({ rSol: SOL }), t0, t0 + 1_000, 200, RULES).action, "buy", "$200 exactly is enough");
});

test("decision: wrong mode, wrong quote, graduated curve, or no SOL price never buy", () => {
  const t0 = 1_000_000;
  const rich = { rSol: 5n * SOL };
  assert.equal(evaluateCandidate(curve({ ...rich, mayhem: 0 }), t0, t0 + 2_000, 200, RULES).action, "skip");
  assert.equal(evaluateCandidate(curve({ ...rich, quote: USDC }), t0, t0 + 2_000, 200, RULES).action, "skip");
  assert.equal(evaluateCandidate(curve({ ...rich, complete: 1 }), t0, t0 + 2_000, 200, RULES).action, "skip");
  assert.equal(evaluateCandidate(curve(rich), t0, t0 + 2_000, undefined, RULES).action, "wait");
  assert.equal(evaluateCandidate(curve(rich), t0, t0 + 20_000, undefined, RULES).action, "skip");
});

test("requireMayhem=false lets an ordinary pump.fun coin through", () => {
  const t0 = 1_000_000;
  const plain = curve({ rSol: 5n * SOL, mayhem: 0 });
  assert.equal(evaluateCandidate(plain, t0, t0 + 2_000, 200, { ...RULES, requireMayhem: false }).action, "buy");
  assert.equal(evaluateCandidate(plain, t0, t0 + 2_000, 200, { ...RULES, requireMayhem: true }).action, "skip");
});

test("minimum age: a liquid coin waits until it is old enough, then is bought if still liquid", () => {
  const t0 = 1_000_000;
  const rules: SnipeRules = { ...RULES, minAgeMs: 5_000 };
  const rich = curve({ rSol: (3n * SOL) / 2n }); // $300
  const early = evaluateCandidate(rich, t0, t0 + 2_000, 200, rules);
  assert.equal(early.action, "wait");
  assert.match(early.reason, /waiting until 5s old/);
  assert.equal(evaluateCandidate(rich, t0, t0 + 4_999, 200, rules).action, "wait");
  assert.equal(evaluateCandidate(rich, t0, t0 + 5_000, 200, rules).action, "buy", "exactly at the minimum age");
  assert.equal(evaluateCandidate(rich, t0, t0 + 15_000, 200, rules).action, "buy");
  assert.equal(evaluateCandidate(rich, t0, t0 + 16_000, 200, rules).action, "skip", "the deadline still wins");
});

test("minimum age: seed liquidity that is pulled before the minimum age is never bought", () => {
  const t0 = 1_000_000;
  const rules: SnipeRules = { ...RULES, minAgeMs: 5_000 };
  const seeded = curve({ rSol: (3n * SOL) / 2n }); // $300 at 2s
  assert.equal(evaluateCandidate(seeded, t0, t0 + 2_000, 200, rules).action, "wait");
  const pulled = curve({ rSol: SOL / 20n }); // $10 at 6s: the seed was withdrawn
  assert.equal(evaluateCandidate(pulled, t0, t0 + 6_000, 200, rules).action, "wait");
  const end = evaluateCandidate(pulled, t0, t0 + 16_000, 200, rules);
  assert.equal(end.action, "skip");
  assert.match(end.reason, /< \$200 at the deadline/);
});

test("holders: non-empty token accounts minus the curve's own", () => {
  assert.equal(holdersFromLargest([]), 0);
  assert.equal(holdersFromLargest([{ amount: "500" }]), 0, "only the curve holds anything");
  assert.equal(holdersFromLargest([{ amount: "500" }, { amount: "40" }, { amount: "0" }, { amount: "7" }]), 2);
  assert.equal(holdersFromLargest(Array.from({ length: 20 }, () => ({ amount: "1" }))), 19, "the top-20 view caps at 19");
});

test("top 10 holders' share of supply excludes the curve's own account and ignores empties", () => {
  const supply = 1000n;
  const accounts = [
    { amount: "500" }, // the curve
    { amount: "10" },
    { amount: "80" },
    { amount: "60" },
    { amount: "0" },
    { amount: "40" },
    { amount: "30" },
    { amount: "25" },
    { amount: "20" },
    { amount: "15" },
    { amount: "15" },
    { amount: "12" },
    { amount: "5" }, // the 11th real holder: outside the top 10
  ];
  // top 10 real holders: 80+60+40+30+25+20+15+15+12+10 = 307 of 1000
  assert.equal(top10Percent(accounts, supply), 30.7);
  assert.equal(top10Percent([{ amount: "500" }], supply), 0, "only the curve");
  assert.equal(top10Percent(accounts, 0n), 0);
});

const FULL: SnipeRules = {
  minLiquidityUsd: 5000,
  buyDeadlineMs: 600_000,
  maxTop10Pct: 31,
  requireAuthoritiesDisabled: true,
  requireMayhem: false,
};
const GOOD: CoinDetails = { top10Pct: 20, mintDisabled: true, freezeDisabled: true };

test("details verdict: unknown waits, a live authority is permanent, 31% is the inclusive ceiling", () => {
  assert.equal(detailsVerdict({ minLiquidityUsd: 1, buyDeadlineMs: 1 }, undefined).ok, true, "no rules, no checks");
  assert.equal(detailsVerdict(FULL, undefined).ok, false);
  assert.match(detailsVerdict(FULL, { top10Pct: 10 }).reason, /authorities unknown/);
  assert.equal(detailsVerdict(FULL, GOOD).ok, true);
  const mint = detailsVerdict(FULL, { ...GOOD, mintDisabled: false });
  assert.deepEqual([mint.ok, mint.permanent], [false, true]);
  assert.match(mint.reason, /mint authority enabled/);
  const freeze = detailsVerdict(FULL, { ...GOOD, freezeDisabled: false });
  assert.deepEqual([freeze.ok, freeze.permanent], [false, true]);
  assert.match(freeze.reason, /freeze authority enabled/);
  assert.equal(detailsVerdict(FULL, { ...GOOD, top10Pct: 31 }).ok, true, "exactly 31% passes");
  const high = detailsVerdict(FULL, { ...GOOD, top10Pct: 31.5 });
  assert.deepEqual([high.ok, high.permanent], [false, false]);
  assert.match(high.reason, /top 10 holders 31\.5% > 31%/);
  assert.equal(detailsVerdict({ ...FULL, requireAuthoritiesDisabled: false, maxTop10Pct: 0, minHolders: 6 }, { holders: 6 }).ok, true);
  assert.match(detailsVerdict({ ...FULL, minHolders: 6 }, { ...GOOD, holders: 3 }).reason, /holders 3 < 6/);
});

test("entry: $5k liquidity, then the on-chain checks, inside the 10-minute window", () => {
  const t0 = 1_000_000;
  const rich = curve({ rSol: 30n * SOL, mayhem: 0 }); // 30 SOL at $200 = $6,000, an ordinary (non-mayhem) coin
  const poor = curve({ rSol: (49n * SOL) / 2n, mayhem: 0 }); // 24.5 SOL = $4,900
  assert.equal(evaluateCandidate(poor, t0, t0 + 60_000, 200, FULL, GOOD).action, "wait", "$4,900 is not enough");
  assert.equal(evaluateCandidate(rich, t0, t0 + 60_000, 200, FULL, undefined).action, "wait", "details not read yet");
  assert.equal(evaluateCandidate(rich, t0, t0 + 60_000, 200, FULL, GOOD).action, "buy");
  assert.equal(evaluateCandidate(rich, t0, t0 + 599_000, 200, FULL, GOOD).action, "buy", "still inside the 10 minutes");
  const old = evaluateCandidate(rich, t0, t0 + 601_000, 200, FULL, GOOD);
  assert.equal(old.action, "skip");
  assert.match(old.reason, /only after the 600s deadline/);

  const enabled = evaluateCandidate(rich, t0, t0 + 10_000, 200, FULL, { ...GOOD, mintDisabled: false });
  assert.equal(enabled.action, "skip", "a live authority is skipped at once, not polled to the deadline");
  assert.match(enabled.reason, /mint authority enabled/);

  const crowded = { ...GOOD, top10Pct: 40 };
  assert.equal(evaluateCandidate(rich, t0, t0 + 100_000, 200, FULL, crowded).action, "wait", "concentration can still fall");
  const end = evaluateCandidate(rich, t0, t0 + 601_000, 200, FULL, crowded);
  assert.equal(end.action, "skip");
  assert.match(end.reason, /top 10 holders 40\.0% > 31% at the deadline/);
});

test("detailsNeeded: only when liquidity, the age window and the mode qualify, and a detail rule is on", () => {
  const t0 = 1_000_000;
  const rich = curve({ rSol: 30n * SOL, mayhem: 0 });
  assert.equal(detailsNeeded(rich, t0, t0 + 60_000, 200, FULL), true);
  assert.equal(detailsNeeded(curve({ rSol: SOL }), t0, t0 + 60_000, 200, FULL), false, "too little liquidity");
  assert.equal(detailsNeeded(rich, t0, t0 + 601_000, 200, FULL), false, "past the deadline");
  assert.equal(detailsNeeded(rich, t0, t0 + 2_000, 200, { ...FULL, minAgeMs: 5_000 }), false, "younger than the minimum age");
  assert.equal(detailsNeeded(rich, t0, t0 + 60_000, 200, { ...FULL, maxTop10Pct: 0, requireAuthoritiesDisabled: false }), false, "no detail rule");
  assert.equal(detailsNeeded(rich, t0, t0 + 60_000, undefined, FULL), false, "no SOL price");
  assert.equal(detailsNeeded(rich, t0, t0 + 60_000, 200, { ...FULL, requireMayhem: true }), false, "not a mayhem coin");
});

test("poll cadence: every second while new or near the bar, slower as a quiet coin ages", () => {
  assert.equal(pollIntervalMs(5_000, false), 1_000);
  assert.equal(pollIntervalMs(60_000, false), 3_000);
  assert.equal(pollIntervalMs(300_000, false), 10_000);
  assert.equal(pollIntervalMs(300_000, true), 2_000, "a coin near the liquidity bar is watched closely");
  assert.equal(pollIntervalMs(5_000, true), 1_000, "never slower than the age tier");
});

const LADDER: LadderLeg[] = [
  { pct: 75, sellPct: 30 },
  { pct: 120, sellPct: 30 },
  { pct: 300, sellPct: 100 },
];
const BASIS = 49_375_000; // 0.05 SOL less the 1.25% fee
const pos = (tokens: bigint, legsDone: number) => ({ basis: BASIS, initialTokens: 1000n, tokens, legsDone });
/** What the remaining tokens are worth when their price is `ratio` times the entry price. */
const worth = (tokens: bigint, ratio: number) => BASIS * (Number(tokens) / 1000) * ratio;

test("ladder: 30% at +75%, 30% at +120%, the rest at +300%, each measured on price", () => {
  assert.deepEqual(ladderAction(pos(1000n, 0), worth(1000n, 1.74), LADDER), { leg: "none" });
  const first = ladderAction(pos(1000n, 0), worth(1000n, 1.76), LADDER);
  assert.deepEqual(first, { leg: "tp1", fraction: 0.3, done: 1 });
  // after TP1 700 tokens remain; TP2 sells another 30% of the original = 30/70 of what is left
  assert.deepEqual(ladderAction(pos(700n, 1), worth(700n, 2.19), LADDER), { leg: "none" });
  const second = ladderAction(pos(700n, 1), worth(700n, 2.21), LADDER);
  assert.equal(second.leg, "tp2");
  assert.ok("fraction" in second && Math.abs(second.fraction - 30 / 70) < 1e-9);
  assert.deepEqual(ladderAction(pos(400n, 2), worth(400n, 3.9), LADDER), { leg: "none" });
  assert.deepEqual(ladderAction(pos(400n, 2), worth(400n, 4.1), LADDER), { leg: "tp3", fraction: 1, done: 3 });
});

test("ladder: a price that gaps past several legs sells them together, and past the last sells everything", () => {
  const gap = ladderAction(pos(1000n, 0), worth(1000n, 2.5), LADDER);
  assert.equal(gap.leg, "tp2");
  assert.ok("fraction" in gap && Math.abs(gap.fraction - 0.6) < 1e-9, "30% + 30% of the original");
  assert.ok("done" in gap && gap.done === 2);
  assert.deepEqual(ladderAction(pos(1000n, 0), worth(1000n, 5), LADDER), { leg: "tp3", fraction: 1, done: 3 });
});

test("ladder: nothing to do when finished, empty, or without legs", () => {
  assert.deepEqual(ladderAction(pos(0n, 3), 1e12, LADDER), { leg: "none" });
  assert.deepEqual(ladderAction(pos(400n, 3), 1e12, LADDER), { leg: "none" }, "all legs already done");
  assert.deepEqual(ladderAction(pos(1000n, 0), 1e12, []), { leg: "none" });
});

test("ladder on real curve maths: +100% fires TP1, +150% fires TP1+TP2, +400% the last, a drained curve nothing", () => {
  // A curve with 18 real SOL, constant product k kept across price moves.
  const c0 = curve({ vSol: 48n * SOL, vTok: 670_625_000_000_000n, rSol: 18n * SOL });
  const stake = SOL / 20n;
  const tokens = quoteBuy(c0, stake, 125n);
  const basis = Number(stake - (stake * 125n) / 10_000n);
  const k = c0.vSol * c0.vTok;
  const priceMoved = (factor: number, realSol?: bigint): CurveState => {
    const vSol = BigInt(Math.round(Number(c0.vSol) * Math.sqrt(factor))); // price is proportional to vSol squared over k
    return curve({ vSol, vTok: k / vSol, rSol: realSol ?? c0.rSol + (vSol - c0.vSol) });
  };
  const leg = (c: CurveState) =>
    ladderAction({ basis, initialTokens: tokens, tokens, legsDone: 0 }, Number(quoteSell(c, tokens, 0n)), LADDER).leg;
  assert.equal(leg(c0), "none");
  assert.equal(leg(priceMoved(1.5)), "none");
  assert.equal(leg(priceMoved(2.0)), "tp1");
  assert.equal(leg(priceMoved(2.5)), "tp2");
  assert.equal(leg(priceMoved(5.0)), "tp3");
  assert.equal(leg(priceMoved(5.0, 0n)), "none", "no real SOL left: the leftover virtual price cannot be sold into");
});

test("rug path: real liquidity 40% or more below its peak since the buy", () => {
  assert.equal(rugTriggered(100, 61, 40), false);
  assert.equal(rugTriggered(100, 60, 40), true, "exactly 40% down counts");
  assert.equal(rugTriggered(100, 1, 40), true);
  assert.equal(rugTriggered(100, 1, 0), false, "off when the setting is 0");
  assert.equal(rugTriggered(0, 0, 40), false, "no peak recorded yet");
});

test("no-sell timeout: 10 minutes after the buy with no take-profit sold yet, and never once one has sold", () => {
  const bought = 1_000_000;
  const ten = 600_000;
  assert.equal(noSellTimedOut({ anySold: false, boughtAt: bought }, bought + ten - 1, ten), false);
  assert.equal(noSellTimedOut({ anySold: false, boughtAt: bought }, bought + ten, ten), true);
  assert.equal(noSellTimedOut({ anySold: true, boughtAt: bought }, bought + ten * 5, ten), false, "a sold position is not timed out");
  assert.equal(noSellTimedOut({ anySold: false, boughtAt: bought }, bought + ten * 5, 0), false, "off when 0");
});

test("AMM pricing after graduation: tokens x USD price / SOL price, in lamports", () => {
  // 2,000 tokens (6 decimals) at $0.0005 with SOL at $200 = 0.005 SOL
  assert.equal(ammValueLamports(2_000_000_000n, 0.0005, 200), 5_000_000n);
  assert.equal(ammValueLamports(0n, 0.0005, 200), 0n);
  assert.equal(ammValueLamports(2_000_000_000n, 0, 200), 0n);
  assert.equal(ammValueLamports(2_000_000_000n, 0.0005, 0), 0n);
});

test("MAYHEM_SNIPE config: off by default, only an explicit paper turns it on, 60% slippage default", () => {
  const d = buildConfig({});
  assert.equal(d.mayhemSnipeMode, "off");
  assert.equal(d.mayhemSnipeMinLiquidityUsd, 200);
  assert.equal(d.mayhemSnipeBuyDeadlineSeconds, 15);
  assert.equal(d.mayhemSnipeHoldSeconds, 40);
  assert.equal(d.mayhemSnipeSlippagePercent, 60);
  assert.equal(buildConfig({ MAYHEM_SNIPE_MODE: " PAPER " }).mayhemSnipeMode, "paper");
  assert.equal(buildConfig({ MAYHEM_SNIPE_MODE: "live" }).mayhemSnipeMode, "off", "there is no live mode");
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_SLIPPAGE_PERCENT: "100" }), /MAYHEM_SNIPE_SLIPPAGE_PERCENT/);
});

test("MAYHEM_SNIPE_MIN_AGE_SECONDS: defaults to 0, accepts 5, rejects out of range", () => {
  assert.equal(buildConfig({}).mayhemSnipeMinAgeSeconds, 0);
  assert.equal(buildConfig({ MAYHEM_SNIPE_MIN_AGE_SECONDS: "5" }).mayhemSnipeMinAgeSeconds, 5);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MIN_AGE_SECONDS: "3600" }), /MAYHEM_SNIPE_MIN_AGE_SECONDS/);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MIN_AGE_SECONDS: "-1" }), /MAYHEM_SNIPE_MIN_AGE_SECONDS/);
});

test("MAYHEM_SNIPE new-rules config: everything defaults to off, and the requested setup parses", () => {
  const d = buildConfig({});
  assert.equal(d.mayhemSnipeOnlyMayhem, true);
  assert.equal(d.mayhemSnipeMinHolders, 0);
  assert.equal(d.mayhemSnipeMaxTop10Percent, 0);
  assert.equal(d.mayhemSnipeRequireAuthoritiesDisabled, false);
  assert.deepEqual(d.mayhemSnipeLadder, []);
  assert.equal(d.mayhemSnipeNoSellTimeoutSeconds, 0);
  assert.equal(d.mayhemSnipeRugDropPercent, 0);
  const c = buildConfig({
    MAYHEM_SNIPE_MODE: "paper",
    MAYHEM_SNIPE_ONLY_MAYHEM: "false",
    MAYHEM_SNIPE_MIN_LIQUIDITY_USD: "5000",
    MAYHEM_SNIPE_BUY_DEADLINE_SECONDS: "600",
    MAYHEM_SNIPE_MAX_TOP10_PERCENT: "31",
    MAYHEM_SNIPE_REQUIRE_AUTHORITIES_DISABLED: "true",
    MAYHEM_SNIPE_LADDER: "75:30,120:30,300:rest",
    MAYHEM_SNIPE_NO_SELL_TIMEOUT_SECONDS: "600",
    MAYHEM_SNIPE_RUG_DROP_PERCENT: "40",
    MAYHEM_SNIPE_HOLD_SECONDS: "0",
  });
  assert.equal(c.mayhemSnipeOnlyMayhem, false);
  assert.equal(c.mayhemSnipeMinLiquidityUsd, 5000);
  assert.equal(c.mayhemSnipeBuyDeadlineSeconds, 600);
  assert.equal(c.mayhemSnipeMaxTop10Percent, 31);
  assert.equal(c.mayhemSnipeRequireAuthoritiesDisabled, true);
  assert.deepEqual(c.mayhemSnipeLadder, [
    { pct: 75, sellPct: 30 },
    { pct: 120, sellPct: 30 },
    { pct: 300, sellPct: 100 },
  ]);
  assert.equal(c.mayhemSnipeNoSellTimeoutSeconds, 600);
  assert.equal(c.mayhemSnipeRugDropPercent, 40);
  assert.equal(c.mayhemSnipeHoldSeconds, 0);
});

test("MAYHEM_SNIPE_LADDER: a single leg, the last share is optional, and malformed ladders are rejected", () => {
  assert.deepEqual(buildConfig({ MAYHEM_SNIPE_LADDER: "300" }).mayhemSnipeLadder, [{ pct: 300, sellPct: 100 }]);
  assert.deepEqual(buildConfig({ MAYHEM_SNIPE_LADDER: "50:40, 200:rest" }).mayhemSnipeLadder, [
    { pct: 50, sellPct: 40 },
    { pct: 200, sellPct: 100 },
  ]);
  for (const bad of ["75:30,50:30,300", "75:60,120:60,300", "75,120", "75:30,abc", "75:0,300", "75:100,300", "0:30,300", ":30,300"]) {
    assert.throws(() => buildConfig({ MAYHEM_SNIPE_LADDER: bad }), /MAYHEM_SNIPE_LADDER/, `should reject "${bad}"`);
  }
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MAX_TOP10_PERCENT: "101" }), /MAYHEM_SNIPE_MAX_TOP10_PERCENT/);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_RUG_DROP_PERCENT: "100" }), /MAYHEM_SNIPE_RUG_DROP_PERCENT/);
});

test("validateConfig: no time exit needs a ladder", () => {
  const base = { DRY_RUN: "true", MAYHEM_SNIPE_MODE: "paper" };
  assert.throws(() => validateConfig(buildConfig({ ...base, MAYHEM_SNIPE_HOLD_SECONDS: "0" })), /never sells/);
  assert.doesNotThrow(() =>
    validateConfig(buildConfig({ ...base, MAYHEM_SNIPE_LADDER: "75:30,120:30,300:rest", MAYHEM_SNIPE_HOLD_SECONDS: "0" }))
  );
});
