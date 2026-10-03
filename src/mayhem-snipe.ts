/**
 * Pump.fun "mayhem mode" sniper: PAPER ONLY. It simulates against the live bonding curve
 * and never signs or sends a transaction. A live mode does not exist on purpose: getting in
 * fast live needs a direct pump.fun buy/sell with the wallet key, which is a separate, much
 * riskier piece of work.
 *
 * Entry (all configurable, see MAYHEM_SNIPE_* in config.ts):
 *  - a coin qualifies if its creation event has is_mayhem_mode and a SOL quote;
 *  - the curve is polled once a second (one batched RPC call for every coin and position);
 *  - it is bought the moment its REAL SOL reserves (the liquidity that can actually be pulled
 *    out) are worth >= MIN_LIQUIDITY_USD AND, if MIN_HOLDERS is set, it has that many holders,
 *    provided the coin is at least MIN_AGE and at most BUY_DEADLINE seconds old;
 *  - holders = non-empty token accounts minus the curve's own, read on-chain with
 *    getTokenLargestAccounts (capped at 19 by that call), and only for coins that already
 *    pass every other check.
 *
 * Exit, one of two modes:
 *  - timed (default): 100% is sold HOLD_SECONDS after launch, whatever the price;
 *  - ladder (MAYHEM_SNIPE_TP1_PERCENT > 0): TP1_SELL_PERCENT of the position is sold the first
 *    time its price is TP1_PERCENT above cost and the rest at TP2_PERCENT. Nothing else is
 *    checked: the sell fires on the first poll that crosses the target. There is no stop-loss,
 *    so a position that never reaches a target stays open (HOLD_SECONDS > 0 adds an optional
 *    time exit for whatever is left). "Price" is what the remaining tokens would fetch on the
 *    curve right now, capped by the SOL it really holds, so a drained curve can never fire a
 *    phantom take-profit off its leftover virtual price. Open positions are saved to
 *    data/mayhem-open.json so a restart does not lose them.
 *
 * Both sides tolerate MAYHEM_SNIPE_SLIPPAGE_PERCENT slippage. A fill is simulated
 * MAYHEM_SNIPE_FILL_DELAY_MS after the quote against a fresh read of the curve, because that
 * is the movement a live transaction would face; if the fill is worse than the tolerance, the
 * trade fails (a failed sell is retried).
 *
 * Layouts come from pump.fun's published IDL (pump-fun/pump-public-docs, idl/pump.json) and
 * were checked against live mainnet events on 2026-10-03: CreateEvent.is_mayhem_mode is the
 * byte 200 after the uri, BondingCurve.is_mayhem_mode is account byte 81.
 *
 * Simplifications that flatter the result, so read the numbers with them in mind: our own
 * paper trade does not move the curve, other snipers' competing buys are only seen through
 * the fill-delay re-read, and the 1.25% fee is an assumption.
 * ponytail: one poll timer, no per-coin sockets. Revisit if the RPC rate-limits.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { logger } from "./logger.js";
import { PUMP_FUN_MINT_AUTHORITY, toWebsocketUrl } from "./onchain-feed.js";
import { PUMP_FUN_PROGRAM } from "./onchain-launchpads.js";

const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const WSOL = "So11111111111111111111111111111111111111112";
const POLL_MS = 1000;
const LAMPORTS = 1_000_000_000;

export interface MayhemLaunch {
  mint: string;
  symbol: string;
  /** Chain block time of the creation, epoch ms (1s resolution). */
  chainTimeMs: number;
}

export interface CurveState {
  vTok: bigint;
  vSol: bigint;
  rTok: bigint;
  rSol: bigint;
  complete: boolean;
  mayhem: boolean;
  quoteIsSol: boolean;
}

const isSolQuote = (bytes: Uint8Array): boolean => {
  if (bytes.every((b) => b === 0)) return true; // default pubkey = native SOL
  return new PublicKey(bytes).toBase58() === WSOL;
};

function readStr(buf: Buffer, offset: number): { value: string; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const n = buf.readUInt32LE(offset);
  if (n > 1_000 || offset + 4 + n > buf.length) return null;
  return { value: buf.toString("utf8", offset + 4, offset + 4 + n), next: offset + 4 + n };
}

