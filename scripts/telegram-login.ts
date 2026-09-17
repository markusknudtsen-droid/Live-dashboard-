/**
 * One-off interactive Telegram login. Run it once, paste the result into .env,
 * never run it again.
 *
 *   npx tsx scripts/telegram-login.ts
 *
 * Deliberately separate from the trading loop: the bot must never contain an
 * interactive prompt, or an unattended restart would block forever waiting for
 * a code nobody is there to type.
 *
 * The session string this prints grants FULL access to the Telegram account it
 * is generated for — read and send, every chat. It is more sensitive than any
 * other credential in this project. It belongs in .env (gitignored) and nowhere
 * else: not in chat, not in a commit, not in a screenshot.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import "dotenv/config";

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const apiIdRaw = process.env.TELEGRAM_API_ID || (await rl.question("api_id from my.telegram.org: "));
    const apiHash = process.env.TELEGRAM_API_HASH || (await rl.question("api_hash from my.telegram.org: "));

    const apiId = Number(String(apiIdRaw).trim());
    if (!Number.isFinite(apiId) || apiId <= 0) {
      console.error("api_id must be a number. Copy it exactly from my.telegram.org.");
      process.exitCode = 1;
      return;
    }
    if (!apiHash || apiHash.trim().length < 8) {
      console.error("api_hash looks wrong. Copy it exactly from my.telegram.org.");
      process.exitCode = 1;
      return;
    }

    const { TelegramClient } = await import("telegram");
    const { StringSession } = await import("telegram/sessions/index.js");

    // Empty session = a fresh login; the string is produced at the end.
    const client = new TelegramClient(new StringSession(""), apiId, apiHash.trim(), {
      connectionRetries: 5,
    });

    console.log("\nTelegram will send a login code to your account (in the app, not by SMS, if the app is installed).\n");

    await client.start({
      phoneNumber: async () => (await rl.question("Phone number, with country code (e.g. +47...): ")).trim(),
      phoneCode: async () => (await rl.question("Login code Telegram just sent: ")).trim(),
      // Only asked for when the account has two-step verification enabled.
      password: async () => (await rl.question("Two-step verification password (blank if none): ")).trim(),
      onError: (err) => console.error("Login error:", err instanceof Error ? err.message : String(err)),
    });

    const session = String(client.session.save());

    console.log("\n" + "=".repeat(70));
    console.log("Add this line to .env - treat it like a password, never share it:\n");
    console.log(`TELEGRAM_SESSION=${session}`);
    console.log("=".repeat(70));
    console.log("\nAlso make sure .env has:");
    console.log(`  TELEGRAM_API_ID=${apiId}`);
    console.log("  TELEGRAM_API_HASH=<your api_hash>");
    console.log("  TELEGRAM_ENABLED=true");
    console.log("\nThen restart the bot. The session persists - you will not need to run this again.\n");

    await client.disconnect();
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("Login failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
