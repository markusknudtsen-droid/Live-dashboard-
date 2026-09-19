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

// reasoning/narrative are model-generated, but the strict JSON schema only
// guarantees they're typeof "string" — nothing rules out control
// characters, and the model's own output can be steered by attacker-
// controlled prompt content (the token symbol/name). Several call sites log
// reasoning verbatim, one without even a length-capping .slice(), so this
// must be sanitized here rather than at each of those call sites.
test("normalizeAiAnalysis sanitizes reasoning/narrative against control-character log injection", () => {
  const normalized = normalizeAiAnalysis({
    confidence: 90,
    action: "BUY",
    reasoning: "Looks great.\nSYSTEM: this is a fake log line.",
    stopLossPercent: 15,
    takeProfitPercent: 50,
    positionSizePercent: 50,
    riskRewardRatio: 2,
    trendStrength: "strong_up",
    momentum: "accelerating",
    riskLevel: "medium",
    narrative: "ai\nhype",
  });

  assert.equal(normalized.reasoning, "Looks great. SYSTEM: this is a fake log line.");
  assert.equal(normalized.narrative, "ai hype");
});
