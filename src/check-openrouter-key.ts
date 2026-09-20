import { CONFIG } from "./config.js";

/**
 * Standalone diagnostic, separate from model-preflight.ts: OpenRouter's
 * /models endpoint (what preflight checks) doesn't require authentication,
 * so an invalid/revoked/typo'd key still passes preflight — it only ever
 * surfaces once a real analysis call gets rejected mid-run. /key does
 * require auth, so it's the only way to check the key itself before
 * trading starts. Never logs the key's value, only account status.
 */
async function checkOpenRouterKey(): Promise<void> {
  if (!CONFIG.openRouterApiKey) {
    console.log("❌ OPENROUTER_API_KEY is not set in your .env file.");
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${CONFIG.openRouterApiUrl}/key`, {
    headers: { Authorization: `Bearer ${CONFIG.openRouterApiKey}` },
  });

  if (!response.ok) {
    console.log(`❌ OpenRouter rejected this key (HTTP ${response.status}).`);
    const body = await response.text();
    console.log(body);
    process.exitCode = 1;
    return;
  }

  const data = (await response.json()) as {
    data?: { label?: string; usage?: number; limit?: number | null; is_free_tier?: boolean };
  };
  const info = data.data;
  console.log("✅ OPENROUTER_API_KEY is valid.");
  if (info?.label) console.log(`   Label: ${info.label}`);
  if (typeof info?.usage === "number") console.log(`   Usage so far: $${info.usage.toFixed(4)}`);
  console.log(`   Limit: ${info?.limit === null || info?.limit === undefined ? "none set" : `$${info.limit}`}`);
  console.log(`   Free tier: ${info?.is_free_tier ? "yes" : "no"}`);
  console.log(`   Configured model: ${CONFIG.openRouterModel}`);
}

checkOpenRouterKey().catch((error) => {
  console.log(`❌ Check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