/** Pure: a mayhem, SOL-quoted pump.fun creation from a transaction's logs, else null. */
export function parseMayhemCreate(logs: readonly string[]): MayhemLaunch | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice(14), "base64");
    } catch {
      continue;
    }
    if (buf.length < 8 || !buf.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;
    const name = readStr(buf, 8);
    const symbol = name && readStr(buf, name.next);
    const uri = symbol && readStr(buf, symbol.next);
    if (!uri) continue;
    const o = uri.next;
    if (buf.length - o < 234) continue; // needs everything up to and including quote_mint
    if (buf[o + 200] !== 1) continue; // is_mayhem_mode
    if (!isSolQuote(buf.subarray(o + 202, o + 234))) continue;
    try {
      return {
        mint: new PublicKey(buf.subarray(o, o + 32)).toBase58(),
        // Names are attacker-controlled: keep only a short alphanumeric tag for logs.
        symbol: (symbol as { value: string }).value.replace(/[^A-Za-z0-9$]/g, "").slice(0, 12),
        chainTimeMs: Number(buf.readBigInt64LE(o + 128)) * 1000,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Pure: BondingCurve account data -> the fields the simulation needs, else null. */
export function decodeCurve(data: Uint8Array | null | undefined): CurveState | null {
  if (!data || data.length < 115) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  return {
    vTok: b.readBigUInt64LE(8),
    vSol: b.readBigUInt64LE(16),
    rTok: b.readBigUInt64LE(24),
    rSol: b.readBigUInt64LE(32),
    complete: b[48] === 1,
    mayhem: b[81] === 1,
    quoteIsSol: isSolQuote(b.subarray(83, 115)),
  };
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Pure: tokens received for `solInLamports` on this curve (constant product, fee on input). */
export function quoteBuy(c: CurveState, solInLamports: bigint, feeBps: bigint): bigint {
  const net = solInLamports - (solInLamports * feeBps) / 10_000n;
  if (net <= 0n || c.vSol <= 0n || c.vTok <= 0n) return 0n;
  const out = c.vTok - ceilDiv(c.vTok * c.vSol, c.vSol + net);
  return out > c.rTok ? c.rTok : out < 0n ? 0n : out;
}

/** Pure: lamports received for selling `tokens` (fee on output, capped at the curve's real SOL). */
export function quoteSell(c: CurveState, tokens: bigint, feeBps: bigint): bigint {
  if (tokens <= 0n || c.vSol <= 0n || c.vTok <= 0n) return 0n;
  let gross = c.vSol - ceilDiv(c.vTok * c.vSol, c.vTok + tokens);
  if (gross > c.rSol) gross = c.rSol; // the curve cannot pay out more SOL than it holds
  if (gross < 0n) gross = 0n;
  return gross - (gross * feeBps) / 10_000n;
}

/** Pure: on-chain min-out semantics. `filled` may be at most `slippagePct` worse than `quoted`. */
export function withinSlippage(quoted: bigint, filled: bigint, slippagePct: number): boolean {
  return Number(filled) >= Number(quoted) * (1 - slippagePct / 100);
}

export function liquidityUsd(realSolLamports: bigint, solUsd: number): number {
  return (Number(realSolLamports) / LAMPORTS) * solUsd;
}

/**
 * Pure: holders from getTokenLargestAccounts. A live curve's own token account is always
 * the biggest non-empty one, so it is subtracted. Token accounts, not distinct owners.
 */
export function holdersFromLargest(accounts: ReadonlyArray<{ amount: string }>): number {
  const nonEmpty = accounts.filter((a) => a.amount !== "0").length;
  return Math.max(0, nonEmpty - 1);
}

export interface SnipeRules {
  minLiquidityUsd: number;
  buyDeadlineMs: number;
  /**
   * Do not buy before the coin is this old. A coin still liquid at that age is bought; one
   * whose liquidity was pulled in the meantime simply runs out the clock and is skipped.
   */
  minAgeMs?: number;
  /** Do not buy a coin with fewer holders than this (0 or unset = no check). */
  minHolders?: number;
}

export interface Decision {
  action: "buy" | "wait" | "skip";
  reason: string;
  liquidityUsd: number;
}

/**
 * Pure: what to do with a coin right now, given its curve, launch time and the SOL price.
 * `holders` is the last known holder count (undefined if never read).
 */
export function evaluateCandidate(
  curve: CurveState,
  launchMs: number,
  nowMs: number,
  solUsd: number | undefined,
  rules: SnipeRules,
  holders?: number
): Decision {
  const liq = solUsd ? liquidityUsd(curve.rSol, solUsd) : 0;
  if (!curve.mayhem) return { action: "skip", reason: "curve is not in mayhem mode", liquidityUsd: liq };
  if (!curve.quoteIsSol) return { action: "skip", reason: "curve is not SOL-quoted", liquidityUsd: liq };
  if (curve.complete) return { action: "skip", reason: "curve already complete", liquidityUsd: liq };
  const late = nowMs - launchMs > rules.buyDeadlineMs;
  if (!solUsd) {
    return late
      ? { action: "skip", reason: "no SOL price to value liquidity", liquidityUsd: 0 }
      : { action: "wait", reason: "no SOL price yet", liquidityUsd: 0 };
  }
  if (liq >= rules.minLiquidityUsd) {
    const minHolders = rules.minHolders ?? 0;
    const holdersShort = minHolders > 0 && (holders === undefined || holders < minHolders);
    if (late) {
      return holdersShort
        ? { action: "skip", reason: `holders ${holders ?? "?"} < ${minHolders} at the deadline (liquidity $${liq.toFixed(0)})`, liquidityUsd: liq }
        : { action: "skip", reason: `reached $${liq.toFixed(0)} only after the ${rules.buyDeadlineMs / 1000}s deadline`, liquidityUsd: liq };
    }
    const minAgeMs = rules.minAgeMs ?? 0;
    if (nowMs - launchMs < minAgeMs) {
      return { action: "wait", reason: `liquidity $${liq.toFixed(0)}, waiting until ${minAgeMs / 1000}s old`, liquidityUsd: liq };
    }
    if (holdersShort) {
      return { action: "wait", reason: holders === undefined ? "holders unknown" : `holders ${holders} < ${minHolders}`, liquidityUsd: liq };
    }
    return { action: "buy", reason: `liquidity $${liq.toFixed(0)}`, liquidityUsd: liq };
  }
  return late
    ? { action: "skip", reason: `liquidity $${liq.toFixed(0)} < $${rules.minLiquidityUsd} at the deadline`, liquidityUsd: liq }
    : { action: "wait", reason: `liquidity $${liq.toFixed(0)} < $${rules.minLiquidityUsd}`, liquidityUsd: liq };
}

/** Pure: true when only the holder count stands between this coin and a buy (worth one RPC call). */
export function holdersNeeded(
  curve: CurveState,
  launchMs: number,
  nowMs: number,
  solUsd: number | undefined,
  rules: SnipeRules
): boolean {
  if (!solUsd || (rules.minHolders ?? 0) <= 0) return false;
  if (!curve.mayhem || !curve.quoteIsSol || curve.complete) return false;
  const age = nowMs - launchMs;
  if (age > rules.buyDeadlineMs || age < (rules.minAgeMs ?? 0)) return false;
  return liquidityUsd(curve.rSol, solUsd) >= rules.minLiquidityUsd;
}

export interface Ladder {
  tp1Pct: number;
  /** Share of the position sold at TP1, percent. */
  tp1SellPct: number;
  tp2Pct: number;
}

export type LadderAction = { leg: "none" } | { leg: "tp1" | "tp2"; fraction: number };

/**
 * Pure: which take-profit, if any, is due. `value` is what ALL the remaining tokens would
 * fetch right now on the curve (no fee, capped at the SOL the curve holds), `basis` the cost
 * of the whole original position. Targets are measured against the cost of what is left, so
 * TP2 means the remaining tokens' price is TP2_PERCENT above what was paid for them.
 * A price that gaps straight past TP2 sells everything.
 */
export function ladderAction(
  p: { basis: number; initialTokens: bigint; tokens: bigint; tp1Done: boolean },
  value: number,
  ladder: Ladder
): LadderAction {
  if (p.tokens <= 0n || p.initialTokens <= 0n) return { leg: "none" };
  const basisLeft = p.basis * (Number(p.tokens) / Number(p.initialTokens));
  if (value >= basisLeft * (1 + ladder.tp2Pct / 100)) return { leg: "tp2", fraction: 1 };
  if (!p.tp1Done && value >= basisLeft * (1 + ladder.tp1Pct / 100)) return { leg: "tp1", fraction: ladder.tp1SellPct / 100 };
  return { leg: "none" };
}

// ---- runtime (impure) -----------------------------------------------------------------

interface Tracked {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
  /** Highest liquidity (USD) seen while tracking: shows how much early liquidity later vanished. */
  peakLiq: number;
  /** Last holder count read (only read once a coin passes every other check). */
  holders?: number;
}

interface Leg {
  leg: "tp1" | "tp2" | "time";
  ageMs: number;
  tokens: string;
  solOut: number;
}

interface Position {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
  /** Lamports paid, fee included. */
  stake: bigint;
  /** Lamports of the stake that bought tokens (fee excluded): what the price targets measure. */
  basis: bigint;
  initialTokens: bigint;
  tokens: bigint;
  realized: bigint;
  tp1Done: boolean;
  legs: Leg[];
  buyAgeMs: number;
  liqAtBuy: number;
  holdersAtBuy?: number;
  solUsd: number;
  buyQuoted: bigint;
  lastValue?: bigint;
  selling?: boolean;
  unpriced?: boolean;
}

interface StoredPosition {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
  stake: string;
  basis: string;
  initialTokens: string;
  tokens: string;
  realized: string;
  tp1Done: boolean;
  legs: Leg[];
  buyAgeMs: number;
  liqAtBuy: number;
  holdersAtBuy?: number;
  solUsd: number;
  buyQuoted: string;
}

const active = new Map<string, Tracked>();
const positions = new Map<string, Position>();
let connection: Connection | null = null;
let started = false;
let polling = false;
let lastSummaryAt = 0;
const totals = { closed: 0, wins: 0, failed: 0, pnlSol: 0 };
let solUsdCache: { at: number; value: number } | null = null;
let writeChain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const feeBps = (): bigint => BigInt(Math.round(CONFIG.mayhemSnipeFeePercent * 100));
const curvePda = (mint: string): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_FUN_PROGRAM))[0];
const dataFile = (name: string): string => path.join(path.dirname(CONFIG.stateFilePath), name);
const ladderCfg = (): Ladder | null =>
  CONFIG.mayhemSnipeTp1Percent > 0
    ? { tp1Pct: CONFIG.mayhemSnipeTp1Percent, tp1SellPct: CONFIG.mayhemSnipeTp1SellPercent, tp2Pct: CONFIG.mayhemSnipeTp2Percent }
    : null;

function record(obj: Record<string, unknown>): void {
  const file = dataFile("mayhem-snipes.jsonl");
  const line = JSON.stringify({ t: Date.now(), ...obj }) + "\n";
  writeChain = writeChain
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line, "utf-8");
    })
    .catch((e) => logger.debug(`mayhem snipe log write failed: ${e instanceof Error ? e.message : String(e)}`));
}

