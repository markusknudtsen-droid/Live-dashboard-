import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The MCP server forces DRY_RUN itself, but set it here too so any module
// loaded first in this process is already in paper mode.
process.env.DRY_RUN = "true";
process.env.PAPER_STARTING_BALANCE_SOL = "10";
process.env.OPENROUTER_API_KEY = "test";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createMemebotServer, SERVER_NAME } = await import("../src/mcp-server.js");
const { initTrader, setActivePositions } = await import("../src/trader.js");

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

// The MCP tools operate on the trader module's global state (paper wallet,
// balance, positions). Reset it before every test so each test is independent
// of declaration order and concurrency.
beforeEach(() => {
  initTrader();
  setActivePositions([]);
});

// Wire a real MCP client to the server over an in-memory transport pair.
const server = createMemebotServer();
const client = new Client({ name: "memebot-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

after(async () => {
  await client.close();
  await server.close();
});

function structured(result: unknown): Record<string, any> {
  const r = result as { structuredContent?: Record<string, any>; isError?: boolean; content?: Array<{ text?: string }> };
  assert.ok(!r.isError, `tool call errored: ${r.content?.[0]?.text}`);
  assert.ok(r.structuredContent, "tool returned structuredContent");
  return r.structuredContent!;
}

test("lists all memebot tools", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "memebot_analyze_token",
    "memebot_check_exits",
    "memebot_get_boost_signals",
    "memebot_get_portfolio",
    "memebot_get_status",
    "memebot_paper_buy",
    "memebot_paper_sell",
    "memebot_scan_candidates",
  ]);
});

test("get_status reports PAPER mode with the configured strategy", async () => {
  const out = structured(await client.callTool({ name: "memebot_get_status", arguments: {} }));
  assert.equal(out.mode, "PAPER");
  assert.equal(out.paper_balance_sol, 10);
  assert.equal(out.max_concurrent_positions, 3);
  assert.equal(out.strategy.min_confidence, 80);
  assert.equal(out.strategy.stop_loss_percent, 33);
  assert.equal(out.strategy.take_profit_percent, 50);
  assert.ok(out.wallet_address.length > 30);
});

test("analyze_token is deterministic and maps confidence to action + size tier", async () => {
  const args = {
    price_usd: 0.00002,
    volume_24h: 1_000_000,
    liquidity_usd: 500_000,
    txns_24h_buys: 800,
    txns_24h_sells: 200,
    price_change_5m: 1,
    price_change_1h: 2,
    price_change_6h: 3,
    price_change_24h: 4,
    age_hours: 12,
    boost_amount: 500,
  };
  const out = structured(await client.callTool({ name: "memebot_analyze_token", arguments: args }));
  // 50 + (0.8-0.5)*80=24 + min(2,5)*3=6 + 10 + 8 + 5 = 103 -> clamped 100
  assert.equal(out.confidence, 100);
  assert.equal(out.action, "BUY");
  assert.equal(out.position_size_sol, 0.3);
  // Match the source's exact computation (price * (1 - pct/100)) rather than a
  // separately-written literal, so this isn't a floating-point rounding trap.
  assert.equal(out.stop_loss_price, 0.00002 * (1 - 33 / 100));
  assert.equal(out.take_profit_price, 0.00002 * 1.5);

  const again = structured(await client.callTool({ name: "memebot_analyze_token", arguments: args }));
  assert.equal(again.confidence, 100, "same inputs give the same score");
});

test("analyze_token scores a weak token as SKIP with no position size", async () => {
  const out = structured(
    await client.callTool({
      name: "memebot_analyze_token",
      arguments: {
        price_usd: 0.001,
        volume_24h: 5_000,
        liquidity_usd: 100_000,
        txns_24h_buys: 20,
        txns_24h_sells: 180,
        price_change_5m: -5,
        price_change_1h: -10,
        price_change_6h: -20,
        price_change_24h: -40,
        age_hours: 100,
        boost_amount: 0,
      },
    })
  );
  // 50 + (0.1-0.5)*80=-32 + ~0.15 + 0 + 0 + 0 = 18
  assert.equal(out.confidence, 18);
  assert.equal(out.action, "SKIP");
  assert.equal(out.position_size_sol, 0);
});

