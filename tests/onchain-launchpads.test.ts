import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "test";
const {
  LAUNCHLAB_CREATION_INSTRUCTIONS,
  LAUNCHLAB_PROGRAM,
  STONKFUN_PLATFORM_CONFIG,
  extractInitialisedMint,
  logsContainCreation,
  parseFeedSources,
  transactionTouches,
} = await import("../src/onchain-launchpads.js");
const { stonkfunCreationFromTx } = await import("../src/onchain-feed.js");
const { buildConfig } = await import("../src/config.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Real mainnet LaunchLab creations captured on 2026-10-02.
const FIXTURE = JSON.parse(readFileSync(path.join(__dirname, "fixtures/launchlab-creations.json"), "utf-8")) as {
  stonkfun: Array<{ sig: string; mint: string; logs: string[]; tx: any }>;
  other: Array<{ sig: string; mint: string; logs: string[]; tx: any }>;
};

test("recognises every captured LaunchLab creation from its logs alone", () => {
  for (const s of [...FIXTURE.stonkfun, ...FIXTURE.other]) {
    assert.equal(logsContainCreation(s.logs, LAUNCHLAB_PROGRAM, LAUNCHLAB_CREATION_INSTRUCTIONS), true);
  }
});

test("a token-program instruction or another program's log does not count as a creation", () => {
  const trade = [
    `Program ${LAUNCHLAB_PROGRAM} invoke [1]`,
    "Program log: Instruction: BuyExactIn",
    "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PAmpW8ZxT3DVDK invoke [2]",
    "Program log: Instruction: InitializeMint2",
    "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PAmpW8ZxT3DVDK success",
    `Program ${LAUNCHLAB_PROGRAM} success`,
  ];
  assert.equal(logsContainCreation(trade, LAUNCHLAB_PROGRAM, LAUNCHLAB_CREATION_INSTRUCTIONS), false);
  // Right instruction name, but logged by a different program (e.g. a router).
  const foreign = ["Program Other111 invoke [1]", "Program log: Instruction: InitializeV2", "Program Other111 success"];
  assert.equal(logsContainCreation(foreign, LAUNCHLAB_PROGRAM, LAUNCHLAB_CREATION_INSTRUCTIONS), false);
  assert.equal(logsContainCreation([], LAUNCHLAB_PROGRAM, LAUNCHLAB_CREATION_INSTRUCTIONS), false);
});

test("reads the new mint and recognises Stonk.fun launches in real captured transactions", () => {
  assert.ok(FIXTURE.stonkfun.length > 0);
  for (const s of FIXTURE.stonkfun) {
    assert.equal(extractInitialisedMint(s.tx), s.mint);
    assert.equal(transactionTouches(s.tx, STONKFUN_PLATFORM_CONFIG), true);
    const created = stonkfunCreationFromTx(s.tx, s.sig, 5, 99);
    assert.deepEqual(
      { mint: created?.mint, source: created?.source, signature: created?.signature, detectedAt: created?.detectedAt },
      { mint: s.mint, source: "stonkfun", signature: s.sig, detectedAt: 99 }
    );
  }
});

test("a LaunchLab launch from another platform is not reported as Stonk.fun", () => {
  assert.ok(FIXTURE.other.length > 0);
  for (const s of FIXTURE.other) {
    assert.equal(transactionTouches(s.tx, STONKFUN_PLATFORM_CONFIG), false);
    assert.equal(stonkfunCreationFromTx(s.tx, s.sig, 5, 99), null);
  }
});

test("ambiguous or missing transaction data never invents a mint", () => {
  assert.equal(extractInitialisedMint(null), null);
  assert.equal(extractInitialisedMint({}), null);
  const two = {
    transaction: {
      message: {
        instructions: [
          { parsed: { type: "initializeMint2", info: { mint: "MintA" } } },
          { parsed: { type: "initializeMint2", info: { mint: "MintB" } } },
        ],
      },
    },
  };
  assert.equal(extractInitialisedMint(two), null);
  assert.equal(stonkfunCreationFromTx(null, "s", 1, 1), null);
});

test("feed sources default to pump.fun + Stonk.fun and ignore unknown names", () => {
  assert.deepEqual(parseFeedSources(undefined), ["pumpfun", "stonkfun"]);
  assert.deepEqual(parseFeedSources(" Stonkfun , bogus, stonkfun"), ["stonkfun"]);
  assert.deepEqual(buildConfig({ OPENROUTER_API_KEY: "x" }).onchainFeedSources, ["pumpfun", "stonkfun"]);
  assert.deepEqual(buildConfig({ OPENROUTER_API_KEY: "x", ONCHAIN_FEED_SOURCES: "pumpfun" }).onchainFeedSources, ["pumpfun"]);
});
