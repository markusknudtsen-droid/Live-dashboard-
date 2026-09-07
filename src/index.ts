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
  setTradeListener,
  setAbandonListener,
  getHeldTokens,
  MAX_CONCURRENT_POSITIONS,
} from "./trader.js";
import { logger } from "./logger.js";
import { filterRestorablePositions, loadState, saveState, TradeHistoryItem } from "./persistence.js";
import { isDashboardReportingEnabled, reportTrade } from "./dashboard-reporter.js";
import {
  describeGateState,
  maxNewEntries,
  resolveFirstTradeValidation,
  shouldSkipNewEntries,
} from "./first-trade-gate.js";
import type { FirstTradeValidation } from "./first-trade-gate.js";
import { adjustConfidence, checkRugGates, qualifiesForInstantBuy } from "./entry-score.js";
import { fetchCreatorWallet, fetchDevReputation, devReputationBonus } from "./dev-reputation.js";
import {
  canReenter,
  pruneExits,
  recordExit,
  reconcilePositions,
  type RecentExit,
} from "./position-guard.js";
import {
  observeBoosts,
  isBoostFresh,
  pruneSightings,
  type BoostSightings,
} from "./boost-tracker.js";
import type { TokenCandidate } from "./scanner.js";
import { checkAnalysisModel, formatModelCheck } from "./model-preflight.js";

const tradeHistory: TradeHistoryItem[] = [];

/** Tokens exited recently, blocking immediate re-entry. Persisted across restarts. */
let recentExits: RecentExit[] = [];

/**
 * When each boosted token was first seen. Deliberately NOT persisted: after a
 * restart the bot has no way to know whether a boost it finds is seconds or
 * hours old, so every boost present at startup is baselined as already-seen and
 * never instant-bought. Persisting would fake a freshness it cannot verify.
 */
let boostSightings: BoostSightings = new Map();
let boostBaselineTaken = false;

function reentryConfig() {
  return {
    cooldownMinutes: CONFIG.reentryCooldownMinutes,
    blockLosersForRun: CONFIG.blockLosingReentryForRun,
  };
}

/**
 * Record an exit for a position that left the wallet without the bot selling
 * it — abandoned after failed sells, or found missing during reconciliation.
 * Outcome is unknown, so it counts as a loss: that is the conservative side
 * under BLOCK_LOSING_REENTRY_FOR_RUN, and re-buying something that vanished
 * unexplained is the behaviour worth suppressing.
 */
function recordNonSaleExit(tokenAddress: string, tokenSymbol: string): void {
  recentExits = recordExit(recentExits, {
    tokenAddress,
    tokenSymbol,
    exitedAt: Date.now(),
    wasLoss: true,
  });
  recentExits = pruneExits(recentExits, Date.now(), reentryConfig());
}

/**
 * Whether a token may be bought, given what has already been exited. Shared by
 * the instant-buy and analysed paths so neither can bypass the cooldown.
 */
function reentryBlocked(tokenAddress: string, symbol: string): boolean {
  if (CONFIG.reentryCooldownMinutes <= 0 && !CONFIG.blockLosingReentryForRun) return false;
  const verdict = canReenter(tokenAddress, recentExits, Date.now(), reentryConfig());
  if (!verdict.allowed) {
    logger.info(`⏳ Skipping ${symbol}: ${verdict.reason}`);
    return true;
  }
  return false;
}

/**
 * Build the TradeSignal an instant buy needs, without a model round-trip.
 *
 * Exit levels come from the operator's configured percentages, exactly as they
 * would for an analysed trade — the boost decides WHETHER to buy, never how
 * much risk to take. Confidence is recorded as 100 only to denote "did not go
 * through the model"; it is never compared against minConfidence on this path.
 */
