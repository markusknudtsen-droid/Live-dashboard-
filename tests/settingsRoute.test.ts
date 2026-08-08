import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const tmpDir = await mkdtemp(path.join(os.tmpdir(), "settings-route-test-"));
process.env.BOT_STATE_FILE = path.join(tmpDir, "state.json");
process.env.BOT_SETTINGS_FILE = path.join(tmpDir, "settings.json");
process.env.DASHBOARD_INGEST_KEY = "settings-test-ingest";
process.env.DASHBOARD_JWT_SECRET = "settings-route-test-jwt-secret";

await writeFile(
  process.env.BOT_SETTINGS_FILE,
  JSON.stringify(
    {
      active_status: true,
      buy_amount_sol: 0.4,
      override_enabled: false,
      private_withdrawal_address: "",
      min_confidence: 80,
      stop_loss_percent: 15,
      take_profit_percent: 50,
      engine_port: 5050,
      engine_api_key: "super-secret-token",
      preserve_classic_dashboard: true,
      updated_at: Date.now(),
    },
    null,
    2
  )
);

const { createApp } = await import("../server/app.js");
const { issueSessionToken } = await import("../server/middleware/auth.js");

const app = createApp();
const server: Server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
const authHeaders = { authorization: `Bearer ${issueSessionToken()}` };

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(tmpDir, { recursive: true, force: true });
});

test("GET /api/settings masks engine API key", async () => {
  const res = await fetch(`${base}/api/settings`, { headers: authHeaders });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.engine_api_key, undefined);
  assert.match(body.engine_api_key_masked, /^su/);
});

test("POST /api/settings/kill-switch forces override and inactive status", async () => {
  const res = await fetch(`${base}/api/settings/kill-switch`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.settings.override_enabled, true);
  assert.equal(body.settings.active_status, false);
});

test("POST /api/settings/connection/test validates bad port", async () => {
  const res = await fetch(`${base}/api/settings/connection/test`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ port: 70000 }),
  });
  assert.equal(res.status, 400);
});
