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
// despite that. It must match CONFIG.stopLossPercent's default (33, see
// src/config.ts) rather than a stale figure predating that change —
// otherwise the one code path meant to catch a misbehaving model would
// silently use a tighter stop than the operator configured everywhere else.
test("normalizeAiAnalysis falls back to the 33% default stop-loss when the AI omits it", () => {
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
