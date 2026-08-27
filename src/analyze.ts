import { CONFIG } from "./config.js";
import { TokenCandidate } from "./scanner.js";
import { httpPost } from "./http.js";
import { logger } from "./logger.js";
import { normalizeAiAnalysis } from "./services/analysis-normalizer.js";

export interface TradeSignal {
  token: TokenCandidate;
  confidence: number; // 0-100
  action: "BUY" | "SKIP" | "WATCH";
  reasoning: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizeSol: number;
  riskRewardRatio: number;
  trendStrength: string;
  momentum: string;
  riskLevel: string;
  narrative: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * Analyze a token candidate using OpenRouter AI
 * Returns a structured trade signal with confidence score
 */
export async function analyzeToken(candidate: TokenCandidate): Promise<TradeSignal> {
  const prompt = buildAnalysisPrompt(candidate);

  try {
    const response = await httpPost<OpenRouterResponse>(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "google/gemini-2.0-flash-001",
        messages: [
          {
            role: "system",
            content: `You are an expert memecoin trading analyst with a proven track record. Your job is to analyze token data and provide a precise trading recommendation. You MUST be conservative - only recommend BUY when confidence is genuinely above 80%. You are optimizing for an 80%+ win rate, which means being very selective.

Key principles:
- High buy/sell ratio (>60%) with increasing volume = strong signal
- Fresh tokens (1-24h old) with growing liquidity = opportunity
- Boosted tokens with organic volume growth = momentum play
- Low liquidity (<$20k) = high risk, reduce position size
- Declining buy ratio or volume = avoid
- Token age > 48h with no significant growth = likely dead

Current market context: Solana memecoins are the primary focus. Look for tokens with strong community momentum, narrative alignment (AI, political, animal memes, gaming), and healthy on-chain metrics.`,
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "trade_signal",
            strict: true,
            schema: {
              type: "object",
              properties: {
                confidence: { type: "number", description: "Confidence score 0-100. Only 80+ means BUY." },
                action: { type: "string", enum: ["BUY", "SKIP", "WATCH"], description: "Trading action" },
                reasoning: { type: "string", description: "2-3 sentence explanation of the decision" },
                stopLossPercent: { type: "number", description: "Recommended stop loss as percentage below entry (e.g. 15 = -15%)" },
                takeProfitPercent: { type: "number", description: "Recommended take profit as percentage above entry (e.g. 50 = +50%)" },
                positionSizePercent: { type: "number", description: "Recommended position size as percentage of max (0-100)" },
                riskRewardRatio: { type: "number", description: "Risk/reward ratio (e.g. 3.0 means 3:1)" },
                trendStrength: { type: "string", enum: ["strong_up", "moderate_up", "neutral", "moderate_down", "strong_down"] },
                momentum: { type: "string", enum: ["accelerating", "steady", "decelerating", "reversing"] },
                riskLevel: { type: "string", enum: ["low", "medium", "high", "extreme"] },
                narrative: { type: "string", description: "Which meta/narrative this token belongs to" },
              },
              required: [
                "confidence",
                "action",
                "reasoning",
                "stopLossPercent",
                "takeProfitPercent",
                "positionSizePercent",
                "riskRewardRatio",
                "trendStrength",
                "momentum",
                "riskLevel",
                "narrative",
              ],
              additionalProperties: false,
            },
          },
        },
        temperature: 0.3,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.openRouterApiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty AI response");
    // Passes the currently active CONFIG.stopLossPercent (mutable at
    // runtime — index.ts overwrites it from dashboard settings each cycle)
    // as the fallback used only when the AI's own stopLossPercent is
    // missing/invalid, so that rare path tracks the operator's actual
    // setting instead of a hardcoded snapshot of its default.
    const analysis = normalizeAiAnalysis(JSON.parse(content), CONFIG.stopLossPercent);

    const entryPrice = candidate.priceUsd;
    const stopLoss = entryPrice * (1 - analysis.stopLossPercent / 100);
    const takeProfit = entryPrice * (1 + analysis.takeProfitPercent / 100);
    const positionSizeSol = CONFIG.maxPositionSol * (analysis.positionSizePercent / 100);

    return {
      token: candidate,
      confidence: analysis.confidence,
      action: analysis.action,
      reasoning: analysis.reasoning,
      entryPrice,
      stopLoss,
      takeProfit,
      positionSizeSol: Math.min(positionSizeSol, CONFIG.maxPositionSol),
      riskRewardRatio: analysis.riskRewardRatio,
      trendStrength: analysis.trendStrength,
      momentum: analysis.momentum,
      riskLevel: analysis.riskLevel,
      narrative: analysis.narrative,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`AI analysis failed for ${candidate.symbol}: ${message}`);
    return {
      token: candidate,
      confidence: 0,
      action: "SKIP",
      reasoning: "Analysis failed - skipping for safety",
      entryPrice: candidate.priceUsd,
      stopLoss: 0,
      takeProfit: 0,
      positionSizeSol: 0,
      riskRewardRatio: 0,
      trendStrength: "neutral",
      momentum: "steady",
      riskLevel: "extreme",
      narrative: "unknown",
    };
  }
}

function buildAnalysisPrompt(c: TokenCandidate): string {
  return `Analyze this memecoin for a potential trade:

TOKEN: ${c.symbol} (${c.name})
CHAIN: ${c.chainId}
CONTRACT: ${c.address}

PRICE DATA:
- Current: $${c.priceUsd.toFixed(10)}
- 5min change: ${c.priceChange5m >= 0 ? "+" : ""}${c.priceChange5m.toFixed(2)}%
- 1h change: ${c.priceChange1h >= 0 ? "+" : ""}${c.priceChange1h.toFixed(2)}%
- 6h change: ${c.priceChange6h >= 0 ? "+" : ""}${c.priceChange6h.toFixed(2)}%
- 24h change: ${c.priceChange24h >= 0 ? "+" : ""}${c.priceChange24h.toFixed(2)}%

VOLUME & LIQUIDITY:
- 24h Volume: $${c.volume24h.toLocaleString()}
- Liquidity: $${c.liquidityUsd.toLocaleString()}
- Market Cap: $${c.marketCap.toLocaleString()}
- Volume/Liquidity Ratio: ${(c.volume24h / Math.max(c.liquidityUsd, 1)).toFixed(2)}

TRANSACTION DATA:
- 24h Buys: ${c.txns24hBuys}
- 24h Sells: ${c.txns24hSells}
- Buy/Sell Ratio: ${(c.buyToSellRatio * 100).toFixed(1)}%

TOKEN AGE: ${c.ageHours.toFixed(1)} hours
${c.boostAmount ? `BOOST AMOUNT: ${c.boostAmount} (paid promotion)` : ""}

Provide your trading analysis. Remember: only recommend BUY if confidence is genuinely 80+. We are optimizing for WIN RATE, not frequency.`;
}

/**
 * Batch analyze multiple candidates and return sorted by confidence
 */
export async function batchAnalyze(candidates: TokenCandidate[]): Promise<TradeSignal[]> {
  const signals: TradeSignal[] = [];

  for (const candidate of candidates) {
    logger.info(`🧠 Analyzing ${candidate.symbol}...`);
    const signal = await analyzeToken(candidate);
    signals.push(signal);

    const emoji = signal.action === "BUY" ? "🟢" : signal.action === "WATCH" ? "🟡" : "🔴";
    logger.info(`${emoji} ${signal.token.symbol}: ${signal.action} (${signal.confidence}%) - ${signal.reasoning.slice(0, 60)}...`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}
