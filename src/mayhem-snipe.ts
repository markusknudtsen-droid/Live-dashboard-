/**
 * Pump.fun launch sniper: PAPER ONLY. It simulates against the live bonding curve and never
 * signs or sends a transaction. A live mode does not exist on purpose: getting in fast live
 * needs a direct pump.fun buy/sell with the wallet key, which is a separate, much riskier
 * piece of work. (The "mayhem" name is historical; it can watch every pump.fun launch.)
 *
 * Entry (all configurable, see MAYHEM_SNIPE_* in config.ts):
 *  - a launch qualifies if it has a SOL quote and, unless ONLY_MAYHEM is off, is_mayhem_mode;
 *  - each watched coin's bonding curve is re-read by batched RPC calls: every second while it
 *    is brand new, less often as it ages (see pollIntervalMs) so a 10-minute window stays cheap;
 *  - it is bought the moment its REAL SOL reserves (the liquidity that can actually be pulled
 *    out) are worth >= MIN_LIQUIDITY_USD, the coin is between MIN_AGE and BUY_DEADLINE seconds
 *    old, and it passes the optional on-chain checks, which are only read once everything else
 *    already passes: MIN_HOLDERS, MAX_TOP10_PERCENT (the 10 biggest holders' share of supply,
 *    the curve's own account excluded) and REQUIRE_AUTHORITIES_DISABLED (mint and freeze
 *    authority both revoked). A coin with an enabled authority is skipped at once.
 *
 * Exit, one of two modes:
 *  - timed (default, no ladder): 100% is sold HOLD_SECONDS after launch, whatever the price;
 *  - ladder (MAYHEM_SNIPE_LADDER set): each leg "pct:sellPct" sells sellPct% of the ORIGINAL
 *    position the first time the price is pct% above cost; the last leg sells whatever is
 *    left. Sells fire on the first poll that crosses a target, with no other checks. Also:
 *      rug      RUG_DROP_PERCENT: real liquidity fell that far below its peak since the buy:
 *               sell 100%. On a curve that is drained in a single transaction there is nothing
 *               left to sell into by the time it is seen, so this mainly catches slow bleeds;
 *               because real SOL is only the part of the pool above the virtual 30 SOL it
 *               also behaves like a stop-loss around a third of the price;
 *      timeout  NO_SELL_TIMEOUT_SECONDS after the buy with no take-profit sold yet: sell 100%;
 *      time     HOLD_SECONDS > 0: sell whatever is left that long after launch.
 *    "Price" is what the remaining tokens would fetch on the curve right now, capped by the
 *    SOL it really holds, so a drained curve can never fire a phantom take-profit off its
 *    leftover virtual price. A coin that graduates to the AMM can no longer be sold into the
 *    curve; it is then priced from Jupiter's pool feed every 5s and exits are booked at that
 *    price less the fee. Open positions are saved to data/mayhem-open.json so a restart does
 *    not lose them.
 *
 * Both curve sides tolerate MAYHEM_SNIPE_SLIPPAGE_PERCENT slippage. A fill is simulated
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
 * the fill-delay re-read, the 1.25% fee is an assumption, and AMM exits have no slippage.
 * ponytail: one poll timer, no per-coin sockets. Revisit if the RPC rate-limits.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { fetchLivePrice } from "./live-price.js";
import { logger } from "./logger.js";
import { PUMP_FUN_MINT_AUTHORITY, toWebsocketUrl } from "./onchain-feed.js";
import { PUMP_FUN_PROGRAM } from "./onchain-launchpads.js";

const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const WSOL = "So11111111111111111111111111111111111111112";
const POLL_MS = 1000;
const LAMPORTS = 1_000_000_000;
/** Pump.fun launches tokens with 6 decimals (checked on mayhem Token-2022 mints too). */
export const TOKEN_DECIMALS = 6;
const MAX_WATCHED = 3000;

export interface PumpLaunch {
  mint: string;
  symbol: string;
  /** Chain block time of the creation, epoch ms (1s resolution). */
  chainTimeMs: number;
  mayhem: boolean;
}

