import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buildConfig, validateConfig } from "../src/config.js";
import {
  decodeCurve,
  evaluateCandidate,
  holdersFromLargest,
  holdersNeeded,
  ladderAction,
  liquidityUsd,
  parseMayhemCreate,
  quoteBuy,
  quoteSell,
  withinSlippage,
  type CurveState,
  type Ladder,
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
function curveData(o: Partial<{ vTok: bigint; vSol: bigint; rTok: bigint; rSol: bigint; complete: number; mayhem: number; quote: Uint8Array }> = {}): Buffer {
  const b = Buffer.alloc(141);
  b.writeBigUInt64LE(o.vTok ?? 1_073_000_000_000_000n, 8);
  b.writeBigUInt64LE(o.vSol ?? 30_000_000_000n, 16);
  b.writeBigUInt64LE(o.rTok ?? 793_100_000_000_000n, 24);
  b.writeBigUInt64LE(o.rSol ?? 0n, 32);
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
});

test("ignores non-mayhem, other-quote, truncated and junk events; accepts a WSOL quote", () => {
  assert.equal(parseMayhemCreate([createLine({ mayhem: 0 })]), null);
  assert.equal(parseMayhemCreate([createLine({ quote: USDC })]), null);
  assert.ok(parseMayhemCreate([createLine({ quote: WSOL })]));
  assert.equal(parseMayhemCreate(["Program data: AAAA", "Program log: hi", "Program data: !!!"]), null);
  const cut = createLine().slice(0, 120);
  assert.equal(parseMayhemCreate([cut]), null);
});

