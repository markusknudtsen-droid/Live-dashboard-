import { CONFIG, validateConfig } from "./config.js";
import { scanForCandidates } from "./scanner.js";
import { batchAnalyze, TradeSignal } from "./analyze.js";
import {
  initTrader,
  executeBuy,
  monitorPositions,
  getBalance,
  getActivePositions,
  setActivePositions,
} from "./trader.js";
import { logger } from "./logger.js";
import { loadState, saveState, TradeHistoryItem } from "./persistence.js";
import { loadSettings } from "./settingsStore.js";

const tradeHistory: TradeHistoryItem[] = [];
let cycleInProgress = false;

async function persistRuntimeState(): Promise<void> {
  await saveState({
    activePositions: getActivePositions(),
    tradeHistory,
  });
}

async function runCycle(): Promise<void> {
  const cycleStart = Date.now();
  logger.info(`🔄 CYCLE START: ${new Date().toISOString()}`);

  const dashboardSettings = await loadSettings();
  if (dashboardSettings.override_enabled || !dashboardSettings.active_status) {
    logger.warn("⏸️ Manual override enabled from dashboard. Skipping trading, only monitoring positions.");
    await monitorPositions();
    await persistRuntimeState();
    return;
  }

  // Apply dashboard-configured strategy values for this cycle.
  CONFIG.maxPositionSol = dashboardSettings.buy_amount_sol;
  CONFIG.minConfidence = dashboardSettings.min_confidence;
  CONFIG.stopLossPercent = dashboardSettings.stop_loss_percent;
  CONFIG.takeProfitPercent = dashboardSettings.take_profit_percent;

  const balance = await getBalance();
  logger.info(`💰 Wallet Balance: ${balance.toFixed(4)} SOL`);

  if (balance < 0.05) {
    logger.warn("Low balance! Skipping trading, only monitoring positions.");
    await monitorPositions();
    await persistRuntimeState();
    return;
  }

  await monitorPositions();

  logger.info("📡 Scanning for candidates...");
  const candidates = await scanForCandidates();

  if (candidates.length === 0) {
    logger.info("No candidates found this cycle.");
    await persistRuntimeState();
    return;
  }

  logger.info(`🧠 Analyzing top ${Math.min(candidates.length, 5)} candidates...`);
  const topCandidates = candidates.slice(0, 5);
  const signals = await batchAnalyze(topCandidates);

  const buySignals = signals.filter((s) => s.action === "BUY" && s.confidence >= CONFIG.minConfidence);
  logger.info(`📊 Results: ${buySignals.length} BUY signals (>=${CONFIG.minConfidence}% confidence)`);

  if (buySignals.length === 0) {
    logger.info("No signals meet confidence threshold.");
    logWatchSignals(signals);
    await persistRuntimeState();
    return;
  }

  const activePositions = getActivePositions();
  const maxConcurrentPositions = 3;

  if (activePositions.length >= maxConcurrentPositions) {
    logger.warn(`Max concurrent positions (${maxConcurrentPositions}) reached. Skipping new entries.`);
    await persistRuntimeState();
    return;
  }

  const slotsAvailable = maxConcurrentPositions - activePositions.length;
  const tradesToExecute = buySignals.slice(0, slotsAvailable);

  for (const signal of tradesToExecute) {
    if (activePositions.find((p) => p.tokenAddress === signal.token.address)) {
      logger.info(`Already in position for ${signal.token.symbol}, skipping.`);
      continue;
    }

    logger.info(`🎯 TRADE SIGNAL: ${signal.token.symbol}`);
    logger.info(
      `Confidence=${signal.confidence}% Trend=${signal.trendStrength} Momentum=${signal.momentum} Risk=${signal.riskLevel}`
    );
    logger.info(`Reasoning=${signal.reasoning}`);

    const result = await executeBuy(signal);

    tradeHistory.push({
      timestamp: Date.now(),
      symbol: signal.token.symbol,
      action: "BUY",
      confidence: signal.confidence,
      result: result.success ? "SUCCESS" : `FAILED: ${result.error}`,
      txSignature: result.txSignature,
    });

    if (result.success) {
      logger.info("✅ Trade executed successfully");
    } else {
      logger.warn(`❌ Trade failed: ${result.error}`);
    }
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  logger.info(`⏱️ Cycle completed in ${elapsed}s`);
  await persistRuntimeState();
}

function logWatchSignals(signals: TradeSignal[]): void {
  const watchSignals = signals.filter((s) => s.action === "WATCH" || s.confidence >= 60);
  if (watchSignals.length > 0) {
    logger.info("👀 Tokens to watch:");
    for (const s of watchSignals) {
      logger.info(`${s.token.symbol} (${s.confidence}%) - ${s.reasoning.slice(0, 50)}...`);
    }
  }
}

async function runScheduledCycle(): Promise<void> {
  if (cycleInProgress) {
    logger.warn("Previous cycle still running. Skipping overlapping cycle.");
    return;
  }

  cycleInProgress = true;
  try {
    await runCycle();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Cycle error: ${message}`);
  } finally {
    cycleInProgress = false;
  }
}

async function main(): Promise<void> {
  logger.info("MEMECOIN AI TRADING BOT v1.0.0");

  validateConfig();

  const { publicKey } = initTrader();
  const loadedState = await loadState();
  setActivePositions(loadedState.activePositions);
  tradeHistory.push(...loadedState.tradeHistory);
  logger.info(
    `Recovered state: ${loadedState.activePositions.length} active positions, ${loadedState.tradeHistory.length} history entries`
  );

  const balance = await getBalance();
  logger.info(`💰 Starting Balance: ${balance.toFixed(4)} SOL`);
  logger.info(`📍 Wallet: ${publicKey}`);
  logger.info(`Bot starting with ${CONFIG.scanIntervalSeconds}s scan interval`);
  logger.info(`Min confidence for trade: ${CONFIG.minConfidence}%`);
  logger.info(`Max position size: ${CONFIG.maxPositionSol} SOL`);
  logger.info(`Stop loss: -${CONFIG.stopLossPercent}%`);
  logger.info(`Take profit: +${CONFIG.takeProfitPercent}%`);

  await runScheduledCycle();

  setInterval(() => {
    void runScheduledCycle();
  }, CONFIG.scanIntervalSeconds * 1000);

  process.on("SIGINT", () => {
    logger.info("🛑 Bot stopped by user.");
    logger.info(`📈 Trade History (${tradeHistory.length} trades):`);
    for (const t of tradeHistory) {
      logger.info(`${new Date(t.timestamp).toISOString()} | ${t.symbol} | ${t.action} | ${t.confidence}% | ${t.result}`);
    }
    void persistRuntimeState().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
