import "dotenv/config";

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
    maxMarketCapUsd: parseNumberInRange("MAX_MARKET_CAP_USD", env.MAX_MARKET_CAP_USD, 0, 0, 1_000_000_000),
    boostFreshWindowSeconds: parseNumberInRange(
      "BOOST_FRESH_WINDOW_SECONDS",
      env.BOOST_FRESH_WINDOW_SECONDS,
      120,
      5,
      3600
    ),
    letWinnersRun: parseBoolean(env.LET_WINNERS_RUN, false),
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
  if (config.entryScoringEnabled) {
    console.log("   ⚖️  ENTRY_SCORING enabled: age/boost/social modifiers, bonuses capped at +15.");
  }
  if (config.useFixedPositionSize) {
    console.log(
      `   📏 USE_FIXED_POSITION_SIZE enabled: every entry is exactly ${config.maxPositionSol} SOL (model sizing ignored).`
    );
  }
}