function buildInstantBuySignal(token: TokenCandidate): TradeSignal {
  return {
    token,
    confidence: 100,
    action: "BUY",
    reasoning: `Instant buy: DexScreener boost ${token.boostAmount ?? 0} >= ${CONFIG.instantBuyBoostThreshold}. No model analysis.`,
    entryPrice: token.priceUsd,
    stopLoss: token.priceUsd * (1 - CONFIG.stopLossPercent / 100),
    takeProfit: token.priceUsd * (1 + CONFIG.takeProfitPercent / 100),
    positionSizeSol: CONFIG.maxPositionSol,
    riskRewardRatio: CONFIG.takeProfitPercent / CONFIG.stopLossPercent,
    trendStrength: "unknown",
    momentum: "unknown",
    riskLevel: "high",
    narrative: "boost-triggered",
  };
}
let cycleInProgress = false;
let monitoringInProgress = false;
let firstTradeValidated: FirstTradeValidation = null;
// Tracks the analysis model preflight relative to the scheduled cycle loop,
// which starts immediately and does NOT wait for the preflight to resolve.
// Position monitoring (see runMonitoringTick()) runs on its own independent
// schedule and never depends on this at all. "pending" and "broken" both
// block new scans/entries in runCycle(); only "ok" allows them. This is
// deliberately NOT a boolean: while the preflight (an external HTTP call
// with retries) is still in flight, entries must stay blocked exactly like
// a confirmed failure — "pending" is not "assume it's fine".
type AnalysisModelStatus = "pending" | "ok" | "broken";
let analysisModelStatus: AnalysisModelStatus = "pending";

async function persistRuntimeState(): Promise<void> {
  // saveState() itself serializes concurrent writes (see persistence.ts), so
  // callers here don't need to queue on top of it.
  await saveState({
    activePositions: getActivePositions(),
    tradeHistory,
    firstTradeValidated,
    recentExits,
  });
}

/**
 * Position monitoring runs on its own independent schedule (see main()),
 * separate from the scan/analyze/buy cycle below — a provider outage can
 * make batchAnalyze() spend its full retry/timeout budget on every one of
 * up to 5 candidates sequentially (potentially several minutes), and
 * runScheduledCycle()'s cycleInProgress guard means a slow cycle blocks
 * every interval tick behind it. If monitoring lived inside that same
 * cycle, an AI-provider outage would starve stop-loss/take-profit checks on
 * real open positions for exactly as long as it starves analysis — the
 * opposite of the guarantee the rest of this file works to provide.
 * monitoringInProgress mirrors cycleInProgress so overlapping monitoring
 * ticks can't double-evaluate (and potentially double-sell) the same
 * position; it's a separate flag because the two loops are now independent
 * and neither should be able to block the other.
 */
/**
 * Reconciliation only ran at startup, so a position sold by hand mid-run stayed
 * in the bot's book: it kept pricing a coin it no longer owned, and the exit was
 * never recorded, leaving the token free to be bought straight back. Running it
 * periodically closes that window to one interval instead of one restart.
 */
let monitoringTicks = 0;

async function reconcileDuringRun(): Promise<void> {
  const positions = getActivePositions();
  if (positions.length === 0) return;

  let held: { mint: string; amount: number }[];
  try {
    held = await getHeldTokens();
  } catch (error) {
    logger.debug(`Mid-run reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Same guard as startup: an empty answer alongside open positions is the
  // signature of an incomplete query, not proof the wallet is empty.
  if (held.length === 0) return;

  const { drop } = reconcilePositions(positions, held);
  if (drop.length === 0) return;

  logger.warn(
    `🧹 Mid-run: ${drop.length} position(s) no longer held (${drop
      .map((p) => p.tokenSymbol)
      .join(", ")}) — removing and recording as exits.`
  );
  const dropped = new Set(drop.map((p) => p.tokenAddress));
  setActivePositions(positions.filter((p) => !dropped.has(p.tokenAddress)));
  for (const p of drop) recordNonSaleExit(p.tokenAddress, p.tokenSymbol);
  await persistRuntimeState();
}

async function runMonitoringTick(): Promise<void> {
  if (monitoringInProgress) return;
  monitoringInProgress = true;
  try {
    await monitorPositions();
    monitoringTicks += 1;
    if (CONFIG.reconcileOnStartup && !CONFIG.dryRun && monitoringTicks % CONFIG.reconcileEveryTicks === 0) {
      await reconcileDuringRun();
    }
    await persistRuntimeState();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Monitoring tick failed: ${message}`);
  } finally {
    monitoringInProgress = false;
  }
}