test("decodes a curve account and rejects a short one", () => {
  const c = decodeCurve(curveData({ rSol: 3n * SOL, mayhem: 1, complete: 0 }));
  assert.ok(c);
  assert.equal(c.rSol, 3n * SOL);
  assert.equal(c.mayhem, true);
  assert.equal(c.complete, false);
  assert.equal(c.quoteIsSol, true);
  assert.equal(decodeCurve(curveData({ quote: USDC }))?.quoteIsSol, false);
  assert.equal(decodeCurve(Buffer.alloc(50)), null);
  assert.equal(decodeCurve(null), null);
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

test("decision: waits below $200, buys at or above it, and honours the 15s deadline", () => {
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

test("minimum age: unset or 0 keeps the old behaviour (buy the moment liquidity qualifies)", () => {
  const t0 = 1_000_000;
  const rich = curve({ rSol: (3n * SOL) / 2n });
  assert.equal(evaluateCandidate(rich, t0, t0 + 1_000, 200, RULES).action, "buy");
  assert.equal(evaluateCandidate(rich, t0, t0 + 1_000, 200, { ...RULES, minAgeMs: 0 }).action, "buy");
});

const HOLDER_RULES: SnipeRules = { minLiquidityUsd: 3000, buyDeadlineMs: 120_000, minHolders: 6 };
const LADDER: Ladder = { tp1Pct: 78, tp1SellPct: 50, tp2Pct: 300 };

test("holders: non-empty token accounts minus the curve's own", () => {
  assert.equal(holdersFromLargest([]), 0);
  assert.equal(holdersFromLargest([{ amount: "500" }]), 0, "only the curve holds anything");
  assert.equal(holdersFromLargest([{ amount: "500" }, { amount: "40" }, { amount: "0" }, { amount: "7" }]), 2);
  assert.equal(holdersFromLargest(Array.from({ length: 20 }, () => ({ amount: "1" }))), 19, "the top-20 view caps at 19");
});

test("holders: a liquid coin waits for 6 holders, is bought at 6, and is skipped with the reason at the deadline", () => {
  const t0 = 1_000_000;
  const rich = curve({ rSol: 20n * SOL }); // 20 SOL at $200 = $4,000
  assert.equal(evaluateCandidate(rich, t0, t0 + 10_000, 200, HOLDER_RULES, undefined).action, "wait");
  const few = evaluateCandidate(rich, t0, t0 + 10_000, 200, HOLDER_RULES, 3);
  assert.equal(few.action, "wait");
  assert.match(few.reason, /holders 3 < 6/);
  assert.equal(evaluateCandidate(rich, t0, t0 + 10_000, 200, HOLDER_RULES, 6).action, "buy", "exactly 6 is enough");
  const late = evaluateCandidate(rich, t0, t0 + 121_000, 200, HOLDER_RULES, 3);
  assert.equal(late.action, "skip");
  assert.match(late.reason, /holders 3 < 6 at the deadline/);
});

test("holders: $3k liquidity is needed first, and 2 minutes is the limit", () => {
  const t0 = 1_000_000;
  const poor = curve({ rSol: (29n * SOL) / 2n }); // 14.5 SOL at $200 = $2,900
  assert.equal(evaluateCandidate(poor, t0, t0 + 10_000, 200, HOLDER_RULES, 12).action, "wait", "$2,900 is not enough");
  const rich = curve({ rSol: 20n * SOL });
  assert.equal(evaluateCandidate(rich, t0, t0 + 119_000, 200, HOLDER_RULES, 8).action, "buy", "still inside the 2 minutes");
  assert.equal(evaluateCandidate(rich, t0, t0 + 121_000, 200, HOLDER_RULES, 8).action, "skip", "older than 2 minutes");
});

test("holdersNeeded: only when liquidity, the age window and the mode all qualify", () => {
  const t0 = 1_000_000;
  const rich = curve({ rSol: 20n * SOL });
  assert.equal(holdersNeeded(rich, t0, t0 + 10_000, 200, HOLDER_RULES), true);
  assert.equal(holdersNeeded(curve({ rSol: SOL }), t0, t0 + 10_000, 200, HOLDER_RULES), false, "too little liquidity");
  assert.equal(holdersNeeded(rich, t0, t0 + 121_000, 200, HOLDER_RULES), false, "past the deadline");
  assert.equal(holdersNeeded(rich, t0, t0 + 2_000, 200, { ...HOLDER_RULES, minAgeMs: 5_000 }), false, "younger than the minimum age");
  assert.equal(holdersNeeded(rich, t0, t0 + 10_000, 200, { ...HOLDER_RULES, minHolders: 0 }), false, "no holder rule");
  assert.equal(holdersNeeded(rich, t0, t0 + 10_000, undefined, HOLDER_RULES), false, "no SOL price");
  assert.equal(holdersNeeded(curve({ rSol: 20n * SOL, mayhem: 0 }), t0, t0 + 10_000, 200, HOLDER_RULES), false, "not a mayhem coin");
});

test("ladder: nothing below +78%, 50% at +78%, the rest at +300%, measured against the cost of what is left", () => {
  const basis = 49_375_000; // 0.05 SOL less the 1.25% fee
  const p = { basis, initialTokens: 1000n, tokens: 1000n, tp1Done: false };
  assert.deepEqual(ladderAction(p, basis * 1.7799, LADDER), { leg: "none" });
  assert.deepEqual(ladderAction(p, basis * 1.7801, LADDER), { leg: "tp1", fraction: 0.5 });
  const half = { ...p, tokens: 500n, tp1Done: true };
  assert.deepEqual(ladderAction(half, (basis / 2) * 3.99, LADDER), { leg: "none" }, "TP1 is never repeated");
  assert.deepEqual(ladderAction(half, (basis / 2) * 4.01, LADDER), { leg: "tp2", fraction: 1 });
});

test("ladder: a price that gaps straight past +300% sells everything at once; an empty position never triggers", () => {
  const p = { basis: 49_375_000, initialTokens: 1000n, tokens: 1000n, tp1Done: false };
  assert.deepEqual(ladderAction(p, 49_375_000 * 4.5, LADDER), { leg: "tp2", fraction: 1 });
  assert.deepEqual(ladderAction({ ...p, tokens: 0n }, 1e12, LADDER), { leg: "none" });
});

test("ladder on real curve maths: +90% fires TP1, +400% fires TP2, a drained curve with a high virtual price fires nothing", () => {
  // A curve with 18 real SOL (about $3k at $170), constant product k kept across price moves.
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
    ladderAction({ basis, initialTokens: tokens, tokens, tp1Done: false }, Number(quoteSell(c, tokens, 0n)), LADDER).leg;
  assert.equal(leg(c0), "none");
  assert.equal(leg(priceMoved(1.5)), "none");
  assert.equal(leg(priceMoved(2.0)), "tp1");
  assert.equal(leg(priceMoved(5.0)), "tp2");
  assert.equal(leg(priceMoved(5.0, 0n)), "none", "no real SOL left: the leftover virtual price cannot be sold into");
});

test("MAYHEM_SNIPE ladder config: off by default, the requested setup parses, bad values are rejected", () => {
  const d = buildConfig({});
  assert.equal(d.mayhemSnipeMinHolders, 0);
  assert.equal(d.mayhemSnipeTp1Percent, 0);
  assert.equal(d.mayhemSnipeTp1SellPercent, 50);
  assert.equal(d.mayhemSnipeTp2Percent, 300);
  const c = buildConfig({
    MAYHEM_SNIPE_MODE: "paper",
    MAYHEM_SNIPE_MIN_LIQUIDITY_USD: "3000",
    MAYHEM_SNIPE_MIN_HOLDERS: "6",
    MAYHEM_SNIPE_BUY_DEADLINE_SECONDS: "120",
    MAYHEM_SNIPE_TP1_PERCENT: "78",
    MAYHEM_SNIPE_TP2_PERCENT: "300",
    MAYHEM_SNIPE_HOLD_SECONDS: "0",
  });
  assert.equal(c.mayhemSnipeMinLiquidityUsd, 3000);
  assert.equal(c.mayhemSnipeMinHolders, 6);
  assert.equal(c.mayhemSnipeBuyDeadlineSeconds, 120);
  assert.equal(c.mayhemSnipeTp1Percent, 78);
  assert.equal(c.mayhemSnipeHoldSeconds, 0);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MIN_HOLDERS: "20" }), /MAYHEM_SNIPE_MIN_HOLDERS/);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MIN_HOLDERS: "2.5" }), /MAYHEM_SNIPE_MIN_HOLDERS/);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_TP1_SELL_PERCENT: "100" }), /MAYHEM_SNIPE_TP1_SELL_PERCENT/);
});

