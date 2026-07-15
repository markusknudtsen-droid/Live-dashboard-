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
