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
  assert.equal(sell.status, "completed");
  assert.equal(sell.token_address, sampleTrade.token_address);
  assert.equal(sell.profit_sol, 0.18);
});

test("trade log supports text search across symbols, addresses, and status", async () => {
  const token = issueSessionToken();
  const searchRes = await fetch(
    `${base}/api/trades?page=1&pageSize=20&search=${encodeURIComponent(sampleTrade.token_address.slice(0, 12))}`,
    {
      headers: { authorization: `Bearer ${token}` },
    }
  );
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json();
  assert.ok(searchBody.items.length >= 1);
  assert.ok(searchBody.items.every((item: { token_address?: string }) => item.token_address?.includes(sampleTrade.token_address.slice(0, 12))));

  const statusRes = await fetch(`${base}/api/trades?page=1&pageSize=20&search=completed`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assert.ok(statusBody.items.length >= 1);
  assert.ok(statusBody.items.every((item: { status: string }) => item.status === "completed"));
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