async function runCycle(): Promise<void> {
  const cycleStart = Date.now();
  logger.info(`🔄 CYCLE START: ${new Date().toISOString()}`);

  const balance = await getBalance();
  logger.info(`💰 Wallet Balance: ${balance.toFixed(4)} SOL`);

  if (balance < 0.05) {
    logger.warn("Low balance! Skipping trading this cycle (positions are still monitored independently).");
    await persistRuntimeState();
    return;
  }

  if (analysisModelStatus !== "ok") {
    const reason =
      analysisModelStatus === "pending"
        ? "the analysis model preflight is still checking OpenRouter"
        : "the analysis model preflight failed at startup (see above)";
    logger.warn(`⛔ Skipping scan/analysis this cycle: ${reason}. Existing positions are still being monitored.`);
    await persistRuntimeState();
    return;
  }

  logger.info("📡 Scanning for candidates...");
  const candidates = await scanForCandidates();

  // Fold this poll into the boost sighting record BEFORE any buy decision, so
  // freshness is judged against when the bot actually first saw each boost.
  const now = Date.now();
  const observed = observeBoosts(
    candidates
      .filter((c) => (c.boostAmount ?? 0) > 0)
      .map((c) => ({ chainId: c.chainId, tokenAddress: c.address, boostAmount: c.boostAmount ?? 0 })),
    boostSightings,
    now,
    !boostBaselineTaken
  );
  boostSightings = pruneSightings(observed.sightings, now, {
    freshWindowSeconds: CONFIG.boostFreshWindowSeconds,
  });
  if (!boostBaselineTaken) {
    boostBaselineTaken = true;
    logger.info(
      `⚡ Boost baseline taken: ${boostSightings.size} already-boosted token(s) recorded and will NOT be ` +
        `instant-bought. Only boosts observed arriving from now on qualify.`
    );
  } else if (observed.newlyBoosted.length > 0) {
    logger.info(`⚡ Newly boosted this cycle: ${observed.newlyBoosted.map((o) => o.tokenAddress.slice(0, 6)).join(", ")}`);
  }

  if (candidates.length === 0) {
    logger.info("No candidates found this cycle.");
    await persistRuntimeState();
    return;
  }

  // Instant buy runs BEFORE analysis — skipping the model round-trip is the
  // whole point, since a heavily boosted coin moves inside the ~30s the
  // analysis takes. The rug gates still apply: a large boost is someone
  // spending money on promotion, which says nothing about whether the position
  // can be sold again.
  if (CONFIG.instantBuyOnBoostEnabled) {
    const instantConfig = {
      enabled: true,
      boostThreshold: CONFIG.instantBuyBoostThreshold,
    };
    const gateConfig = {
      minLiquidityUsd: CONFIG.minLiquidityUsd,
      maxMarketCapUsd: CONFIG.maxMarketCapUsd,
      holderCheckMinMarketCapUsd: CONFIG.holderCheckMinMarketCapUsd,
      maxTopHolderPercent: CONFIG.maxTopHolderPercent,
      requireHolderData: false,
    };

    for (const candidate of candidates) {
      if (getActivePositions().length >= MAX_CONCURRENT_POSITIONS) break;
      if (getActivePositions().some((p) => p.tokenAddress === candidate.address)) continue;
      if (reentryBlocked(candidate.address, candidate.symbol)) continue;

      // The boost must be one this run actually watched arrive. Without this
      // the bot buys whatever happens to be sitting in the rolling boosts feed,
      // which may be hours stale and already rolling over.
      if (!isBoostFresh(candidate.chainId, candidate.address, boostSightings, Date.now(), {
        freshWindowSeconds: CONFIG.boostFreshWindowSeconds,
      })) {
        if ((candidate.boostAmount ?? 0) >= CONFIG.instantBuyBoostThreshold) {
          logger.info(
            `⏱️  ${candidate.symbol}: boost ${candidate.boostAmount} met the threshold but is not fresh ` +
              `(not first seen within ${CONFIG.boostFreshWindowSeconds}s) — skipping.`
          );
        }
        continue;
      }

      const verdict = qualifiesForInstantBuy(
        {
          boostAmount: candidate.boostAmount ?? 0,
          liquidityUsd: candidate.liquidityUsd,
          marketCapUsd: candidate.marketCap,
          topHolderPercent: undefined,
        },
        instantConfig,
        gateConfig
      );

      if (!verdict.buy) {
        // Only worth a line when the boost cleared the bar but a gate stopped
        // it; every other candidate failing the threshold is just noise.
        if ((candidate.boostAmount ?? 0) >= CONFIG.instantBuyBoostThreshold) {
          logger.warn(`⛔ ${candidate.symbol}: ${verdict.reason}`);
        }
        continue;
      }

      logger.info(`⚡ INSTANT BUY: ${candidate.symbol} — ${verdict.reason}`);
      const instantSignal = buildInstantBuySignal(candidate);
      const result = await executeBuy(instantSignal);
      tradeHistory.push({
        timestamp: Date.now(),
        symbol: candidate.symbol,
        action: "BUY",
        confidence: 100,
        result: result.success ? "SUCCESS" : `FAILED: ${result.error}`,
        txSignature: result.txSignature,
      });
      if (result.success) {
        logger.info("✅ Instant buy executed");
      } else {
        logger.warn(`❌ Instant buy failed: ${result.error}`);
      }
      await persistRuntimeState();
    }
  }

  logger.info(`🧠 Analyzing top ${Math.min(candidates.length, 5)} candidates...`);
  const topCandidates = candidates.slice(0, 5);
  const signals = await batchAnalyze(topCandidates);

  // Modifiers adjust the model's confidence using cheap-to-fake marketing
  // signals (boost, socials) and hard-to-fake ones (age). The bonus cap in
  // entry-score.ts keeps marketing alone from carrying a coin over the line.
  if (CONFIG.entryScoringEnabled) {
    for (const s of signals) {
      const adj = adjustConfidence(s.confidence, {
        ageHours: s.token.ageHours,
        boostAmount: s.token.boostAmount ?? 0,
        hasXSocial: s.token.hasXSocial,
        hasOtherSocial: s.token.hasOtherSocial,
        hasPaidDexInfo: s.token.hasPaidDexInfo,
      });
      if (adj.adjustedConfidence !== s.confidence) {
        logger.info(
          `⚖️  ${s.token.symbol}: ${s.confidence}% → ${adj.adjustedConfidence}% (${adj.reasons.join(", ")})`
        );
        s.confidence = adj.adjustedConfidence;
      }
    }
  }

  // Creator reputation, from pump.fun's unofficial API. Runs after the other
  // modifiers and before the threshold filter, so a proven dev can lift a coin
  // over the line — the operator's stated intent. Bounded by a 30-minute cache
  // keyed on creator wallet, so repeat sightings cost nothing.
  //
  // Every failure path here yields no bonus rather than a guess: a dead
  // endpoint costs this signal and leaves the rest of the bot untouched.
  if (CONFIG.devReputationEnabled) {
    const repConfig = {
      minFollowers: CONFIG.devMinFollowers,
      minMigratedTokens: CONFIG.devMinMigratedTokens,
      bonus: CONFIG.devReputationBonus,
    };
    for (const s of signals) {
      try {
        const creator = await fetchCreatorWallet(s.token.address);
        if (!creator) continue;
        const rep = await fetchDevReputation(creator);
        const { bonus, reason } = devReputationBonus(rep, repConfig);
        if (bonus > 0) {
          const before = s.confidence;
          s.confidence = Math.min(100, s.confidence + bonus);
          logger.info(`👤 ${s.token.symbol}: ${before}% → ${s.confidence}% (${reason})`);
        }
      } catch (error) {
        logger.debug(
          `Dev reputation lookup skipped for ${s.token.symbol}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  const buySignals = signals.filter((s) => s.action === "BUY" && s.confidence >= CONFIG.minConfidence);
  logger.info(`📊 Results: ${buySignals.length} BUY signals (>=${CONFIG.minConfidence}% confidence)`);

  if (buySignals.length === 0) {
    logger.info("No signals meet confidence threshold.");
    logWatchSignals(signals);
    await persistRuntimeState();
    return;
  }

  const activePositions = getActivePositions();

  let slotsAvailable: number;
  if (CONFIG.requireProfitableFirstTrade) {
    const gate = shouldSkipNewEntries(firstTradeValidated, activePositions.length);
    if (gate.skip) {
      logger.warn(`⛔ New entries paused: ${gate.reason}`);
      await persistRuntimeState();
      return;
    }
    slotsAvailable = maxNewEntries(firstTradeValidated, MAX_CONCURRENT_POSITIONS, activePositions.length);
    if (slotsAvailable <= 0) {
      logger.warn(`Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached. Skipping new entries.`);
      await persistRuntimeState();
      return;
    }
  } else {
    if (activePositions.length >= MAX_CONCURRENT_POSITIONS) {
      logger.warn(`Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached. Skipping new entries.`);
      await persistRuntimeState();
      return;
    }
    slotsAvailable = MAX_CONCURRENT_POSITIONS - activePositions.length;
  }

  const tradesToExecute = buySignals.slice(0, slotsAvailable);

  for (const signal of tradesToExecute) {
    if (activePositions.find((p) => p.tokenAddress === signal.token.address)) {
      logger.info(`Already in position for ${signal.token.symbol}, skipping.`);
      continue;
    }

    if (reentryBlocked(signal.token.address, signal.token.symbol)) continue;

    // Hard gates run last, immediately before the buy: they cannot be
    // outvoted by confidence, however high the score.
    if (CONFIG.rugGatesEnabled) {
      const gate = checkRugGates(
        {
          liquidityUsd: signal.token.liquidityUsd,
          marketCapUsd: signal.token.marketCap,
          // Holder concentration needs an RPC lookup that is not wired yet;
          // undefined means "unknown", which fails closed only when the market
          // cap puts the coin above the concentration threshold.
          topHolderPercent: undefined,
        },
        {
          minLiquidityUsd: CONFIG.minLiquidityUsd,
          maxMarketCapUsd: CONFIG.maxMarketCapUsd,
          holderCheckMinMarketCapUsd: CONFIG.holderCheckMinMarketCapUsd,
          maxTopHolderPercent: CONFIG.maxTopHolderPercent,
          // Not yet wired, so an unknown reading must not veto every trade.
          requireHolderData: false,
        }
      );
      if (!gate.pass) {
        logger.warn(`⛔ ${signal.token.symbol} rejected by rug gate: ${gate.reason}`);
        continue;
      }
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

  // Kick off the analysis-model preflight WITHOUT awaiting it yet. It's an
  // external HTTP call (retries + timeouts can add up to tens of seconds, or
  // minutes with a generous HTTP_MAX_RETRIES/HTTP_TIMEOUT_MS), and awaiting
  // it here would delay restoring positions and running the first
  // monitorPositions() by exactly that long — leaving an already-open
  // real-money position without a stop-loss check for the duration. The
  // result is consumed below, after state is restored, so a slow or hanging
  // preflight can never postpone position protection.
  const modelCheckPromise = checkAnalysisModel();

  // Attach the handler now, not after the first scheduled cycle runs below.
  // Promise callbacks only fire once *attached*, so if this were attached
  // later (even via .then() on an already-resolved promise), an earlier
  // synchronous read of analysisModelStatus — e.g. runCycle()'s check on the
  // very first scheduled cycle — would still see "pending" regardless of how
  // long the preflight actually took, wasting one full scan interval before
  // the bot could ever act on a fast-resolving preflight.
  void modelCheckPromise.then((modelCheck) => {
    const modelReport = formatModelCheck(modelCheck, CONFIG.openRouterModel);
    if (modelReport) {
      // Match the log level to the worst thing the report contains, so it
      // can't be suppressed by a LOG_LEVEL the user set to quiet down normal
      // info noise. Fatal failures matter most: this is the only place the
      // diagnostics (which model, why it failed, what to set instead) get
      // printed — the branch below doesn't throw, it fails soft into
      // analysisModelStatus = "broken", so there's no second "see above"
      // error to fall back on if this were suppressed.
      if (!modelCheck.ok) logger.error(modelReport);
      else if (modelCheck.warnings.length > 0) logger.warn(modelReport);
      else logger.info(modelReport);
    }
    if (!modelCheck.ok) {
      // Do NOT throw/exit here: that would stop the whole process, including
      // monitorPositions() — which has nothing to do with AI and is exactly
      // what protects any already-open position with stop-loss/take-profit.
      // Block only new scanning/entries (enforced in runCycle()); the bot
      // keeps running and watching positions regardless.
      analysisModelStatus = "broken";
      logger.error("⛔ Trading new positions is disabled until OPENROUTER_MODEL is fixed and the bot is restarted. Existing positions will still be monitored.");
    } else {
      analysisModelStatus = "ok";
    }
  });

  // Push every executed buy/sell to the dashboard (best-effort, non-blocking),
  // and — when enabled — resolve the first-trade validation gate on SELL.
  setTradeListener((event) => {
    void reportTrade(event);
    // Record every exit so the same coin cannot be re-bought on the next cycle.
    if (event.type === "SELL") {
      recentExits = recordExit(recentExits, {
        tokenAddress: event.tokenAddress,
        tokenSymbol: event.symbol,
        exitedAt: Date.now(),
        wasLoss: (event.pnlPercent ?? 0) <= 0,
      });
      recentExits = pruneExits(recentExits, Date.now(), reentryConfig());
      // Persist immediately rather than waiting for cycle end. An exit record
      // held only in memory is lost if the process dies first, and the cooldown
      // then has no memory of the coin at all — which is how a token exited at a
      // loss was re-bought after a restart despite BLOCK_LOSING_REENTRY_FOR_RUN.
      // The first-trade gate persists eagerly for exactly this reason.
      persistRuntimeState().catch((error) => logger.error("Failed to persist exit record", error));
    }
    if (CONFIG.requireProfitableFirstTrade) {
      const next = resolveFirstTradeValidation(event, firstTradeValidated);
      if (next !== firstTradeValidated) {
        firstTradeValidated = next;
        logger.info(`🔒 First-trade validation resolved: ${describeGateState(firstTradeValidated)}`);
        // Persist immediately rather than waiting for cycle-end: a crash
        // between resolution and the next scheduled persist would otherwise
        // lose the outcome and re-open the gate on restart.
        persistRuntimeState().catch((error) => logger.error("Failed to persist first-trade gate state", error));
      }
    }
  });
  // An abandoned position has left the bot's control; treat it as an exit so
  // the cooldown applies, and persist at once so a restart cannot lose it.
  setAbandonListener((position) => {
    recordNonSaleExit(position.tokenAddress, position.tokenSymbol);
    logger.warn(`⏳ ${position.tokenSymbol} abandoned — recorded as an exit so it is not immediately re-bought.`);
    persistRuntimeState().catch((error) => logger.error("Failed to persist abandon record", error));
  });

  if (isDashboardReportingEnabled()) {
    logger.info(`📡 Dashboard trade reporting enabled → ${CONFIG.dashboardApiUrl}/trades/ingest`);
  }

  const { publicKey } = initTrader();
  const loadedState = await loadState();
  firstTradeValidated = loadedState.firstTradeValidated;
  const restorable = filterRestorablePositions(loadedState.activePositions, CONFIG.dryRun);
  const skipped = loadedState.activePositions.length - restorable.length;
  if (skipped > 0) {
    logger.info(
      CONFIG.dryRun
        ? `🧪 DRY RUN: skipping ${skipped} persisted position(s) from a previous run (fresh paper wallet).`
        : `Skipping ${skipped} paper (DRYRUN-) position(s) from persisted state — they were never bought on-chain.`
    );
  }
  // The wallet is the authority on what is held, not the state file. Anything
  // the wallet does not back is a phantom: the bot would price it, hit the
  // stop, fail to sell, and retry forever. A failed holdings lookup must NOT be
  // treated as "holds nothing" — on error we keep every position and say so.
  let reconciled = restorable;
  recentExits = pruneExits(loadedState.recentExits ?? [], Date.now(), reentryConfig());
  if (CONFIG.reconcileOnStartup && !CONFIG.dryRun && restorable.length > 0) {
    try {
      const held = await getHeldTokens();

      // "The wallet holds nothing" while positions exist is the exact signature
      // of an incomplete holdings query — which is how a live Token-2022
      // position was deleted and left unmanaged. A successful-but-wrong answer
      // is indistinguishable from a true empty wallet, so treat the ambiguous
      // case conservatively and keep the positions. Genuinely-gone positions are
      // still retired, just by the bounded sell-retry path instead. Keeping a
      // stale position costs a few failed sells; deleting a live one costs the
      // whole position.
      if (held.length === 0 && restorable.length > 0) {
        logger.warn(
          `⚠️  Wallet reports zero token holdings while ${restorable.length} position(s) are persisted. ` +
            `Keeping them rather than risk deleting live positions — if they really are gone, the sell path ` +
            `will retire them after ${CONFIG.maxSellAttempts} failed attempts.`
        );
        throw new Error("empty holdings with open positions — not trusted for reconciliation");
      }

      const { keep, drop } = reconcilePositions(restorable, held);
      if (drop.length > 0) {
        logger.warn(
          `🧹 Dropping ${drop.length} position(s) the wallet does not hold: ` +
            `${drop.map((p) => p.tokenSymbol).join(", ")}. Sold elsewhere, or never settled.`
        );
        // A position that left the wallet without the bot selling it is still
        // an exit. Without recording it, a coin sold by hand is eligible for
        // instant re-purchase on the very next cycle — which is how TRONK was
        // bought back seconds after being sold manually.
        for (const p of drop) recordNonSaleExit(p.tokenAddress, p.tokenSymbol);
      }
      reconciled = keep;
    } catch (error) {
      logger.warn(
        `Could not read wallet holdings for reconciliation (${
          error instanceof Error ? error.message : String(error)
        }); keeping all persisted positions.`
      );
    }
  }

  setActivePositions(reconciled);
  tradeHistory.push(...loadedState.tradeHistory);
  logger.info(
    `Recovered state: ${reconciled.length} active positions, ${loadedState.tradeHistory.length} history entries`
  );

  // Protect restored positions IMMEDIATELY, before anything that can block.
  // Restoring them into memory does nothing on its own — monitorPositions()
  // is what actually checks prices and fires stop-loss/take-profit. The
  // independent monitoring interval set up below (runMonitoringTick) won't
  // fire its own first tick until a full scanIntervalSeconds from now (60s
  // by default); without this pass, a position carried across a restart
  // would sit unchecked for that entire gap while the price moved. The
  // model preflight kicked off above is never awaited here — it resolves in
  // the background via modelCheckPromise.then() — so it has no bearing on
  // this wait; this one-off pass exists purely to cover the scan-interval
  // gap, with no risk of a near-instant duplicate once the real interval
  // starts.
  if (restorable.length > 0) {
    try {
      await monitorPositions();
      await persistRuntimeState();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Initial position monitoring pass failed: ${message}`);
    }
  }

  const balance = await getBalance();
  logger.info(`💰 Starting Balance: ${balance.toFixed(4)} SOL`);
  logger.info(`📍 Wallet: ${publicKey}`);

  // Raising MAX_CONCURRENT_POSITIONS does not by itself fund the extra slots.
  // A wallet that can only ever half-fill its own slot count silently runs
  // under-configured; surfacing the arithmetic once at startup makes that
  // visible instead of a mystery the operator has to reverse-engineer later.
  const TRADING_FLOOR_SOL = 0.05;
  const neededForAllSlots = MAX_CONCURRENT_POSITIONS * CONFIG.maxPositionSol + TRADING_FLOOR_SOL;
  if (balance < neededForAllSlots) {
    const affordableSlots = Math.max(0, Math.floor((balance - TRADING_FLOOR_SOL) / CONFIG.maxPositionSol));
    logger.warn(
      `⚠️  MAX_CONCURRENT_POSITIONS=${MAX_CONCURRENT_POSITIONS} at ${CONFIG.maxPositionSol} SOL/slot needs ` +
        `${neededForAllSlots.toFixed(3)} SOL to fill every slot; current balance only supports ` +
        `~${affordableSlots} slot(s) at once. Fund the wallet, lower MAX_CONCURRENT_POSITIONS, or lower ` +
        `MAX_POSITION_SOL to use the configured slot count.`
    );
  }
  logger.info(`Bot starting with ${CONFIG.scanIntervalSeconds}s scan interval`);
  logger.info(`Min confidence for trade: ${CONFIG.minConfidence}%`);
  logger.info(`Max position size: ${CONFIG.maxPositionSol} SOL`);
  logger.info(`Stop loss: -${CONFIG.stopLossPercent}%`);
  logger.info(`Take profit: +${CONFIG.takeProfitPercent}%`);
  if (CONFIG.requireProfitableFirstTrade) {
    logger.info(`🔒 First-trade validation gate: ${describeGateState(firstTradeValidated)}`);
  }

  // Position monitoring runs on its own independent interval, decoupled from
  // the scan/analyze/buy cycle below — see runMonitoringTick()'s comment for
  // why: a stuck cycle (e.g. an AI-provider outage) must never starve
  // stop-loss/take-profit checks on real open positions. The first tick
  // fires one scanIntervalSeconds from now, not immediately — the pass just
  // above already covers right now.
  setInterval(() => {
    void runMonitoringTick();
  }, CONFIG.scanIntervalSeconds * 1000);

  // Start the scan/analyze/buy cycle loop NOW, without waiting for the
  // preflight. runCycle() checks analysisModelStatus itself: if the
  // preflight (kicked off, and its handler attached, above) already
  // resolved by now, this first cycle can scan immediately; otherwise it
  // stays "pending" and this cycle skips scanning/entries same as any other
  // in-flight state.
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
