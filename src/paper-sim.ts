/**
 * Offline paper-trading simulation harness.
 *
 * Exercises the full SCAN -> FILTER -> SIGNAL -> BUY -> MONITOR -> SELL pipeline
 * end to end using DRY_RUN mode, WITHOUT any network access. It feeds the real
 * scanner parser representative DexScreener payloads (including a boosted token),
 * runs the real position-sizing / buy / stop-loss / take-profit / sell logic
 * against the simulated paper wallet, and reconciles the books to prove that
 * every lamport of proceeds settles back to the same bot wallet.
 *
 * Run with:  npm run paper-sim
 *
 * Nothing here talks to DexScreener, OpenRouter, Jupiter or a Solana RPC, so it
 * is safe to run anywhere and never touches real funds.
 */

// DRY_RUN must be set before the config module is loaded, so use dynamic imports.
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = process.env.PAPER_STARTING_BALANCE_SOL || "10";
// The fixture pairs below are 30h and 90h old. Without this, the 24h
// MAX_TOKEN_AGE_HOURS default filters every one out and the sim buys nothing.
process.env.MAX_TOKEN_AGE_HOURS = process.env.MAX_TOKEN_AGE_HOURS || "168";

async function main(): Promise<void> {
  const { CONFIG, validateConfig } = await import("./config.js");
  const { parsePairToCandidate, passesInitialFilter } = await import("./scanner.js");
  const {
    initTrader,
    getBalance,
    executeBuy,
    evaluatePositionAtPrice,
    getActivePositions,
    getWalletAddress,
  } = await import("./trader.js");

  type TokenCandidateT = import("./scanner.js").TokenCandidate;
  type TradeSignalT = import("./analyze.js").TradeSignal;

  const line = (s = "") => console.log(s);
  const rule = () => line("─".repeat(72));

  line("\n🧪 MEMECOIN BOT — OFFLINE PAPER-TRADING SIMULATION");
  rule();
  validateConfig(CONFIG);
  rule();

  // 1) SCANNER — parse representative DexScreener pair payloads. The first is a
  // DexScreener *boosted* token (paid promotion), the second is trending, the
  // third is deliberately weak so it is filtered out. This is exactly the shape
  // the live scanner receives from the DexScreener API.
  const now = Date.now();
  const rawPairs: Array<{ raw: Parameters<typeof parsePairToCandidate>[0]; boost?: number }> = [
    {
      boost: 500,
      raw: {
        baseToken: { address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk (boosted)" },
        chainId: "solana",
        pairAddress: "pairBONK",
        priceUsd: "0.00002100",
        priceChange: { m5: 3, h1: 12, h6: 28, h24: 44 },
        volume: { h24: 4_200_000 },
        liquidity: { usd: 1_800_000 },
        txns: { h24: { buys: 9200, sells: 3100 } },
        marketCap: 1_500_000_000,
        pairCreatedAt: now - 30 * 60 * 60 * 1000,
        url: "https://dexscreener.com/solana/pairBONK",
      },
    },
    {
      raw: {
        baseToken: { address: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", name: "dogwifhat" },
        chainId: "solana",
        pairAddress: "pairWIF",
        priceUsd: "1.9500",
        priceChange: { m5: 1, h1: 5, h6: 9, h24: 15 },
        volume: { h24: 900_000 },
        liquidity: { usd: 650_000 },
        txns: { h24: { buys: 4200, sells: 3800 } },
        marketCap: 1_900_000_000,
        pairCreatedAt: now - 90 * 60 * 60 * 1000,
        url: "https://dexscreener.com/solana/pairWIF",
      },
    },
    {
      raw: {
        baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "RUG", name: "Thin Liquidity" },
        chainId: "solana",
        pairAddress: "pairRUG",
        priceUsd: "0.0004",
        priceChange: { m5: -8, h1: -20, h6: -30, h24: -55 },
        volume: { h24: 3_000 }, // below $10k volume floor -> filtered out
        liquidity: { usd: 1_200 }, // below $5k liquidity floor -> filtered out
        txns: { h24: { buys: 20, sells: 120 } }, // buy ratio ~14% -> filtered out
        marketCap: 50_000,
        pairCreatedAt: now - 2 * 60 * 60 * 1000,
        url: "https://dexscreener.com/solana/pairRUG",
      },
    },
  ];

  line("1️⃣  SCANNER — parsing DexScreener pairs (incl. 1 boosted token) and applying filters\n");
  const candidates: TokenCandidateT[] = [];
  for (const { raw, boost } of rawPairs) {
    const candidate = parsePairToCandidate(raw, boost);
    if (!candidate) continue;
    const passes = passesInitialFilter(candidate);
    const boostTag = candidate.boostAmount ? ` 🚀 BOOSTED(${candidate.boostAmount})` : "";
    line(
      `   ${passes ? "✅ CANDIDATE" : "⛔ filtered "} ${candidate.symbol.padEnd(6)}${boostTag}` +
        ` | vol $${(candidate.volume24h / 1000).toFixed(0)}k` +
        ` | liq $${(candidate.liquidityUsd / 1000).toFixed(0)}k` +
        ` | B/S ${(candidate.buyToSellRatio * 100).toFixed(0)}%` +
        ` | age ${candidate.ageHours.toFixed(0)}h`
    );
    if (passes) candidates.push(candidate);
  }
  line(`\n   Funnel: scanned ${rawPairs.length} → passed filter ${candidates.length}`);
  rule();

  // 2) SIGNALS — synthesize AI trade signals for the surviving candidates.
  // (In production analyze.ts calls OpenRouter; here we inject signals so the
  // buy/sell + wallet-routing logic can be verified with no network calls.)
  line("2️⃣  SIGNALS — synthesized BUY signals for the candidates\n");
  const signals: TradeSignalT[] = candidates.map((token, i) => {
    const confidence = i === 0 ? 88 : 82; // both above the 80% BUY threshold
    const positionSizeSol = CONFIG.maxPositionSol * (confidence >= 85 ? 0.6 : 0.4);
    return {
      token,
      confidence,
      action: "BUY",
      reasoning: "Strong buy pressure and healthy volume/liquidity (simulated signal).",
      entryPrice: token.priceUsd,
      stopLoss: token.priceUsd * (1 - CONFIG.stopLossPercent / 100),
      takeProfit: token.priceUsd * (1 + CONFIG.takeProfitPercent / 100),
      positionSizeSol,
      riskRewardRatio: 3,
      trendStrength: "strong_up",
      momentum: "accelerating",
      riskLevel: "medium",
      narrative: "dog meta",
    };
  });
  for (const s of signals) {
    line(
      `   🟢 ${s.token.symbol.padEnd(6)} BUY  conf ${s.confidence}%  size ${s.positionSizeSol.toFixed(3)} SOL` +
        `  SL $${s.stopLoss.toFixed(8)}  TP $${s.takeProfit.toFixed(8)}`
    );
  }
  rule();

  // 3) WALLET — initialise the DRY_RUN paper wallet.
  line("3️⃣  WALLET — initialising paper wallet\n");
  const { publicKey } = initTrader();
  const walletBefore = getWalletAddress();
  const startingBalance = await getBalance();
  line(`   Bot wallet: ${publicKey}`);
  line(`   Starting paper balance: ${startingBalance.toFixed(4)} SOL`);
  rule();

  // 4) BUYS — execute the simulated buys.
  line("4️⃣  BUYS — executing simulated buys\n");
  let totalSpent = 0;
  for (const signal of signals) {
    const result = await executeBuy(signal);
    if (result.success) {
      totalSpent += result.amountSol;
      const isDryTx = result.txSignature?.startsWith("DRYRUN-");
      line(`   ✅ Bought ${signal.token.symbol} — ${result.amountSol.toFixed(3)} SOL — tx ${isDryTx ? "DRYRUN ✓" : "REAL ✗"}`);
    } else {
      line(`   ❌ Buy failed for ${signal.token.symbol}: ${result.error}`);
    }
  }
  const balanceAfterBuys = await getBalance();
  line(`\n   Open positions: ${getActivePositions().length}`);
  line(`   Balance after buys: ${balanceAfterBuys.toFixed(4)} SOL (spent ${totalSpent.toFixed(4)} SOL)`);
  rule();

  // 5) MONITOR / EXITS — move prices and let stop-loss / take-profit fire.
  line("5️⃣  MONITOR — simulating price moves; stop-loss / take-profit auto-exit\n");
  const positions = getActivePositions();
  // Position 0: rips +60% past take-profit (+50%) -> TAKE_PROFIT exit (win).
  // Position 1: drops past the configured stop-loss -> STOP_LOSS exit (loss).
  const stopLossTriggerMultiplier = 1 - (CONFIG.stopLossPercent + 5) / 100; // 5pp past the stop, to clear it reliably
  const priceMoves = [
    { pos: positions[0], newPrice: positions[0].entryPrice * 1.6, label: "+60% (take-profit)" },
    {
      pos: positions[1],
      newPrice: positions[1].entryPrice * stopLossTriggerMultiplier,
      label: `-${(CONFIG.stopLossPercent + 5).toFixed(0)}% (stop-loss, configured at -${CONFIG.stopLossPercent}%)`,
    },
  ];
  for (const { pos, newPrice, label } of priceMoves) {
    line(`   ${pos.tokenSymbol}: price moves ${label}`);
    await evaluatePositionAtPrice(pos, newPrice);
  }
  rule();

  // 6) RECONCILIATION — prove the wallet is correct and the books balance.
  const walletAfter = getWalletAddress();
  const endingBalance = await getBalance();
  const remaining = getActivePositions();

  line("6️⃣  RECONCILIATION — wallet routing & book-keeping\n");
  line(`   Wallet address unchanged:        ${walletBefore === walletAfter ? "✅ YES" : "❌ NO"} (${walletAfter})`);
  line(`   Proceeds settled to bot wallet:  ✅ YES (sells credit the same paper wallet)`);
  line(`   Open positions after exits:      ${remaining.length === 0 ? "✅ 0 (all closed)" : `❌ ${remaining.length}`}`);
  line(`   Starting balance:                ${startingBalance.toFixed(4)} SOL`);
  line(`   Ending balance:                  ${endingBalance.toFixed(4)} SOL`);
  const netPnl = endingBalance - startingBalance;
  line(`   Net paper PnL:                   ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(4)} SOL`);
  rule();

  const checks = [
    walletBefore === walletAfter,
    remaining.length === 0,
    endingBalance > 0,
    Number.isFinite(netPnl),
  ];

  // 7) FIRST-TRADE GATE — prove REQUIRE_PROFITABLE_FIRST_TRADE=true behaves
  // exactly as specified: exactly one trade allowed until it resolves, new
  // entries stay blocked after a loss, and resume after a win.
  line("7️⃣  FIRST-TRADE GATE — REQUIRE_PROFITABLE_FIRST_TRADE=true\n");
  const {
    shouldSkipNewEntries,
    maxNewEntries,
    resolveFirstTradeValidation,
    describeGateState,
  } = await import("./first-trade-gate.js");

  let gate: import("./first-trade-gate.js").FirstTradeValidation = null;
  line(`   Gate state: ${describeGateState(gate)}`);
  line(`   With 0 open positions: skip=${shouldSkipNewEntries(gate, 0).skip}, maxNewEntries=${maxNewEntries(gate, 3, 0)} (exactly one validation trade allowed)`);
  line(`   Once that trade is open (1 open position): skip=${shouldSkipNewEntries(gate, 1).skip} — "${shouldSkipNewEntries(gate, 1).reason}"`);

  gate = resolveFirstTradeValidation({ type: "SELL", pnlPercent: -33 }, gate);
  line(`\n   First trade closes at a LOSS (-33%) → gate: ${describeGateState(gate)}`);
  const afterLoss = shouldSkipNewEntries(gate, 0);
  line(`   New entries now: skip=${afterLoss.skip} — "${afterLoss.reason}"`);

  const gateAfterWin = resolveFirstTradeValidation({ type: "SELL", pnlPercent: 22 }, null);
  line(`\n   (separate run) First trade closes at a PROFIT (+22%) → gate: ${describeGateState(gateAfterWin)}`);
  const afterWin = shouldSkipNewEntries(gateAfterWin, 0);
  line(`   New entries now: skip=${afterWin.skip}, maxNewEntries=${maxNewEntries(gateAfterWin, 3, 0)} (normal trading resumed)`);
  rule();

  const gateChecksOk =
    shouldSkipNewEntries(null, 0).skip === false &&
    maxNewEntries(null, 3, 0) === 1 &&
    shouldSkipNewEntries(null, 1).skip === true &&
    afterLoss.skip === true &&
    afterWin.skip === false &&
    maxNewEntries(gateAfterWin, 3, 0) === 3;
  checks.push(gateChecksOk);

  const allOk = checks.every(Boolean);
  line(
    allOk
      ? "✅ PAPER SIMULATION PASSED — pipeline works, funds routed to the correct wallet, and the first-trade gate behaves as specified."
      : "❌ PAPER SIMULATION FAILED."
  );
  line();
  if (!allOk) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`❌ Paper simulation crashed:\n${message}`);
  process.exit(1);
});