function savePositions(): void {
  const file = dataFile("mayhem-open.json");
  const stored: StoredPosition[] = [...positions.values()].map((p) => ({
    mint: p.mint,
    symbol: p.symbol,
    launchMs: p.launchMs,
    detectedAt: p.detectedAt,
    stake: p.stake.toString(),
    basis: p.basis.toString(),
    initialTokens: p.initialTokens.toString(),
    tokens: p.tokens.toString(),
    realized: p.realized.toString(),
    tp1Done: p.tp1Done,
    legs: p.legs,
    buyAgeMs: p.buyAgeMs,
    liqAtBuy: p.liqAtBuy,
    holdersAtBuy: p.holdersAtBuy,
    solUsd: p.solUsd,
    buyQuoted: p.buyQuoted.toString(),
  }));
  writeChain = writeChain
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(stored), "utf-8");
      await rename(`${file}.tmp`, file);
    })
    .catch((e) => logger.debug(`mayhem open-positions save failed: ${e instanceof Error ? e.message : String(e)}`));
}

function loadPositions(): void {
  try {
    const stored = JSON.parse(readFileSync(dataFile("mayhem-open.json"), "utf-8")) as StoredPosition[];
    for (const s of stored) {
      positions.set(s.mint, {
        mint: s.mint,
        symbol: s.symbol,
        launchMs: s.launchMs,
        detectedAt: s.detectedAt,
        stake: BigInt(s.stake),
        basis: BigInt(s.basis),
        initialTokens: BigInt(s.initialTokens),
        tokens: BigInt(s.tokens),
        realized: BigInt(s.realized),
        tp1Done: s.tp1Done,
        legs: s.legs ?? [],
        buyAgeMs: s.buyAgeMs,
        liqAtBuy: s.liqAtBuy,
        holdersAtBuy: s.holdersAtBuy,
        solUsd: s.solUsd,
        buyQuoted: BigInt(s.buyQuoted),
      });
    }
    if (positions.size > 0) logger.info(`🎯 MAYHEM_SNIPE resumed ${positions.size} open paper position(s) from the last run.`);
  } catch {
    /* no saved positions */
  }
}

