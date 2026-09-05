import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Express } from "express";

const previousEnv = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  BOT_STATE_FILE: process.env.BOT_STATE_FILE,
};

process.env.OPENROUTER_API_KEY = "test";
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "api-test-"));
process.env.BOT_STATE_FILE = path.join(tmpDir, "state.json");

const { createApp, isLoopbackHostname } = await import("../src/api.js");
type ActivePositionT = import("../src/trader.js").ActivePosition;

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// --- isLoopbackHostname: the pure classifier the Host-header guard below
// depends on. Direct coverage for exactly the edge cases earlier review
// rounds found the hard way (case, trailing dot, IPv6 forms, the full
// 127.0.0.0/8 range) so a future change can't reintroduce any of them.

test("isLoopbackHostname recognizes the full 127.0.0.0/8 range, not just 127.0.0.1", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("127.0.0.2"), true);
  assert.equal(isLoopbackHostname("127.1.2.3"), true);
  assert.equal(isLoopbackHostname("127.255.255.255"), true);
});

test("isLoopbackHostname recognizes localhost and IPv6 loopback in both bracketed and unbracketed form", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
});

test("isLoopbackHostname is case-insensitive and tolerates a trailing FQDN dot", () => {
  assert.equal(isLoopbackHostname("LOCALHOST"), true);
  assert.equal(isLoopbackHostname("localhost."), true);
  assert.equal(isLoopbackHostname("LocalHost."), true);
});

test("isLoopbackHostname rejects non-loopback hosts and malformed IPv4-shaped strings", () => {
  assert.equal(isLoopbackHostname("evil.com"), false);
  assert.equal(isLoopbackHostname("128.0.0.1"), false);
  assert.equal(isLoopbackHostname("10.0.0.1"), false);
  assert.equal(isLoopbackHostname("127.0.0.256"), false);
  assert.equal(isLoopbackHostname("127.0.0.1.1"), false);
});

// Alternate valid IPv6 spellings of loopback that Node's net.Server.listen()
// binds identically to ::1 — a hand-rolled string-match classifier missed
// all of these, which would silently disable the DNS-rebinding guard for
// any of these perfectly valid API_HOST values.
test("isLoopbackHostname recognizes alternate valid spellings of IPv6 loopback", () => {
  assert.equal(isLoopbackHostname("0:0:0:0:0:0:0:1"), true, "fully expanded ::1");
  assert.equal(isLoopbackHostname("::ffff:127.0.0.1"), true, "IPv4-mapped, dotted-decimal tail");
  assert.equal(isLoopbackHostname("::ffff:7f00:1"), true, "IPv4-mapped, hex tail");
  assert.equal(isLoopbackHostname("[0:0:0:0:0:0:0:1]"), true, "bracketed, as URL.hostname would report it");
});

test("isLoopbackHostname rejects non-loopback IPv6 addresses, including a non-loopback IPv4-mapped one", () => {
  assert.equal(isLoopbackHostname("::ffff:8.8.8.8"), false);
  assert.equal(isLoopbackHostname("fe80::1"), false, "link-local, not loopback");
  assert.equal(isLoopbackHostname("::2"), false);
});

// --- HTTP-level coverage of createApp(): Host-header/DNS-rebinding
// rejection, loopback acceptance, CORS, and the loadStateStrict-backed
// 200/500 split — none of this had a round-trip test before, despite
// several rounds of edge-case fixes to exactly this logic.

function listen(app: Express): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
  });
}

function get(port: number, hostHeader: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/positions", method: "GET", headers: { Host: hostHeader } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: raw ? JSON.parse(raw) : undefined }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("a request with a spoofed non-loopback Host header is rejected (DNS-rebinding guard)", async (t) => {
  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const res = await get(port, "evil.com");
  assert.equal(res.status, 403);
});

test("requests with a genuine loopback Host header are accepted, by IP or by name", async (t) => {
  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const byIp = await get(port, `127.0.0.1:${port}`);
  assert.equal(byIp.status, 200);

  const byName = await get(port, `localhost:${port}`);
  assert.equal(byName.status, 200, "the hostname classification, not an exact match to the bound address, is what's checked");
});

test("GET /api/positions returns [] when no state has ever been persisted", async (t) => {
  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const res = await get(port, `127.0.0.1:${port}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test("GET /api/positions maps an active position to the dashboard's expected shape", async (t) => {
  const position: ActivePositionT = {
    tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tokenSymbol: "BONK",
    chainId: "solana",
    entryPrice: 0.00002,
    currentPrice: 0.000032,
    amountSol: 0.2,
    stopLoss: 0.000017,
    takeProfit: 0.00003,
    entryTime: Date.now(),
    pnlPercent: 60,
    txSignature: "5KtP9real0nChainSignature",
  };
  await writeFile(
    process.env.BOT_STATE_FILE!,
    JSON.stringify({ activePositions: [position], tradeHistory: [], firstTradeValidated: null }),
    "utf-8"
  );

  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const res = await get(port, `127.0.0.1:${port}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    {
      symbol: "BONK",
      name: "BONK",
      mint: position.tokenAddress,
      amount: 0.2,
      entryUsd: 0.00002,
      currentUsd: 0.000032,
    },
  ]);
});

