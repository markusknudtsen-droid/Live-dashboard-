import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { CONFIG } from "./config.js";
import { shouldExitOnLiquidityDrop, updatePeakLiquidity, DEFAULT_RUG_EXIT } from "./rug-exit.js";
import { updateTrailingStop } from "./trailing-stop.js";
import { decideSweep } from "./profit-sweep.js";
import { TradeSignal } from "./analyze.js";
import { logger } from "./logger.js";
import { httpGet } from "./http.js";
import { executeJupiterSwap, getJupiterQuote, isValidSolanaMint, SOL_MINT } from "./services/jupiter-client.js";

export interface TradeResult {
  success: boolean;
  txSignature?: string;
  entryPrice: number;
  amountSol: number;
  tokenAddress: string;
  tokenSymbol: string;
  timestamp: number;
  error?: string;
  /** Only set on a successful sell: the sanitized PnL actually used to settle it. */
  pnlPercent?: number;
}

export interface ActivePosition {
  tokenAddress: string;
  tokenSymbol: string;
  chainId: string;
  entryPrice: number;
  currentPrice: number;
  amountSol: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  pnlPercent: number;
  txSignature: string;
  /**
   * Highest price seen since entry, used by the trailing stop. Optional so
   * positions persisted before trailing stops existed still rehydrate; it is
   * seeded from entryPrice on first evaluation.
   */
  peakPrice?: number;
  /**
   * Highest pool liquidity (USD) seen since entry, used by the rug exit.
   * Optional so positions persisted before rug detection existed still
   * rehydrate; it is seeded from the first valid reading.
   */
  peakLiquidityUsd?: number;
  /**
   * Raw base-unit quantity of the token actually received at buy time, from
   * the Jupiter swap's own outAmount. Every sell caps at min(wallet balance,
   * this value) instead of sweeping the wallet's whole balance of the mint.
   *
   * 2026-09-17: a manually-bought $SOF position shared the bot's wallet with
   * the bot's own $SOF position. The bot's stop-loss/partial-take-profit read
   * getTokenAccountsByOwner and sold the ENTIRE wallet balance of the mint,
   * taking the operator's manually-held tokens along with its own. Recording
   * what THIS position actually bought, and never selling more than that, is
   * the fix. Optional: a position restored from state persisted before this
   * field existed falls back to the old whole-wallet-balance behaviour.
   */
  tokenAmountRaw?: string;
  /** Set once the deferral message has been logged, to keep it to one line. */
  takeProfitDeferredLogged?: boolean;
  /**
   * Whether this position was opened as a new/small coin, for
   * RESERVED_NEW_COIN_SLOTS accounting. Recorded at entry rather than derived
   * later: it describes which kind of slot was allocated, and a coin's market
   * cap moves after entry, so a live lookup would silently reclassify a
   * position and let the reservation drift. Optional so positions persisted
   * before this existed still rehydrate (treated as not-new).
   */
  enteredAsNewCoin?: boolean;
  /**
   * Set once PARTIAL_TAKE_PROFIT has banked its slice, so it fires exactly
   * once per position rather than on every monitoring tick above the
   * threshold. Optional so positions persisted before this existed rehydrate
   * as "not yet taken".
   */
  partialTakeProfitTaken?: boolean;
}

interface DexPairPrice {
  priceUsd?: string | number;
  /**
   * DexScreener has always sent this on the same payload monitorPositions()
   * already fetches; it simply was not read. Watching it is what lets a drain
   * be seen as it happens instead of inferred from price afterwards.
   */
  liquidity?: { usd?: string | number };
}

/**
 * The raw base-unit amount to sell for a position: never more than the
 * wallet actually holds, and never more than this position itself recorded
 * having bought. Exported so the cap can be exercised without a live RPC
 * connection or Jupiter round-trip - see tokenAmountRaw's doc comment for
 * the failure ($SOF, 2026-09-17) this replaces.
 */
/**
 * Positions already warned about an inert rug exit, so the warning is emitted
 * once per position instead of on every monitoring cycle. Cleared for a token
 * as soon as a valid liquidity reading arrives, so a feed that recovers and
 * then fails again warns again.
 */
const rugExitInertWarned = new Set<string>();

export function capSellAmount(walletRaw: bigint, positionRaw: bigint | undefined): bigint {
  if (positionRaw === undefined) return walletRaw;
  return positionRaw < walletRaw ? positionRaw : walletRaw;
}

/**
 * A completed trade, emitted after every successful buy/sell so external
 * consumers (e.g. the dashboard reporter) can react without the trader needing
 * to know about them. `paper` is true for DRY_RUN/simulated trades.
 */
export interface TradeEvent {
  type: "BUY" | "SELL";
  symbol: string;
  tokenAddress: string;
  chainId: string;
  amountSol: number;
  price: number;
  paper: boolean;
  txSignature: string;
  timestamp: number;
  confidence?: number;
  pnlPercent?: number;
  reason?: string;
}

type TradeListener = (event: TradeEvent) => void | Promise<void>;
let tradeListener: TradeListener | null = null;

/** Register a callback invoked after every successful buy/sell (or null to clear). */
export function setTradeListener(listener: TradeListener | null): void {
  tradeListener = listener;
}