async function getSolUsd(): Promise<number | undefined> {
  const now = Date.now();
  if (solUsdCache && now - solUsdCache.at < 60_000) return solUsdCache.value;
  try {
    const res = await fetch(`${CONFIG.dexScreenerApiUrl}/tokens/v1/solana/${WSOL}`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const pairs = (await res.json()) as Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
      const best = pairs
        .filter((p) => Number(p.priceUsd) > 0)
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (best) {
        solUsdCache = { at: now, value: Number(best.priceUsd) };
        return solUsdCache.value;
      }
    }
  } catch {
    /* fall through to the stale value */
  }
  // A stale price beats none for a USD liquidity bar; unknown beyond 10 minutes is not trusted.
  return solUsdCache && now - solUsdCache.at < 600_000 ? solUsdCache.value : undefined;
}

async function readCurve(mint: string): Promise<CurveState | null> {
  try {
    const info = await connection!.getAccountInfo(curvePda(mint), "confirmed");
    return decodeCurve(info?.data);
  } catch {
    return null;
  }
}

async function fetchHolders(mint: string): Promise<number | undefined> {
  try {
    const res = await connection!.getTokenLargestAccounts(new PublicKey(mint), "confirmed");
    return holdersFromLargest(res.value.map((v) => ({ amount: v.amount })));
  } catch {
    return undefined;
  }
}

