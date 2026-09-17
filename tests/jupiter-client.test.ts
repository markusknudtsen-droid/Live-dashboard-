import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

interface Received {
  method: string;
  path: string;
  apiKey: string | undefined;
  body: string;
}
const received: Received[] = [];
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    received.push({
      method: req.method || "",
      path: req.url || "",
      apiKey: req.headers["x-api-key"] as string | undefined,
      body: raw,
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/order")) {
      res.end(
        JSON.stringify({
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
          inAmount: "1000000",
          outAmount: "12345",
          transaction: "base64tx",
          requestId: "request-1",
          router: "metis",
          mode: "ultra",
        })
      );
      return;
    }
    res.end(JSON.stringify({ status: "Success", signature: "sig-1", code: 0 }));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const { port } = server.address() as AddressInfo;

const previousEnv = {
  JUPITER_API_BASE_URL: process.env.JUPITER_API_BASE_URL,
  JUPITER_API_KEY: process.env.JUPITER_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  HTTP_MAX_RETRIES: process.env.HTTP_MAX_RETRIES,
};

process.env.JUPITER_API_BASE_URL = `http://127.0.0.1:${port}`;
process.env.JUPITER_API_KEY = "test-jupiter-key";
process.env.OPENROUTER_API_KEY = "test";
process.env.HTTP_MAX_RETRIES = "0";

const { getJupiterQuote, executeJupiterSwap, SOL_MINT, isValidSolanaMint } = await import(
  "../src/services/jupiter-client.js"
);

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const TAKER = "11111111111111111111111111111111";

test("getJupiterQuote uses Swap V2 /order with taker and x-api-key", async () => {
  received.length = 0;
  const order = await getJupiterQuote(SOL_MINT, MINT, 1_000_000, TAKER);
  assert.ok(order);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "GET");
  assert.ok(received[0].path.startsWith("/order"));
  assert.match(received[0].path, /inputMint=So11111111111111111111111111111111111111112/);
  assert.match(received[0].path, /outputMint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263/);
  assert.match(received[0].path, /amount=1000000/);
  assert.match(received[0].path, /taker=11111111111111111111111111111111/);
  assert.equal(received[0].apiKey, "test-jupiter-key");
});

test("executeJupiterSwap uses /execute and passes signed transaction plus requestId", async () => {
  received.length = 0;
  const order = await getJupiterQuote(SOL_MINT, MINT, 1_000_000, TAKER);
  assert.ok(order);
  const result = await executeJupiterSwap(order, "signed-base64-tx");
  assert.equal(result?.status, "Success");
  const executeCall = received.find((r) => r.method === "POST");
  assert.ok(executeCall, "a POST /execute request was made");
  assert.ok(executeCall!.path.startsWith("/execute"));
  assert.equal(executeCall!.apiKey, "test-jupiter-key");
  assert.deepEqual(JSON.parse(executeCall!.body), {
    signedTransaction: "signed-base64-tx",
    requestId: "request-1",
  });
});

test("isValidSolanaMint validates independently of Jupiter API config", () => {
  assert.equal(isValidSolanaMint(MINT), true);
  assert.equal(isValidSolanaMint("not-a-mint"), false);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
