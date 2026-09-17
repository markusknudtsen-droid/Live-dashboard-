#!/usr/bin/env node
/**
 * memecoin-bot-mcp-server — MCP server for the memecoin trading bot.
 *
 * Exposes the bot's scanner, signal analysis and PAPER trading engine as MCP
 * tools over stdio, so MCP clients (Claude Desktop, Claude Code, etc.) can
 * drive the bot conversationally.
 *
 * SAFETY: this server hard-forces DRY_RUN=true before the bot's config module
 * loads. It can only ever trade a simulated paper wallet — no private key is
 * read, no transaction is ever signed or sent, and sell proceeds always settle
 * back to the same paper wallet.
 */

// Force paper mode BEFORE any bot module (and therefore config) is evaluated.
// This MUST stay the first import: ESM hoists static imports, so an inline
// `process.env.DRY_RUN = "true"` in this module body would run only AFTER
// config.js has already been built from the un-forced environment.
import "./mcp-safety.js";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONFIG } from "./config.js";
import { scanForCandidates, parsePairToCandidate, passesInitialFilter, type TokenCandidate, type DexPair } from "./scanner.js";
import { sanitizeDisplayText } from "./text-sanitize.js";
import {
  initTrader,
  getBalance,
  executeBuy,
  executeSell,
  evaluatePositionAtPrice,
  getActivePositions,
  getWalletAddress,
  MAX_CONCURRENT_POSITIONS,
} from "./trader.js";
import { scoreSignal, type SignalMetrics, SIZE_TIERS } from "./signal-engine.js";
import { httpGet } from "./http.js";
// Type-only: importing analyze.js as a runtime value would needlessly evaluate
// it (and its dependencies) at server startup.
import type { TradeSignal } from "./analyze.js";

export const SERVER_NAME = "memecoin-bot-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Cap tool responses so a large scan can't blow out the client's context. */
const CHARACTER_LIMIT = 25000;

interface DexTokenBoost {
  chainId?: string;
  tokenAddress?: string;
  amount?: number;
  totalAmount?: number;
}

let traderReady = false;

/** Lazily initialise the paper wallet the first time a tool needs it. */
function ensureTrader(): void {
  if (!traderReady) {
    initTrader();
    traderReady = true;
  }
}

function ok(output: unknown) {
  const text = JSON.stringify(output, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    // Replace BOTH representations with the sentinel — returning the full
    // structuredContent would defeat the limit for clients that consume it.
    const sentinel = {
      truncated: true,
      truncation_message: `Response exceeded ${CHARACTER_LIMIT} characters; narrow the request (e.g. lower 'limit').`,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(sentinel) }], structuredContent: sentinel };
  }
  return { content: [{ type: "text" as const, text }], structuredContent: output as Record<string, unknown> };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

function describeNetworkError(error: unknown, what: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    `${what} failed (${message}). This tool needs outbound HTTPS access to ${CONFIG.dexScreenerApiUrl}. ` +
    `If you are offline or the API is rate-limiting, retry later; the analysis and paper-trading tools work without network.`
  );
}

function candidateSummary(c: TokenCandidate) {
  return {
    symbol: c.symbol,
    name: c.name,
    address: c.address,
    chain_id: c.chainId,
    price_usd: c.priceUsd,
    volume_24h: c.volume24h,
    liquidity_usd: c.liquidityUsd,
    buy_to_sell_ratio: c.buyToSellRatio,
    age_hours: Number.isFinite(c.ageHours) ? Number(c.ageHours.toFixed(1)) : null,
    price_change_24h: c.priceChange24h,
    boost_amount: c.boostAmount ?? 0,
    url: c.url,
  };
}

const MetricsShape = {
  price_usd: z.number().positive().describe("Current token price in USD"),
  volume_24h: z.number().min(0).describe("24h trading volume in USD"),
  liquidity_usd: z.number().min(0).describe("Pool liquidity in USD"),
  txns_24h_buys: z.number().int().min(0).describe("Number of buy transactions in the last 24h"),
  txns_24h_sells: z.number().int().min(0).describe("Number of sell transactions in the last 24h"),
  price_change_5m: z.number().default(0).describe("5-minute price change in percent"),
  price_change_1h: z.number().default(0).describe("1-hour price change in percent"),
  price_change_6h: z.number().default(0).describe("6-hour price change in percent"),
  price_change_24h: z.number().default(0).describe("24-hour price change in percent"),
  age_hours: z.number().min(0).describe("Age of the trading pair in hours"),
  boost_amount: z.number().min(0).default(0).describe("DexScreener boost amount (0 = not boosted)"),
};

