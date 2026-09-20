import { CONFIG, validateConfig } from "./config.js";
import { scanForCandidates, resolveMintsToCandidates, resolveMintsUnfiltered } from "./scanner.js";
import { batchAnalyze, TradeSignal } from "./analyze.js";
import {
  initTrader,
  executeBuy,
  executeAddOn,
  executeSell,
  executeSweep,
  monitorPositions,
  getBalance,
  getActivePositions,
  setActivePositions,
  setTradeListener,
  setAbandonListener,
  getHeldTokens,
  MAX_CONCURRENT_POSITIONS,
} from "./trader.js";
import { isBearishSignal, shouldCloseHeldPosition } from "./momentum-guard.js";
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
import { fetchRugCheckReport } from "./rugcheck.js";
import { fetchNewPoolMints } from "./geckoterminal.js";
import { checkSmallCapGate } from "./small-cap-gate.js";
import {
  fetchCreatorWallet,
  fetchDevReputation,
  devReputationBonus,
  fetchNewPumpMints,
} from "./dev-reputation.js";
import { extractBucket, pruneBucketExits, trendBonus, type BucketExit } from "./narrative-trend.js";
import {
  canReenter,
  pruneExits,
  recordExit,
  reconcilePositions,
  recordBuy,
  buyCountFor,
  exceedsMaxBuys,
  blocksReservedNewCoinSlot,
  type RecentExit,
  type TokenBuyCount,
} from "./position-guard.js";
import {
  observeBoosts,
  isBoostFresh,
  pruneSightings,
  type BoostSightings,
} from "./boost-tracker.js";
import type { TokenCandidate } from "./scanner.js";
import { checkAnalysisModel, formatModelCheck } from "./model-preflight.js";
import { startTelegramWatcher, getTelegramSignal, recentMentionedMints } from "./telegram-signals.js";
import { pollPublicChannel } from "./telegram-scrape.js";

const tradeHistory: TradeHistoryItem[] = [];

/**
 * Recent model verdicts, keyed by token address. The scan sources return a
 * stable set, so without this the bot pays to re-analyse unchanged tokens every
 * cycle instead of spending that budget on ones it has not seen.
 */
const analysisCache = new Map<string, { at: number; signal: TradeSignal }>();

/**
 * When each held position was last re-analysed for a bearish exit. Separate
 * from analysisCache: a held position needs its own cadence independent of
 * how the candidate cache happens to be warmed, and a position just bought
 * should not be re-analysed again within the same cycle.
 */
const positionRecheckAt = new Map<string, number>();

/** Tokens exited recently, blocking immediate re-entry. Persisted across restarts. */
let recentExits: RecentExit[] = [];

/**
 * Buy count per token for this run, for MAX_BUYS_PER_TOKEN. Deliberately NOT
 * persisted: the cap exists to stop a coin being re-bought into the same drop
 * over and over within a session (CARDCAT, 10 times on 2026-09-09), not to
 * blacklist it forever. Persisting would ban a coin traded three times last
 * week from ever being traded again, and grow the state file without bound.
 */
let buyCounts: TokenBuyCount[] = [];

/**
 * When each boosted token was first seen. Deliberately NOT persisted: after a
 * restart the bot has no way to know whether a boost it finds is seconds or
 * hours old, so every boost present at startup is baselined as already-seen and
 * never instant-bought. Persisting would fake a freshness it cannot verify.
 */
let boostSightings: BoostSightings = new Map();
let boostBaselineTaken = false;

/**
 * Closed trades bucketed by keyword ("cat", "dog", ...), feeding the
 * trend-following bonus. Deliberately NOT persisted, same reasoning as
 * buyCounts above: a meta's win rate is a same-session observation, and
 * yesterday's hot bucket is usually today's dead one.
 */
let recentBucketExits: BucketExit[] = [];