// parseStateFile() deliberately preserves a null/non-object entry in
// activePositions rather than dropping it or throwing (see persistence.ts),
// so isRestorablePosition can reject it individually on the main bot's own
// restoration path. This route doesn't go through that validator, so an
// unconditional .map() over the array would throw on the first such entry —
// and since createApp()'s handler catches per-request, not per-entry, that
// turns one malformed persisted position into a 500 that hides every OTHER,
// perfectly valid position in the same response.
test("GET /api/positions skips malformed entries instead of failing the whole response", async (t) => {
  const position: ActivePositionT = {
    tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tokenSymbol: "BONK",
    chainId: "solana",
    entryPrice: 0.00002,
    currentPrice: 0.000032,
    amountSol: 0.2,
    stopLoss: 0.000017,
    takeProfit: 0.00003,
    entryTime: Date.now(),
    pnlPercent: 60,
    txSignature: "5KtP9real0nChainSignature",
  };
  await writeFile(
    process.env.BOT_STATE_FILE!,
    JSON.stringify({
      activePositions: [null, "not an object", position],
      tradeHistory: [],
      firstTradeValidated: null,
    }),
    "utf-8"
  );

  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const res = await get(port, `127.0.0.1:${port}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    {
      symbol: "BONK",
      name: "BONK",
      mint: position.tokenAddress,
      amount: 0.2,
      entryUsd: 0.00002,
      currentUsd: 0.000032,
    },
  ]);
});

// A non-null object that isn't actually a well-formed position (e.g. `{}`,
// or one missing required fields) previously passed a shallow "is it an
// object" filter and got mapped straight into the response as a record
// full of `undefined`s, instead of being skipped like a null/string entry
// is. Reusing persistence.ts's isRestorablePosition shape check (rather
// than a hand-rolled predicate) closes that gap.
test("GET /api/positions skips a malformed-but-object-shaped entry instead of returning a record full of undefined fields", async (t) => {
  const position: ActivePositionT = {
    tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tokenSymbol: "BONK",
    chainId: "solana",
    entryPrice: 0.00002,
    currentPrice: 0.000032,
    amountSol: 0.2,
    stopLoss: 0.000017,
    takeProfit: 0.00003,
    entryTime: Date.now(),
    pnlPercent: 60,
    txSignature: "5KtP9real0nChainSignature",
  };
  await writeFile(
    process.env.BOT_STATE_FILE!,
    JSON.stringify({
      activePositions: [{}, { tokenAddress: "onlyThisField" }, position],
      tradeHistory: [],
      firstTradeValidated: null,
    }),
    "utf-8"
  );

  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const res = await get(port, `127.0.0.1:${port}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [
    {
      symbol: "BONK",
      name: "BONK",
      mint: position.tokenAddress,
      amount: 0.2,
      entryUsd: 0.00002,
      currentUsd: 0.000032,
    },
  ]);
});

test("GET /api/positions returns 500, not a misleading empty list, when the state file is corrupt", async (t) => {
  await writeFile(process.env.BOT_STATE_FILE!, "{not valid json", "utf-8");

  const { server, port } = await listen(createApp({ host: "127.0.0.1" }));
  t.after(() => server.close());

  const res = await get(port, `127.0.0.1:${port}`);
  assert.equal(res.status, 500);

  // Clean up so later tests in this file see a normal empty state again.
  await rm(process.env.BOT_STATE_FILE!, { force: true });
});

test("CORS headers are only sent for an explicitly configured origin, and absent entirely with none configured", async (t) => {
  const withCors = await listen(createApp({ host: "127.0.0.1", allowedOrigins: ["http://allowed.example"] }));
  const withoutCors = await listen(createApp({ host: "127.0.0.1", allowedOrigins: [] }));
  t.after(() => {
    withCors.server.close();
    withoutCors.server.close();
  });

  const allowedOrigin = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: withCors.port,
        path: "/api/positions",
        method: "GET",
        headers: { Host: `127.0.0.1:${withCors.port}`, Origin: "http://allowed.example" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(allowedOrigin["access-control-allow-origin"], "http://allowed.example");

  const disallowedOrigin = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: withCors.port,
        path: "/api/positions",
        method: "GET",
        headers: { Host: `127.0.0.1:${withCors.port}`, Origin: "http://not-allowed.example" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(disallowedOrigin["access-control-allow-origin"], undefined);

  const noCorsConfigured = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: withoutCors.port,
        path: "/api/positions",
        method: "GET",
        headers: { Host: `127.0.0.1:${withoutCors.port}`, Origin: "http://anything.example" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers));
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(noCorsConfigured["access-control-allow-origin"], undefined);
});
