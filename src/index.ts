import { CONFIG, validateConfig } from "./config.js";
import { scanForCandidates, resolveMintsToCandidates, resolveMintsUnfiltered } from "./scanner.js";
import { batchAnalyze, TradeSignal } from "./analyze.js";
import {
  initTrader,
  executeBuy,
  executeAddOn,
  trailIsArmed,
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
import {
  BEARISH_READS_TO_CLOSE,
  isBearishRead,
  isBearishSignal,
  recordBearishRead,
  shouldCloseHeldPosition,
} from "./momentum-guard.js";
import { findFreshLaunches, type FreshLaunchCandidate } from "./fresh-launch.js";
import { exitLevels, sizeForConfidence } from "./position-sizing.js";
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
import { recordConfidenceBonus } from "./entry-features.js";
import { recallVerdict, rememberVerdict, type AnalysisCache } from "./analysis-cache.js";
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

/** Liquidity floor and market-cap ceiling, shared by the instant-buy and analysed paths. */
const RUG_GATE_CONFIG = { minLiquidityUsd: CONFIG.minLiquidityUsd, maxMarketCapUsd: CONFIG.maxMarketCapUsd };

/**
 * Recent model verdicts, keyed by token address. The scan sources return a
 * stable set, so without this the bot pays to re-analyse unchanged tokens every
 * cycle instead of spending that budget on ones it has not seen.
 *
 * Stored and returned BY VALUE — see analysis-cache.ts. Handing out the live
 * object let the confidence modifiers boost the cached verdict in place, so
 * every reuse inside the TTL applied those bonuses a second time.
 */
const analysisCache: AnalysisCache = new Map();

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

/** Record a buy attempt in the trade history and, on success, the per-run buy count. */
function recordBuyResult(
  symbol: string,
  tokenAddress: string,
  confidence: number,
  result: { success: boolean; error?: string; txSignature?: string },
  label: string
): void {
  tradeHistory.push({
    timestamp: Date.now(),
    symbol,
    action: "BUY",
    confidence,
    result: result.success ? "SUCCESS" : `FAILED: ${result.error}`,
    txSignature: result.txSignature,
  });
  if (result.success) {
    logger.info(`✅ ${label} executed: ${symbol}`);
    buyCounts = recordBuy(buyCounts, tokenAddress, symbol);
  } else {
    logger.warn(`❌ ${label} failed: ${result.error}`);
  }
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
 * Scan Jupiter's newest pools and buy anything that clears the fresh-launch
 * gate, at its own size and take-profit.
 *
 * Deliberately separate from the main pipeline: no model call (a five-minute-
 * old token has nothing to analyse) and no DexScreener dependency. The gate in
 * fresh-launch.ts is the only thing standing between this and the wallet, so
 * it fails closed on missing data.
 *
 * Still subject to every shared safety rule: concurrent-position limits,
 * re-entry blocks, and not doubling into something already held.
 */
async function scanFreshLaunches(): Promise<void> {
  if (!CONFIG.freshLaunchEnabled || CONFIG.dryRun) return;

  const candidates = await findFreshLaunches();
  if (candidates.length === 0) return;

  for (const fresh of candidates) {
    const activePositions = getActivePositions();
    if (activePositions.length >= MAX_CONCURRENT_POSITIONS) {
      logger.info(`🌱 ${fresh.symbol} qualified but all ${MAX_CONCURRENT_POSITIONS} position slots are full.`);
      return;
    }
    if (activePositions.some((p) => p.tokenAddress === fresh.address)) continue;

    // Shared helper, so this path obeys MAX_BUYS_PER_TOKEN and the loss/cooldown
    // rules identically to every other entry. Treated as a new coin, which is
    // what it is.
    if (reentryBlocked(fresh.address, fresh.symbol, true)) continue;

    logger.info(
      `🌱 FRESH LAUNCH BUY: ${fresh.symbol} — ${fresh.ageMinutes.toFixed(1)}m old, ` +
        `$${fresh.liquidityUsd.toFixed(0)} liq, $${fresh.buyVolume5m.toFixed(0)} 5m buys, ` +
        `${fresh.organicBuyPercent.toFixed(1)}% organic`
    );

    recordBuyResult(fresh.symbol, fresh.address, 100, await executeBuy(buildFreshLaunchSignal(fresh)), "Fresh-launch buy");
    await persistRuntimeState();
  }
}

/**
 * A synthetic signal for a fresh launch. Take-profit comes from the
 * fresh-launch config (75% by default) rather than the main TAKE_PROFIT_PERCENT
 * — the whole point of this path is a bigger target on a smaller stake. The
 * stop-loss stays on the shared setting so one risk rule governs the bot.
 */
function buildFreshLaunchSignal(fresh: FreshLaunchCandidate): TradeSignal {
  const token: TokenCandidate = {
    address: fresh.address,
    symbol: fresh.symbol,
    name: fresh.name,
    chainId: "solana",
    pairAddress: fresh.address,
    priceUsd: fresh.priceUsd,
    priceChange5m: 0,
    priceChange1h: 0,
    priceChange6h: 0,
    priceChange24h: 0,
    volume24h: fresh.buyVolume5m,
    liquidityUsd: fresh.liquidityUsd,
    marketCap: fresh.marketCapUsd,
    txns24hBuys: 0,
    txns24hSells: 0,
    buyToSellRatio: 0,
    pairCreatedAt: Date.now() - fresh.ageMinutes * 60_000,
    ageHours: fresh.ageMinutes / 60,
    url: `https://jup.ag/tokens/${fresh.address}`,
    hasXSocial: false,
    hasOtherSocial: false,
    hasPaidDexInfo: false,
  };

  return {
    token,
    confidence: 100,
    action: "BUY",
    reasoning:
      `Fresh launch: ${fresh.ageMinutes.toFixed(1)}m old, $${fresh.liquidityUsd.toFixed(0)} liquidity, ` +
      `$${fresh.buyVolume5m.toFixed(0)} 5m buy volume, ${fresh.organicBuyPercent.toFixed(1)}% organic, ` +
      `mint+freeze disabled. No model analysis.`,
    entryPrice: fresh.priceUsd,
    ...exitLevels(fresh.priceUsd, CONFIG.stopLossPercent, CONFIG.freshLaunchTakeProfitPercent),
    positionSizeSol: CONFIG.freshLaunchPositionSol,
    riskRewardRatio: CONFIG.freshLaunchTakeProfitPercent / CONFIG.stopLossPercent,
    trendStrength: "unknown",
    momentum: "unknown",
    riskLevel: "high",
    narrative: "fresh-launch",
    // confidence 100 here is a hardcoded constant, not a model verdict; the
    // gate label is what tells the two apart in the trade history.
    entryContext: { gate: "fresh-launch", source: "fresh-launch", confidenceBeforeModifiers: 100 },
  };
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
    ...exitLevels(token.priceUsd, CONFIG.stopLossPercent, CONFIG.takeProfitPercent),
    positionSizeSol: CONFIG.maxPositionSol,
    riskRewardRatio: CONFIG.takeProfitPercent / CONFIG.stopLossPercent,
    trendStrength: "unknown",
    momentum: "unknown",
    riskLevel: "high",
    narrative: "boost-triggered",
    // Same as fresh-launch: confidence 100 is a constant, and this path is the
    // one deliberate RugCheck exemption, so features.rugCheck stays absent.
    entryContext: { gate: "instant-buy", confidenceBeforeModifiers: 100 },
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

/**
 * Position monitoring runs on its own independent schedule (see main()),
 * separate from the scan/analyze/buy cycle — a provider outage can make
 * batchAnalyze() spend its full retry/timeout budget on every candidate, and
 * runScheduledCycle()'s cycleInProgress guard means a slow cycle blocks every
 * interval tick behind it. If monitoring lived inside that same cycle, an
 * AI-provider outage would starve stop-loss/take-profit checks on real open
 * positions for exactly as long as it starves analysis. monitoringInProgress
 * mirrors cycleInProgress so overlapping ticks can't double-evaluate (and
 * potentially double-sell) the same position.
 */
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

  const refreshed = await resolveMintsUnfiltered(due);
  for (const c of refreshed) positionRecheckAt.set(c.address, now);
  if (refreshed.length === 0) return;

  const signals = await batchAnalyze(refreshed);
  for (const signal of signals) {
    // Re-fetch rather than reuse a captured reference: a monitoring tick could
    // have closed this same position (stop-loss/take-profit) while the model
    // call above was in flight.
    const position = getActivePositions().find((p) => p.tokenAddress === signal.token.address);
    if (!position) continue;

    // A failed model call says nothing about the coin. Counting its 0% as a
    // bearish vote closed Crypt on 2026-09-24 with a failed parse as the third
    // of three "bearish" reads. Unknown is not bearish; wait for a real read.
    if (signal.analysisFailed) {
      logger.info(`⏭️  ${position.tokenSymbol}: re-analysis failed — not counted as a read.`);
      continue;
    }

    // Record this read, then decide on the accumulated history rather than on
    // this single call. One bearish sample no longer closes a position: it
    // takes 3 of the last 4 (so "B B B" or "B B U B"), which is what stops a
    // lone noisy re-analysis from cutting a coin mid-recovery — KCAT, sold at
    // roughly breakeven on one "reversing" read minutes before it pumped.
    const bearish = isBearishRead(
      signal.trendStrength,
      signal.momentum,
      signal.confidence,
      CONFIG.holdExitConfidenceThreshold
    );
    position.recentBearishReads = recordBearishRead(position.recentBearishReads, bearish);

    if (!shouldCloseHeldPosition(position.recentBearishReads)) {
      if (bearish) {
        const tally = position.recentBearishReads.filter(Boolean).length;
        logger.info(
          `⏳ ${position.tokenSymbol}: bearish read ${tally}/${BEARISH_READS_TO_CLOSE} ` +
            `(trend=${signal.trendStrength} momentum=${signal.momentum} conf=${signal.confidence}%) — ` +
            `holding until it is confirmed.`
        );
      }
      continue;
    }

    // A winner whose trailing stop has armed is already protected on price: it
    // cannot give back more than the trail distance from its peak. Closing it
    // here trades that guarantee for an opinion, and the opinion reads
    // "reversing" on every pullback inside a real run — which is how a position
    // gets sold at a 300k cap that later prints 8M. Same condition that already
    // defers take-profit in executeSell, applied to the AI exit too.
    if (CONFIG.letWinnersRun && trailIsArmed(position)) {
      logger.info(
        `🏃 ${position.tokenSymbol}: model reads trend=${signal.trendStrength} momentum=${signal.momentum} ` +
          `but the trailing stop is armed — letting it run instead of cutting the winner.`
      );
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

  // Runs before the main scan: this path is only useful inside a five-minute
  // window, so it must not queue behind the model calls below. Never fatal —
  // a failure here leaves the normal pipeline untouched.
  try {
    await scanFreshLaunches();
  } catch (error) {
    logger.error(`Fresh-launch scan threw (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
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

  // Which feed surfaced each mint. Recorded on the trade so the history can
  // later answer "which discovery source actually produces winners?" — the
  // feeds differ enough (popularity-biased vs. creation-time-ordered) that
  // pooling them hides the answer. Discovery-only, never a trading input.
  const sourceByAddress = new Map<string, string>();
  const tagSource = (found: TokenCandidate[], source: string): void => {
    for (const c of found) if (!sourceByAddress.has(c.address)) sourceByAddress.set(c.address, source);
  };
  tagSource(candidates, "dexscreener");

  // Extra discovery sources supply mint addresses only. Each is resolved
  // through resolveMintsToCandidates(), so every field is real DexScreener
  // data and nothing bypasses isWorthAnalysing()'s liquidity/age bars.
  const addSource = async (mints: string[], source: string, logLabel?: string): Promise<void> => {
    const fresh = mints.filter((m) => !candidates.some((c) => c.address === m));
    if (fresh.length === 0) return;
    const resolved = await resolveMintsToCandidates(fresh);
    if (logLabel && resolved.length > 0) logger.info(`${logLabel}: ${resolved.length} resolved to candidates`);
    tagSource(resolved, source);
    candidates = [...candidates, ...resolved];
  };

  // Telegram surfaces coins the DexScreener feeds never show.
  if (CONFIG.telegramEnabled || CONFIG.telegramScrapeChannels.length > 0) {
    await addSource(recentMentionedMints(Date.now(), CONFIG.telegramSignalTtlMinutes), "telegram");
  }
  // GeckoTerminal's new_pools feed is sorted by actual pool-creation time,
  // which none of DexScreener's feeds are (all biased toward coins that have
  // already gained volume, boost spend, or search relevance).
  if (CONFIG.geckoTerminalEnabled) {
    await addSource(await fetchNewPoolMints(undefined, CONFIG.geckoTerminalNewPoolsLimit), "geckoterminal", "🦎 GeckoTerminal");
  }
  // pump.fun's creation feed — the earliest a Solana meme coin is visible
  // anywhere. A coin too new to have a resolvable pool simply drops out.
  if (CONFIG.pumpfunDiscoveryEnabled) {
    await addSource(await fetchNewPumpMints(CONFIG.pumpfunDiscoveryLimit), "pumpfun", "💊 pump.fun");
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
  boostSightings = pruneSightings(observed.sightings, now, CONFIG.boostFreshWindowSeconds);
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

    for (const candidate of candidates) {
      if (getActivePositions().length >= MAX_CONCURRENT_POSITIONS) break;
      if (getActivePositions().some((p) => p.tokenAddress === candidate.address)) continue;
      if (reentryBlocked(candidate.address, candidate.symbol, candidate.ageHours < CONFIG.newCoinMaxAgeHours)) {
        continue;
      }

      // The boost must be one this run actually watched arrive. Without this
      // the bot buys whatever happens to be sitting in the rolling boosts feed,
      // which may be hours stale and already rolling over.
      if (!isBoostFresh(candidate.chainId, candidate.address, boostSightings, Date.now(), CONFIG.boostFreshWindowSeconds)) {
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
        },
        CONFIG.instantBuyBoostThreshold,
        RUG_GATE_CONFIG
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
      if (instantSignal.entryContext) {
        instantSignal.entryContext.source = sourceByAddress.get(candidate.address);
      }
      recordBuyResult(candidate.symbol, candidate.address, 100, await executeBuy(instantSignal), "Instant buy");
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
    const hit = recallVerdict(analysisCache, c.address, nowMs, analysisTtlMs);
    if (hit) {
      // Re-point the cached verdict at the current candidate so price-derived
      // fields downstream are current, even though the model's judgement is not.
      reused.push({ ...hit, token: c });
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
  // A failed analysis is not a verdict: caching it would sit the coin out
  // for the whole TTL on one flaky model call.
  for (const sig of analysed) if (!sig.analysisFailed) rememberVerdict(analysisCache, sig, nowMs);
  const signals = [...analysed, ...reused];

  // Open a fresh entry context per cycle, before any modifier runs, so the
  // baseline is the model's own verdict rather than anything the modifiers
  // have already added. analysisCache stores and returns verdicts by value
  // (see analysis-cache.ts), so a reused signal starts from the same untouched
  // number a freshly analysed one does.
  for (const s of signals) {
    s.entryContext = {
      confidenceBeforeModifiers: s.confidence,
      gate: "ai",
      source: sourceByAddress.get(s.token.address),
    };
  }

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
        recordConfidenceBonus(s, "entryScore", adj.adjustedConfidence - s.confidence);
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
      const creator = await fetchCreatorWallet(s.token.address);
      if (!creator) continue;
      const { bonus, reason } = devReputationBonus(await fetchDevReputation(creator), repConfig);
      applyBonus(s, "devReputation", bonus, `👤 ${reason}`);
    }
  }

  // A Telegram mention is a marketing signal in the same category as a paid
  // boost — cheap to manufacture, so the bonus is small and not compounded
  // with everything else beyond what the individual modifiers already allow.
  if (CONFIG.telegramEnabled || CONFIG.telegramScrapeChannels.length > 0) {
    for (const s of signals) {
      const sig = getTelegramSignal(s.token.address, Date.now(), CONFIG.telegramSignalTtlMinutes);
      if (sig) {
        applyBonus(s, "telegram", CONFIG.telegramMentionBonus, `📡 +${CONFIG.telegramMentionBonus} mentioned in ${sig.channel}`);
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
      applyBonus(s, "narrativeTrend", bonus, `📈 ${reason}`);
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

  if (CONFIG.requireProfitableFirstTrade) {
    const gate = shouldSkipNewEntries(firstTradeValidated, activePositions.length);
    if (gate.skip) {
      logger.warn(`⛔ New entries paused: ${gate.reason}`);
      await persistRuntimeState();
      return;
    }
  }
  const slotsAvailable = CONFIG.requireProfitableFirstTrade
    ? maxNewEntries(firstTradeValidated, MAX_CONCURRENT_POSITIONS, activePositions.length)
    : MAX_CONCURRENT_POSITIONS - activePositions.length;
  if (slotsAvailable <= 0) {
    logger.warn(`Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached. Skipping new entries.`);
    await persistRuntimeState();
    return;
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
    // outvoted by confidence, however high the score.
    if (CONFIG.rugGatesEnabled) {
      // Cheap, network-free bounds first: liquidity floor and market-cap ceiling.
      const basic = checkRugGates(
        { liquidityUsd: signal.token.liquidityUsd, marketCapUsd: signal.token.marketCap },
        RUG_GATE_CONFIG
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
      // Keep the report on the signal even when the gate then rejects it: on a
      // pass this is what gets recorded with the buy, and a rejected coin never
      // reaches a trade record anyway.
      if (signal.entryContext) signal.entryContext.rugCheck = rc;
      const gate = checkSmallCapGate(
        {
          liquidityUsd: signal.token.liquidityUsd,
          volume24h: signal.token.volume24h,
          hasAnySocial: signal.token.hasXSocial || signal.token.hasOtherSocial,
          rugCheck: rc,
        },
        {
          minLiquidityUsd: CONFIG.minLiquidityUsd,
          minHolders: CONFIG.smallCapMinHolders,
          maxDevHoldingPct: CONFIG.smallCapMaxDevHoldingPct,
          maxInsiderHoldingPct: CONFIG.smallCapMaxInsiderHoldingPct,
          maxBundlerHoldingPct: CONFIG.smallCapMaxBundlerHoldingPct,
          minVolume24h: CONFIG.smallCapMinVolume24h,
          maxRugCheckScore: CONFIG.smallCapMaxRugCheckScore,
          maxRugCheckScoreRaw: CONFIG.maxRugCheckScoreRaw,
          blockDangerRisks: CONFIG.blockDangerRisks,
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

    // Size by conviction, using the FINAL confidence — the same number the
    // filter above used, after every modifier. analyze.ts set a flat size from
    // MAX_POSITION_SOL before any of those modifiers existed, so this is the
    // only place the two can agree. Untiered config leaves the original size
    // untouched, and the instant-buy and fresh-launch paths keep their own
    // deliberate stakes.
    if (CONFIG.positionSizeTiers.length > 0) {
      const tiered = sizeForConfidence(signal.confidence, CONFIG.positionSizeTiers, signal.positionSizeSol);
      if (tiered !== signal.positionSizeSol) {
        logger.info(
          `🎚️  ${signal.token.symbol}: ${signal.confidence}% confidence → staking ${tiered} SOL ` +
            `(was ${signal.positionSizeSol}).`
        );
        signal.positionSizeSol = tiered;
      }
    }

    recordBuyResult(signal.token.symbol, signal.token.address, signal.confidence, await executeBuy(signal), "Trade");
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  logger.info(`⏱️ Cycle completed in ${elapsed}s`);
  await persistRuntimeState();
}

/** Add a confidence bonus (capped at 100), record it on the entry context, and log why. */
function applyBonus(s: TradeSignal, modifier: string, bonus: number, reason: string): void {
  if (bonus <= 0) return;
  const before = s.confidence;
  s.confidence = Math.min(100, s.confidence + bonus);
  recordConfidenceBonus(s, modifier, s.confidence - before);
  logger.info(`${s.token.symbol}: ${before}% → ${s.confidence}% (${reason})`);
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
        // Strictly negative: a breakeven exit is not a loss, and treating it as
        // one let BLOCK_LOSING_REENTRY_FOR_RUN bar re-entry on coins that cost
        // nothing. It also made the "N straight losses" read in the exit log
        // count flat trades as losers.
        wasLoss: (event.pnlPercent ?? 0) < 0,
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