export function createMemebotServer(): McpServer {
  // Defense-in-depth for the paper-mode contract: if the mcp-safety import is
  // ever reordered or removed, refuse to start rather than silently exposing
  // "paper" tools backed by real-trading config.
  if (!CONFIG.dryRun) {
    throw new Error(
      "SAFETY: CONFIG.dryRun is false — the mcp-safety module must be imported before any bot module. Refusing to start."
    );
  }
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "memebot_get_status",
    {
      title: "Get Bot Status",
      description: `Get the bot's current mode, paper wallet and strategy configuration.

Always safe to call; initialises the paper wallet on first use. Returns:
{
  "mode": "PAPER",                    // always PAPER for this server
  "wallet_address": string,           // the simulated bot wallet address
  "paper_balance_sol": number,        // current fake SOL balance
  "open_positions": number,           // count of open paper positions
  "max_concurrent_positions": 3,
  "strategy": {
    "min_confidence": number,         // BUY threshold (default 80)
    "stop_loss_percent": number,      // default 15 (-15% exit)
    "take_profit_percent": number,    // default 50 (+50% exit)
    "size_tiers": [{"min_confidence": number, "position_size_sol": number}]
  }
}`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      ensureTrader();
      return ok({
        mode: "PAPER",
        wallet_address: getWalletAddress(),
        paper_balance_sol: await getBalance(),
        open_positions: getActivePositions().length,
        max_concurrent_positions: 3,
        strategy: {
          min_confidence: CONFIG.minConfidence,
          stop_loss_percent: CONFIG.stopLossPercent,
          take_profit_percent: CONFIG.takeProfitPercent,
          size_tiers: SIZE_TIERS.map((t) => ({ min_confidence: t.minConfidence, position_size_sol: t.positionSizeSol })),
        },
      });
    }
  );

  server.registerTool(
    "memebot_scan_candidates",
    {
      title: "Scan Market Candidates",
      description: `Scan DexScreener (live) for memecoin candidates that pass the bot's filters.

Filters applied (a token must pass ALL): 24h volume > $10,000; liquidity > $5,000;
buy/sell ratio >= 45%; pair age < 168h; valid price > 0.

Args:
  - limit (1-25, default 10): maximum candidates to return, sorted by 24h volume.

Returns: { "count": number, "candidates": [{ symbol, name, address, chain_id,
price_usd, volume_24h, liquidity_usd, buy_to_sell_ratio, age_hours,
price_change_24h, boost_amount, url }] }

Requires network access to api.dexscreener.com. Use memebot_analyze_token to
score any returned candidate.`,
      inputSchema: {
        limit: z.number().int().min(1).max(25).default(10).describe("Maximum candidates to return"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ limit }) => {
      try {
        const candidates = await scanForCandidates();
        const sorted = [...candidates].sort((a, b) => b.volume24h - a.volume24h).slice(0, limit);
        return ok({ count: sorted.length, candidates: sorted.map(candidateSummary) });
      } catch (error) {
        return fail(describeNetworkError(error, "DexScreener scan"));
      }
    }
  );

  server.registerTool(
    "memebot_get_boost_signals",
    {
      title: "Get DexScreener Boost Signals",
      description: `Fetch the current top DexScreener BOOSTED tokens (paid promotions) — the bot's headline signal source.

Args:
  - chain (default "solana"): chain id to filter boosts by (e.g. "solana", "base").
  - limit (1-20, default 10): maximum boosted tokens to return.
  - enrich (default true): when true, fetches pair data for each boost and marks
    whether it passes the bot's candidate filters.

Returns: { "count": number, "boosts": [{ token_address, chain_id, boost_amount,
enriched?: { symbol, price_usd, volume_24h, liquidity_usd, buy_to_sell_ratio,
age_hours, passes_filter } }] }

Requires network access to api.dexscreener.com.`,
      inputSchema: {
        chain: z.string().min(1).max(32).default("solana").describe("Chain id to filter boosts by"),
        limit: z.number().int().min(1).max(20).default(10).describe("Maximum boosted tokens to return"),
        enrich: z.boolean().default(true).describe("Also fetch pair metrics for each boosted token"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chain, limit, enrich }) => {
      try {
        const boosts = await httpGet<DexTokenBoost[]>(`${CONFIG.dexScreenerApiUrl}/token-boosts/top/v1`);
        const filtered = (boosts || [])
          .filter((b) => String(b.chainId || "").toLowerCase() === chain.toLowerCase())
          .slice(0, limit);

        // Enrich in parallel — sequential awaits add avoidable latency with up
        // to 20 boosts. Each enrichment catches its own failure so one bad
        // token never spoils the batch.
        const results = await Promise.all(
          filtered.map(async (boost) => {
            const entry: Record<string, unknown> = {
              token_address: boost.tokenAddress || "",
              chain_id: boost.chainId || chain,
              boost_amount: boost.totalAmount ?? boost.amount ?? 0,
            };
            if (enrich && boost.tokenAddress) {
              try {
                // chainId is optional on boosts — fall back to the requested
                // chain rather than building a /tokens/v1/undefined/... URL.
                const pairs = await httpGet<DexPair[]>(
                  `${CONFIG.dexScreenerApiUrl}/tokens/v1/${boost.chainId || chain}/${boost.tokenAddress}`
                );
                const candidate = Array.isArray(pairs) && pairs.length
                  ? parsePairToCandidate(pairs[0], boost.totalAmount ?? boost.amount)
                  : null;
                if (candidate) {
                  entry.enriched = { ...candidateSummary(candidate), passes_filter: passesInitialFilter(candidate) };
                }
              } catch {
                entry.enriched = null;
              }
            }
            return entry;
          })
        );
        return ok({ count: results.length, boosts: results });
      } catch (error) {
        return fail(describeNetworkError(error, "DexScreener boost fetch"));
      }
    }
  );

  server.registerTool(
    "memebot_analyze_token",
    {
      title: "Analyze Token Metrics",
      description: `Score token metrics into a deterministic trade signal (confidence 0-100 -> BUY/WATCH/SKIP).

Works fully offline: pass the metrics yourself (e.g. from memebot_scan_candidates
or DexScreener). Scoring is arithmetic and reproducible — the same inputs always
give the same confidence:
  base 50
  + (buyRatio - 0.5) * 80            (buy pressure, -40..+40)
  + min(volume/liquidity, 5) * 3     (turnover, 0..+15; 0 if liquidity <= 0)
  + 2/3/3/2 for positive 5m/1h/6h/24h price change (momentum, 0..+10)
  + 8 if age <= 24h else 4 if <= 72h (freshness)
  + 5 if boosted
  -> rounded, clamped to [0,100]
Action: >= 80 BUY, >= 60 WATCH, else SKIP.
Position size tiers: >= 85 -> 0.3 SOL, >= 80 -> 0.2, >= 70 -> 0.1, else 0.

Returns: { confidence, action, buy_to_sell_ratio, position_size_sol,
stop_loss_price, take_profit_price, breakdown: { base, buy_pressure,
volume_liquidity, momentum, freshness, boost } }`,
      inputSchema: MetricsShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const metrics: SignalMetrics = {
        priceUsd: params.price_usd,
        volume24h: params.volume_24h,
        liquidityUsd: params.liquidity_usd,
        txns24hBuys: params.txns_24h_buys,
        txns24hSells: params.txns_24h_sells,
        priceChange5m: params.price_change_5m,
        priceChange1h: params.price_change_1h,
        priceChange6h: params.price_change_6h,
        priceChange24h: params.price_change_24h,
        ageHours: params.age_hours,
        boostAmount: params.boost_amount,
      };
      const signal = scoreSignal(metrics, CONFIG.stopLossPercent, CONFIG.takeProfitPercent);
      return ok({
        confidence: signal.confidence,
        action: signal.action,
        buy_to_sell_ratio: signal.buyToSellRatio,
        position_size_sol: signal.positionSizeSol,
        stop_loss_price: signal.stopLossPrice,
        take_profit_price: signal.takeProfitPrice,
        breakdown: {
          base: signal.breakdown.base,
          buy_pressure: signal.breakdown.buyPressure,
          volume_liquidity: signal.breakdown.volumeLiquidity,
          momentum: signal.breakdown.momentum,
          freshness: signal.breakdown.freshness,
          boost: signal.breakdown.boost,
        },
      });
    }
  );

  server.registerTool(
    "memebot_paper_buy",
    {
      title: "Execute Paper Buy",
      description: `Open a SIMULATED position in the paper wallet (never a real transaction).

Debits the paper balance by amount_sol and opens a position with stop-loss and
take-profit levels derived from the configured percentages. Fails if the paper
balance is insufficient or 3 positions are already open.

Args:
  - token_address (string): Solana mint address of the token.
  - symbol (string): token symbol for display (e.g. "BONK").
  - price_usd (number): entry price in USD.
  - amount_sol (0.001-10, default 0.2): paper SOL to spend.
  - confidence (0-100, default 80): signal confidence recorded on the trade.

Returns: { success, tx_signature ("DRYRUN-..."), symbol, amount_sol, entry_price,
stop_loss_price, take_profit_price, paper_balance_after } or an error message.`,
      inputSchema: {
        token_address: z.string().min(32).max(64).describe("Solana mint address"),
        symbol: z.string().min(1).max(20).describe("Token symbol, e.g. BONK"),
        price_usd: z.number().positive().describe("Entry price in USD"),
        amount_sol: z.number().min(0.001).max(10).default(0.2).describe("Paper SOL to spend"),
        confidence: z.number().min(0).max(100).default(80).describe("Signal confidence to record"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ token_address, symbol, price_usd, amount_sol, confidence }) => {
      ensureTrader();
      // A fast, non-authoritative rejection for a single obviously-full
      // caller — executeBuy() re-checks this same limit itself, inside its
      // trader lock, which is the only check actually atomic with opening a
      // position (concurrent tool calls could otherwise all pass this one).
      if (getActivePositions().length >= MAX_CONCURRENT_POSITIONS) {
        return fail(`Max concurrent positions (${MAX_CONCURRENT_POSITIONS}) reached. Sell a position first with memebot_paper_sell.`);
      }
      // Unlike a scanned TokenCandidate (sanitized once in scanner.ts), this
      // symbol comes straight from the MCP caller with no sanitization of
      // its own — the Zod schema only bounds length (1-20 chars), not
      // character content. executeBuy() logs token.symbol verbatim and
      // emits it via the trade-listener event system (dashboard-reporter.ts
      // included), so sanitize it here, at the point it enters the system,
      // the same way every other TokenCandidate source does.
      const safeSymbol = sanitizeDisplayText(symbol) || "?";
      const signal: TradeSignal = {
        token: {
          address: token_address,
          symbol: safeSymbol,
          name: safeSymbol,
          chainId: "solana",
          pairAddress: "",
          priceUsd: price_usd,
          priceChange5m: 0,
          priceChange1h: 0,
          priceChange6h: 0,
          priceChange24h: 0,
          volume24h: 0,
          volumeChange: 0,
          liquidityUsd: 0,
          marketCap: 0,
          txns24hBuys: 0,
          txns24hSells: 0,
          buyToSellRatio: 0.5,
          pairCreatedAt: Date.now(),
          // A manual paper trade from an MCP caller carries no DexScreener
          // listing data to derive these from.
          hasXSocial: false,
          hasOtherSocial: false,
          hasPaidDexInfo: false,
          ageHours: 0,
          url: `https://dexscreener.com/solana/${token_address}`,
        },
        confidence,
        action: "BUY",
        reasoning: "Manual paper buy via MCP",
        entryPrice: price_usd,
        stopLoss: price_usd * (1 - CONFIG.stopLossPercent / 100),
        takeProfit: price_usd * (1 + CONFIG.takeProfitPercent / 100),
        positionSizeSol: amount_sol,
        riskRewardRatio: CONFIG.takeProfitPercent / CONFIG.stopLossPercent,
        trendStrength: "neutral",
        momentum: "steady",
        riskLevel: "medium",
        narrative: "manual",
      };
      const result = await executeBuy(signal);
      if (!result.success) {
        return fail(result.error || "Paper buy failed.");
      }
      return ok({
        success: true,
        tx_signature: result.txSignature,
        symbol: result.tokenSymbol,
        amount_sol: result.amountSol,
        entry_price: result.entryPrice,
        stop_loss_price: signal.stopLoss,
        take_profit_price: signal.takeProfit,
        paper_balance_after: await getBalance(),
      });
    }
  );

  server.registerTool(
    "memebot_paper_sell",
    {
      title: "Execute Paper Sell",
      description: `Close an open SIMULATED position and settle proceeds back to the paper wallet.

If current_price_usd is provided, the position's PnL is updated to that price
before selling (use this to simulate an exit at a specific price). Proceeds =
amount_sol * (1 + pnl%), credited to the SAME bot wallet the buy came from.

Args:
  - token_address (string): mint address of the open position to sell.
  - current_price_usd (number, optional): price to mark the position at before selling.

Returns: { success, tx_signature ("DRYRUN-..."), symbol, pnl_percent,
proceeds_sol, paper_balance_after } or an error if no such position is open.`,
      inputSchema: {
        token_address: z.string().min(32).max(64).describe("Mint address of the open position"),
        current_price_usd: z.number().positive().optional().describe("Mark price before selling (optional)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ token_address, current_price_usd }) => {
      ensureTrader();
      const position = getActivePositions().find((p) => p.tokenAddress === token_address);
      if (!position) {
        const open = getActivePositions().map((p) => `${p.tokenSymbol} (${p.tokenAddress})`);
        return fail(
          `No open position for ${token_address}. Open positions: ${open.length ? open.join(", ") : "none"}.`
        );
      }
      // The price mark is applied inside executeSell's lock, atomically
      // with settlement, rather than mutated on the shared position object
      // here — two concurrent sell requests for the same position would
      // otherwise both hold that same object, and a mutation made here,
      // outside the lock, could be overwritten by a second, ultimately-
      // rejected request before this request's queued settlement runs.
      const result = await executeSell(position, "MANUAL_MCP", current_price_usd);
      if (!result.success) {
        return fail(result.error || "Paper sell failed.");
      }
      // Read back the PnL executeSell actually settled at, not one computed
      // here beforehand — for the same reason as above, this is the only
      // value guaranteed to match what was actually credited.
      const pnlPercent = result.pnlPercent ?? 0;
      const proceeds = result.amountSol * (1 + pnlPercent / 100);
      return ok({
        success: true,
        tx_signature: result.txSignature,
        symbol: result.tokenSymbol,
        pnl_percent: Number(pnlPercent.toFixed(4)),
        proceeds_sol: Number(proceeds.toFixed(6)),
        paper_balance_after: await getBalance(),
      });
    }
  );

  server.registerTool(
    "memebot_get_portfolio",
    {
      title: "Get Paper Portfolio",
      description: `List the paper wallet balance and all open simulated positions.

Returns: { "wallet_address": string, "paper_balance_sol": number,
"open_positions": [{ symbol, token_address, amount_sol, entry_price,
current_price, pnl_percent, stop_loss_price, take_profit_price, entry_time,
tx_signature }] }`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      ensureTrader();
      return ok({
        wallet_address: getWalletAddress(),
        paper_balance_sol: await getBalance(),
        open_positions: getActivePositions().map((p) => ({
          symbol: p.tokenSymbol,
          token_address: p.tokenAddress,
          amount_sol: p.amountSol,
          entry_price: p.entryPrice,
          current_price: p.currentPrice,
          pnl_percent: p.pnlPercent,
          stop_loss_price: p.stopLoss,
          take_profit_price: p.takeProfit,
          entry_time: p.entryTime,
          tx_signature: p.txSignature,
        })),
      });
    }
  );

  server.registerTool(
    "memebot_check_exits",
    {
      title: "Check Stop-Loss / Take-Profit Exits",
      description: `Evaluate open paper positions against prices and auto-sell any that hit their stop-loss or take-profit.

Args:
  - prices: array of { token_address, price_usd } marks to evaluate. For each
    open position with a matching mark, PnL is updated; if the price is at or
    beyond the stop-loss or take-profit level the position is sold and proceeds
    settle back to the paper wallet.

Returns: { "evaluated": number, "exited": [{ symbol, reason, pnl_percent }],
"still_open": number, "paper_balance_sol": number }`,
      inputSchema: {
        prices: z
          .array(
            z.object({
              token_address: z.string().min(32).max(64),
              price_usd: z.number().positive(),
            })
          )
          .min(1)
          .max(10)
          .describe("Price marks to evaluate open positions against"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ prices }) => {
      ensureTrader();
      const before = getActivePositions();
      const beforeBySig = new Map(before.map((p) => [p.txSignature, { symbol: p.tokenSymbol, sl: p.stopLoss, tp: p.takeProfit }]));
      let evaluated = 0;
      for (const mark of prices) {
        const position = getActivePositions().find((p) => p.tokenAddress === mark.token_address);
        if (!position) continue;
        evaluated += 1;
        await evaluatePositionAtPrice(position, mark.price_usd);
      }
      const openSigs = new Set(getActivePositions().map((p) => p.txSignature));
      const exited = before
        .filter((p) => !openSigs.has(p.txSignature))
        .map((p) => {
          const meta = beforeBySig.get(p.txSignature);
          const reason = meta && p.currentPrice >= meta.tp ? "TAKE_PROFIT" : "STOP_LOSS";
          return { symbol: p.tokenSymbol, reason, pnl_percent: Number(p.pnlPercent.toFixed(4)) };
        });
      return ok({
        evaluated,
        exited,
        still_open: getActivePositions().length,
        paper_balance_sol: await getBalance(),
      });
    }
  );

  return server;
}

async function main(): Promise<void> {
  const server = createMemebotServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (PAPER mode — no real funds)`);
}

const entry = process.argv[1] || "";
if (entry.endsWith("mcp-server.ts") || entry.endsWith("mcp-server.js")) {
  main().catch((error) => {
    console.error("MCP server fatal error:", error);
    process.exit(1);
  });
}
