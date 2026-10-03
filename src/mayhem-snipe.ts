/**
 * Pump.fun "mayhem mode" sniper: PAPER ONLY. It simulates against the live bonding curve
 * and never signs or sends a transaction. A live mode does not exist on purpose: getting
 * under 15s live needs a direct pump.fun buy/sell with the wallet key, which is a separate,
 * much riskier piece of work.
 *
 * Rules (all configurable, see MAYHEM_SNIPE_* in config.ts):
 *  - a coin qualifies if its creation event has is_mayhem_mode and a SOL quote;
 *  - the curve is polled once a second (one batched RPC call for every coin in play);
 *  - the moment its REAL SOL reserves (the liquidity that can actually be pulled out) are
 *    worth >= $200 it is bought, provided that is within 15s of launch, else it is skipped;
 *  - 100% is sold at exactly 40s after launch, whatever the price;
 *  - both sides tolerate 60% slippage. A fill is simulated MAYHEM_SNIPE_FILL_DELAY_MS after
 *    the quote against a fresh read of the curve, because that is the movement a live
 *    transaction would face; if the fill is worse than the tolerance, the trade fails.
 *
 * Layouts come from pump.fun's published IDL (pump-fun/pump-public-docs, idl/pump.json) and
 * were checked against live mainnet events on 2026-10-03: CreateEvent.is_mayhem_mode is the
 * byte 200 after the uri, BondingCurve.is_mayhem_mode is account byte 81.
 *
 * Simplifications that flatter the result, so read the numbers with them in mind: our own
 * paper trade does not move the curve, other snipers' competing buys are only seen through
 * the fill-delay re-read, and the 1.25% fee is an assumption.
 * ponytail: one poll timer, no per-coin sockets. Revisit if the public RPC rate-limits.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { appendFile, mkdir } from "node:fs/promises";
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

export interface SnipeRules {
  minLiquidityUsd: number;
  buyDeadlineMs: number;
}

export interface Decision {
  action: "buy" | "wait" | "skip";
  reason: string;
  liquidityUsd: number;
}

/** Pure: what to do with a coin right now, given its curve, launch time and the SOL price. */
export function evaluateCandidate(
  curve: CurveState,
  launchMs: number,
  nowMs: number,
  solUsd: number | undefined,
  rules: SnipeRules
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
    return late
      ? { action: "skip", reason: `reached $${liq.toFixed(0)} only after the ${rules.buyDeadlineMs / 1000}s deadline`, liquidityUsd: liq }
      : { action: "buy", reason: `liquidity $${liq.toFixed(0)}`, liquidityUsd: liq };
  }
  return late
    ? { action: "skip", reason: `liquidity $${liq.toFixed(0)} < $${rules.minLiquidityUsd} at the deadline`, liquidityUsd: liq }
    : { action: "wait", reason: `liquidity $${liq.toFixed(0)} < $${rules.minLiquidityUsd}`, liquidityUsd: liq };
}

// ---- runtime (impure) -----------------------------------------------------------------

interface Tracked {
  mint: string;
  symbol: string;
  launchMs: number;
  detectedAt: number;
}

const active = new Map<string, Tracked>();
let connection: Connection | null = null;
let started = false;
let polling = false;
const totals = { closed: 0, wins: 0, failed: 0, pnlSol: 0 };
let solUsdCache: { at: number; value: number } | null = null;
let writeChain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const feeBps = (): bigint => BigInt(Math.round(CONFIG.mayhemSnipeFeePercent * 100));
const curvePda = (mint: string): PublicKey =>
  PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_FUN_PROGRAM))[0];

