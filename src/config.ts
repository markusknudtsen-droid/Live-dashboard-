import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

export interface AppConfig {
  openRouterApiKey: string;
  openRouterModel: string;
  openRouterApiUrl: string;
  solanaPrivateKey: string;
  minConfidence: number;
  maxPositionSol: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  scanIntervalSeconds: number;
  solanaRpcUrl: string;
  dexScreenerApiUrl: string;
  jupiterApiBaseUrl: string;
  jupiterApiKey: string;
  scanChains: string[];
  dashboardApiUrl: string;
  dashboardApiKey: string;
  dashboardWebUrl: string;
  allowSkipPreflight: boolean;
  httpTimeoutMs: number;
  httpMaxRetries: number;
  logLevel: "debug" | "info" | "warn" | "error";
  stateFilePath: string;
  dryRun: boolean;
  paperStartingBalanceSol: number;
  requireProfitableFirstTrade: boolean;
  /**
   * When true, every entry is sized at exactly maxPositionSol instead of the
   * model-chosen percentage of it. The operator, not the model, decides how
   * much capital each trade risks. Off by default — existing behaviour is that
   * maxPositionSol is a ceiling the model sizes down from.
   */
  useFixedPositionSize: boolean;
  /** Trailing stop: off by default so existing runs are unchanged. */
  trailingStopEnabled: boolean;
  /** Gain (%) a position must reach before the trail arms. */
  trailingStopActivatePercent: number;
  /** How far (%) below the peak the trailed stop sits. */
  trailingStopDistancePercent: number;
  /** Hard entry gates: off by default. */
  rugGatesEnabled: boolean;
  minLiquidityUsd: number;
  /** Exit a held position when its pool drains this far below its own peak. */
  rugExitLiquidityDropPercent: number;
  /** Master switch for liquidity-drain rug detection on held positions. */
  rugExitEnabled: boolean;
  holderCheckMinMarketCapUsd: number;
  maxTopHolderPercent: number;
  /** Confidence modifiers from age/socials/boost: off by default. */
  entryScoringEnabled: boolean;
  /** Buy a heavily boosted coin without waiting for model analysis. */
  instantBuyOnBoostEnabled: boolean;
  /** Boost amount at or above which the instant buy fires. */
  instantBuyBoostThreshold: number;
  /** Reconcile persisted positions against actual wallet holdings at startup. */
  reconcileOnStartup: boolean;
  /** Minutes a token is blocked from re-entry after any exit. 0 disables. */
  reentryCooldownMinutes: number;
  /** Block a token that exited at a loss for the remainder of the run. */
  blockLosingReentryForRun: boolean;
  /** Consecutive failed sells before a position is abandoned. */
  maxSellAttempts: number;
  /**
   * Re-check wallet holdings every N monitoring ticks, not just at startup, so a
   * position sold outside the bot is noticed within one interval rather than
   * surviving until the next restart.
   */
  reconcileEveryTicks: number;
  /**
   * How many positions may be open at once. Was a hardcoded constant (3);
   * raising it does not by itself change how much SOL is needed — that is
   * maxConcurrentPositions * maxPositionSol plus the 0.05 trading floor. See
   * the startup check in index.ts, which warns rather than silently
   * overriding this when the wallet cannot fund every slot.
   */
  maxConcurrentPositions: number;
  /**
   * Score creators via pump.fun's UNOFFICIAL frontend API. Off by default: it
   * is an undocumented endpoint that can break without notice. Every failure
   * withholds the bonus rather than guessing, so a breakage costs the signal
   * and nothing else.
   */
  /**
   * Let freshly-launched coins into the candidate pool. They cannot satisfy the
   * standard volume24h bar (a trailing figure they have not existed long enough
   * to accumulate), so without this the pool only ever contains established
   * coins already well into their move.
   */
  watchNewCoins: boolean;
  newCoinMaxAgeHours: number;
  newCoinMinMomentumPercent: number;
  /** Candidates sent to the model per cycle. Was hardcoded at 5. */
  maxCandidatesPerCycle: number;
  /**
   * How many candidates are analysed at once. Analysis used to be strictly
   * sequential, so a BUY decided on the first token still waited for every
   * later token's model call before anything could execute — minutes on a
   * full batch, on coins whose whole edge is measured in seconds.
   */
  analysisConcurrency: number;
  /** Minutes an AI verdict is reused before re-analysing the same token. */
  analysisCacheMinutes: number;
  /**
   * Read Solana contract addresses from Telegram signal channels. Off by
   * default. A mention is primarily a CANDIDATE SOURCE (coins the
   * volume-biased DexScreener feeds never surface); the score bonus is
   * secondary and capped, because a channel call is a marketing signal in the
   * same category as a paid boost.
   */
  telegramEnabled: boolean;
  telegramApiId: number;
  telegramApiHash: string;
  telegramSession: string;
  telegramChannels: string[];
  telegramMentionBonus: number;
  telegramSignalTtlMinutes: number;
  /** Public channels read with no login via t.me/s/{channel}. Separate list:
   *  these do not require a session and can run even if MTProto login is
   *  never done. */
  telegramScrapeChannels: string[];
  telegramScrapeIntervalSeconds: number;
  /**
   * Hard ceiling on candidate age, applied to every candidate in the scanner's
   * initial filter. Was a hardcoded 168 (7 days), which let the bot spend its
   * slots on week-old coins that had already made their move.
   */
  maxTokenAgeHours: number;
  /** RugCheck RAW score above which a coin is rejected. See small-cap-gate.ts. */
  maxRugCheckScoreRaw: number;
  /** Reject any coin RugCheck flags with a danger-level risk. */
  blockDangerRisks: boolean;
  /** Global dead-coin floor, applied to every candidate regardless of size. */
  minMarketCapUsd: number;
  /** Below this market cap, checkSmallCapGate() applies instead of the normal rug gate. */
  smallCapMaxMarketCapUsd: number;
  smallCapMinHolders: number;
  smallCapMaxDevHoldingPct: number;
  smallCapMaxInsiderHoldingPct: number;
  smallCapMaxBundlerHoldingPct: number;
  smallCapMinVolume24h: number;
  smallCapMaxRugCheckScore: number;
  /** Coins younger than newCoinMaxAgeHours skip the re-entry cooldown entirely. */
  newCoinCooldownExempt: boolean;
  /** Blocks a BUY (fresh or cooldown-exempt re-entry) when the model's own trendStrength/momentum reads bearish. */
  bearishBuyGuardEnabled: boolean;
  /** Re-checks held positions on this cadence and exits on a bearish read. 0 disables the sell side. */
  bearishExitRecheckMinutes: number;
  /** A held position's re-analysis confidence at or below this closes it, same as a bearish trend/momentum read. */
  holdExitConfidenceThreshold: number;
  /** Cooldown applied to a new coin instead of the full REENTRY_COOLDOWN_MINUTES. */
  newCoinReentryCooldownMinutes: number;
  /** Lifetime cap on buys of the same token. 0 disables the check. */
  maxBuysPerToken: number;
  /** Slots held open for new/small coins so established ones cannot take every slot. 0 disables. */
  reservedNewCoinSlots: number;
  /** Gain at which a slice of the position is banked. 0 disables partial take-profit. */
  /**
   * Whether the bot may add to a position it already holds, once, when it has
   * dipped and the model is still bullish on it at a fresh look. Before this,
   * "Already in position for X, skipping." was unconditional — no matter how
   * strong a later signal was, a held token could never be topped up.
   */
  addOnEnabled: boolean;
  /** Flat SOL size for a single add-on buy, independent of maxPositionSol. */
  addOnSol: number;
  /** Position must be down at least this many percent to qualify for an add-on. */
  addOnTriggerDipPercent: number;
  partialTakeProfitPercent: number;
  /** Fraction of the position sold when that gain is reached, 0..1. */
  partialTakeProfitFraction: number;
  /** A second, creation-time-sorted candidate source, alongside DexScreener. */
  geckoTerminalEnabled: boolean;
  geckoTerminalNewPoolsLimit: number;
  /** A candidate at or below this market cap qualifies for a reserved slot. */
  newCoinSlotMaxMarketCapUsd: number;
  /** Bonus when a candidate's keyword bucket has been winning recently. */
  narrativeTrendEnabled: boolean;
  /** pump.fun's creation feed as a third candidate source. */
  pumpfunDiscoveryEnabled: boolean;
  pumpfunDiscoveryLimit: number;
  devReputationEnabled: boolean;
  devMinFollowers: number;
  devMinMigratedTokens: number;
  devReputationBonus: number;
  /** Skip coins valued above this market cap. 0 disables. */
  maxMarketCapUsd: number;
  /**
   * Seconds after a boost is FIRST observed during which an instant buy may
   * still fire. Beyond it the boost is stale and the move is likely over.
   */
  boostFreshWindowSeconds: number;
  /**
   * When the trailing stop is armed, ignore the fixed take-profit and let the
   * trail decide the exit. Without this a still-climbing position is closed the
   * instant it touches takeProfitPercent, however strong the momentum.
   */
  letWinnersRun: boolean;
  /**
   * Where an automatic profit sweep (and the dashboard's manual withdrawal,
   * server/withdrawalPolicy.ts) sends SOL. Empty disables both: the manual
   * path falls back to accepting any destination, and the automatic sweep
   * refuses to run at all rather than guess a destination.
   */
  withdrawalAddress: string;
  /**
   * Automatically send excess SOL to withdrawalAddress once the balance grows
   * past profitSweepReserveSol. Off by default. Unlike the dashboard's manual
   * withdrawal, this path has NO confirmation code and no human step — an
   * explicit operator trade-off in exchange for not touching the dashboard.
   */
  profitSweepEnabled: boolean;
  /** Balance always left behind, so the bot can keep filling its trading slots. */
  profitSweepReserveSol: number;
  /** Excess below this is left alone rather than swept, to avoid dust-sized transfers. */
  profitSweepMinSol: number;
  /** Caps a single sweep's size. 0 disables the cap (sweep the full excess). */
  profitSweepMaxSol: number;
}

