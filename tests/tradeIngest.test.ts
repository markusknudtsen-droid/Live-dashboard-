import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { rm, mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Configure a temp state dir + ingest key BEFORE the server modules load.
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "ingest-test-"));
process.env.BOT_STATE_FILE = path.join(tmpDir, "state.json");
process.env.DASHBOARD_INGEST_KEY = "shared-bot-key";
process.env.DASHBOARD_JWT_SECRET = "test-jwt-secret-at-least-16-chars";

const { createApp } = await import("../server/app.js");
const { issueSessionToken } = await import("../server/middleware/auth.js");
const { SERVER_CONFIG } = await import("../server/env.js");

const app = createApp();
const server: Server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;

const sampleTrade = {
  type: "BUY",
  symbol: "BONK",
  token_address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  chain_id: "solana",
  amount_sol: 0.3,
  price: 0.000021,
  paper: true,
  confidence: 88,
  tx_signature: "DRYRUN-test-buy-1",
  timestamp: 1_700_000_000_000,
};

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmpDir, { recursive: true, force: true });
});

test("ingest rejects requests with no API key (401)", async () => {
  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleTrade),
  });
  assert.equal(res.status, 401);
});

test("ingest rejects a wrong API key (401)", async () => {
  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "nope" },
    body: JSON.stringify(sampleTrade),
  });
  assert.equal(res.status, 401);
});

test("ingest rejects an invalid payload (400)", async () => {
  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
    body: JSON.stringify({ ...sampleTrade, type: "HODL" }),
  });
  assert.equal(res.status, 400);
});

test("ingest accepts a valid trade with the correct key (201)", async () => {
  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
    body: JSON.stringify(sampleTrade),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("ingested trades appear in the authenticated GET /api/trades log", async () => {
  // Push a SELL too, so both show up.
  const sellRes = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
    body: JSON.stringify({
      ...sampleTrade,
      type: "SELL",
      tx_signature: "DRYRUN-test-sell-1",
      pnl_percent: 60,
      reason: "TAKE_PROFIT",
      timestamp: 1_700_000_100_000,
    }),
  });
  assert.equal(sellRes.status, 201, "the SELL ingestion succeeded");

  const token = issueSessionToken();
  const res = await fetch(`${base}/api/trades`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const pairs = body.items.map((i: { pair: string }) => i.pair);
  assert.ok(pairs.includes("BONK"), "ingested trade appears in the log");
  const sell = body.items.find((i: { tx_signature?: string }) => i.tx_signature === "DRYRUN-test-sell-1");
  assert.ok(sell, "the pushed SELL is present");
  assert.match(sell.outcome, /PAPER TAKE_PROFIT \+60\.00%/);
});

test("ingestion is disabled (503) when no ingest key is configured", async () => {
  const original = SERVER_CONFIG.ingestApiKey;
  SERVER_CONFIG.ingestApiKey = "";
  try {
    const res = await fetch(`${base}/api/trades/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
      body: JSON.stringify(sampleTrade),
    });
    assert.equal(res.status, 503);
  } finally {
    SERVER_CONFIG.ingestApiKey = original;
  }
});

test("a BUY's entry features round-trip through the store", async () => {
  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
    body: JSON.stringify({
      ...sampleTrade,
      tx_signature: "DRYRUN-features-ok",
      features: {
        marketCapUsd: 48_000,
        liquidityUsd: 12_500,
        ageHours: 3.2,
        gate: "ai",
        source: "geckoterminal",
        finalConfidence: 88,
        confidenceBeforeModifiers: 62,
        confidenceBonuses: { entryScore: 8, devReputation: 15 },
        rugCheck: { scoreRaw: 10_001, scoreNormalised: 50, dangerRiskCount: 1, hasHolderData: true },
      },
    }),
  });
  assert.equal(res.status, 201);

  const { loadReportedTrades } = await import("../server/reportedTrades.js");
  const stored = (await loadReportedTrades()).find((t) => t.tx_signature === "DRYRUN-features-ok");
  assert.ok(stored, "the trade was stored");
  assert.equal(stored.features?.gate, "ai");
  assert.equal(stored.features?.source, "geckoterminal");
  assert.equal(stored.features?.marketCapUsd, 48_000);
  assert.equal(stored.features?.confidenceBeforeModifiers, 62);
  assert.deepEqual(stored.features?.confidenceBonuses, { entryScore: 8, devReputation: 15 });
  assert.equal(stored.features?.rugCheck?.scoreRaw, 10_001, "the raw score is kept, not just normalised");
});

test("hostile entry features are sanitised rather than stored verbatim", async () => {
  const bonuses: Record<string, unknown> = { ["x".repeat(200)]: 3, notANumber: "boom" };
  for (let i = 0; i < 50; i++) bonuses[`pad${i}`] = i;

  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
    body: JSON.stringify({
      ...sampleTrade,
      tx_signature: "DRYRUN-features-hostile",
      features: {
        marketCapUsd: "not-a-number",
        ageHours: "Infinity",
        gate: "__proto__",
        source: "s".repeat(500),
        trendStrength: "t".repeat(500),
        confidenceBonuses: bonuses,
        rugCheck: "not-an-object",
      },
    }),
  });
  assert.equal(res.status, 201, "a junk features block does not fail the trade itself");

  const { loadReportedTrades } = await import("../server/reportedTrades.js");
  const stored = (await loadReportedTrades()).find((t) => t.tx_signature === "DRYRUN-features-hostile");
  const f = stored?.features;
  assert.ok(f, "the trade was still stored");
  assert.equal(f.gate, "unknown", "an unrecognised gate is not silently relabelled 'ai'");
  assert.equal(f.marketCapUsd, 0, "an unparseable number degrades to 0");
  assert.equal(f.ageHours, 0, "a non-finite number degrades to 0");
  assert.equal(f.source?.length, 32, "strings are bounded");
  assert.equal(f.trendStrength.length, 32);
  assert.equal(f.rugCheck, undefined, "a non-object rugCheck is dropped, not coerced");
  assert.ok(Object.keys(f.confidenceBonuses ?? {}).length <= 12, "the bonus map is bounded");
  assert.ok(
    Object.keys(f.confidenceBonuses ?? {}).every((k) => k.length <= 32),
    "bonus keys are bounded"
  );
  assert.ok(
    Object.values(f.confidenceBonuses ?? {}).every((v) => Number.isFinite(v)),
    "non-numeric bonuses are dropped"
  );
});

test("entry features are dropped from SELL rows", async () => {
  const res = await fetch(`${base}/api/trades/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "shared-bot-key" },
    body: JSON.stringify({
      ...sampleTrade,
      type: "SELL",
      tx_signature: "DRYRUN-features-on-sell",
      pnl_percent: -33,
      features: { gate: "ai", marketCapUsd: 1 },
    }),
  });
  assert.equal(res.status, 201);

  const { loadReportedTrades } = await import("../server/reportedTrades.js");
  const stored = (await loadReportedTrades()).find((t) => t.tx_signature === "DRYRUN-features-on-sell");
  assert.ok(stored, "the SELL was stored");
  assert.equal(stored.features, undefined, "an entry snapshot only belongs on a BUY");
});
