import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { CONFIG } from "./config.js";
import { TradeSignal } from "./analyze.js";
import { logger } from "./logger.js";
import { httpGet } from "./http.js";
import { buildJupiterSwapTx, getJupiterQuote, isValidSolanaMint, SOL_MINT } from "./services/jupiter-client.js";

export interface TradeResult {
  success: boolean;
  txSignature?: string;
  entryPrice: number;
  amountSol: number;
  tokenAddress: string;
  tokenSymbol: string;
  timestamp: number;
  error?: string;
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

let connection: Connection;
let wallet: Keypair;
const activePositions: ActivePosition[] = [];

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
  const balance = await connection.getBalance(wallet.publicKey);
  return balance / LAMPORTS_PER_SOL;
}

/**
 * Execute a buy trade using Jupiter aggregator
 */
export async function executeBuy(signal: TradeSignal): Promise<TradeResult> {
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

    const balance = await getBalance();
    if (balance < positionSizeSol + 0.01) {
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: `Insufficient balance: ${balance.toFixed(4)} SOL (need ${positionSizeSol.toFixed(4)} + fees)`,
      };
    }

    const amountLamports = Math.floor(positionSizeSol * LAMPORTS_PER_SOL);
    const quote = await getJupiterQuote(SOL_MINT, token.address, amountLamports, 500);

    if (!quote) {
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: "No Jupiter route found",
      };
    }

    const swapTransaction = await buildJupiterSwapTx(quote, wallet.publicKey.toBase58());
    if (!swapTransaction) {
      return {
        success: false,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: "Failed to build swap transaction",
      };
    }

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const txSignature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: CONFIG.allowSkipPreflight,
      maxRetries: 3,
    });

    const confirmation = await connection.confirmTransaction(txSignature, "confirmed");
    if (confirmation.value.err) {
      return {
        success: false,
        txSignature,
        entryPrice: token.priceUsd,
        amountSol: positionSizeSol,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        timestamp: Date.now(),
        error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      };
    }

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
export async function executeSell(position: ActivePosition, reason: string): Promise<TradeResult> {
  logger.info(`💸 Executing SELL: ${position.tokenSymbol} (${reason})`);
  logger.info(`PnL: ${position.pnlPercent >= 0 ? "+" : ""}${position.pnlPercent.toFixed(2)}%`);

  try {
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
    const quote = await getJupiterQuote(position.tokenAddress, SOL_MINT, tokenBalance, 500);
    if (!quote) {
      return {
        success: false,
        entryPrice: position.entryPrice,
        amountSol: position.amountSol,
        tokenAddress: position.tokenAddress,
        tokenSymbol: position.tokenSymbol,
        timestamp: Date.now(),
        error: "No Jupiter sell route found",
      };
    }

    const swapTransaction = await buildJupiterSwapTx(quote, wallet.publicKey.toBase58());
    if (!swapTransaction) {
      throw new Error("Failed to build sell swap transaction");
    }

    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const txSignature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: CONFIG.allowSkipPreflight,
      maxRetries: 3,
    });

    await connection.confirmTransaction(txSignature, "confirmed");

    const idx = activePositions.findIndex((p) => p.tokenAddress === position.tokenAddress);
    if (idx !== -1) activePositions.splice(idx, 1);

    logger.info(`✅ Sold! TX: ${txSignature}`);
    return {
      success: true,
      txSignature,
      entryPrice: position.entryPrice,
      amountSol: position.amountSol,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      timestamp: Date.now(),
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
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        logger.warn(`Skipping invalid price for ${position.tokenSymbol}`);
        continue;
      }

      position.currentPrice = currentPrice;
      position.pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

      logger.info(
        `${position.tokenSymbol}: $${currentPrice.toFixed(10)} (${position.pnlPercent >= 0 ? "+" : ""}${position.pnlPercent.toFixed(2)}%)`
      );

      if (currentPrice <= position.stopLoss) {
        logger.warn(`🛑 STOP LOSS triggered for ${position.tokenSymbol}`);
        await executeSell(position, "STOP_LOSS");
      } else if (currentPrice >= position.takeProfit) {
        logger.info(`🎯 TAKE PROFIT triggered for ${position.tokenSymbol}`);
        await executeSell(position, "TAKE_PROFIT");
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch {
      logger.debug(`Monitoring failed for ${position.tokenSymbol}, continuing.`);
    }
  }
}

export function getActivePositions(): ActivePosition[] {
  return [...activePositions];
}

export function setActivePositions(positions: ActivePosition[]): void {
  activePositions.splice(0, activePositions.length, ...positions);
}