/** Simulated strict sell: quote, wait the fill delay, fill against a fresh read; up to 3 attempts. */
async function sellTokens(mint: string, tokens: bigint): Promise<bigint | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const quoteCurve = await readCurve(mint);
    if (quoteCurve && quoteCurve.quoteIsSol && !quoteCurve.complete) {
      const quoted = quoteSell(quoteCurve, tokens, feeBps());
      await sleep(CONFIG.mayhemSnipeFillDelayMs);
      const fillCurve = (await readCurve(mint)) ?? quoteCurve;
      const filled = quoteSell(fillCurve, tokens, feeBps());
      if (withinSlippage(quoted, filled, CONFIG.mayhemSnipeSlippagePercent)) return filled;
    }
    await sleep(300);
  }
  return null;
}

async function simulateBuy(t: Tracked, decided: CurveState, liqUsd: number, solUsd: number): Promise<void> {
  const stake = BigInt(Math.round(CONFIG.mayhemSnipeStakeSol * LAMPORTS));
  const quoted = quoteBuy(decided, stake, feeBps());
  await sleep(CONFIG.mayhemSnipeFillDelayMs);
  const at = await readCurve(t.mint);
  const base = { mint: t.mint, symbol: t.symbol, detectLagMs: t.detectedAt - t.launchMs };
  if (!at || !at.quoteIsSol || at.complete) {
    record({ type: "fail", ...base, side: "buy", reason: "curve unreadable at fill" });
    totals.failed += 1;
    return;
  }
  const filled = quoteBuy(at, stake, feeBps());
  if (filled <= 0n || !withinSlippage(quoted, filled, CONFIG.mayhemSnipeSlippagePercent)) {
    record({ type: "fail", ...base, side: "buy", reason: `slippage: quoted ${quoted} filled ${filled}`, liquidityUsd: liqUsd });
    totals.failed += 1;
    logger.info(`🎯 SNIPE ${t.symbol}: buy failed, price ran past ${CONFIG.mayhemSnipeSlippagePercent}% slippage.`);
    return;
  }
  const buyAgeMs = Date.now() - t.launchMs;
  logger.info(
    `🎯 SNIPE BUY ${t.symbol}: ${CONFIG.mayhemSnipeStakeSol} SOL at ${(buyAgeMs / 1000).toFixed(1)}s after launch, ` +
      `liquidity $${liqUsd.toFixed(0)}${t.holders !== undefined ? `, ${t.holders} holders` : ""} (paper).`
  );
  if (ladderCfg()) {
    const fee = (stake * feeBps()) / 10_000n;
    positions.set(t.mint, {
      mint: t.mint,
      symbol: t.symbol,
      launchMs: t.launchMs,
      detectedAt: t.detectedAt,
      stake,
      basis: stake - fee,
      initialTokens: filled,
      tokens: filled,
      realized: 0n,
      tp1Done: false,
      legs: [],
      buyAgeMs,
      liqAtBuy: liqUsd,
      holdersAtBuy: t.holders,
      solUsd,
      buyQuoted: quoted,
    });
    savePositions();
    return;
  }
  const sellDelay = Math.max(0, t.launchMs + CONFIG.mayhemSnipeHoldSeconds * 1000 - Date.now());
  setTimeout(() => {
    void simulateSell(t, filled, stake, quoted, buyAgeMs, liqUsd, solUsd).catch(() => undefined);
  }, sellDelay);
}

