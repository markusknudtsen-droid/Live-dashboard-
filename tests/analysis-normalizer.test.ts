import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAiAnalysis } from "../src/services/analysis-normalizer.js";

test("normalizeAiAnalysis clamps numeric values and invalid enums", () => {
  const normalized = normalizeAiAnalysis({
    confidence: 200,
    action: "invalid",
    reasoning: "Test",
    stopLossPercent: -1,
    takeProfitPercent: 5000,
    positionSizePercent: 150,
    riskRewardRatio: 999,
    trendStrength: "bad",
    momentum: "bad",
    riskLevel: "bad",
    narrative: "meme",
  });

  assert.equal(normalized.confidence, 100);
  assert.equal(normalized.action, "SKIP");
  assert.equal(normalized.stopLossPercent, 1);
  assert.equal(normalized.takeProfitPercent, 1000);
  assert.equal(normalized.positionSizePercent, 100);
  assert.equal(normalized.riskRewardRatio, 50);
  assert.equal(normalized.trendStrength, "neutral");
  assert.equal(normalized.momentum, "steady");
  assert.equal(normalized.riskLevel, "high");
});

// The AI's structured-output schema requires stopLossPercent on every
// response, so this fallback only fires if a model returns malformed JSON
// despite that. With no fallback argument passed, it defaults to 33 —
// config.ts's own default — rather than a stale figure predating that
// change.
test("normalizeAiAnalysis falls back to 33% when the AI omits stopLossPercent and no fallback is given", () => {
  const normalized = normalizeAiAnalysis({
    confidence: 90,
    action: "BUY",
    reasoning: "Test",
    // stopLossPercent omitted entirely.
    takeProfitPercent: 50,
    positionSizePercent: 50,
    riskRewardRatio: 2,
    trendStrength: "strong_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "meme",
  });

  assert.equal(normalized.stopLossPercent, 33);
});

// CONFIG.stopLossPercent is mutable at runtime (index.ts overwrites it from
// dashboard settings every cycle), so analyzeToken() passes it explicitly
// as the fallback rather than relying on this function's own 33 default —
// otherwise an operator who changed their configured stop-loss away from
// 33 would have a malformed AI response silently ignore that and revert to
// the stale default. Proves the parameter is actually used, not just
// accepted and discarded.
test("normalizeAiAnalysis uses the caller-supplied fallback, not its own default, when the AI omits stopLossPercent", () => {
  const normalized = normalizeAiAnalysis(
    {
      confidence: 90,
      action: "BUY",
      reasoning: "Test",
      // stopLossPercent omitted entirely.
      takeProfitPercent: 50,
      positionSizePercent: 50,
      riskRewardRatio: 2,
      trendStrength: "strong_up",
      momentum: "accelerating",
      riskLevel: "medium",
      narrative: "meme",
    },
    20 // the operator's actual currently-configured stop-loss, not 33
  );

  assert.equal(normalized.stopLossPercent, 20);
});