function parseNumberInRange(
  key: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a finite number between ${min} and ${max}.`);
  }
  return value;
}

function parseIntegerInRange(
  key: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseLogLevel(raw: string | undefined): AppConfig["logLevel"] {
  const level = (raw || "info").toLowerCase();
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }
  throw new Error("LOG_LEVEL must be one of: debug, info, warn, error.");
}

function parseScanChains(raw: string | undefined): string[] {
  return (raw || "solana")
    .split(",")
    .map((chain) => chain.trim().toLowerCase())
    .filter(Boolean);
}

export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    openRouterApiKey: env.OPENROUTER_API_KEY || "",
    // The analysis model. Configurable because model IDs get retired — the
    // previous hardcoded google/gemini-2.0-flash-001 was withdrawn from
    // OpenRouter, which silently turned every analysis into a zero-confidence
    // SKIP. See checkAnalysisModel() in src/model-preflight.ts, which verifies
    // this model actually works before any trading starts.
    openRouterModel: env.OPENROUTER_MODEL || "deepseek/deepseek-v3.2",
    // Configurable purely so tests can point analyzeToken() at a local
    // stand-in server (see tests/analyze.test.ts) instead of a real network
    // call — same convention as jupiterApiBaseUrl below. Not meant to be
    // changed in normal use; strip trailing slash(es) so `${base}/chat/...`
    // never double-slashes.
    openRouterApiUrl: (env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    solanaPrivateKey: env.SOLANA_PRIVATE_KEY || "",
    minConfidence: parseNumberInRange("MIN_CONFIDENCE", env.MIN_CONFIDENCE, 80, 0, 100),
    maxPositionSol: parseNumberInRange("MAX_POSITION_SOL", env.MAX_POSITION_SOL, 0.5, 0.001, 10),
    // Widened from the original 15% default: memecoins commonly dip before
    // reversing, so a tight stop can exit a trade that would have recovered.
    // 33% accepts a deeper drawdown in exchange for more room to work.
    stopLossPercent: parseNumberInRange("STOP_LOSS_PERCENT", env.STOP_LOSS_PERCENT, 33, 1, 95),
    takeProfitPercent: parseNumberInRange("TAKE_PROFIT_PERCENT", env.TAKE_PROFIT_PERCENT, 50, 1, 1000),
    scanIntervalSeconds: parseIntegerInRange("SCAN_INTERVAL_SECONDS", env.SCAN_INTERVAL_SECONDS, 60, 5, 3600),
    solanaRpcUrl: env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    dexScreenerApiUrl: env.DEXSCREENER_API_URL || "https://api.dexscreener.com",
    // Jupiter Swap V2 Meta-Aggregator: /order + /execute. Keyless access is
    // available at a lower rate limit; configure JUPITER_API_KEY for a
    // production bot and higher reliability. Strip trailing slashes so
    // `${base}/order` never produces a double slash.
    jupiterApiBaseUrl: (env.JUPITER_API_BASE_URL || "https://api.jup.ag/swap/v2").replace(/\/+$/, ""),
    // Accept either name: JUPITER_API_KEY, or JUPITER_API (the label Jupiter's
    // own portal shows when you generate a key).
    jupiterApiKey: env.JUPITER_API_KEY || env.JUPITER_API || "",
    scanChains: parseScanChains(env.SCAN_CHAINS),
    dashboardApiUrl: env.DASHBOARD_API_URL || "",
    dashboardApiKey: env.DASHBOARD_API_KEY || "",
    dashboardWebUrl: env.DASHBOARD_WEB_URL || "",
    allowSkipPreflight: parseBoolean(env.ALLOW_SKIP_PREFLIGHT, false),
    httpTimeoutMs: parseIntegerInRange("HTTP_TIMEOUT_MS", env.HTTP_TIMEOUT_MS, 10000, 1000, 120000),
    httpMaxRetries: parseIntegerInRange("HTTP_MAX_RETRIES", env.HTTP_MAX_RETRIES, 3, 0, 10),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    stateFilePath: env.BOT_STATE_FILE || "./data/state.json",
    dryRun: parseBoolean(env.DRY_RUN, false),
    paperStartingBalanceSol: parseNumberInRange(
      "PAPER_STARTING_BALANCE_SOL",
      env.PAPER_STARTING_BALANCE_SOL,
      10,
      0.001,
      100000
    ),
    // Opt-in safety gate for going live with a new wallet/strategy: open
    // exactly one position, wait for it to close, and only resume normal
    // trading if that first trade's realized PnL was positive. See
    // src/first-trade-gate.ts. Off by default — existing behavior unchanged.
    requireProfitableFirstTrade: parseBoolean(env.REQUIRE_PROFITABLE_FIRST_TRADE, false),
    useFixedPositionSize: parseBoolean(env.USE_FIXED_POSITION_SIZE, false),
    trailingStopEnabled: parseBoolean(env.TRAILING_STOP_ENABLED, false),
    trailingStopActivatePercent: parseNumberInRange(
      "TRAILING_STOP_ACTIVATE_PERCENT",
      env.TRAILING_STOP_ACTIVATE_PERCENT,
      15,
      0,
      1000
    ),
    // Kept below the activation gain on purpose: a trail as wide as the
    // activation threshold arms with its stop still under entry.
    trailingStopDistancePercent: parseNumberInRange(
      "TRAILING_STOP_DISTANCE_PERCENT",
      env.TRAILING_STOP_DISTANCE_PERCENT,
      10,
      1,
      99
    ),
    rugGatesEnabled: parseBoolean(env.RUG_GATES_ENABLED, false),
    minLiquidityUsd: parseNumberInRange("MIN_LIQUIDITY_USD", env.MIN_LIQUIDITY_USD, 5000, 0, 100_000_000),
    // Defaults on: a drained pool is the one exit signal that is never a false
    // alarm worth ignoring, and it costs no extra API call to watch.
    rugExitEnabled: parseBoolean(env.RUG_EXIT_ENABLED, true),
    // Floor of 5 keeps this from being set so tight that ordinary swap noise
    // closes healthy positions; 99 keeps it from being disabled by stealth.
    rugExitLiquidityDropPercent: parseNumberInRange(
      "RUG_EXIT_LIQUIDITY_DROP_PERCENT",
      env.RUG_EXIT_LIQUIDITY_DROP_PERCENT,
      40,
      5,
      99
    ),
    holderCheckMinMarketCapUsd: parseNumberInRange(
      "HOLDER_CHECK_MIN_MARKET_CAP_USD",
      env.HOLDER_CHECK_MIN_MARKET_CAP_USD,
      60000,
      0,
      100_000_000
    ),
    maxTopHolderPercent: parseNumberInRange("MAX_TOP_HOLDER_PERCENT", env.MAX_TOP_HOLDER_PERCENT, 30, 1, 100),
    entryScoringEnabled: parseBoolean(env.ENTRY_SCORING_ENABLED, false),
    instantBuyOnBoostEnabled: parseBoolean(env.INSTANT_BUY_ON_BOOST_ENABLED, false),
    instantBuyBoostThreshold: parseNumberInRange(
      "INSTANT_BUY_BOOST_THRESHOLD",
      env.INSTANT_BUY_BOOST_THRESHOLD,
      500,
      1,
      1_000_000
    ),
    // On by default: the failure it prevents (pricing and repeatedly trying to
    // sell a coin the wallet no longer holds) is silent, and the check costs
    // one RPC call per start.
    reconcileOnStartup: parseBoolean(env.RECONCILE_ON_STARTUP, true),
    reentryCooldownMinutes: parseNumberInRange(
      "REENTRY_COOLDOWN_MINUTES",
      env.REENTRY_COOLDOWN_MINUTES,
      60,
      0,
      10_080
    ),
    blockLosingReentryForRun: parseBoolean(env.BLOCK_LOSING_REENTRY_FOR_RUN, false),
    maxSellAttempts: parseNumberInRange("MAX_SELL_ATTEMPTS", env.MAX_SELL_ATTEMPTS, 5, 1, 100),
    reconcileEveryTicks: parseNumberInRange("RECONCILE_EVERY_TICKS", env.RECONCILE_EVERY_TICKS, 20, 1, 10_000),
    maxConcurrentPositions: parseNumberInRange("MAX_CONCURRENT_POSITIONS", env.MAX_CONCURRENT_POSITIONS, 3, 1, 20),
    watchNewCoins: parseBoolean(env.WATCH_NEW_COINS, false),
    newCoinMaxAgeHours: parseNumberInRange("NEW_COIN_MAX_AGE_HOURS", env.NEW_COIN_MAX_AGE_HOURS, 6, 0.05, 168),
    newCoinMinMomentumPercent: parseNumberInRange("NEW_COIN_MIN_MOMENTUM_PERCENT", env.NEW_COIN_MIN_MOMENTUM_PERCENT, 15, -100, 10_000),
    maxCandidatesPerCycle: parseNumberInRange("MAX_CANDIDATES_PER_CYCLE", env.MAX_CANDIDATES_PER_CYCLE, 5, 1, 25),
    analysisConcurrency: parseNumberInRange("ANALYSIS_CONCURRENCY", env.ANALYSIS_CONCURRENCY, 4, 1, 10),
    analysisCacheMinutes: parseNumberInRange("ANALYSIS_CACHE_MINUTES", env.ANALYSIS_CACHE_MINUTES, 10, 0, 1440),
    telegramEnabled: parseBoolean(env.TELEGRAM_ENABLED, false),
    telegramApiId: parseNumberInRange("TELEGRAM_API_ID", env.TELEGRAM_API_ID, 0, 0, 1_000_000_000),
    telegramApiHash: (env.TELEGRAM_API_HASH || "").trim(),
    telegramSession: (env.TELEGRAM_SESSION || "").trim(),
    telegramChannels: (env.TELEGRAM_CHANNELS || "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0),
    telegramMentionBonus: parseNumberInRange("TELEGRAM_MENTION_BONUS", env.TELEGRAM_MENTION_BONUS, 6, 0, 100),
    telegramSignalTtlMinutes: parseNumberInRange("TELEGRAM_SIGNAL_TTL_MINUTES", env.TELEGRAM_SIGNAL_TTL_MINUTES, 30, 0, 1440),
    telegramScrapeChannels: (env.TELEGRAM_SCRAPE_CHANNELS || "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0),
    telegramScrapeIntervalSeconds: parseNumberInRange("TELEGRAM_SCRAPE_INTERVAL_SECONDS", env.TELEGRAM_SCRAPE_INTERVAL_SECONDS, 45, 10, 3600),
    maxTokenAgeHours: parseNumberInRange("MAX_TOKEN_AGE_HOURS", env.MAX_TOKEN_AGE_HOURS, 24, 0.01, 8760),
    maxRugCheckScoreRaw: parseNumberInRange("MAX_RUGCHECK_SCORE_RAW", env.MAX_RUGCHECK_SCORE_RAW, 5000, 0, 10_000_000),
    blockDangerRisks: parseBoolean(env.BLOCK_DANGER_RISKS, true),
    minMarketCapUsd: parseNumberInRange("MIN_MARKET_CAP_USD", env.MIN_MARKET_CAP_USD, 7000, 0, 100_000_000),
    smallCapMaxMarketCapUsd: parseNumberInRange("SMALL_CAP_MAX_MARKET_CAP_USD", env.SMALL_CAP_MAX_MARKET_CAP_USD, 40_000, 0, 100_000_000),
    smallCapMinHolders: parseNumberInRange("SMALL_CAP_MIN_HOLDERS", env.SMALL_CAP_MIN_HOLDERS, 60, 0, 1_000_000),
    smallCapMaxDevHoldingPct: parseNumberInRange("SMALL_CAP_MAX_DEV_HOLDING_PCT", env.SMALL_CAP_MAX_DEV_HOLDING_PCT, 8, 0, 100),
    smallCapMaxInsiderHoldingPct: parseNumberInRange("SMALL_CAP_MAX_INSIDER_HOLDING_PCT", env.SMALL_CAP_MAX_INSIDER_HOLDING_PCT, 22, 0, 100),
    smallCapMaxBundlerHoldingPct: parseNumberInRange("SMALL_CAP_MAX_BUNDLER_HOLDING_PCT", env.SMALL_CAP_MAX_BUNDLER_HOLDING_PCT, 22, 0, 100),
    smallCapMinVolume24h: parseNumberInRange("SMALL_CAP_MIN_VOLUME_24H", env.SMALL_CAP_MIN_VOLUME_24H, 1000, 0, 100_000_000),
    smallCapMaxRugCheckScore: parseNumberInRange("SMALL_CAP_MAX_RUGCHECK_SCORE", env.SMALL_CAP_MAX_RUGCHECK_SCORE, 50, 0, 100),
    newCoinCooldownExempt: parseBoolean(env.NEW_COIN_COOLDOWN_EXEMPT, false),
    bearishBuyGuardEnabled: parseBoolean(env.BEARISH_BUY_GUARD_ENABLED, true),
    bearishExitRecheckMinutes: parseNumberInRange("BEARISH_EXIT_RECHECK_MINUTES", env.BEARISH_EXIT_RECHECK_MINUTES, 3, 0, 1440),
    holdExitConfidenceThreshold: parseNumberInRange("HOLD_EXIT_CONFIDENCE_THRESHOLD", env.HOLD_EXIT_CONFIDENCE_THRESHOLD, 55, 0, 100),
    newCoinReentryCooldownMinutes: parseNumberInRange("NEW_COIN_REENTRY_COOLDOWN_MINUTES", env.NEW_COIN_REENTRY_COOLDOWN_MINUTES, 2, 0, 1440),
    maxBuysPerToken: parseNumberInRange("MAX_BUYS_PER_TOKEN", env.MAX_BUYS_PER_TOKEN, 3, 0, 1000),
    reservedNewCoinSlots: parseNumberInRange("RESERVED_NEW_COIN_SLOTS", env.RESERVED_NEW_COIN_SLOTS, 1, 0, 100),
    addOnEnabled: parseBoolean(env.ADD_ON_ENABLED, true),
    addOnSol: parseNumberInRange("ADD_ON_SOL", env.ADD_ON_SOL, 0.05, 0, 100),
    addOnTriggerDipPercent: parseNumberInRange("ADD_ON_TRIGGER_DIP_PERCENT", env.ADD_ON_TRIGGER_DIP_PERCENT, 15, 0.1, 100),
    partialTakeProfitPercent: parseNumberInRange("PARTIAL_TAKE_PROFIT_PERCENT", env.PARTIAL_TAKE_PROFIT_PERCENT, 100, 0, 100_000),
    partialTakeProfitFraction: parseNumberInRange("PARTIAL_TAKE_PROFIT_FRACTION", env.PARTIAL_TAKE_PROFIT_FRACTION, 0.5, 0.01, 0.99),
    geckoTerminalEnabled: parseBoolean(env.GECKOTERMINAL_ENABLED, true),
    geckoTerminalNewPoolsLimit: parseNumberInRange("GECKOTERMINAL_NEW_POOLS_LIMIT", env.GECKOTERMINAL_NEW_POOLS_LIMIT, 20, 1, 100),
    newCoinSlotMaxMarketCapUsd: parseNumberInRange("NEW_COIN_SLOT_MAX_MARKET_CAP_USD", env.NEW_COIN_SLOT_MAX_MARKET_CAP_USD, 60_000, 0, 100_000_000),
    narrativeTrendEnabled: parseBoolean(env.NARRATIVE_TREND_ENABLED, false),
    pumpfunDiscoveryEnabled: parseBoolean(env.PUMPFUN_DISCOVERY_ENABLED, false),
    pumpfunDiscoveryLimit: parseNumberInRange("PUMPFUN_DISCOVERY_LIMIT", env.PUMPFUN_DISCOVERY_LIMIT, 20, 1, 100),
    devReputationEnabled: parseBoolean(env.DEV_REPUTATION_ENABLED, false),
    devMinFollowers: parseNumberInRange("DEV_MIN_FOLLOWERS", env.DEV_MIN_FOLLOWERS, 2000, 0, 10_000_000),
    devMinMigratedTokens: parseNumberInRange("DEV_MIN_MIGRATED_TOKENS", env.DEV_MIN_MIGRATED_TOKENS, 3, 0, 10_000),
    devReputationBonus: parseNumberInRange("DEV_REPUTATION_BONUS", env.DEV_REPUTATION_BONUS, 15, 0, 100),
    maxMarketCapUsd: parseNumberInRange("MAX_MARKET_CAP_USD", env.MAX_MARKET_CAP_USD, 0, 0, 1_000_000_000),
    boostFreshWindowSeconds: parseNumberInRange(
      "BOOST_FRESH_WINDOW_SECONDS",
      env.BOOST_FRESH_WINDOW_SECONDS,
      120,
      5,
      3600
    ),
    letWinnersRun: parseBoolean(env.LET_WINNERS_RUN, false),
    withdrawalAddress: (env.WITHDRAWAL_ADDRESS || "").trim(),
    profitSweepEnabled: parseBoolean(env.PROFIT_SWEEP_ENABLED, false),
    profitSweepReserveSol: parseNumberInRange("PROFIT_SWEEP_RESERVE_SOL", env.PROFIT_SWEEP_RESERVE_SOL, 0.5, 0, 1000),
    profitSweepMinSol: parseNumberInRange("PROFIT_SWEEP_MIN_SOL", env.PROFIT_SWEEP_MIN_SOL, 0.1, 0, 1000),
    profitSweepMaxSol: parseNumberInRange("PROFIT_SWEEP_MAX_SOL", env.PROFIT_SWEEP_MAX_SOL, 0, 0, 1000),
  };
}

export const CONFIG = buildConfig();

export function validateConfig(config: AppConfig = CONFIG): void {
  // OPENROUTER_API_KEY is deliberately NOT checked here. A missing key only
  // breaks AI analysis, not the bot as a whole — checkAnalysisModel()
  // (src/model-preflight.ts) catches an EMPTY key at startup and represents
  // it as a broken analysisModelStatus the same way a retired/incompatible
  // model is, which blocks new entries but never position monitoring. An
  // invalid-but-present key (revoked, typo'd, wrong account) isn't caught
  // there — the /models catalogue endpoint it checks against doesn't
  // require authentication — so it only surfaces once a real completion
  // request gets rejected, handled by analyze.ts's existing per-call
  // failure tracking and streak escalation instead. Either way, throwing
  // here would exit the whole process before state is even restored,
  // leaving any already-open position completely unmonitored — exactly the
  // outcome this PR's analysis-failure handling elsewhere exists to prevent.
  if (!config.solanaPrivateKey && !config.dryRun) {
    throw new Error(
      "SOLANA_PRIVATE_KEY is required. Set it in your .env file (or enable DRY_RUN=true to test with a simulated paper wallet)."
    );
  }
  if (config.scanChains.length === 0) {
    throw new Error("SCAN_CHAINS must include at least one chain.");
  }
  if (config.profitSweepEnabled) {
    if (!config.withdrawalAddress) {
      throw new Error("PROFIT_SWEEP_ENABLED requires WITHDRAWAL_ADDRESS to be set.");
    }
    try {
      new PublicKey(config.withdrawalAddress);
    } catch {
      throw new Error("WITHDRAWAL_ADDRESS is not a valid Solana address.");
    }
  }
  console.log("✅ Configuration validated");
  if (config.dryRun) {
    console.log(
      `   🧪 DRY RUN MODE: no real funds or transactions are used (paper balance: ${config.paperStartingBalanceSol} SOL)`
    );
  }
  console.log(`   Analysis model: ${config.openRouterModel}`);
  console.log(`   Min Confidence: ${config.minConfidence}%`);
  console.log(`   Max Position: ${config.maxPositionSol} SOL`);
  console.log(`   Stop Loss: -${config.stopLossPercent}%`);
  console.log(`   Take Profit: +${config.takeProfitPercent}%`);
  console.log(`   Scan Interval: ${config.scanIntervalSeconds}s`);
  console.log(`   Chains: ${config.scanChains.join(", ")}`);
  console.log(
    `   Jupiter API: ${config.jupiterApiKey ? "authenticated key configured" : "unauthenticated (free tier)"} @ ${config.jupiterApiBaseUrl}`
  );
  if (config.requireProfitableFirstTrade) {
    console.log("   🔒 REQUIRE_PROFITABLE_FIRST_TRADE enabled: only one position until it proves profitable.");
  }
  if (config.trailingStopEnabled) {
    console.log(
      `   🔒 TRAILING_STOP enabled: arms at +${config.trailingStopActivatePercent}%, trails ` +
        `${config.trailingStopDistancePercent}% below peak, never below entry once armed.`
    );
  }
  if (config.rugGatesEnabled) {
    console.log(
      `   🛡️  RUG_GATES enabled: min liquidity $${config.minLiquidityUsd}, max top-holder ` +
        `${config.maxTopHolderPercent}% above $${config.holderCheckMinMarketCapUsd} MC.`
    );
  }
  if (config.maxMarketCapUsd > 0) {
    console.log(`   📉 MAX_MARKET_CAP_USD: skipping coins above $${config.maxMarketCapUsd.toLocaleString("en-US")}.`);
  }
  if (config.instantBuyOnBoostEnabled) {
    console.log(
      `   ⚡ INSTANT_BUY on boost >= ${config.instantBuyBoostThreshold}, only within ` +
        `${config.boostFreshWindowSeconds}s of the boost first being seen.`
    );
  }
  if (config.letWinnersRun) {
    console.log(
      "   🏃 LET_WINNERS_RUN enabled: once the trailing stop is armed it owns the exit; " +
        "the fixed take-profit stands down."
    );
  }
  if (config.minMarketCapUsd > 0) {
    console.log(`   📉 MIN_MARKET_CAP_USD: skipping coins below $${config.minMarketCapUsd.toLocaleString("en-US")}.`);
  }
  console.log(
    `   🔬 SMALL_CAP_GATE: coins under $${config.smallCapMaxMarketCapUsd.toLocaleString("en-US")} need RugCheck ` +
      `Good (score<=${config.smallCapMaxRugCheckScore}), ${config.smallCapMinHolders}+ holders, dev<=${config.smallCapMaxDevHoldingPct}%, ` +
      `insiders<=${config.smallCapMaxInsiderHoldingPct}%, bundlers<=${config.smallCapMaxBundlerHoldingPct}%, mint/freeze auth disabled.`
  );
  if (config.bearishBuyGuardEnabled) {
    console.log("   📉 BEARISH_BUY_GUARD: a BUY is skipped when the model's own trend/momentum reads bearish.");
  }
  console.log(
    `   🔁 NEW_COIN_REENTRY_COOLDOWN: ${config.newCoinReentryCooldownMinutes}min cooldown on a new coin re-entry ` +
      `(instead of full exemption).`
  );
  if (config.geckoTerminalEnabled) {
    console.log(
      `   🦎 GECKOTERMINAL: up to ${config.geckoTerminalNewPoolsLimit} newest Solana pool(s) per cycle, ` +
        `resolved via DexScreener like every other source.`
    );
  }
  if (config.partialTakeProfitPercent > 0) {
    console.log(
      `   💰 PARTIAL_TAKE_PROFIT: at +${config.partialTakeProfitPercent}%, ` +
        `${Math.round(config.partialTakeProfitFraction * 100)}% of the position is banked; the rest runs on.`
    );
  }
  if (config.reservedNewCoinSlots > 0) {
    console.log(
      `   🪺 RESERVED_NEW_COIN_SLOTS: ${config.reservedNewCoinSlots} of ${config.maxConcurrentPositions} slot(s) held ` +
        `for coins under $${config.newCoinSlotMaxMarketCapUsd.toLocaleString("en-US")} market cap.`
    );
  }
  if (config.maxBuysPerToken > 0) {
    console.log(`   🎯 MAX_BUYS_PER_TOKEN: a token cannot be bought more than ${config.maxBuysPerToken} times in a run.`);
  }
  if (config.bearishExitRecheckMinutes > 0) {
    console.log(
      `   🐻 BEARISH_EXIT: held positions are re-analysed every ${config.bearishExitRecheckMinutes}min and closed on a bearish read.`
    );
  }
  if (config.newCoinCooldownExempt) {
    console.log(`   ⏳ NEW_COIN_COOLDOWN_EXEMPT: coins under ${config.newCoinMaxAgeHours}h skip the re-entry cooldown.`);
  }
  if (config.watchNewCoins) {
    console.log(
      `   🌱 WATCH_NEW_COINS enabled: coins under ${config.newCoinMaxAgeHours}h qualify on liquidity ` +
        `+ >=${config.newCoinMinMomentumPercent}% short-window momentum instead of 24h volume.`
    );
  }
  if (config.telegramScrapeChannels.length > 0) {
    console.log(
      `   📡 TELEGRAM scrape (no login): ${config.telegramScrapeChannels.length} public channel(s), ` +
        `polled every ${config.telegramScrapeIntervalSeconds}s.`
    );
  }
  if (config.telegramEnabled) {
    console.log(
      `   📡 TELEGRAM signals enabled: ${config.telegramChannels.length} channel(s), ` +
        `+${config.telegramMentionBonus} for a mention within ${config.telegramSignalTtlMinutes} minutes.`
    );
  }
  if (config.devReputationEnabled) {
    console.log(
      `   👤 DEV_REPUTATION enabled: +${config.devReputationBonus} when the pump.fun creator has ` +
        `>=${config.devMinFollowers} followers AND >=${config.devMinMigratedTokens} migrated tokens ` +
        `(unofficial API — any failure simply withholds the bonus).`
    );
  }
  if (config.entryScoringEnabled) {
    console.log("   ⚖️  ENTRY_SCORING enabled: age/boost/social modifiers, bonuses capped at +15.");
  }
  if (config.useFixedPositionSize) {
    console.log(
      `   📏 USE_FIXED_POSITION_SIZE enabled: every entry is exactly ${config.maxPositionSol} SOL (model sizing ignored).`
    );
  }
  if (config.profitSweepEnabled) {
    console.log(
      `   🏦 PROFIT_SWEEP enabled: balance above ${config.profitSweepReserveSol} SOL is automatically sent to ` +
        `${config.withdrawalAddress}` +
        (config.profitSweepMaxSol > 0 ? ` (max ${config.profitSweepMaxSol} SOL/sweep)` : "") +
        ". No confirmation step — this path is fully autonomous."
    );
  }
}