/** Timed mode: sell the whole position, whatever the price. */
async function simulateSell(
  t: Tracked,
  tokens: bigint,
  stake: bigint,
  buyQuoted: bigint,
  buyAgeMs: number,
  liqAtBuy: number,
  solUsd: number
): Promise<void> {
  const base = { mint: t.mint, symbol: t.symbol, detectLagMs: t.detectedAt - t.launchMs };
  const filled = await sellTokens(t.mint, tokens);
  if (filled === null) {
    totals.failed += 1;
    record({ type: "fail", ...base, side: "sell", reason: "no fill within slippage after 3 attempts", stakeSol: Number(stake) / LAMPORTS });
    logger.warn(`🎯 SNIPE ${t.symbol}: sell could not fill within ${CONFIG.mayhemSnipeSlippagePercent}% slippage after 3 attempts (counted as failed, not as a loss).`);
    return;
  }
  const pnlSol = (Number(filled) - Number(stake)) / LAMPORTS;
  const pnlPct = (Number(filled) / Number(stake) - 1) * 100;
  totals.closed += 1;
  if (pnlSol > 0) totals.wins += 1;
  totals.pnlSol += pnlSol;
  record({
    type: "snipe",
    ...base,
    stakeSol: Number(stake) / LAMPORTS,
    buyAgeMs,
    exitAgeMs: Date.now() - t.launchMs,
    liquidityUsdAtBuy: liqAtBuy,
    holdersAtBuy: t.holders,
    solUsd,
    tokens: tokens.toString(),
    buyQuotedTokens: buyQuoted.toString(),
    solOut: Number(filled) / LAMPORTS,
    pnlSol,
    pnlPct,
  });
  logger.info(
    `🎯 SNIPE SELL ${t.symbol}: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL) at ${((Date.now() - t.launchMs) / 1000).toFixed(1)}s. ` +
      `Running: ${totals.closed} closed, ${totals.wins} wins, ${totals.pnlSol >= 0 ? "+" : ""}${totals.pnlSol.toFixed(4)} SOL, ${totals.failed} failed.`
  );
}

/** Ladder mode: the position is fully sold, so book it. */
function finalizePosition(pos: Position): void {
  const pnlSol = (Number(pos.realized) - Number(pos.stake)) / LAMPORTS;
  const pnlPct = (Number(pos.realized) / Number(pos.stake) - 1) * 100;
  totals.closed += 1;
  if (pnlSol > 0) totals.wins += 1;
  totals.pnlSol += pnlSol;
  const last = pos.legs[pos.legs.length - 1];
  record({
    type: "snipe",
    mode: "ladder",
    mint: pos.mint,
    symbol: pos.symbol,
    detectLagMs: pos.detectedAt - pos.launchMs,
    stakeSol: Number(pos.stake) / LAMPORTS,
    buyAgeMs: pos.buyAgeMs,
    exitAgeMs: last?.ageMs ?? 0,
    liquidityUsdAtBuy: pos.liqAtBuy,
    holdersAtBuy: pos.holdersAtBuy,
    solUsd: pos.solUsd,
    tokens: pos.initialTokens.toString(),
    buyQuotedTokens: pos.buyQuoted.toString(),
    solOut: Number(pos.realized) / LAMPORTS,
    pnlSol,
    pnlPct,
    legs: pos.legs,
  });
  positions.delete(pos.mint);
  logger.info(
    `🎯 SNIPE CLOSED ${pos.symbol}: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL). ` +
      `Running: ${totals.closed} closed, ${totals.wins} wins, ${totals.pnlSol >= 0 ? "+" : ""}${totals.pnlSol.toFixed(4)} SOL, ${positions.size} still open.`
  );
}

