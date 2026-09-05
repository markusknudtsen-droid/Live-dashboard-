import test from "node:test";
import assert from "node:assert/strict";
import { buildConfig, validateConfig } from "../src/config.js";

test("buildConfig parses valid env values", () => {
  const config = buildConfig({
    OPENROUTER_API_KEY: "x",
    SOLANA_PRIVATE_KEY: "y",
    MIN_CONFIDENCE: "85",
    MAX_POSITION_SOL: "0.25",
    STOP_LOSS_PERCENT: "10",
    TAKE_PROFIT_PERCENT: "40",
    SCAN_INTERVAL_SECONDS: "30",
    SCAN_CHAINS: "solana,base",
    LOG_LEVEL: "warn",
    HTTP_TIMEOUT_MS: "5000",
    HTTP_MAX_RETRIES: "2",
    ALLOW_SKIP_PREFLIGHT: "false",
    BOT_STATE_FILE: "./data/custom-state.json",
  });

  assert.equal(config.minConfidence, 85);
  assert.equal(config.scanChains.length, 2);
  assert.equal(config.logLevel, "warn");
  assert.equal(config.allowSkipPreflight, false);
});

test("buildConfig rejects out-of-range confidence", () => {
  assert.throws(
    () =>
      buildConfig({
        MIN_CONFIDENCE: "101",
      }),
    /MIN_CONFIDENCE/
  );
});

test("buildConfig rejects invalid scan interval", () => {
  assert.throws(
    () =>
      buildConfig({
        SCAN_INTERVAL_SECONDS: "1",
      }),
    /SCAN_INTERVAL_SECONDS/
  );
});

test("buildConfig parses DRY_RUN and paper balance", () => {
  const config = buildConfig({
    OPENROUTER_API_KEY: "x",
    DRY_RUN: "true",
    PAPER_STARTING_BALANCE_SOL: "3.5",
  });
  assert.equal(config.dryRun, true);
  assert.equal(config.paperStartingBalanceSol, 3.5);
});

test("buildConfig defaults OPENROUTER_MODEL to a currently-live model, not the retired Gemini 2.0 Flash", () => {
  const config = buildConfig({ OPENROUTER_API_KEY: "x" });
  assert.equal(config.openRouterModel, "deepseek/deepseek-v3.2");
});

test("buildConfig accepts a custom OPENROUTER_MODEL", () => {
  const config = buildConfig({ OPENROUTER_API_KEY: "x", OPENROUTER_MODEL: "deepseek/deepseek-r1" });
  assert.equal(config.openRouterModel, "deepseek/deepseek-r1");
});

test("validateConfig allows a missing private key when DRY_RUN is enabled", () => {
  const config = buildConfig({ OPENROUTER_API_KEY: "x", DRY_RUN: "true" });
  assert.doesNotThrow(() => validateConfig(config));
});

test("validateConfig still requires a private key when not in DRY_RUN", () => {
  const config = buildConfig({ OPENROUTER_API_KEY: "x", DRY_RUN: "false" });
  assert.throws(() => validateConfig(config), /SOLANA_PRIVATE_KEY/);
});

// A missing OPENROUTER_API_KEY must not crash the whole process — that would
// exit before positions are restored, leaving them unmonitored.
// checkAnalysisModel() (src/model-preflight.ts) is what catches this instead,
// the same "broken" path as a retired/incompatible model: it blocks new
// entries but never position monitoring. See tests/model-preflight.test.ts.
test("validateConfig does not throw when OPENROUTER_API_KEY is missing", () => {
  const config = buildConfig({ DRY_RUN: "true" });
  assert.equal(config.openRouterApiKey, "");
  assert.doesNotThrow(() => validateConfig(config));
});

test("buildConfig defaults to the Jupiter Swap V2 endpoint with no key set", () => {
  const config = buildConfig({ OPENROUTER_API_KEY: "x" });
  assert.equal(config.jupiterApiBaseUrl, "https://api.jup.ag/swap/v2");
  assert.equal(config.jupiterApiKey, "");
});

test("buildConfig accepts JUPITER_API_KEY or the JUPITER_API alias, and a custom base URL", () => {
  const viaCanonicalName = buildConfig({ OPENROUTER_API_KEY: "x", JUPITER_API_KEY: "key-1" });
  assert.equal(viaCanonicalName.jupiterApiKey, "key-1");

  const viaPortalLabel = buildConfig({ OPENROUTER_API_KEY: "x", JUPITER_API: "key-2" });
  assert.equal(viaPortalLabel.jupiterApiKey, "key-2");

  const customBase = buildConfig({ OPENROUTER_API_KEY: "x", JUPITER_API_BASE_URL: "https://api.example.test/swap/v2" });
  assert.equal(customBase.jupiterApiBaseUrl, "https://api.example.test/swap/v2");
});

test("buildConfig strips trailing slashes from JUPITER_API_BASE_URL to avoid double-slash request URLs", () => {
  const oneSlash = buildConfig({ OPENROUTER_API_KEY: "x", JUPITER_API_BASE_URL: "https://api.example.test/swap/v2/" });
  assert.equal(oneSlash.jupiterApiBaseUrl, "https://api.example.test/swap/v2");

  const manySlashes = buildConfig({ OPENROUTER_API_KEY: "x", JUPITER_API_BASE_URL: "https://api.example.test/swap/v2///" });
  assert.equal(manySlashes.jupiterApiBaseUrl, "https://api.example.test/swap/v2");
});