test("paper buy -> portfolio -> sell round-trip settles to the same wallet", async () => {
  const status = structured(await client.callTool({ name: "memebot_get_status", arguments: {} }));
  const wallet = status.wallet_address;
  const startBalance = status.paper_balance_sol;

  const buy = structured(
    await client.callTool({
      name: "memebot_paper_buy",
      arguments: { token_address: MINT, symbol: "BONK", price_usd: 0.00002, amount_sol: 0.3, confidence: 88 },
    })
  );
  assert.equal(buy.success, true);
  assert.ok(String(buy.tx_signature).startsWith("DRYRUN-"), "buy tx is simulated");
  assert.equal(buy.paper_balance_after, startBalance - 0.3);

  const portfolio = structured(await client.callTool({ name: "memebot_get_portfolio", arguments: {} }));
  assert.equal(portfolio.wallet_address, wallet, "portfolio reports the same wallet");
  assert.equal(portfolio.open_positions.length, 1);
  assert.equal(portfolio.open_positions[0].symbol, "BONK");

  // Sell at +60% (past the +50% take-profit level).
  const sell = structured(
    await client.callTool({
      name: "memebot_paper_sell",
      arguments: { token_address: MINT, current_price_usd: 0.000032 },
    })
  );
  assert.equal(sell.success, true);
  assert.ok(String(sell.tx_signature).startsWith("DRYRUN-"));
  assert.equal(Math.round(sell.pnl_percent), 60);
  // Proceeds 0.3 * 1.6 = 0.48 -> balance = start - 0.3 + 0.48 = start + 0.18
  assert.ok(Math.abs(sell.paper_balance_after - (startBalance + 0.18)) < 1e-9, "profit settled back to the wallet");

  const finalStatus = structured(await client.callTool({ name: "memebot_get_status", arguments: {} }));
  assert.equal(finalStatus.wallet_address, wallet, "wallet never changes across trades");
  assert.equal(finalStatus.open_positions, 0);
});

// Unlike a scanned TokenCandidate (sanitized once in scanner.ts), the
// symbol here comes straight from the MCP caller — the Zod schema only
// bounds length (1-20 chars), not character content. executeBuy() logs
// token.symbol verbatim, so an unsanitized newline could forge a fake log
// line.
test("paper buy sanitizes an MCP-caller-supplied symbol containing control characters", async () => {
  const buy = structured(
    await client.callTool({
      name: "memebot_paper_buy",
      arguments: { token_address: MINT, symbol: "BAD\nSYS:BUY", price_usd: 0.00002, amount_sol: 0.2, confidence: 85 },
    })
  );
  assert.equal(buy.success, true);
  assert.equal(buy.symbol, "BAD SYS:BUY");

  const portfolio = structured(await client.callTool({ name: "memebot_get_portfolio", arguments: {} }));
  assert.equal(portfolio.open_positions[0].symbol, "BAD SYS:BUY");
});

test("check_exits auto-sells a position that crosses stop-loss", async () => {
  const buy = structured(
    await client.callTool({
      name: "memebot_paper_buy",
      arguments: { token_address: MINT, symbol: "BONK", price_usd: 0.0001, amount_sol: 0.1, confidence: 80 },
    })
  );
  assert.equal(buy.success, true);

  const out = structured(
    await client.callTool({
      name: "memebot_check_exits",
      arguments: { prices: [{ token_address: MINT, price_usd: 0.00006 }] }, // -40% < -33% stop
    })
  );
  assert.equal(out.evaluated, 1);
  assert.equal(out.exited.length, 1);
  assert.equal(out.exited[0].reason, "STOP_LOSS");
  assert.equal(out.still_open, 0);
});

test("paper_sell for an unknown position returns an actionable error", async () => {
  const result = (await client.callTool({
    name: "memebot_paper_sell",
    arguments: { token_address: "So11111111111111111111111111111111111111112" },
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
  assert.equal(result.isError, true);
  assert.match(String(result.content?.[0]?.text), /No open position/);
});

test("server identifies itself correctly", () => {
  assert.equal(SERVER_NAME, "memecoin-bot-mcp-server");
});
