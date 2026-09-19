import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Spin up a local dashboard stand-in and point the bot at it BEFORE config loads.
interface Received {
  path: string;
  apiKey: string | undefined;
  body: unknown;
}
const received: Received[] = [];
let failNext = false;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    received.push({
      path: req.url || "",
      apiKey: req.headers["x-api-key"] as string | undefined,
      body: raw ? JSON.parse(raw) : null,
    });
    if (failNext) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// Don't let the listening socket keep the test process alive if the after()
// hook is skipped (e.g. by a name filter aborting the run early).
server.unref();
const { port } = server.address() as AddressInfo;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

process.env.DASHBOARD_API_URL = `http://127.0.0.1:${port}/api`;
process.env.DASHBOARD_API_KEY = "secret-bot-key";
process.env.OPENROUTER_API_KEY = "test";
process.env.HTTP_MAX_RETRIES = "0";
process.env.HTTP_TIMEOUT_MS = "2000";

const { reportTrade, isDashboardReportingEnabled } = await import("../src/dashboard-reporter.js");
type TradeEventT = import("../src/trader.js").TradeEvent;

const buyEvent: TradeEventT = {
  type: "BUY",
  symbol: "BONK",
  tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  chainId: "solana",
  amountSol: 0.3,
  price: 0.000021,
  paper: true,
  txSignature: "DRYRUN-abc",
  timestamp: 1_700_000_000_000,
  confidence: 88,
};

test("reporting is enabled when DASHBOARD_API_URL is set", () => {
  assert.equal(isDashboardReportingEnabled(), true);
});

test("reportTrade POSTs the trade to /trades/ingest with the api key and snake_case payload", async () => {
  received.length = 0;
  await reportTrade(buyEvent);
  assert.equal(received.length, 1, "exactly one request received");
  const req = received[0];
  assert.equal(req.path, "/api/trades/ingest");
  assert.equal(req.apiKey, "secret-bot-key");
  const body = req.body as Record<string, unknown>;
  assert.equal(body.type, "BUY");
  assert.equal(body.symbol, "BONK");
  assert.equal(body.token_address, buyEvent.tokenAddress);
  assert.equal(body.amount_sol, 0.3);
  assert.equal(body.paper, true);
  assert.equal(body.confidence, 88);
  assert.equal(body.tx_signature, "DRYRUN-abc");
});

test("reportTrade is best-effort: a 5xx from the dashboard never throws", async () => {
  received.length = 0;
  failNext = true;
  await assert.doesNotReject(() => reportTrade({ ...buyEvent, type: "SELL", pnlPercent: 60, reason: "TAKE_PROFIT" }));
  failNext = false;
  assert.ok(received.length >= 1, "the request was still attempted");
});
