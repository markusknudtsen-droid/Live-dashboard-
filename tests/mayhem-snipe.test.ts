import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { buildConfig } from "../src/config.js";
import {
  decodeCurve,
  evaluateCandidate,
  liquidityUsd,
  parseMayhemCreate,
  quoteBuy,
  quoteSell,
  withinSlippage,
  type CurveState,
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