test("validateConfig: no time exit needs the ladder, and TP2 must be above TP1", () => {
  const base = { DRY_RUN: "true", MAYHEM_SNIPE_MODE: "paper" };
  assert.throws(() => validateConfig(buildConfig({ ...base, MAYHEM_SNIPE_HOLD_SECONDS: "0" })), /never sells/);
  assert.throws(
    () => validateConfig(buildConfig({ ...base, MAYHEM_SNIPE_TP1_PERCENT: "300", MAYHEM_SNIPE_TP2_PERCENT: "78" })),
    /TP2_PERCENT must be above/
  );
  assert.doesNotThrow(() =>
    validateConfig(buildConfig({ ...base, MAYHEM_SNIPE_TP1_PERCENT: "78", MAYHEM_SNIPE_HOLD_SECONDS: "0" }))
  );
});

test("MAYHEM_SNIPE_MIN_AGE_SECONDS: defaults to 0, accepts 5, rejects out of range", () => {
  assert.equal(buildConfig({}).mayhemSnipeMinAgeSeconds, 0);
  assert.equal(buildConfig({ MAYHEM_SNIPE_MIN_AGE_SECONDS: "5" }).mayhemSnipeMinAgeSeconds, 5);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MIN_AGE_SECONDS: "120" }), /MAYHEM_SNIPE_MIN_AGE_SECONDS/);
  assert.throws(() => buildConfig({ MAYHEM_SNIPE_MIN_AGE_SECONDS: "-1" }), /MAYHEM_SNIPE_MIN_AGE_SECONDS/);
});