function record(obj: Record<string, unknown>): void {
  const file = path.join(path.dirname(CONFIG.stateFilePath), "mayhem-snipes.jsonl");
  const line = JSON.stringify({ t: Date.now(), ...obj }) + "\n";
  writeChain = writeChain
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, line, "utf-8");
    })
    .catch((e) => logger.debug(`mayhem snipe log write failed: ${e instanceof Error ? e.message : String(e)}`));
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
  // A stale price beats none for a $200 bar; unknown beyond 10 minutes is not trusted.
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
  logger.info(`🎯 SNIPE BUY ${t.symbol}: ${CONFIG.mayhemSnipeStakeSol} SOL at ${(buyAgeMs / 1000).toFixed(1)}s after launch, liquidity $${liqUsd.toFixed(0)} (paper).`);
  const sellDelay = Math.max(0, t.launchMs + CONFIG.mayhemSnipeHoldSeconds * 1000 - Date.now());
  setTimeout(() => {
    void simulateSell(t, filled, stake, quoted, buyAgeMs, liqUsd, solUsd).catch(() => undefined);
  }, sellDelay);
}

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
  // Strict sell: retry the read/fill a few times, but never past a bounded window.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const quoteCurve = await readCurve(t.mint);
    if (quoteCurve && quoteCurve.quoteIsSol && !quoteCurve.complete) {
      const quoted = quoteSell(quoteCurve, tokens, feeBps());
      await sleep(CONFIG.mayhemSnipeFillDelayMs);
      const fillCurve = (await readCurve(t.mint)) ?? quoteCurve;
      const filled = quoteSell(fillCurve, tokens, feeBps());
      if (withinSlippage(quoted, filled, CONFIG.mayhemSnipeSlippagePercent)) {
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
        return;
      }
    }
    await sleep(300);
  }
  totals.failed += 1;
  record({ type: "fail", ...base, side: "sell", reason: "no fill within slippage after 3 attempts", stakeSol: Number(stake) / LAMPORTS });
  logger.warn(`🎯 SNIPE ${t.symbol}: sell could not fill within ${CONFIG.mayhemSnipeSlippagePercent}% slippage after 3 attempts (counted as failed, not as a loss).`);
}

async function pollOnce(): Promise<void> {
  if (polling || active.size === 0 || !connection) return;
  polling = true;
  try {
    const tracked = [...active.values()];
    const solUsd = await getSolUsd();
    const rules: SnipeRules = {
      minLiquidityUsd: CONFIG.mayhemSnipeMinLiquidityUsd,
      buyDeadlineMs: CONFIG.mayhemSnipeBuyDeadlineSeconds * 1000,
    };
    for (let i = 0; i < tracked.length; i += 100) {
      const chunk = tracked.slice(i, i + 100);
      let infos: Array<{ data: Buffer } | null> = [];
      try {
        infos = await connection.getMultipleAccountsInfo(chunk.map((t) => curvePda(t.mint)), "confirmed");
      } catch {
        infos = [];
      }
      const now = Date.now();
      chunk.forEach((t, idx) => {
        const curve = decodeCurve(infos[idx]?.data);
        if (!curve) {
          // Account not visible yet: keep waiting until the deadline passes.
          if (now - t.launchMs > rules.buyDeadlineMs) {
            active.delete(t.mint);
            record({ type: "skip", mint: t.mint, symbol: t.symbol, reason: "curve never readable by the deadline" });
          }
          return;
        }
        const d = evaluateCandidate(curve, t.launchMs, now, solUsd, rules);
        if (d.action === "wait") return;
        active.delete(t.mint);
        if (d.action === "skip") {
          record({ type: "skip", mint: t.mint, symbol: t.symbol, reason: d.reason, liquidityUsd: d.liquidityUsd, ageMs: now - t.launchMs });
          return;
        }
        void simulateBuy(t, curve, d.liquidityUsd, solUsd as number).catch(() => undefined);
      });
    }
  } finally {
    polling = false;
  }
}

export function startMayhemSnipe(): void {
  if (CONFIG.mayhemSnipeMode === "off" || started) return;
  try {
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
          active.set(launch.mint, { mint: launch.mint, symbol: launch.symbol, launchMs, detectedAt: now });
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