export type MayhemLaunch = PumpLaunch;

export interface CurveState {
  vTok: bigint;
  vSol: bigint;
  rTok: bigint;
  rSol: bigint;
  /** Total token supply, raw units. */
  supply: bigint;
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

/** Pure: a SOL-quoted pump.fun creation (mayhem or not) from a transaction's logs, else null. */
export function parseCreate(logs: readonly string[]): PumpLaunch | null {
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
    if (!isSolQuote(buf.subarray(o + 202, o + 234))) continue;
    try {
      return {
        mint: new PublicKey(buf.subarray(o, o + 32)).toBase58(),
        // Names are attacker-controlled: keep only a short alphanumeric tag for logs.
        symbol: (symbol as { value: string }).value.replace(/[^A-Za-z0-9$]/g, "").slice(0, 12),
        chainTimeMs: Number(buf.readBigInt64LE(o + 128)) * 1000,
        mayhem: buf[o + 200] === 1,
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Pure: a mayhem, SOL-quoted pump.fun creation from a transaction's logs, else null. */
export function parseMayhemCreate(logs: readonly string[]): MayhemLaunch | null {
  const launch = parseCreate(logs);
  return launch && launch.mayhem ? launch : null;
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
    supply: b.readBigUInt64LE(40),
    complete: b[48] === 1,
    mayhem: b[81] === 1,
    quoteIsSol: isSolQuote(b.subarray(83, 115)),
  };
}

export interface MintAuthorities {
  mintDisabled: boolean;
  freezeDisabled: boolean;
}

/** Pure: an SPL / Token-2022 mint account -> whether mint and freeze authority are revoked. */
export function decodeMintAuthorities(data: Uint8Array | null | undefined): MintAuthorities | null {
  if (!data || data.length < 82) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.length);
  // COption tags: 0 = None (revoked). Mint authority at byte 0, freeze authority at byte 46.
  return { mintDisabled: b.readUInt32LE(0) === 0, freezeDisabled: b.readUInt32LE(46) === 0 };
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

/** Pure: lamports that `tokens` are worth at a USD price per token (used once a coin is on the AMM). */
export function ammValueLamports(tokens: bigint, priceUsd: number, solUsd: number): bigint {
  if (tokens <= 0n || !(priceUsd > 0) || !(solUsd > 0)) return 0n;
  return BigInt(Math.floor(((Number(tokens) / 10 ** TOKEN_DECIMALS) * priceUsd * LAMPORTS) / solUsd));
}

/**
 * Pure: holders from getTokenLargestAccounts. A live curve's own token account is always
 * the biggest non-empty one, so it is subtracted. Token accounts, not distinct owners.
 */
export function holdersFromLargest(accounts: ReadonlyArray<{ amount: string }>): number {
  const nonEmpty = accounts.filter((a) => a.amount !== "0").length;
  return Math.max(0, nonEmpty - 1);
}

/**
 * Pure: percent of the total supply held by the 10 biggest holders, not counting the curve's
 * own account (the biggest one of a live curve, which holds the unsold supply).
 */
export function top10Percent(accounts: ReadonlyArray<{ amount: string }>, supply: bigint): number {
  if (supply <= 0n) return 0;
  const amounts = accounts
    .map((a) => BigInt(a.amount))
    .filter((a) => a > 0n)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const top = amounts.slice(1, 11);
  const sum = top.reduce((s, a) => s + a, 0n);
  return Number((sum * 10_000n) / supply) / 100;
}

/** Pure: how often a watched coin is re-read. Fast while brand new or close to qualifying. */
export function pollIntervalMs(ageMs: number, nearThreshold: boolean): number {
  const byAge = ageMs < 30_000 ? 1_000 : ageMs < 120_000 ? 3_000 : 10_000;
  return nearThreshold ? Math.min(byAge, 2_000) : byAge;
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
  /** Do not buy when the 10 biggest holders own more than this share of supply (0/unset = off). */
  maxTop10Pct?: number;
  /** Require both mint and freeze authority to be revoked. */
  requireAuthoritiesDisabled?: boolean;
  /** Only mayhem-mode curves (default true). */
  requireMayhem?: boolean;
}

/** On-chain facts read only for a coin that already passes every other check. */
export interface CoinDetails {
  holders?: number;
  top10Pct?: number;
  mintDisabled?: boolean;
  freezeDisabled?: boolean;
}

export interface Decision {
  action: "buy" | "wait" | "skip";
  reason: string;
  liquidityUsd: number;
}

const detailRulesOn = (r: SnipeRules): boolean =>
  (r.minHolders ?? 0) > 0 || (r.maxTop10Pct ?? 0) > 0 || r.requireAuthoritiesDisabled === true;

/**
 * Pure: do the on-chain facts pass? `permanent` means it can never pass (a revoked authority
 * cannot come back), so the coin is skipped now instead of being polled to the deadline.
 */
export function detailsVerdict(rules: SnipeRules, d: CoinDetails | undefined): { ok: boolean; permanent: boolean; reason: string } {
  if (!detailRulesOn(rules)) return { ok: true, permanent: false, reason: "" };
  if (!d) return { ok: false, permanent: false, reason: "on-chain details unknown" };
  if (rules.requireAuthoritiesDisabled) {
    if (d.mintDisabled === undefined || d.freezeDisabled === undefined) return { ok: false, permanent: false, reason: "authorities unknown" };
    if (!d.mintDisabled) return { ok: false, permanent: true, reason: "mint authority enabled" };
    if (!d.freezeDisabled) return { ok: false, permanent: true, reason: "freeze authority enabled" };
  }
  const minHolders = rules.minHolders ?? 0;
  if (minHolders > 0 && (d.holders === undefined || d.holders < minHolders)) {
    return { ok: false, permanent: false, reason: `holders ${d.holders ?? "?"} < ${minHolders}` };
  }
  const maxTop10 = rules.maxTop10Pct ?? 0;
  if (maxTop10 > 0 && (d.top10Pct === undefined || d.top10Pct > maxTop10)) {
    return { ok: false, permanent: false, reason: `top 10 holders ${d.top10Pct === undefined ? "?" : d.top10Pct.toFixed(1)}% > ${maxTop10}%` };
  }
  return { ok: true, permanent: false, reason: "" };
}

/**
 * Pure: what to do with a coin right now, given its curve, launch time and the SOL price.
 * `details` are the last on-chain facts read (undefined if never read).
 */
export function evaluateCandidate(
  curve: CurveState,
  launchMs: number,
  nowMs: number,
  solUsd: number | undefined,
  rules: SnipeRules,
  details?: CoinDetails
): Decision {
  const liq = solUsd ? liquidityUsd(curve.rSol, solUsd) : 0;
  if ((rules.requireMayhem ?? true) && !curve.mayhem) return { action: "skip", reason: "curve is not in mayhem mode", liquidityUsd: liq };
  if (!curve.quoteIsSol) return { action: "skip", reason: "curve is not SOL-quoted", liquidityUsd: liq };
  if (curve.complete) return { action: "skip", reason: "curve already complete", liquidityUsd: liq };
  const late = nowMs - launchMs > rules.buyDeadlineMs;
  if (!solUsd) {
    return late
      ? { action: "skip", reason: "no SOL price to value liquidity", liquidityUsd: 0 }
      : { action: "wait", reason: "no SOL price yet", liquidityUsd: 0 };
  }
  if (liq >= rules.minLiquidityUsd) {
    const v = detailsVerdict(rules, details);
    if (!v.ok && v.permanent) return { action: "skip", reason: `${v.reason} (liquidity $${liq.toFixed(0)})`, liquidityUsd: liq };
    if (late) {
      return !v.ok
        ? { action: "skip", reason: `${v.reason} at the deadline (liquidity $${liq.toFixed(0)})`, liquidityUsd: liq }
        : { action: "skip", reason: `reached $${liq.toFixed(0)} only after the ${rules.buyDeadlineMs / 1000}s deadline`, liquidityUsd: liq };
    }
    const minAgeMs = rules.minAgeMs ?? 0;
    if (nowMs - launchMs < minAgeMs) {
      return { action: "wait", reason: `liquidity $${liq.toFixed(0)}, waiting until ${minAgeMs / 1000}s old`, liquidityUsd: liq };
    }
    if (!v.ok) return { action: "wait", reason: v.reason, liquidityUsd: liq };
    return { action: "buy", reason: `liquidity $${liq.toFixed(0)}`, liquidityUsd: liq };
  }
  return late
    ? { action: "skip", reason: `liquidity $${liq.toFixed(0)} < $${rules.minLiquidityUsd} at the deadline`, liquidityUsd: liq }
    : { action: "wait", reason: `liquidity $${liq.toFixed(0)} < $${rules.minLiquidityUsd}`, liquidityUsd: liq };
}

/** Pure: true when only the on-chain checks stand between this coin and a buy (worth RPC calls). */
export function detailsNeeded(
  curve: CurveState,
  launchMs: number,
  nowMs: number,
  solUsd: number | undefined,
  rules: SnipeRules
): boolean {
  if (!solUsd || !detailRulesOn(rules)) return false;
  if (((rules.requireMayhem ?? true) && !curve.mayhem) || !curve.quoteIsSol || curve.complete) return false;
  const age = nowMs - launchMs;
  if (age > rules.buyDeadlineMs || age < (rules.minAgeMs ?? 0)) return false;
  return liquidityUsd(curve.rSol, solUsd) >= rules.minLiquidityUsd;
}

/** One take-profit step: at `pct`% above cost sell `sellPct`% of the ORIGINAL position (last leg: the rest). */
export interface LadderLeg {
  pct: number;
  sellPct: number;
}

export type LadderAction = { leg: "none" } | { leg: string; fraction: number; done: number };

/**
 * Pure: which take-profit, if any, is due. `value` is what ALL the remaining tokens would
 * fetch right now (no fee, capped at the SOL the curve holds), `basis` the cost of the whole
 * original position, `legsDone` how many legs have already sold. The price ratio is the same
 * for what is left as for the whole position, so legs are compared on that. When a price
 * gaps past several legs at once they are sold together; passing the last leg sells all.
 * `fraction` is the share of the CURRENT remaining tokens to sell now.
 */
export function ladderAction(
  p: { basis: number; initialTokens: bigint; tokens: bigint; legsDone: number },
  value: number,
  legs: readonly LadderLeg[]
): LadderAction {
  if (p.tokens <= 0n || p.initialTokens <= 0n || legs.length === 0 || p.legsDone >= legs.length) return { leg: "none" };
  const basisLeft = p.basis * (Number(p.tokens) / Number(p.initialTokens));
  if (!(basisLeft > 0)) return { leg: "none" };
  const ratio = value / basisLeft;
  let crossed = -1;
  for (let i = p.legsDone; i < legs.length; i++) {
    if (ratio >= 1 + (legs[i] as LadderLeg).pct / 100) crossed = i;
    else break;
  }
  if (crossed < 0) return { leg: "none" };
  const last = legs.length - 1;
  if (crossed === last) return { leg: `tp${last + 1}`, fraction: 1, done: legs.length };
  const doneShare = legs.slice(0, p.legsDone).reduce((s, l) => s + l.sellPct, 0);
  const sellShare = legs.slice(p.legsDone, crossed + 1).reduce((s, l) => s + l.sellPct, 0);
  return { leg: `tp${crossed + 1}`, fraction: sellShare / (100 - doneShare), done: crossed + 1 };
}

/** Pure: real liquidity has fallen `dropPct`% or more below its peak since the buy. */
export function rugTriggered(peakRealSol: number, nowRealSol: number, dropPct: number): boolean {
  return dropPct > 0 && peakRealSol > 0 && nowRealSol <= peakRealSol * (1 - dropPct / 100);
}

/** Pure: no take-profit has sold within `timeoutMs` of the buy. */
export function noSellTimedOut(p: { anySold: boolean; boughtAt: number }, nowMs: number, timeoutMs: number): boolean {
  return timeoutMs > 0 && !p.anySold && nowMs - p.boughtAt >= timeoutMs;
}

// ---- runtime (impure) -----------------------------------------------------------------

interface Tracked {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
  mayhem: boolean;
  /** Highest liquidity (USD) seen while tracking: shows how much early liquidity later vanished. */
  peakLiq: number;
  /** Last on-chain facts read (only read once a coin passes every other check). */
  details?: CoinDetails;
  /** Epoch ms of the next curve read; older coins are read less often. */
  nextCheckAt: number;
}

interface Leg {
  leg: string;
  ageMs: number;
  tokens: string;
  solOut: number;
  venue: "curve" | "amm";
}

interface Position {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
  boughtAt: number;
  /** Lamports paid, fee included. */
  stake: bigint;
  /** Lamports of the stake that bought tokens (fee excluded): what the price targets measure. */
  basis: bigint;
  initialTokens: bigint;
  tokens: bigint;
  realized: bigint;
  legsDone: number;
  legs: Leg[];
  /** Highest real SOL in the curve since the buy, for the rug exit. */
  peakRealSol: bigint;
  buyAgeMs: number;
  liqAtBuy: number;
  holdersAtBuy?: number;
  top10AtBuy?: number;
  solUsd: number;
  buyQuoted: bigint;
  lastValue?: bigint;
  selling?: boolean;
  graduated?: boolean;
  lastAmmCheck?: number;
}

interface StoredPosition {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
  boughtAt?: number;
  stake: string;
  basis: string;
  initialTokens: string;
  tokens: string;
  realized: string;
  legsDone?: number;
  legs: Leg[];
  peakRealSol?: string;
  buyAgeMs: number;
  liqAtBuy: number;
  holdersAtBuy?: number;
  top10AtBuy?: number;
  solUsd: number;
  buyQuoted: string;
  graduated?: boolean;
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
const ladderOn = (): boolean => CONFIG.mayhemSnipeLadder.length > 0;

function currentRules(): SnipeRules {
  return {
    minLiquidityUsd: CONFIG.mayhemSnipeMinLiquidityUsd,
    buyDeadlineMs: CONFIG.mayhemSnipeBuyDeadlineSeconds * 1000,
    minAgeMs: CONFIG.mayhemSnipeMinAgeSeconds * 1000,
    minHolders: CONFIG.mayhemSnipeMinHolders,
    maxTop10Pct: CONFIG.mayhemSnipeMaxTop10Percent,
    requireAuthoritiesDisabled: CONFIG.mayhemSnipeRequireAuthoritiesDisabled,
    requireMayhem: CONFIG.mayhemSnipeOnlyMayhem,
  };
}

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
    boughtAt: p.boughtAt,
    stake: p.stake.toString(),
    basis: p.basis.toString(),
    initialTokens: p.initialTokens.toString(),
    tokens: p.tokens.toString(),
    realized: p.realized.toString(),
    legsDone: p.legsDone,
    legs: p.legs,
    peakRealSol: p.peakRealSol.toString(),
    buyAgeMs: p.buyAgeMs,
    liqAtBuy: p.liqAtBuy,
    holdersAtBuy: p.holdersAtBuy,
    top10AtBuy: p.top10AtBuy,
    solUsd: p.solUsd,
    buyQuoted: p.buyQuoted.toString(),
    graduated: p.graduated,
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
        boughtAt: s.boughtAt ?? s.launchMs + s.buyAgeMs,
        stake: BigInt(s.stake),
        basis: BigInt(s.basis),
        initialTokens: BigInt(s.initialTokens),
        tokens: BigInt(s.tokens),
        realized: BigInt(s.realized),
        legsDone: s.legsDone ?? 0,
        legs: s.legs ?? [],
        peakRealSol: BigInt(s.peakRealSol ?? "0"),
        buyAgeMs: s.buyAgeMs,
        liqAtBuy: s.liqAtBuy,
        holdersAtBuy: s.holdersAtBuy,
        top10AtBuy: s.top10AtBuy,
        solUsd: s.solUsd,
        buyQuoted: BigInt(s.buyQuoted),
        graduated: s.graduated,
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

/** Read the on-chain facts the rules ask for, keeping what an earlier read already found. */
async function fetchDetails(mint: string, curve: CurveState, rules: SnipeRules, prev?: CoinDetails): Promise<CoinDetails> {
  const d: CoinDetails = { ...prev };
  if ((rules.minHolders ?? 0) > 0 || (rules.maxTop10Pct ?? 0) > 0) {
    try {
      const res = await connection!.getTokenLargestAccounts(new PublicKey(mint), "confirmed");
      const accounts = res.value.map((v) => ({ amount: v.amount }));
      d.holders = holdersFromLargest(accounts);
      d.top10Pct = top10Percent(accounts, curve.supply);
    } catch {
      /* keep the previous value, if any */
    }
  }
  if (rules.requireAuthoritiesDisabled && (d.mintDisabled === undefined || d.freezeDisabled === undefined)) {
    try {
      const info = await connection!.getAccountInfo(new PublicKey(mint), "confirmed");
      const a = decodeMintAuthorities(info?.data);
      if (a) {
        d.mintDisabled = a.mintDisabled;
        d.freezeDisabled = a.freezeDisabled;
      }
    } catch {
      /* try again next tick */
    }
  }
  return d;
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
  const boughtAt = Date.now();
  const buyAgeMs = boughtAt - t.launchMs;
  const d = t.details;
  logger.info(
    `🎯 SNIPE BUY ${t.symbol}: ${CONFIG.mayhemSnipeStakeSol} SOL at ${(buyAgeMs / 1000).toFixed(1)}s after launch, liquidity $${liqUsd.toFixed(0)}` +
      `${d?.holders !== undefined ? `, ${d.holders} holders` : ""}${d?.top10Pct !== undefined ? `, top10 ${d.top10Pct.toFixed(1)}%` : ""} (paper).`
  );
  if (ladderOn()) {
    const fee = (stake * feeBps()) / 10_000n;
    positions.set(t.mint, {
      mint: t.mint,
      symbol: t.symbol,
      launchMs: t.launchMs,
      detectedAt: t.detectedAt,
      boughtAt,
      stake,
      basis: stake - fee,
      initialTokens: filled,
      tokens: filled,
      realized: 0n,
      legsDone: 0,
      legs: [],
      peakRealSol: at.rSol,
      buyAgeMs,
      liqAtBuy: liqUsd,
      holdersAtBuy: d?.holders,
      top10AtBuy: d?.top10Pct,
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
    holdersAtBuy: t.details?.holders,
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
    heldMs: Date.now() - pos.boughtAt,
    liquidityUsdAtBuy: pos.liqAtBuy,
    holdersAtBuy: pos.holdersAtBuy,
    top10AtBuy: pos.top10AtBuy,
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

/**
 * Ladder mode: sell `fraction` of what is left, immediately, with no other checks. With
 * `ammValueAll` (lamports the whole remainder is worth on the AMM) it is booked at that price
 * less the fee instead of being simulated against the curve.
 */
async function exitLeg(pos: Position, leg: string, fraction: number, legsDone?: number, ammValueAll?: bigint): Promise<void> {
  if (pos.selling) return;
  pos.selling = true;
  try {
    const amount = fraction >= 1 ? pos.tokens : (pos.tokens * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    if (amount <= 0n) return;
    let out: bigint | null;
    if (ammValueAll !== undefined) {
      const gross = (ammValueAll * amount) / pos.tokens;
      out = gross - (gross * feeBps()) / 10_000n;
    } else {
      out = await sellTokens(pos.mint, amount);
    }
    if (out === null) {
      record({ type: "fail", mint: pos.mint, symbol: pos.symbol, side: "sell", leg, reason: "no fill within slippage after 3 attempts" });
      logger.warn(`🎯 SNIPE ${pos.symbol}: ${leg} sell could not fill within ${CONFIG.mayhemSnipeSlippagePercent}% slippage; it stays open and is retried.`);
      return;
    }
    pos.tokens -= amount;
    pos.realized += out;
    if (legsDone !== undefined) pos.legsDone = legsDone;
    const ageMs = Date.now() - pos.launchMs;
    const venue = ammValueAll !== undefined ? "amm" : "curve";
    pos.legs.push({ leg, ageMs, tokens: amount.toString(), solOut: Number(out) / LAMPORTS, venue });
    record({
      type: "leg",
      mint: pos.mint,
      symbol: pos.symbol,
      leg,
      venue,
      ageMs,
      heldMs: Date.now() - pos.boughtAt,
      soldTokens: amount.toString(),
      solOut: Number(out) / LAMPORTS,
      remainingTokens: pos.tokens.toString(),
    });
    logger.info(
      `🎯 SNIPE ${leg.toUpperCase()} ${pos.symbol}: sold ${((Number(amount) / Number(pos.initialTokens)) * 100).toFixed(0)}% of the position ` +
        `for ${(Number(out) / LAMPORTS).toFixed(4)} SOL (${venue}), ${((Date.now() - pos.boughtAt) / 1000).toFixed(0)}s after the buy.`
    );
    if (pos.tokens <= 0n) finalizePosition(pos);
    savePositions();
  } finally {
    pos.selling = false;
  }
}

/** Decide which exit, if any, is due for a position priced at `value` lamports (all of what is left). */
function dueExit(pos: Position, value: number, now: number): { leg: string; fraction: number; done?: number } | null {
  const legs = CONFIG.mayhemSnipeLadder;
  const action = legs.length
    ? ladderAction({ basis: Number(pos.basis), initialTokens: pos.initialTokens, tokens: pos.tokens, legsDone: pos.legsDone }, value, legs)
    : ({ leg: "none" } as LadderAction);
  if ("fraction" in action) return { leg: action.leg, fraction: action.fraction, done: action.done };
  if (noSellTimedOut({ anySold: pos.legs.length > 0, boughtAt: pos.boughtAt }, now, CONFIG.mayhemSnipeNoSellTimeoutSeconds * 1000)) {
    return { leg: "timeout", fraction: 1 };
  }
  const holdMs = CONFIG.mayhemSnipeHoldSeconds * 1000;
  if (holdMs > 0 && now >= pos.launchMs + holdMs) return { leg: "time", fraction: 1 };
  return null;
}

/** A graduated coin cannot be sold into the curve; price it from Jupiter's pool feed, every 5s. */
async function checkGraduated(pos: Position, now: number, solUsd: number | undefined): Promise<void> {
  if (pos.selling || !solUsd || now - (pos.lastAmmCheck ?? 0) < 5_000) return;
  pos.lastAmmCheck = now;
  if (!pos.graduated) {
    pos.graduated = true;
    logger.info(`🎯 SNIPE ${pos.symbol}: the curve graduated to the AMM; the position is now priced from Jupiter's pool feed every 5s.`);
  }
  const lp = await fetchLivePrice(pos.mint, "solana", 4000);
  if (!lp) return;
  const value = ammValueLamports(pos.tokens, lp.priceUsd, solUsd);
  pos.lastValue = value;
  const due = dueExit(pos, Number(value), now);
  if (due) await exitLeg(pos, due.leg, due.fraction, due.done, value);
}

/** Ladder mode, once a second: price each open position and fire any exit that is due. */
function monitorPositions(now: number, byMint: Map<string, Uint8Array | undefined>, solUsd: number | undefined): void {
  const rugPct = CONFIG.mayhemSnipeRugDropPercent;
  for (const pos of [...positions.values()]) {
    if (pos.selling) continue;
    const curve = decodeCurve(byMint.get(pos.mint));
    if (!curve) continue;
    if (curve.complete) {
      void checkGraduated(pos, now, solUsd).catch(() => undefined);
      continue;
    }
    if (curve.rSol > pos.peakRealSol) pos.peakRealSol = curve.rSol;
    const value = quoteSell(curve, pos.tokens, 0n);
    pos.lastValue = value;
    if (rugTriggered(Number(pos.peakRealSol), Number(curve.rSol), rugPct)) {
      void exitLeg(pos, "rug", 1).catch(() => undefined);
      continue;
    }
    const due = dueExit(pos, Number(value), now);
    if (due) void exitLeg(pos, due.leg, due.fraction, due.done).catch(() => undefined);
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
      `Closed so far: ${totals.closed} (${totals.wins} wins, ${totals.pnlSol >= 0 ? "+" : ""}${totals.pnlSol.toFixed(4)} SOL). Watching ${active.size} launches.`
  );
}

async function pollOnce(): Promise<void> {
  if (polling || (active.size === 0 && positions.size === 0) || !connection) return;
  polling = true;
  try {
    const start = Date.now();
    const due = [...active.values()].filter((t) => t.nextCheckAt <= start);
    if (due.length === 0 && positions.size === 0) return;
    const solUsd = await getSolUsd();
    const rules = currentRules();
    // One batched read covers every due coin and every open position.
    const mints = [...new Set([...due.map((t) => t.mint), ...positions.keys()])];
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
    monitorPositions(now, byMint, solUsd);
    for (const t of due) {
      const curve = decodeCurve(byMint.get(t.mint));
      if (!curve) {
        // Account not visible yet: keep waiting until the deadline passes.
        if (now - t.launchMs > rules.buyDeadlineMs) {
          active.delete(t.mint);
          record({ type: "skip", mint: t.mint, symbol: t.symbol, reason: "curve never readable by the deadline" });
        } else {
          t.nextCheckAt = now + pollIntervalMs(now - t.launchMs, false);
        }
        continue;
      }
      if (detailsNeeded(curve, t.launchMs, now, solUsd, rules)) {
        t.details = await fetchDetails(t.mint, curve, rules, t.details);
      }
      const d = evaluateCandidate(curve, t.launchMs, now, solUsd, rules, t.details);
      t.peakLiq = Math.max(t.peakLiq, d.liquidityUsd);
      if (d.action === "wait") {
        t.nextCheckAt = now + pollIntervalMs(now - t.launchMs, d.liquidityUsd >= rules.minLiquidityUsd * 0.5);
        continue;
      }
      active.delete(t.mint);
      if (d.action === "skip") {
        record({
          type: "skip",
          mint: t.mint,
          symbol: t.symbol,
          mayhem: t.mayhem,
          reason: d.reason,
          liquidityUsd: d.liquidityUsd,
          peakLiquidityUsd: t.peakLiq,
          holders: t.details?.holders,
          top10Pct: t.details?.top10Pct,
          mintDisabled: t.details?.mintDisabled,
          freezeDisabled: t.details?.freezeDisabled,
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
          const launch = parseCreate(logs.logs);
          if (!launch || (CONFIG.mayhemSnipeOnlyMayhem && !launch.mayhem) || active.has(launch.mint)) return;
          const now = Date.now();
          // Trust the chain's clock for "after launch", unless it is wildly off our own.
          const launchMs = Math.abs(now - launch.chainTimeMs) < 30_000 ? launch.chainTimeMs : now;
          active.set(launch.mint, { mint: launch.mint, symbol: launch.symbol, launchMs, detectedAt: now, mayhem: launch.mayhem, peakLiq: 0, nextCheckAt: 0 });
          if (active.size > MAX_WATCHED) {
            const oldest = active.keys().next().value;
            if (oldest !== undefined) active.delete(oldest);
          }
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
