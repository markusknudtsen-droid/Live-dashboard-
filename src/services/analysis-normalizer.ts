import { sanitizeDisplayText } from "../text-sanitize.js";

export interface RawAiAnalysis {
  confidence: number;
  action: "BUY" | "SKIP" | "WATCH";
  reasoning: string;
  stopLossPercent: number;
  takeProfitPercent: number;
  positionSizePercent: number;
  riskRewardRatio: number;
  trendStrength: "strong_up" | "moderate_up" | "neutral" | "moderate_down" | "strong_down";
  momentum: "accelerating" | "steady" | "decelerating" | "reversing";
  riskLevel: "low" | "medium" | "high" | "extreme";
  narrative: string;
}

const validActions = new Set<RawAiAnalysis["action"]>(["BUY", "SKIP", "WATCH"]);
const validTrend = new Set<RawAiAnalysis["trendStrength"]>([
  "strong_up",
  "moderate_up",
  "neutral",
  "moderate_down",
  "strong_down",
]);
const validMomentum = new Set<RawAiAnalysis["momentum"]>(["accelerating", "steady", "decelerating", "reversing"]);
const validRisk = new Set<RawAiAnalysis["riskLevel"]>(["low", "medium", "high", "extreme"]);

function asFiniteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeAiAnalysis(raw: unknown): RawAiAnalysis {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const actionCandidate = String(source.action || "SKIP").toUpperCase() as RawAiAnalysis["action"];
  const trendCandidate = String(source.trendStrength || "neutral") as RawAiAnalysis["trendStrength"];
  const momentumCandidate = String(source.momentum || "steady") as RawAiAnalysis["momentum"];
  const riskCandidate = String(source.riskLevel || "high") as RawAiAnalysis["riskLevel"];

  return {
    confidence: clamp(asFiniteNumber(source.confidence, 0), 0, 100),
    action: validActions.has(actionCandidate) ? actionCandidate : "SKIP",
    // reasoning/narrative are model-generated, but the strict JSON schema
    // only guarantees they're typeof "string" — nothing rules out control
    // characters, and the model's output can itself be steered by
    // attacker-controlled prompt content (the token symbol/name — see
    // analyze.ts's system prompt). Several call sites log reasoning
    // verbatim, one (index.ts's runCycle) without even a length-capping
    // .slice(), so sanitize both here rather than at each of those sites.
    // reasoning gets a much larger cap than the 40-char default (meant for
    // short labels like a token symbol) since it's meant to hold a genuine
    // 2-3 sentence explanation.
    reasoning: sanitizeDisplayText(String(source.reasoning || "No reasoning provided."), 500),
    stopLossPercent: clamp(asFiniteNumber(source.stopLossPercent, 15), 1, 95),
    takeProfitPercent: clamp(asFiniteNumber(source.takeProfitPercent, 50), 1, 1000),
    positionSizePercent: clamp(asFiniteNumber(source.positionSizePercent, 0), 0, 100),
    riskRewardRatio: clamp(asFiniteNumber(source.riskRewardRatio, 0), 0, 50),
    trendStrength: validTrend.has(trendCandidate) ? trendCandidate : "neutral",
    momentum: validMomentum.has(momentumCandidate) ? momentumCandidate : "steady",
    riskLevel: validRisk.has(riskCandidate) ? riskCandidate : "high",
    narrative: sanitizeDisplayText(String(source.narrative || "unknown")),
  };
}
