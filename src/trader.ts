import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes } from "node:crypto";
import { CONFIG } from "./config.js";
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
}

interface DexPairPrice {
  priceUsd?: string | number;
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
export const MAX_CONCURRENT_POSITIONS = 3;

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
 */
let traderLockBusy = false;
const sellQueue: Array<() => void> = [];
const buyQueue: Array<() => void> = [];

function scheduleNextTraderTask(): void {
  if (traderLockBusy) return;
  const next = sellQueue.shift() ?? buyQueue.shift();
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

    const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
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
      await evaluatePositionAtPrice(position, currentPrice);

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
export async function evaluatePositionAtPrice(position: ActivePosition, currentPrice: number): Promise<void> {
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
  if (currentPrice <= position.stopLoss) {
    logger.warn(`🛑 STOP LOSS triggered for ${position.tokenSymbol}`);
    await executeSell(position, "STOP_LOSS", currentPrice);
  } else if (currentPrice >= position.takeProfit) {
    logger.info(`🎯 TAKE PROFIT triggered for ${position.tokenSymbol}`);
    await executeSell(position, "TAKE_PROFIT", currentPrice);
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
