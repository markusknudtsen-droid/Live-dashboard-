import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Stand in for Jupiter and point the bot at it BEFORE config loads, so we can
// assert the configured base URL and (when set) the x-api-key header are used
// exactly as documented, without ever hitting the real Jupiter API.
interface Received {
  method: string;
  path: string;
  apiKey: string | undefined;
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
    });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/quote")) {
      res.end(JSON.stringify({ inputMint: "a", outputMint: "b", inAmount: "1", outAmount: "1", slippageBps: 500 }));
      return;
    }
    res.end(JSON.stringify({ swapTransaction: "base64tx" }));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
const { port } = server.address() as AddressInfo;

process.env.JUPITER_API_BASE_URL = `http://127.0.0.1:${port}`;
process.env.JUPITER_API_KEY = "test-jupiter-key";
process.env.HTTP_MAX_RETRIES = "0";

const { getJupiterQuote, buildJupiterSwapTx, SOL_MINT, isValidSolanaMint } = await import(
  "../src/services/jupiter-client.js"
);

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

test("getJupiterQuote hits the configured base URL and sends the x-api-key header", async () => {
  received.length = 0;
  const quote = await getJupiterQuote(SOL_MINT, MINT, 1_000_000);
  assert.ok(quote);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, "GET");
  assert.ok(received[0].path.startsWith("/quote"));
  assert.equal(received[0].apiKey, "test-jupiter-key");
});

test("buildJupiterSwapTx hits the configured base URL and sends the x-api-key header", async () => {
  received.length = 0;
  const quote = await getJupiterQuote(SOL_MINT, MINT, 1_000_000);
  assert.ok(quote);
  const tx = await buildJupiterSwapTx(quote!, "SomePublicKeyPlaceholder1111111111111111111");
  assert.equal(tx, "base64tx");
  const swapCall = received.find((r) => r.method === "POST");
  assert.ok(swapCall, "a POST /swap request was made");
  assert.ok(swapCall!.path.startsWith("/swap"));
  assert.equal(swapCall!.apiKey, "test-jupiter-key");
});

test("isValidSolanaMint still validates independent of the Jupiter API config", () => {
  assert.equal(isValidSolanaMint(MINT), true);
  assert.equal(isValidSolanaMint("not-a-mint"), false);
});

after(() => {
  server.close();
});
