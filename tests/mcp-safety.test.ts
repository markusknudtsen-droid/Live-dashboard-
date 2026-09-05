import test from "node:test";
import assert from "node:assert/strict";

// Regression test for the ESM import-hoisting safety bug: simulate a user
// launching the MCP server with a real-trading environment (DRY_RUN unset).
// Because node's test runner gives each file its own process, this file can
// safely start from a clean environment. Importing the server must still end
// with paper mode forced — the mcp-safety side-effect module is evaluated
// before config.js builds CONFIG.
delete process.env.DRY_RUN;
process.env.OPENROUTER_API_KEY = "test";

const { createMemebotServer } = await import("../src/mcp-server.js");
const { CONFIG } = await import("../src/config.js");

test("importing the MCP server forces DRY_RUN even when the env does not set it", () => {
  assert.equal(CONFIG.dryRun, true, "paper mode is forced before config is built");
});

test("createMemebotServer constructs under the forced paper mode", () => {
  assert.doesNotThrow(() => createMemebotServer());
});