/** Ladder mode: sell `fraction` of what is left, immediately, with no other checks. */
async function exitLeg(pos: Position, leg: Leg["leg"], fraction: number): Promise<void> {
  if (pos.selling) return;
  pos.selling = true;
  try {
    const amount = fraction >= 1 ? pos.tokens : (pos.tokens * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    if (amount <= 0n) return;
    const out = await sellTokens(pos.mint, amount);
    if (out === null) {
      record({ type: "fail", mint: pos.mint, symbol: pos.symbol, side: "sell", leg, reason: "no fill within slippage after 3 attempts" });
      logger.warn(`🎯 SNIPE ${pos.symbol}: ${leg} sell could not fill within ${CONFIG.mayhemSnipeSlippagePercent}% slippage; it stays open and is retried.`);
      return;
    }
    pos.tokens -= amount;
    pos.realized += out;
    if (leg === "tp1") pos.tp1Done = true;
    const ageMs = Date.now() - pos.launchMs;
    pos.legs.push({ leg, ageMs, tokens: amount.toString(), solOut: Number(out) / LAMPORTS });
    record({
      type: "leg",
      mint: pos.mint,
      symbol: pos.symbol,
      leg,
      ageMs,
      soldTokens: amount.toString(),
      solOut: Number(out) / LAMPORTS,
      remainingTokens: pos.tokens.toString(),
    });
    logger.info(
      `🎯 SNIPE ${leg.toUpperCase()} ${pos.symbol}: sold ${((Number(amount) / Number(pos.initialTokens)) * 100).toFixed(0)}% of the position ` +
        `for ${(Number(out) / LAMPORTS).toFixed(4)} SOL, ${(ageMs / 1000).toFixed(0)}s after launch.`
    );
    if (pos.tokens <= 0n) finalizePosition(pos);
    savePositions();
  } finally {
    pos.selling = false;
  }
}

/** Ladder mode, once a second: price each open position and fire any take-profit that is due. */
function monitorPositions(now: number, byMint: Map<string, Uint8Array | undefined>): void {
  const ladder = ladderCfg();
  const holdMs = CONFIG.mayhemSnipeHoldSeconds * 1000;
  for (const pos of [...positions.values()]) {
    if (pos.selling) continue;
    const curve = decodeCurve(byMint.get(pos.mint));
    if (!curve) continue;
    if (curve.complete) {
      // A graduated curve cannot be sold into; it trades on the AMM now. Left open and flagged.
      if (!pos.unpriced) {
        pos.unpriced = true;
        logger.warn(`🎯 SNIPE ${pos.symbol}: the curve graduated while the position was open; it can no longer be priced here.`);
      }
      continue;
    }
    const value = quoteSell(curve, pos.tokens, 0n);
    pos.lastValue = value;
    const action: LadderAction = ladder
      ? ladderAction({ basis: Number(pos.basis), initialTokens: pos.initialTokens, tokens: pos.tokens, tp1Done: pos.tp1Done }, Number(value), ladder)
      : { leg: "none" };
    if (action.leg !== "none") void exitLeg(pos, action.leg, action.fraction).catch(() => undefined);
    else if (holdMs > 0 && now >= pos.launchMs + holdMs) void exitLeg(pos, "time", 1).catch(() => undefined);
  }
}

function logSummary(now: number): void {
  if (positions.size === 0 || now - lastSummaryAt < 60_000) return;
  lastSummaryAt = now;
  let value = 0;
  let cost = 0;
  for (const p of positions.values()) {
    value += Number(p.lastValue ?? 0n);
    cost += Number(p.basis) * (Number(p.tokens) / Number(p.initialTokens));
  }
  logger.info(
    `🎯 SNIPE OPEN: ${positions.size} position(s) marked at ${(value / LAMPORTS).toFixed(4)} SOL against ${(cost / LAMPORTS).toFixed(4)} SOL cost. ` +
      `Closed so far: ${totals.closed} (${totals.wins} wins, ${totals.pnlSol >= 0 ? "+" : ""}${totals.pnlSol.toFixed(4)} SOL).`
  );
}

async function pollOnce(): Promise<void> {
  if (polling || (active.size === 0 && positions.size === 0) || !connection) return;
  polling = true;
  try {
    const tracked = [...active.values()];
    const solUsd = await getSolUsd();
    const rules: SnipeRules = {
      minLiquidityUsd: CONFIG.mayhemSnipeMinLiquidityUsd,
      buyDeadlineMs: CONFIG.mayhemSnipeBuyDeadlineSeconds * 1000,
      minAgeMs: CONFIG.mayhemSnipeMinAgeSeconds * 1000,
      minHolders: CONFIG.mayhemSnipeMinHolders,
    };
    // One batched read covers every coin being watched and every open position.
    const mints = [...new Set([...tracked.map((t) => t.mint), ...positions.keys()])];
    const byMint = new Map<string, Uint8Array | undefined>();
    for (let i = 0; i < mints.length; i += 100) {
      const chunk = mints.slice(i, i + 100);
      try {
        const infos = await connection.getMultipleAccountsInfo(chunk.map(curvePda), "confirmed");
        chunk.forEach((m, idx) => byMint.set(m, infos[idx]?.data));
      } catch {
        /* unreadable this tick: everything waits for the next one */
      }
    }
    const now = Date.now();
    monitorPositions(now, byMint);
    for (const t of tracked) {
      const curve = decodeCurve(byMint.get(t.mint));
      if (!curve) {
        // Account not visible yet: keep waiting until the deadline passes.
        if (now - t.launchMs > rules.buyDeadlineMs) {
          active.delete(t.mint);
          record({ type: "skip", mint: t.mint, symbol: t.symbol, reason: "curve never readable by the deadline" });
        }
        continue;
      }
      if (holdersNeeded(curve, t.launchMs, now, solUsd, rules)) {
        const h = await fetchHolders(t.mint);
        if (h !== undefined) t.holders = h;
      }
      const d = evaluateCandidate(curve, t.launchMs, now, solUsd, rules, t.holders);
      t.peakLiq = Math.max(t.peakLiq, d.liquidityUsd);
      if (d.action === "wait") continue;
      active.delete(t.mint);
      if (d.action === "skip") {
        record({
          type: "skip",
          mint: t.mint,
          symbol: t.symbol,
          reason: d.reason,
          liquidityUsd: d.liquidityUsd,
          peakLiquidityUsd: t.peakLiq,
          holders: t.holders,
          ageMs: now - t.launchMs,
        });
        continue;
      }
      void simulateBuy(t, curve, d.liquidityUsd, solUsd as number).catch(() => undefined);
    }
    logSummary(now);
  } finally {
    polling = false;
  }
}

export function startMayhemSnipe(): void {
  if (CONFIG.mayhemSnipeMode === "off" || started) return;
  try {
    loadPositions();
    const wsEndpoint = CONFIG.onchainFeedWsUrl || toWebsocketUrl(CONFIG.solanaRpcUrl);
    connection = new Connection(CONFIG.solanaRpcUrl, { wsEndpoint, commitment: "confirmed" });
    connection.onLogs(
      new PublicKey(PUMP_FUN_MINT_AUTHORITY),
      (logs) => {
        try {
          if (logs.err) return;
          const launch = parseMayhemCreate(logs.logs);
          if (!launch || active.has(launch.mint)) return;
          const now = Date.now();
          // Trust the chain's clock for "after launch", unless it is wildly off our own.
          const launchMs = Math.abs(now - launch.chainTimeMs) < 30_000 ? launch.chainTimeMs : now;
          active.set(launch.mint, { mint: launch.mint, symbol: launch.symbol, launchMs, detectedAt: now, peakLiq: 0 });
          void pollOnce().catch(() => undefined);
        } catch (error) {
          logger.debug(`mayhem snipe event ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      "confirmed"
    );
    setInterval(() => void pollOnce().catch(() => undefined), POLL_MS);
    started = true;
    logger.info("🎯 MAYHEM_SNIPE watching pump.fun creations (paper simulation, nothing is sent on-chain).");
  } catch (error) {
    logger.warn(`MAYHEM_SNIPE could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}
