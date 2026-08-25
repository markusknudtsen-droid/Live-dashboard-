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

test("buildConfig defaults dryRun to false and parses DRY_RUN/PAPER_STARTING_BALANCE_SOL", () => {
  const config = buildConfig({});
  assert.equal(config.dryRun, false);
  assert.equal(config.paperStartingBalanceSol, 10);

  const dryConfig = buildConfig({
    DRY_RUN: "true",
    PAPER_STARTING_BALANCE_SOL: "25",
  });
  assert.equal(dryConfig.dryRun, true);
  assert.equal(dryConfig.paperStartingBalanceSol, 25);
});

test("validateConfig requires SOLANA_PRIVATE_KEY unless DRY_RUN is enabled", () => {
  const config = buildConfig({
    OPENROUTER_API_KEY: "x",
  });
  assert.throws(() => validateConfig(config), /SOLANA_PRIVATE_KEY/);

  const dryConfig = buildConfig({
    OPENROUTER_API_KEY: "x",
    DRY_RUN: "true",
  });
  assert.doesNotThrow(() => validateConfig(dryConfig));
});

test("buildConfig defaults to the free, unauthenticated Jupiter endpoint with no key set", () => {
  const config = buildConfig({});
  assert.equal(config.jupiterApiBaseUrl, "https://quote-api.jup.ag/v6");
  assert.equal(config.jupiterApiKey, "");
});

test("buildConfig accepts JUPITER_API_KEY or the JUPITER_API alias, and a custom base URL", () => {
  const viaCanonicalName = buildConfig({ JUPITER_API_KEY: "key-1" });
  assert.equal(viaCanonicalName.jupiterApiKey, "key-1");

  const viaPortalLabel = buildConfig({ JUPITER_API: "key-2" });
  assert.equal(viaPortalLabel.jupiterApiKey, "key-2");

  const customBase = buildConfig({ JUPITER_API_BASE_URL: "https://api.jup.ag/swap/v1" });
  assert.equal(customBase.jupiterApiBaseUrl, "https://api.jup.ag/swap/v1");
});

test("buildConfig strips trailing slashes from JUPITER_API_BASE_URL to avoid double-slash request URLs", () => {
  const oneSlash = buildConfig({ JUPITER_API_BASE_URL: "https://api.jup.ag/swap/v1/" });
  assert.equal(oneSlash.jupiterApiBaseUrl, "https://api.jup.ag/swap/v1");

  const manySlashes = buildConfig({ JUPITER_API_BASE_URL: "https://api.jup.ag/swap/v1///" });
  assert.equal(manySlashes.jupiterApiBaseUrl, "https://api.jup.ag/swap/v1");
});