function emitTrade(event: TradeEvent): void {
  if (!tradeListener) return;
  // A misbehaving listener must never break the trading loop, but stay
  // debuggable: if reporting silently died, the operator should see why.
  const logListenerFailure = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Trade listener failed for ${event.type} ${event.symbol}: ${message}`);
  };
  try {
    // Async listeners are part of the contract; catch their rejection too, or
    // it would surface as an unhandled promise rejection.
    const result = tradeListener(event);
    if (result && typeof result.then === "function") {
      result.catch(logListenerFailure);
    }
  } catch (error: unknown) {
    logListenerFailure(error);
  }
}

let connection: Connection;
let wallet: Keypair;
const activePositions: ActivePosition[] = [];
let paperBalanceSol = 0;

/**
 * Hard ceiling on simultaneously open positions, enforced inside the trader
 * lock (see isTradeSignalSafe's caller in executeBuyLocked) so it holds
 * regardless of how many concurrent callers are racing to open one. Callers
 * (index.ts's runCycle, mcp-server.ts's memebot_paper_buy) also check this
 * up front for a fast rejection/UX message, and index.ts layers its own
 * additional, first-trade-gate-derived restriction on top — but only this
 * check, made after acquiring the lock, is authoritative: two callers can
 * both pass an outside check before either has actually opened a position.
 */
// Was a literal 3. Reads from config so this repo's ~8 call sites (index.ts,
// mcp-server.ts, this file) don't each need a config lookup — CONFIG is fully
// initialized before this module body runs, since this file imports it above.
export const MAX_CONCURRENT_POSITIONS = CONFIG.maxConcurrentPositions;

/**
 * Serializes executeBuy()/executeSell() against each other. index.ts runs
 * the scan/analyze/buy cycle (runCycle, which calls executeBuy) and position
 * monitoring (runMonitoringTick, which calls executeSell via
 * monitorPositions) on two INDEPENDENT schedules with no guard between them
 * — each only guards against overlapping itself. Without this lock, an
 * executeBuy() awaiting its balance check (or, in live mode, a Jupiter
 * quote/build/send/confirm round-trip) can interleave with a concurrently-
 * running executeSell() doing the same — both reading/mutating the same
 * in-memory activePositions/paperBalanceSol, and in live mode, submitting
 * overlapping swap transactions from the same wallet.
 *
 * Exits (stop-loss/take-profit) are safety-critical, so sells are given
 * priority over buys: a sell already queued always runs before the next
 * buy, though it still can't preempt a buy that's already mid-execution —
 * an in-flight blockchain transaction can't be cancelled, only waited out.
 *
 * The profit sweep (executeSweep) shares this same lock at the lowest
 * priority, behind both queues below: it reads/spends the same SOL balance
 * a buy or sell can be mid-transaction against, and must never race one.
 */
let traderLockBusy = false;
const sellQueue: Array<() => void> = [];
const buyQueue: Array<() => void> = [];
const sweepQueue: Array<() => void> = [];

function scheduleNextTraderTask(): void {
  if (traderLockBusy) return;
  const next = sellQueue.shift() ?? buyQueue.shift() ?? sweepQueue.shift();
  if (!next) return;
  traderLockBusy = true;
  next();
}

function acquireTraderLock(queue: Array<() => void>): Promise<() => void> {
  return new Promise((resolve) => {
    queue.push(() =>
      resolve(() => {
        traderLockBusy = false;
        scheduleNextTraderTask();
      })
    );
    scheduleNextTraderTask();
  });
}

async function withTraderLock<T>(queue: Array<() => void>, fn: () => Promise<T>): Promise<T> {
  const release = await acquireTraderLock(queue);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Generate a fake, clearly-labelled transaction signature for DRY_RUN mode so
 * simulated trades are never mistaken for real on-chain transactions.
 */
function generateDryRunTxSignature(): string {
  return `DRYRUN-${bs58.encode(randomBytes(64))}`;
}

/**
 * Locate a position in the active list. Prefers object identity (the
 * monitor loop passes the exact stored instance); falls back to the unique
 * per-buy tx signature so an equivalent deserialized copy still matches the
 * right entry instead of matching another position in the same token.
 */
function findPositionIndex(position: ActivePosition): number {
  const byIdentity = activePositions.indexOf(position);
  if (byIdentity !== -1) return byIdentity;
  return activePositions.findIndex((p) => p.txSignature === position.txSignature);
}

/**
 * Whether the trailing stop has armed for this position — i.e. its peak has
 * reached the activation gain, so the stop is now trailing rather than sitting
 * at the original level.
 */
function trailIsArmed(position: ActivePosition): boolean {
  if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) return false;
  const peak = position.peakPrice ?? position.entryPrice;
  const peakGainPercent = ((peak - position.entryPrice) / position.entryPrice) * 100;
  return peakGainPercent >= CONFIG.trailingStopActivatePercent;
}

/** Remove a closed position from the active list. */
function removePosition(position: ActivePosition): void {
  const idx = findPositionIndex(position);
  if (idx !== -1) activePositions.splice(idx, 1);
}

function isTradeSignalSafe(signal: TradeSignal): { ok: boolean; reason?: string } {
  if (!isValidSolanaMint(signal.token.address)) {
    return { ok: false, reason: "Invalid token mint address." };
  }
  if (!Number.isFinite(signal.token.priceUsd) || signal.token.priceUsd <= 0) {
    return { ok: false, reason: "Invalid token entry price." };
  }
  if (!Number.isFinite(signal.positionSizeSol) || signal.positionSizeSol <= 0) {
    return { ok: false, reason: "Invalid position size from analysis." };
  }
  return { ok: true };
}

/**
 * Initialize the Solana connection and wallet
 */
export function initTrader(): { publicKey: string; connection: Connection } {
  connection = new Connection(CONFIG.solanaRpcUrl, "confirmed");

  if (CONFIG.dryRun) {
    // Paper-trading: generate an ephemeral wallet and a fake balance. No real
    // key is needed and no real funds are ever touched.
    wallet = Keypair.generate();
    paperBalanceSol = CONFIG.paperStartingBalanceSol;
    logger.info(`🧪 DRY RUN wallet generated: ${wallet.publicKey.toBase58()}`);
    logger.info(`🧪 Paper balance: ${paperBalanceSol.toFixed(4)} SOL (fake, no real funds used)`);
    return { publicKey: wallet.publicKey.toBase58(), connection };
  }

  try {
    const secretKey = bs58.decode(CONFIG.solanaPrivateKey);
    wallet = Keypair.fromSecretKey(secretKey);
    logger.info(`💰 Wallet initialized: ${wallet.publicKey.toBase58()}`);
    return { publicKey: wallet.publicKey.toBase58(), connection };
  } catch {
    throw new Error("Invalid SOLANA_PRIVATE_KEY. Must be base58 encoded.");
  }
}

/**
 * Get wallet SOL balance
 */
export async function getBalance(): Promise<number> {
  if (CONFIG.dryRun) {
    return paperBalanceSol;
  }
  const balance = await connection.getBalance(wallet.publicKey);
  return balance / LAMPORTS_PER_SOL;
}

export interface SweepResult {
  success: boolean;
  amountSol?: number;
  txSignature?: string;
  error?: string;
}

/**
 * Automatically send excess SOL to CONFIG.withdrawalAddress once the balance
 * grows past CONFIG.profitSweepReserveSol. See profit-sweep.ts for the sizing
 * decision and config.ts for why this path has no confirmation step, unlike
 * the dashboard's manual withdrawal (server/routes/vault.ts).
 *
 * Shares the trader lock with buys/sells (lowest priority — see
 * scheduleNextTraderTask above) so it can never read or spend a balance a
 * buy/sell is already mid-transaction against.
 */
export async function executeSweep(): Promise<SweepResult> {
  return withTraderLock(sweepQueue, executeSweepLocked);
}

async function executeSweepLocked(): Promise<SweepResult> {
  if (CONFIG.dryRun) {
    return { success: false, error: "Sweep skipped: DRY_RUN has no real wallet to sweep from." };
  }
  if (!isValidSolanaMint(CONFIG.withdrawalAddress)) {
    return { success: false, error: "WITHDRAWAL_ADDRESS is not set or not a valid Solana address." };
  }

  const balance = await getBalance();
  const decision = decideSweep({
    balanceSol: balance,
    reserveSol: CONFIG.profitSweepReserveSol,
    minSweepSol: CONFIG.profitSweepMinSol,
    maxSweepSol: CONFIG.profitSweepMaxSol,
  });
  if (!decision.shouldSweep) {
    return { success: false, error: decision.reason };
  }

  try {
    const destination = new PublicKey(CONFIG.withdrawalAddress);
    const lamports = Math.floor(decision.amountSol * LAMPORTS_PER_SOL);
    const transaction = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: destination, lamports })
    );
    const txSignature = await sendAndConfirmTransaction(connection, transaction, [wallet], {
      commitment: "confirmed",
      skipPreflight: CONFIG.allowSkipPreflight,
    });

    logger.info(`🏦 Profit sweep: ${decision.amountSol.toFixed(4)} SOL → ${CONFIG.withdrawalAddress}`);
    logger.info(`https://solscan.io/tx/${txSignature}`);

    return { success: true, amountSol: decision.amountSol, txSignature };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Profit sweep failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Execute a buy trade using Jupiter aggregator
 */
export async function executeBuy(signal: TradeSignal): Promise<TradeResult> {
  return withTraderLock(buyQueue, () => executeBuyLocked(signal));
}

async function executeBuyLocked(signal: TradeSignal): Promise<TradeResult> {
  const { token, positionSizeSol, stopLoss, takeProfit } = signal;

  logger.info(`🛒 Executing BUY: ${token.symbol}`);
  logger.info(`Amount: ${positionSizeSol.toFixed(4)} SOL`);
  logger.info(`Entry: $${token.priceUsd.toFixed(10)}`);
  logger.info(`Stop Loss: $${stopLoss.toFixed(10)} (-${CONFIG.stopLossPercent}%)`);
  logger.info(`Take Profit: $${takeProfit.toFixed(10)} (+${CONFIG.takeProfitPercent}%)`);

  try {
    const tokenValidation = isTradeSignalSafe(signal);
    if (!tokenValidation.ok) {
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: tokenValidation.reason,
      };
    }

    // Callers check activePositions.length against MAX_CONCURRENT_POSITIONS
    // before ever calling executeBuy, but that check happens outside this
    // lock — concurrent callers (e.g. overlapping memebot_paper_buy MCP
    // calls) can all pass it, then all queue here and each open a position,
    // exceeding the limit. Re-check now, inside the lock, against the live
    // count: this is the only check that's actually atomic with the buy.
    if (activePositions.length >= MAX_CONCURRENT_POSITIONS) {
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: `Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached.`,
      };
    }

    const balance = await getBalance();
    // Real buys reserve a small SOL buffer for the network fee; simulated
    // (paper) buys pay no on-chain fee, so no buffer is required in DRY_RUN.
    const feeBufferSol = CONFIG.dryRun ? 0 : 0.01;
    if (balance < positionSizeSol + feeBufferSol) {
      const need = CONFIG.dryRun
        ? positionSizeSol.toFixed(4)
        : `${positionSizeSol.toFixed(4)} + fees`;
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: `Insufficient balance: ${balance.toFixed(4)} SOL (need ${need})`,
      };
    }

    if (CONFIG.dryRun) {
      // Simulated buy: debit the paper wallet and open a position. No Jupiter
      // route is fetched and no transaction is signed or sent.
      const txSignature = generateDryRunTxSignature();
      paperBalanceSol -= positionSizeSol;

      activePositions.push({
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        chainId: token.chainId,
        entryPrice: token.priceUsd,
        currentPrice: token.priceUsd,
        amountSol: positionSizeSol,
        stopLoss,
        takeProfit,
        entryTime: Date.now(),
        pnlPercent: 0,
        txSignature,
        enteredAsNewCoin: token.marketCap < CONFIG.newCoinSlotMaxMarketCapUsd,
      });

      logger.info(`🧪 [DRY RUN] Simulated buy executed. Fake TX: ${txSignature}`);
      logger.info(`🧪 [DRY RUN] Paper balance: ${paperBalanceSol.toFixed(4)} SOL`);

      emitTrade({
        type: "BUY",
        symbol: token.symbol,
        tokenAddress: token.address,
        chainId: token.chainId,
        amountSol: positionSizeSol,
        price: token.priceUsd,
        paper: true,
        txSignature,
        timestamp: Date.now(),
        confidence: signal.confidence,
      });

      return {
        success: true,
        txSignature,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
      };
    }

    const amountLamports = Math.floor(positionSizeSol * LAMPORTS_PER_SOL);
    const order = await getJupiterQuote(SOL_MINT, token.address, amountLamports, wallet.publicKey.toBase58());

    if (!order?.transaction || !order.requestId) {
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: "No valid Jupiter Swap V2 order found",
      };
    }

    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([wallet]);
    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    const execution = await executeJupiterSwap(order, signedTransaction);
    if (!execution || execution.status !== "Success" || !execution.signature) {
      return {
        success: false,
        txSignature: execution?.signature,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: `Jupiter execution failed${execution?.error ? `: ${execution.error}` : ""}`,
      };
    }

    const txSignature = execution.signature;

    activePositions.push({
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      chainId: token.chainId,
      entryPrice: token.priceUsd,
      currentPrice: token.priceUsd,
      amountSol: positionSizeSol,
      stopLoss,
      takeProfit,
      entryTime: Date.now(),
      pnlPercent: 0,
      txSignature,
      // The quote is already validated (outAmount present, > 0) before this
      // point is reached - see getJupiterQuote's own checks.
      tokenAmountRaw: order.outAmount,
      enteredAsNewCoin: token.marketCap < CONFIG.newCoinSlotMaxMarketCapUsd,
    });

    logger.info(`✅ Trade executed! TX: ${txSignature}`);
    logger.info(`https://solscan.io/tx/${txSignature}`);

    emitTrade({
      type: "BUY",
      symbol: token.symbol,
      tokenAddress: token.address,
      chainId: token.chainId,
      amountSol: positionSizeSol,
      price: token.priceUsd,
      paper: false,
      txSignature,
      timestamp: Date.now(),
      confidence: signal.confidence,
    });

    return {
      success: true,
      txSignature,
      entryPrice: token.priceUsd,
      amountSol: positionSizeSol,
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      timestamp: Date.now(),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Trade failed: ${message}`);
    return {
      success: false,
      entryPrice: token.priceUsd,
      amountSol: positionSizeSol,
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      timestamp: Date.now(),
      error: message,
    };
  }
}

/**
 * Execute a sell (exit position) using Jupiter
 */
/**
 * `markPriceUsd`, if given, marks the position to this price before
 * settling — used by callers (mcp-server.ts's memebot_paper_sell) that let
 * an operator specify an exit price. This must happen INSIDE the lock,
 * after the duplicate check below, rather than the caller mutating
 * position.currentPrice/pnlPercent itself before calling executeSell: two
 * concurrent sell requests for the same position (different callers, or
 * the same caller invoked twice) both hold the same shared object, and a
 * mutation applied outside the lock can be overwritten by a second,
 * ultimately-rejected request before the first request's queued
 * settlement ever runs — settling the first request at a price it never
 * reported.
 */
/**
 * Sell a FRACTION of a position and leave the rest open.
 *
 * Exists because LET_WINNERS_RUN hands the entire exit to the trailing stop:
 * on a large spike the bot banks nothing on the way up and gives back the
 * whole trail distance on the way down. Taking a slice at a big gain locks
 * real profit while the remainder still rides the trailing stop and the
 * bearish exit.
 *
 * entryPrice is deliberately NOT changed — cost basis per token is unchanged
 * by selling some of them, so the remainder's PnL stays measured against the
 * original entry. amountSol IS reduced, since it tracks the SOL still at risk.
 *
 * Returns the same TradeResult shape as executeSell, with amountSol set to
 * the slice that was sold.
 */
export async function executeSellPartial(
  position: ActivePosition,
  fraction: number,
  reason: string,
  markPriceUsd?: number
): Promise<TradeResult> {
  return withTraderLock(sellQueue, () => executeSellPartialLocked(position, fraction, reason, markPriceUsd));
}

async function executeSellPartialLocked(
  position: ActivePosition,
  fraction: number,
  reason: string,
  markPriceUsd?: number
): Promise<TradeResult> {
  const failure = (error: string): TradeResult => ({
    success: false,
    entryPrice: position.entryPrice,
    amountSol: position.amountSol,
    tokenAddress: position.tokenAddress,
    tokenSymbol: position.tokenSymbol,
    timestamp: Date.now(),
    error,
  });

  if (!(fraction > 0 && fraction < 1)) return failure(`Partial sell fraction must be between 0 and 1, got ${fraction}`);
  // A position closed while this was queued must not be partially sold.
  if (findPositionIndex(position) === -1) return failure("Position already closed");

  if (Number.isFinite(markPriceUsd) && (markPriceUsd as number) > 0) {
    position.currentPrice = markPriceUsd as number;
    position.pnlPercent = ((markPriceUsd as number) - position.entryPrice) / position.entryPrice * 100;
  }
  const pnlPercent = Math.max(Number.isFinite(position.pnlPercent) ? position.pnlPercent : 0, -100);
  const soldSol = position.amountSol * fraction;

  logger.info(
    `💰 Banking ${Math.round(fraction * 100)}% of ${position.tokenSymbol} at ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}% (${reason})`
  );

  try {
    if (CONFIG.dryRun) {
      const txSignature = generateDryRunTxSignature();
      paperBalanceSol += soldSol * (1 + pnlPercent / 100);
      position.amountSol -= soldSol;
      position.partialTakeProfitTaken = true;

      logger.info(
        `🧪 [DRY RUN] Partial sell executed. Remaining ${position.amountSol.toFixed(4)} SOL in ${position.tokenSymbol}. ` +
          `Paper balance: ${paperBalanceSol.toFixed(4)} SOL`
      );
      emitTrade({
        type: "SELL",
        symbol: position.tokenSymbol,
        tokenAddress: position.tokenAddress,
        chainId: position.chainId,
        amountSol: soldSol,
        price: position.currentPrice,
        paper: true,
        txSignature,
        timestamp: Date.now(),
        pnlPercent,
        reason,
      });
      return {
        success: true,
        txSignature,
        entryPrice: position.entryPrice,
        amountSol: soldSol,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        timestamp: Date.now(),
        pnlPercent,
      };
    }

    if (!isValidSolanaMint(position.tokenAddress)) {
      throw new Error(`Invalid position token mint: ${position.tokenAddress}`);
    }

    const tokenMint = new PublicKey(position.tokenAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint: tokenMint });
    if (tokenAccounts.value.length === 0) return failure("No token balance found");

    // Raw base units, capped at this position's own recorded amount (see
    // tokenAmountRaw's doc comment) rather than the wallet's whole balance of
    // the mint - the same fix as the full sell path. Floor rather than round,
    // so the quote can never ask for more than is actually available.
    const walletRawBalance = BigInt(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
    // Same fallback warning as the full-sell path: without a recorded buy
    // quantity this partial is a fraction of the WHOLE wallet balance, which
    // would take a slice of any manually-held tokens of the same mint too.
    if (!position.tokenAmountRaw) {
      logger.warn(
        `⚠️  ${position.tokenSymbol}: no recorded buy quantity — partial sell is sized off the wallet's ENTIRE ` +
          `balance of this mint, including any manually-held tokens.`
      );
    }
    const rawBalance = capSellAmount(walletRawBalance, position.tokenAmountRaw ? BigInt(position.tokenAmountRaw) : undefined);
    const rawToSell = (rawBalance * BigInt(Math.round(fraction * 10_000))) / 10_000n;
    if (rawToSell <= 0n) return failure("Partial sell amount rounds to zero");

    const order = await getJupiterQuote(
      position.tokenAddress,
      SOL_MINT,
      rawToSell.toString(),
      wallet.publicKey.toBase58()
    );
    if (!order?.transaction || !order.requestId) return failure("No valid Jupiter Swap V2 partial sell order found");

    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([wallet]);
    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    const execution = await executeJupiterSwap(order, signedTransaction);
    if (!execution || execution.status !== "Success" || !execution.signature) {
      throw new Error(`Jupiter partial sell failed${execution?.error ? `: ${execution.error}` : ""}`);
    }

    // Only mutate the position after the swap has actually settled, so a
    // failed swap leaves the position exactly as it was and the trigger can
    // fire again on a later tick.
    position.amountSol -= soldSol;
    position.partialTakeProfitTaken = true;
    // Shrink the recorded amount by exactly what was sold, so a later full
    // sell of the remainder is still capped against what THIS position
    // actually has left, not the wallet's whole balance of the mint.
    if (position.tokenAmountRaw) {
      const remaining = BigInt(position.tokenAmountRaw) - rawToSell;
      position.tokenAmountRaw = (remaining > 0n ? remaining : 0n).toString();
    }

    logger.info(`✅ Banked ${soldSol.toFixed(4)} SOL of ${position.tokenSymbol}! TX: ${execution.signature}`);
    logger.info(`   ${position.amountSol.toFixed(4)} SOL still running in ${position.tokenSymbol}.`);

    emitTrade({
      type: "SELL",
      symbol: position.tokenSymbol,
      tokenAddress: position.tokenAddress,
      chainId: position.chainId,
      amountSol: soldSol,
      price: position.currentPrice,
      paper: false,
      txSignature: execution.signature,
      timestamp: Date.now(),
      pnlPercent,
      reason,
    });

    return {
      success: true,
      txSignature: execution.signature,
      entryPrice: position.entryPrice,
      amountSol: soldSol,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      timestamp: Date.now(),
      pnlPercent,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Partial sell failed: ${message}`);
    return failure(message);
  }
}

export async function executeSell(
  position: ActivePosition,
  reason: string,
  markPriceUsd?: number
): Promise<TradeResult> {
  return withTraderLock(sellQueue, () => executeSellLocked(position, reason, markPriceUsd));
}

async function executeSellLocked(position: ActivePosition, reason: string, markPriceUsd?: number): Promise<TradeResult> {
  // The trader lock only serializes execution — it doesn't stop two callers
  // from both looking up the SAME still-open position before either of them
  // reaches it (e.g. two concurrent memebot_paper_sell MCP calls for the
  // same token_address, each resolving the position via
  // getActivePositions().find() before calling executeSell). Both then
  // queue here; without this check, the first call settles and removes the
  // position, and the second — still holding the same object reference —
  // would settle it a second time (crediting the paper wallet twice, or
  // attempting a second live sell) before removePosition() below became a
  // silent no-op. Re-verify membership now, inside the lock, and reject a
  // stale request instead.
  if (findPositionIndex(position) === -1) {
    return {
      success: false,
      entryPrice: position.entryPrice,
      amountSol: position.amountSol,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      timestamp: Date.now(),
      error: "Position already closed (duplicate sell request).",
    };
  }

  if (markPriceUsd !== undefined && Number.isFinite(markPriceUsd) && markPriceUsd > 0 && position.entryPrice > 0) {
    position.currentPrice = markPriceUsd;
    position.pnlPercent = ((markPriceUsd - position.entryPrice) / position.entryPrice) * 100;
  }

  // Sanitize PnL once, up front: a corrupted/rehydrated position can carry
  // NaN/Infinity (toFixed throws on Infinity) or an impossible sub-100% loss.
  // This value drives the log, the paper settlement and the emitted event.
  const pnlPercent = Math.max(Number.isFinite(position.pnlPercent) ? position.pnlPercent : 0, -100);

  logger.info(`💸 Executing SELL: ${position.tokenSymbol} (${reason})`);
  logger.info(`PnL: ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`);

  try {
    if (CONFIG.dryRun) {
      // Simulated sell: credit the position's proceeds back to the SAME paper
      // wallet the buy was funded from (proceeds = amountSol adjusted by PnL),
      // then close the position. Nothing leaves the wallet on a trade exit.
      const txSignature = generateDryRunTxSignature();
      const proceedsSol = position.amountSol * (1 + pnlPercent / 100);
      paperBalanceSol += proceedsSol;

      removePosition(position);

      logger.info(`🧪 [DRY RUN] Simulated sell executed. Fake TX: ${txSignature}`);
      logger.info(
        `🧪 [DRY RUN] Proceeds ${proceedsSol.toFixed(4)} SOL settled to bot wallet. Paper balance: ${paperBalanceSol.toFixed(4)} SOL`
      );

      emitTrade({
        type: "SELL",
        symbol: position.tokenSymbol,
        tokenAddress: position.tokenAddress,
        chainId: position.chainId,
        amountSol: position.amountSol,
        price: position.currentPrice,
        paper: true,
        txSignature,
        timestamp: Date.now(),
        // Emit the same sanitized PnL the settlement used, so downstream
        // consumers (dashboard reporting) never see NaN/Infinity.
        pnlPercent,
        reason,
      });

      return {
        success: true,
        txSignature,
        entryPrice: position.entryPrice,
        amountSol: position.amountSol,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        timestamp: Date.now(),
        pnlPercent,
      };
    }

    if (!isValidSolanaMint(position.tokenAddress)) {
      throw new Error(`Invalid position token mint: ${position.tokenAddress}`);
    }

    const tokenMint = new PublicKey(position.tokenAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: tokenMint,
    });

    if (tokenAccounts.value.length === 0) {
      return {
        success: false,
        entryPrice: position.entryPrice,
        amountSol: position.amountSol,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        timestamp: Date.now(),
        error: "No token balance found",
      };
    }

    // Cap at this position's own recorded amount, never the whole wallet
    // balance of the mint - see tokenAmountRaw's doc comment for why. Falls
    // back to the old whole-balance behaviour only when the position predates
    // this field (nothing recorded to cap against).
    const walletRaw = BigInt(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
    // Falling back means selling the wallet's WHOLE balance of this mint —
    // the pre-fix behaviour that took a manually-held $SOF position on
    // 2026-09-17. It is the safe choice for an old position (the alternative
    // is failing to sell at all), but the operator should know it happened.
    if (!position.tokenAmountRaw) {
      logger.warn(
        `⚠️  ${position.tokenSymbol}: no recorded buy quantity — selling the wallet's ENTIRE balance of this ` +
          `mint. Any manually-held tokens of the same coin will be sold with it.`
      );
    }
    const sellRaw = capSellAmount(walletRaw, position.tokenAmountRaw ? BigInt(position.tokenAmountRaw) : undefined);
    if (sellRaw <= 0n) {
      return {
        success: false,
        entryPrice: position.entryPrice,
        amountSol: position.amountSol,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        timestamp: Date.now(),
        error: "Recorded position amount is zero or the wallet holds none of this mint",
      };
    }
    const tokenBalance = sellRaw.toString();
    const order = await getJupiterQuote(position.tokenAddress, SOL_MINT, tokenBalance, wallet.publicKey.toBase58());
    if (!order?.transaction || !order.requestId) {
      return {
        success: false,
        entryPrice: position.entryPrice,
        amountSol: position.amountSol,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        timestamp: Date.now(),
        error: "No valid Jupiter Swap V2 sell order found",
      };
    }

    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([wallet]);
    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    const execution = await executeJupiterSwap(order, signedTransaction);
    if (!execution || execution.status !== "Success" || !execution.signature) {
      throw new Error(`Jupiter sell execution failed${execution?.error ? `: ${execution.error}` : ""}`);
    }

    const txSignature = execution.signature;

    removePosition(position);

    logger.info(`✅ Sold! TX: ${txSignature}`);

    emitTrade({
      type: "SELL",
      symbol: position.tokenSymbol,
      tokenAddress: position.tokenAddress,
      chainId: position.chainId,
      amountSol: position.amountSol,
      price: position.currentPrice,
      paper: false,
      txSignature,
      timestamp: Date.now(),
      pnlPercent,
      reason,
    });

    return {
      success: true,
      txSignature,
      entryPrice: position.entryPrice,
      amountSol: position.amountSol,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      timestamp: Date.now(),
      pnlPercent,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Sell failed: ${message}`);
    return {
      success: false,
      entryPrice: position.entryPrice,
      amountSol: position.amountSol,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      timestamp: Date.now(),
      error: message,
    };
  }
}

/**
 * Every SPL token the wallet actually holds with a non-zero balance.
 *
 * Used to reconcile persisted positions against reality at startup. Throws on
 * failure rather than returning an empty array: an empty result means "the
 * wallet holds nothing" and would drop every position, so the caller must be
 * able to tell that apart from "the lookup failed".
 */
export async function getHeldTokens(): Promise<{ mint: string; amount: number }[]> {
  // BOTH token programs must be queried. Tokens live under the classic SPL
  // Token program OR Token-2022, and which one is not knowable from the mint
  // address. Querying only the classic program returns an empty list for a
  // wallet holding Token-2022 tokens — a result indistinguishable from "holds
  // nothing", which reconciliation then acts on by deleting live positions.
  // That happened: a Token-2022 position was dropped, left unmanaged with no
  // trailing stop, and gave back a +77% gain.
  //
  // Both ids are hard-coded rather than pulling in @solana/spl-token for two
  // constants; neither changes.
  const TOKEN_PROGRAMS = [
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // SPL Token
    new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), // Token-2022
  ];

  // Deliberately NOT Promise.allSettled: a partial answer is the dangerous
  // case. If either program cannot be queried the caller must see a throw and
  // keep every position, rather than receive a short list that looks complete.
  const responses = await Promise.all(
    TOKEN_PROGRAMS.map((programId) => connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId }))
  );

  return responses
    .flatMap((res) => res.value)
    .map((a) => {
      const info = (a.account.data as unknown as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      const tokenAmount = info?.tokenAmount as { uiAmount?: number | null; amount?: string } | undefined;
      // uiAmount can be null; the raw string is always present, so fall back to
      // it rather than reading null as a zero balance.
      const ui = Number(tokenAmount?.uiAmount ?? Number.NaN);
      const amount = Number.isFinite(ui) ? ui : Number(tokenAmount?.amount ?? 0);
      return { mint: String(info?.mint ?? ""), amount };
    })
    .filter((t) => t.mint && Number.isFinite(t.amount) && t.amount > 0);
}

/**
 * Consecutive failed sell attempts per position, keyed by token address.
 *
 * A position whose token has left the wallet can never be sold, and the exit
 * path retries every monitoring tick — 306 attempts were observed on a single
 * phantom position. After a bounded number of failures the position is dropped
 * so the loop terminates and the operator sees one loud message, not a flood.
 */
const failedSellCounts = new Map<string, number>();

export function getFailedSellCount(tokenAddress: string): number {
  return failedSellCounts.get(tokenAddress) ?? 0;
}

export function resetFailedSellCount(tokenAddress: string): void {
  failedSellCounts.delete(tokenAddress);
}

/**
 * Notified when a position is abandoned after repeated sell failures.
 *
 * Abandoning removes the position from the active list, which silently makes
 * the token eligible to be bought again on the very next cycle — the re-entry
 * cooldown only knows about exits it is told about. Without this hook an
 * abandoned coin can be re-bought immediately, which is how the same token got
 * bought twice within half an hour.
 */
type AbandonListener = (position: ActivePosition) => void;
let abandonListener: AbandonListener | null = null;

export function setAbandonListener(listener: AbandonListener | null): void {
  abandonListener = listener;
}

/** Record a failed sell. Returns true when the position should be abandoned. */
export function noteFailedSell(tokenAddress: string, maxAttempts: number): boolean {
  const next = (failedSellCounts.get(tokenAddress) ?? 0) + 1;
  failedSellCounts.set(tokenAddress, next);
  return next >= maxAttempts;
}

/**
 * Monitor active positions and trigger stop-loss / take-profit
 */
export async function monitorPositions(): Promise<void> {
  if (activePositions.length === 0) return;

  logger.info(`📊 Monitoring ${activePositions.length} active positions...`);

  for (const position of [...activePositions]) {
    try {
      const pairs = await httpGet<DexPairPrice[]>(
        `${CONFIG.dexScreenerApiUrl}/tokens/v1/${position.chainId}/${position.tokenAddress}`
      );
      if (!pairs.length) continue;

      const currentPrice = Number(pairs[0].priceUsd || 0);
      // Deliberately NOT `|| 0`: a missing field must stay undefined so the rug
      // check can tell "unreadable" from "the pool is actually gone". Coercing
      // it to 0 would panic-sell every position on any partial API response.
      const rawLiquidity = pairs[0].liquidity?.usd;
      const currentLiquidityUsd = rawLiquidity === undefined || rawLiquidity === null ? undefined : Number(rawLiquidity);
      await evaluatePositionAtPrice(position, currentPrice, currentLiquidityUsd);

      await new Promise((r) => setTimeout(r, 500));
    } catch {
      logger.debug(`Monitoring failed for ${position.tokenSymbol}, continuing.`);
    }
  }
}

/**
 * Update a single position against a known current price and trigger a
 * stop-loss / take-profit exit if the level has been hit. Separated from the
 * DexScreener price fetch in monitorPositions so the exit logic can be exercised
 * without any network access (used by the paper-trading simulation and tests).
 */
export async function evaluatePositionAtPrice(
  position: ActivePosition,
  currentPrice: number,
  currentLiquidityUsd?: number
): Promise<void> {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    logger.warn(`Skipping invalid price for ${position.tokenSymbol}`);
    return;
  }

  // Positions can be rehydrated from persisted state, so guard against a
  // missing/zero entry price that would make PnL Infinity/NaN and corrupt the
  // exit and paper-settlement math.
  if (!Number.isFinite(position.entryPrice) || position.entryPrice <= 0) {
    logger.warn(`Skipping ${position.tokenSymbol}: invalid entry price (${position.entryPrice}).`);
    return;
  }

  position.currentPrice = currentPrice;
  position.pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

  logger.info(
    `${position.tokenSymbol}: $${currentPrice.toFixed(10)} (${position.pnlPercent >= 0 ? "+" : ""}${position.pnlPercent.toFixed(2)}%)`
  );

  // A draining pool outranks every other exit. Stop-loss, take-profit and the
  // partial all reason about price, and during a rug the price is the last
  // thing to tell the truth — the pool empties first and whatever is left to
  // sell into disappears with it. This runs before the trailing-stop update so
  // no ratchet logic can defer it, and it never consults the model: the 5-15s
  // AI round-trip is exactly what turned Schrodinger into -98.28%.
  if (CONFIG.rugExitEnabled) {
    // A rug exit that can never fire looks exactly like a rug that never
    // happened: both are silence. If the feed gives us no liquidity for this
    // position, the drain check below is inert for it and the operator has no
    // way to know their protection is off. Say so once per position — once,
    // because monitoring re-evaluates every cycle and this would otherwise
    // repeat every few seconds for the life of the position.
    if (typeof currentLiquidityUsd !== "number" || !Number.isFinite(currentLiquidityUsd)) {
      if (!rugExitInertWarned.has(position.tokenAddress)) {
        rugExitInertWarned.add(position.tokenAddress);
        logger.warn(
          `⚠️  ${position.tokenSymbol}: no liquidity reading from the price feed — rug exit is INERT for this ` +
            `position (stop-loss and trailing stop still apply).`
        );
      }
    } else {
      rugExitInertWarned.delete(position.tokenAddress);
    }

    position.peakLiquidityUsd = updatePeakLiquidity(position.peakLiquidityUsd, currentLiquidityUsd);

    const rug = shouldExitOnLiquidityDrop(position.peakLiquidityUsd, currentLiquidityUsd, {
      liquidityDropPercent: CONFIG.rugExitLiquidityDropPercent,
      minTrackedLiquidityUsd: DEFAULT_RUG_EXIT.minTrackedLiquidityUsd,
    });

    if (rug.exit) {
      logger.warn(`🚨 RUG EXIT for ${position.tokenSymbol}: ${rug.reason} — selling now, no model call.`);
      const rugResult = await executeSell(position, "LIQUIDITY_DRAIN", currentPrice);
      if (rugResult.success) resetFailedSellCount(position.tokenAddress);
      return;
    }
  }

  // Pass this call's own currentPrice through as executeSell's markPriceUsd
  // rather than relying on the position.currentPrice/pnlPercent just written
  // above: this function isn't under the trader lock, so two concurrent
  // calls for the same position (e.g. two overlapping memebot_check_exits
  // MCP calls covering the same token) can both mutate that shared object
  // before either of their queued executeSell calls actually runs — the
  // same race fixed for mcp-server.ts's memebot_paper_sell. Passing the
  // local, per-call price explicitly guarantees THIS call's settlement
  // uses THIS call's own price no matter what a second, concurrent
  // evaluation does to the shared position afterward.
  // Raise the stop before testing it, so a price that both sets a new peak and
  // then has to be judged against the stop is judged against the CURRENT one.
  if (CONFIG.trailingStopEnabled) {
    const trail = updateTrailingStop({
      entryPrice: position.entryPrice,
      currentPrice,
      peakPrice: position.peakPrice,
      currentStopLoss: position.stopLoss,
      activateAtPercent: CONFIG.trailingStopActivatePercent,
      distancePercent: CONFIG.trailingStopDistancePercent,
    });
    position.peakPrice = trail.peakPrice;
    if (trail.raised) {
      const lockedPercent = ((trail.stopLoss - position.entryPrice) / position.entryPrice) * 100;
      logger.info(
        `🔒 Trailing stop raised for ${position.tokenSymbol}: $${trail.stopLoss.toFixed(10)} ` +
          `(locks ${lockedPercent >= 0 ? "+" : ""}${lockedPercent.toFixed(2)}%)`
      );
      position.stopLoss = trail.stopLoss;
    }
  }

  // A fixed take-profit and a trailing stop are two different exit theories, and
  // running both means the fixed one always wins: it fires at a price the trail
  // has, by definition, already climbed past. Observed on OTC — the trail had
  // ratcheted to +37.61% and was still rising when the +50% take-profit closed
  // the position at +52.90%, ending a move that was still going. When the trail
  // is armed it is already protecting a real gain, so let it own the exit and
  // stand the fixed target down. The stop-loss always takes precedence: capping
  // downside is never deferred.
  const trailArmed = CONFIG.trailingStopEnabled && trailIsArmed(position);
  const deferTakeProfit = CONFIG.letWinnersRun && trailArmed;

  const exitReason: "STOP_LOSS" | "TAKE_PROFIT" | null =
    currentPrice <= position.stopLoss
      ? "STOP_LOSS"
      : !deferTakeProfit && currentPrice >= position.takeProfit
        ? "TAKE_PROFIT"
        : null;

  if (deferTakeProfit && currentPrice >= position.takeProfit && !position.takeProfitDeferredLogged) {
    position.takeProfitDeferredLogged = true;
    const lockedPercent = ((position.stopLoss - position.entryPrice) / position.entryPrice) * 100;
    logger.info(
      `🏃 ${position.tokenSymbol} passed the +${CONFIG.takeProfitPercent}% target and is still running — ` +
        `letting the trailing stop manage it (currently locking +${lockedPercent.toFixed(2)}%).`
    );
  }

  // Bank a slice on a large gain before the trailing stop hands it back.
  // Only when no full exit is due — a stop-loss or take-profit closing the
  // whole position makes a partial sale pointless. Computed from currentPrice
  // rather than position.pnlPercent so it cannot act on a stale value.
  const gainPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  if (
    !exitReason &&
    CONFIG.partialTakeProfitPercent > 0 &&
    !position.partialTakeProfitTaken &&
    Number.isFinite(gainPercent) &&
    gainPercent >= CONFIG.partialTakeProfitPercent
  ) {
    logger.info(
      `💰 PARTIAL TAKE PROFIT for ${position.tokenSymbol} at +${gainPercent.toFixed(2)}% ` +
        `(threshold +${CONFIG.partialTakeProfitPercent}%)`
    );
    await executeSellPartial(position, CONFIG.partialTakeProfitFraction, "PARTIAL_TAKE_PROFIT", currentPrice);
    return;
  }

  if (!exitReason) return;

  if (exitReason === "STOP_LOSS") logger.warn(`🛑 STOP LOSS triggered for ${position.tokenSymbol}`);
  else logger.info(`🎯 TAKE PROFIT triggered for ${position.tokenSymbol}`);

  const result = await executeSell(position, exitReason, currentPrice);

  if (result.success) {
    resetFailedSellCount(position.tokenAddress);
    return;
  }

  // A position whose token is no longer in the wallet can never be sold, and
  // this path runs every monitoring tick. Give up after a bounded number of
  // attempts rather than retrying forever (306 attempts were observed on one
  // phantom position) and say so once, loudly.
  if (noteFailedSell(position.tokenAddress, CONFIG.maxSellAttempts)) {
    logger.error(
      `🚨 Abandoning ${position.tokenSymbol}: ${CONFIG.maxSellAttempts} consecutive sell attempts failed ` +
        `(last error: ${result.error ?? "unknown"}). Removing it from active positions — verify the wallet manually.`
    );
    removePosition(position);
    resetFailedSellCount(position.tokenAddress);
    // Tell the cooldown this token has left, or abandoning it quietly makes it
    // buyable again on the next cycle.
    try {
      abandonListener?.(position);
    } catch (error) {
      logger.warn(`Abandon listener failed for ${position.tokenSymbol}: ${String(error)}`);
    }
  } else {
    logger.warn(
      `Sell attempt ${getFailedSellCount(position.tokenAddress)}/${CONFIG.maxSellAttempts} failed for ` +
        `${position.tokenSymbol}: ${result.error ?? "unknown"}`
    );
  }
}

export function getActivePositions(): ActivePosition[] {
  return [...activePositions];
}

/**
 * Current simulated paper-wallet balance (DRY_RUN mode only). Returns 0 when
 * not running in dry-run mode, where the real on-chain balance is authoritative.
 */
export function getPaperBalanceSol(): number {
  return CONFIG.dryRun ? paperBalanceSol : 0;
}

/** The public address of the wallet the bot is trading from (real or paper). */
export function getWalletAddress(): string {
  return wallet ? wallet.publicKey.toBase58() : "";
}

export function setActivePositions(positions: ActivePosition[]): void {
  activePositions.splice(0, activePositions.length, ...positions);
}