/**
 * Retention window for pruneExits(). Must be at least as long as the LONGER
 * of the two cooldowns below, or an exit record could be pruned before the
 * cooldown that actually applies to it has finished — which would silently
 * re-open a normal-coin re-entry early, since canReenter() has nothing left
 * to check against once the record is gone.
 */
function pruneConfig() {
  return {
    cooldownMinutes: Math.max(CONFIG.reentryCooldownMinutes, CONFIG.newCoinReentryCooldownMinutes),
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
  recentExits = pruneExits(recentExits, Date.now(), pruneConfig());
}

/**
 * Whether a token may be bought, given what has already been exited and how
 * many times it has already been bought this run. Shared by the instant-buy
 * and analysed paths so neither can bypass either check.
 *
 * `useNewCoinCooldown` selects NEW_COIN_REENTRY_COOLDOWN_MINUTES instead of
 * the full REENTRY_COOLDOWN_MINUTES — a real incident, 2026-09-09: CARDCAT and
 * Laptop were bought, stopped out, and bought straight back repeatedly under
 * the FULL exemption this replaced (zero cooldown at all for a new coin). A
 * short cooldown is not zero, and the buy-count cap below is what actually
 * bounds the damage a whipsawing coin can do regardless of any cooldown length.
 */
function reentryBlocked(tokenAddress: string, symbol: string, useNewCoinCooldown: boolean): boolean {
  if (exceedsMaxBuys(buyCounts, tokenAddress, CONFIG.maxBuysPerToken)) {
    logger.info(
      `⛔ Skipping ${symbol}: already bought ${buyCountFor(buyCounts, tokenAddress)} time(s) this run ` +
        `(max ${CONFIG.maxBuysPerToken})`
    );
    return true;
  }

  const cooldownMinutes = useNewCoinCooldown ? CONFIG.newCoinReentryCooldownMinutes : CONFIG.reentryCooldownMinutes;
  if (cooldownMinutes <= 0 && !CONFIG.blockLosingReentryForRun) return false;
  const verdict = canReenter(tokenAddress, recentExits, Date.now(), {
    cooldownMinutes,
    blockLosersForRun: CONFIG.blockLosingReentryForRun,
  });
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

/**
 * Re-analyse held positions on their own cadence and close any the model now
 * reads as bearish. Deliberately independent of wallet balance — an exit
 * frees SOL rather than needing it — but still needs the analysis model, so
 * the caller skips this alongside scanning when that model is unavailable.
 *
 * Uses resolveMintsUnfiltered(), not resolveMintsToCandidates(): a held
 * position must stay checkable even once it no longer looks like a fresh buy
 * candidate (thin liquidity, gone quiet) — that is exactly the state a
 * bearish exit exists to catch.
 */
async function checkHeldPositionsForBearishExit(): Promise<void> {
  if (CONFIG.bearishExitRecheckMinutes <= 0) return;

  const now = Date.now();
  const due = getActivePositions()
    .map((p) => p.tokenAddress)
    .filter((addr) => {
      const last = positionRecheckAt.get(addr);
      return last === undefined || now - last >= CONFIG.bearishExitRecheckMinutes * 60_000;
    });
  if (due.length === 0) return;

  let refreshed: Awaited<ReturnType<typeof resolveMintsUnfiltered>>;
  try {
    refreshed = await resolveMintsUnfiltered(due);
  } catch (error) {
    logger.debug(`Bearish-exit recheck skipped: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const c of refreshed) positionRecheckAt.set(c.address, now);
  if (refreshed.length === 0) return;

  const signals = await batchAnalyze(refreshed);
  for (const signal of signals) {
    // Re-fetch rather than reuse a captured reference: a monitoring tick could
    // have closed this same position (stop-loss/take-profit) while the model
    // call above was in flight.
    const position = getActivePositions().find((p) => p.tokenAddress === signal.token.address);
    if (!position) continue;
    if (!shouldCloseHeldPosition(signal.trendStrength, signal.momentum, signal.confidence, CONFIG.holdExitConfidenceThreshold)) {
      continue;
    }

    logger.warn(
      isBearishSignal(signal.trendStrength, signal.momentum)
        ? `📉 ${position.tokenSymbol}: model now reads trend=${signal.trendStrength} momentum=${signal.momentum} — closing position`
        : `📉 ${position.tokenSymbol}: re-analysis confidence fell to ${signal.confidence}% (<= ${CONFIG.holdExitConfidenceThreshold}%) — closing position`
    );
    try {
      const result = await executeSell(position, "AI_BEARISH", signal.token.priceUsd);
      if (!result.success) {
        logger.warn(`Bearish exit for ${position.tokenSymbol} failed: ${result.error}`);
      }
    } catch (error) {
      logger.error(
        `Bearish exit threw for ${position.tokenSymbol}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

async function runCycle(): Promise<void> {
  const cycleStart = Date.now();
  logger.info(`🔄 CYCLE START: ${new Date().toISOString()}`);

  const balance = await getBalance();
  logger.info(`💰 Wallet Balance: ${balance.toFixed(4)} SOL`);

  // Runs every cycle regardless of what follows — banking profit out of the
  // hot wallet is orthogonal to whether trading proceeds this cycle. Never
  // fatal: a sweep failure must not stop the scan/analyze/buy loop below.
  if (CONFIG.profitSweepEnabled) {
    try {
      const sweep = await executeSweep();
      if (sweep.success) {
        logger.info(`🏦 Swept ${sweep.amountSol?.toFixed(4)} SOL to withdrawal address.`);
        tradeHistory.push({
          timestamp: Date.now(),
          symbol: "SOL",
          action: "WITHDRAW",
          confidence: 100,
          result: "SUCCESS",
          txSignature: sweep.txSignature,
        });
      } else if (sweep.error && !sweep.error.includes("below the")) {
        // "below the ... minimum" is the routine no-op case (nothing to
        // sweep yet) and would otherwise log every single cycle.
        logger.debug(`Sweep skipped: ${sweep.error}`);
      }
    } catch (error) {
      logger.error(`Profit sweep threw (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
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

  // Runs even on a low-balance cycle: an exit frees SOL rather than needing
  // it, and a wallet too low to buy is exactly when the existing positions
  // matter most.
  try {
    await checkHeldPositionsForBearishExit();
  } catch (error) {
    logger.error(
      `Bearish-exit recheck failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (balance < 0.05) {
    logger.warn("Low balance! Skipping trading this cycle (positions are still monitored independently).");
    await persistRuntimeState();
    return;
  }

  logger.info("📡 Scanning for candidates...");
  let candidates = await scanForCandidates();

  // Telegram is a candidate source: it surfaces coins the DexScreener feeds
  // never show. Resolved candidates still pass isWorthAnalysing() inside
  // resolveMintsToCandidates(), so a mention cannot bypass the liquidity/age
  // bars that gate everything else.
  if (CONFIG.telegramEnabled || CONFIG.telegramScrapeChannels.length > 0) {
    const mentioned = recentMentionedMints(Date.now(), CONFIG.telegramSignalTtlMinutes)
      .filter((m) => !candidates.some((c) => c.address === m));
    if (mentioned.length > 0) {
      const resolved = await resolveMintsToCandidates(mentioned);
      candidates = [...candidates, ...resolved];
    }
  }

  // GeckoTerminal is a second discovery source, alongside DexScreener: its
  // new_pools feed is sorted by actual pool-creation time, which none of
  // DexScreener's own feeds are (all three are biased toward coins that have
  // already gained volume, boost spend, or search relevance). It supplies
  // mint addresses only — everything else is fetched from DexScreener via the
  // same resolveMintsToCandidates() path used above, so a GeckoTerminal find
  // gets real social/paid-info data rather than being built on fields
  // GeckoTerminal never carries, and cannot bypass isWorthAnalysing() either.
  if (CONFIG.geckoTerminalEnabled) {
    const gtMints = (await fetchNewPoolMints(undefined, CONFIG.geckoTerminalNewPoolsLimit)).filter(
      (addr) => !candidates.some((c) => c.address === addr)
    );
    if (gtMints.length > 0) {
      const resolved = await resolveMintsToCandidates(gtMints);
      if (resolved.length > 0) {
        logger.info(`🦎 GeckoTerminal: ${resolved.length} new pool(s) resolved to candidates`);
      }
      candidates = [...candidates, ...resolved];
    }
  }

  // pump.fun's own creation feed — the earliest a Solana meme coin is visible
  // anywhere, well before DexScreener indexes a pool for it. Same
  // discovery-only contract as GeckoTerminal above: mints in,
  // resolveMintsToCandidates() supplies every real field, so a coin too new to
  // have a resolvable pool simply drops out here instead of being traded on
  // data nobody fetched.
  if (CONFIG.pumpfunDiscoveryEnabled) {
    const pumpMints = (await fetchNewPumpMints(CONFIG.pumpfunDiscoveryLimit)).filter(
      (addr) => !candidates.some((c) => c.address === addr)
    );
    if (pumpMints.length > 0) {
      const resolved = await resolveMintsToCandidates(pumpMints);
      if (resolved.length > 0) {
        logger.info(`💊 pump.fun: ${resolved.length} new mint(s) resolved to candidates`);
      }
      candidates = [...candidates, ...resolved];
    }
  }

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
      if (reentryBlocked(candidate.address, candidate.symbol, candidate.ageHours < CONFIG.newCoinMaxAgeHours)) {
        continue;
      }

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

      if (CONFIG.minMarketCapUsd > 0 && candidate.marketCap < CONFIG.minMarketCapUsd) continue;

      // Same reservation as the analysed path: a boost must not let an
      // established coin take the slot being held for a new one.
      if (
        blocksReservedNewCoinSlot(
          getActivePositions().filter((p) => !p.enteredAsNewCoin).length,
          MAX_CONCURRENT_POSITIONS,
          CONFIG.reservedNewCoinSlots,
          candidate.marketCap < CONFIG.newCoinSlotMaxMarketCapUsd
        )
      ) {
        continue;
      }

      // THE ONE RUGCHECK EXEMPTION, by operator decision (2026-09-16): a coin
      // that just picked up a fresh DexScreener boost is bought on speed alone,
      // because the move is usually over by the time a RugCheck round-trip
      // returns. Everything else still applies — age ceiling, market-cap
      // bounds, re-entry cooldown, reserved slots — and qualifiesForInstantBuy
      // below still enforces the MIN_LIQUIDITY_USD floor, which is the check
      // the operator asked to keep ("as long as the liquidity is over 5k$").
      //
      // This is the riskiest path in the bot: boosts are exactly what rug
      // operators buy, and it skips both the model and RugCheck. 🦖🦖🦖 came
      // in this way and lost -58% on a coin the model later scored 21%.
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
        buyCounts = recordBuy(buyCounts, candidate.address, candidate.symbol);
      } else {
        logger.warn(`❌ Instant buy failed: ${result.error}`);
      }
      await persistRuntimeState();
    }
  }

  // Skip anything whose verdict is still fresh. The same coins resurface every
  // cycle because the scan sources are stable, and re-asking the model about an
  // unchanged token is pure spend: one run sent Magatard for analysis 76 times.
  // Reusing recent verdicts frees that budget for tokens not yet seen.
  const nowMs = Date.now();
  const analysisTtlMs = CONFIG.analysisCacheMinutes * 60_000;
  const fresh: typeof candidates = [];
  const reused: TradeSignal[] = [];
  for (const c of candidates) {
    const hit = analysisCache.get(c.address);
    if (analysisTtlMs > 0 && hit && nowMs - hit.at < analysisTtlMs) {
      // Re-point the cached verdict at the current candidate so price-derived
      // fields downstream are current, even though the model's judgement is not.
      reused.push({ ...hit.signal, token: c });
    } else {
      fresh.push(c);
    }
  }

  const toAnalyse = fresh.slice(0, CONFIG.maxCandidatesPerCycle);
  logger.info(
    `🧠 Analyzing ${toAnalyse.length} candidate(s)` +
      (reused.length > 0 ? ` (${reused.length} reused from cache)` : "") +
      ` of ${candidates.length} found...`
  );
  const analysed = await batchAnalyze(toAnalyse);
  for (const sig of analysed) analysisCache.set(sig.token.address, { at: nowMs, signal: sig });
  const signals = [...analysed, ...reused];

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

  // A Telegram mention is a marketing signal in the same category as a paid
  // boost — cheap to manufacture, so the bonus is small and not compounded
  // with everything else beyond what the individual modifiers already allow.
  if (CONFIG.telegramEnabled || CONFIG.telegramScrapeChannels.length > 0) {
    for (const s of signals) {
      const sig = getTelegramSignal(s.token.address, Date.now(), CONFIG.telegramSignalTtlMinutes);
      if (sig) {
        const before = s.confidence;
        s.confidence = Math.min(100, s.confidence + CONFIG.telegramMentionBonus);
        logger.info(
          `📡 ${s.token.symbol}: ${before}% → ${s.confidence}% (+${CONFIG.telegramMentionBonus} mentioned in ${sig.channel})`
        );
      }
    }
  }

  // Trend following, off the bot's own realised results: if recent closed
  // trades in this coin's keyword bucket have been winning, nudge it up. Needs
  // DEFAULT_TREND.minSamples closes in the bucket first, so it contributes
  // nothing until the session has actually traded a meta a few times.
  if (CONFIG.narrativeTrendEnabled) {
    recentBucketExits = pruneBucketExits(recentBucketExits, Date.now());
    for (const s of signals) {
      const bucket = extractBucket(`${s.token.symbol} ${s.token.name}`);
      const { bonus, reason } = trendBonus(bucket, recentBucketExits, Date.now());
      if (bonus > 0) {
        const before = s.confidence;
        s.confidence = Math.min(100, s.confidence + bonus);
        logger.info(`📈 ${s.token.symbol}: ${before}% → ${s.confidence}% (${reason})`);
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
    const held = activePositions.find((p) => p.tokenAddress === signal.token.address);
    if (held) {
      // A fresh BUY signal for a token we already hold used to be thrown away
      // unconditionally. If it has genuinely dipped AND the model looked at it
      // again just now and still says BUY at full confidence, that is exactly
      // the case worth topping up rather than ignoring - once per position,
      // at a flat size independent of the original entry.
      if (
        CONFIG.addOnEnabled &&
        !held.addOnTaken &&
        held.pnlPercent <= -CONFIG.addOnTriggerDipPercent
      ) {
        logger.info(
          `➕ ${signal.token.symbol} is down ${held.pnlPercent.toFixed(1)}% and still reads BUY (${signal.confidence}%) — adding ${CONFIG.addOnSol} SOL.`
        );
        const addOnResult = await executeAddOn(held, signal, CONFIG.addOnSol);
        if (!addOnResult.success) {
          logger.warn(`Add-on for ${signal.token.symbol} failed: ${addOnResult.error}`);
        }
        await persistRuntimeState();
      } else {
        logger.info(`Already in position for ${signal.token.symbol}, skipping.`);
      }
      continue;
    }

    // Real incident, 2026-09-09: with the cooldown exemption below, Laptop was
    // bought, stopped out, and bought straight back into the same coin three
    // times in 25 minutes — the last re-entry lasted 6 seconds before a -36%
    // stop. The model already computes trendStrength/momentum on every call;
    // this is the first thing that reads them for a decision instead of just
    // logging them. Runs before the cooldown check so it also protects a
    // FRESH entry, not only a cooldown-exempt re-entry.
    if (CONFIG.bearishBuyGuardEnabled && isBearishSignal(signal.trendStrength, signal.momentum)) {
      logger.warn(
        `📉 Skipping ${signal.token.symbol}: model itself reads trend=${signal.trendStrength} momentum=${signal.momentum} despite a BUY verdict`
      );
      continue;
    }

    // A coin younger than the new-coin window uses the shorter
    // NEW_COIN_REENTRY_COOLDOWN_MINUTES instead of the full cooldown — fast-
    // moving coins can legitimately be worth re-entering after a wick sooner
    // than an established coin would be. It is a shorter cooldown, not zero;
    // see reentryBlocked()'s comment for why that changed.
    const isNewCoin = signal.token.ageHours < CONFIG.newCoinMaxAgeHours;
    if (reentryBlocked(signal.token.address, signal.token.symbol, CONFIG.newCoinCooldownExempt && isNewCoin)) {
      continue;
    }

    // Hold a slot open for a small new coin. The scan feeds are ranked by
    // volume and boost, so established coins arrive first and would otherwise
    // fill every slot before the small-cap gate ever sees a candidate.
    const qualifiesForNewCoinSlot = signal.token.marketCap < CONFIG.newCoinSlotMaxMarketCapUsd;
    const nonNewHeld = getActivePositions().filter((p) => !p.enteredAsNewCoin).length;
    if (
      blocksReservedNewCoinSlot(
        nonNewHeld,
        MAX_CONCURRENT_POSITIONS,
        CONFIG.reservedNewCoinSlots,
        qualifiesForNewCoinSlot
      )
    ) {
      logger.info(
        `🪺 Skipping ${signal.token.symbol}: $${Math.round(signal.token.marketCap).toLocaleString("en-US")} market cap ` +
          `is above the $${CONFIG.newCoinSlotMaxMarketCapUsd.toLocaleString("en-US")} bar, and the last ` +
          `${CONFIG.reservedNewCoinSlots} slot(s) are held for new coins`
      );
      continue;
    }

    // Dead-coin floor, applied before any other check, to every candidate.
    if (CONFIG.minMarketCapUsd > 0 && signal.token.marketCap < CONFIG.minMarketCapUsd) {
      logger.warn(
        `⛔ ${signal.token.symbol} rejected: market cap $${Math.round(signal.token.marketCap)} below the ` +
          `$${CONFIG.minMarketCapUsd} dead-coin floor.`
      );
      continue;
    }

    // Hard gates run last, immediately before the buy: they cannot be
    // outvoted by confidence, however high the score. Below the small-cap
    // threshold the operator's stricter RugCheck-backed checklist applies
    // instead of the normal rug gate — a harder bar for the segment that is
    // cheapest to fake.
    if (CONFIG.rugGatesEnabled) {
      // Cheap, network-free bounds first: liquidity floor and market-cap ceiling.
      const basic = checkRugGates(
        {
          liquidityUsd: signal.token.liquidityUsd,
          marketCapUsd: signal.token.marketCap,
          topHolderPercent: undefined,
        },
        {
          minLiquidityUsd: CONFIG.minLiquidityUsd,
          maxMarketCapUsd: CONFIG.maxMarketCapUsd,
          holderCheckMinMarketCapUsd: CONFIG.holderCheckMinMarketCapUsd,
          maxTopHolderPercent: CONFIG.maxTopHolderPercent,
          // Concentration comes from RugCheck below now, not from this gate.
          requireHolderData: false,
        }
      );
      if (!basic.pass) {
        logger.warn(`⛔ ${signal.token.symbol} rejected by rug gate: ${basic.reason}`);
        continue;
      }

      // RugCheck now screens EVERY analysed buy, at any market cap. It used to
      // run only below SMALL_CAP_MAX_MARKET_CAP_USD ($40k), so coins between
      // there and the ceiling were bought with no authority, rugged-flag,
      // danger-risk or score check at all — the hole that let GTA IV (-99.6%,
      // unsellable) and CATE (-83%) through on 2026-09-16. The only exemption
      // is the fresh-boost instant buy above, which trades that screening for
      // speed and keeps just the liquidity floor.
      const rc = await fetchRugCheckReport(signal.token.address);
      const gate = checkSmallCapGate(
        {
          marketCapUsd: signal.token.marketCap,
          liquidityUsd: signal.token.liquidityUsd,
          volume24h: signal.token.volume24h,
          hasAnySocial: signal.token.hasXSocial || signal.token.hasOtherSocial,
          rugCheck: rc,
        },
        {
          maxMarketCapUsd: CONFIG.smallCapMaxMarketCapUsd,
          minLiquidityUsd: CONFIG.minLiquidityUsd,
          minHolders: CONFIG.smallCapMinHolders,
          maxDevHoldingPct: CONFIG.smallCapMaxDevHoldingPct,
          maxInsiderHoldingPct: CONFIG.smallCapMaxInsiderHoldingPct,
          maxBundlerHoldingPct: CONFIG.smallCapMaxBundlerHoldingPct,
          minVolume24h: CONFIG.smallCapMinVolume24h,
          maxRugCheckScore: CONFIG.smallCapMaxRugCheckScore,
          maxRugCheckScoreRaw: CONFIG.maxRugCheckScoreRaw,
          blockDangerRisks: CONFIG.blockDangerRisks,
          requireRugCheckData: true,
        }
      );
      if (!gate.pass) {
        logger.warn(`⛔ ${signal.token.symbol} rejected by RugCheck gate: ${gate.reason}`);
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
      buyCounts = recordBuy(buyCounts, signal.token.address, signal.token.symbol);
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
      // Feed the trend memory. TradeEvent carries no token name, so the bucket
      // is matched on symbol alone here while the bonus side below matches
      // symbol + name — a coin whose theme is only in its full name records
      // nothing rather than recording wrong.
      const exitBucket = extractBucket(event.symbol);
      if (exitBucket) {
        recentBucketExits = pruneBucketExits(
          [...recentBucketExits, { bucket: exitBucket, pnlPercent: event.pnlPercent ?? 0, exitedAt: Date.now() }],
          Date.now()
        );
      }
      recentExits = recordExit(recentExits, {
        tokenAddress: event.tokenAddress,
        tokenSymbol: event.symbol,
        exitedAt: Date.now(),
        wasLoss: (event.pnlPercent ?? 0) <= 0,
      });
      recentExits = pruneExits(recentExits, Date.now(), pruneConfig());
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
  recentExits = pruneExits(loadedState.recentExits ?? [], Date.now(), pruneConfig());
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

  // Telegram is optional and must never block startup. Both paths degrade to
  // "no signal" on any failure — see telegram-signals.ts / telegram-scrape.ts.
  if (CONFIG.telegramEnabled) {
    void startTelegramWatcher({
      apiId: CONFIG.telegramApiId,
      apiHash: CONFIG.telegramApiHash,
      session: CONFIG.telegramSession,
      channels: CONFIG.telegramChannels,
      ttlMinutes: CONFIG.telegramSignalTtlMinutes,
    });
  }
  if (CONFIG.telegramScrapeChannels.length > 0) {
    const pollScrapeChannels = async (): Promise<void> => {
      for (const channel of CONFIG.telegramScrapeChannels) {
        try {
          await pollPublicChannel(channel);
        } catch (error) {
          logger.debug(`Telegram scrape failed for ${channel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };
    void pollScrapeChannels();
    setInterval(() => {
      void pollScrapeChannels();
    }, CONFIG.telegramScrapeIntervalSeconds * 1000);
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
