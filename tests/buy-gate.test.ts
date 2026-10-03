import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DRY_RUN = "true";
process.env.OPENROUTER_API_KEY = "test";

const { parseMintAuthorities, evaluateHardBuyGate, checkHardBuyGate, clearRevokedCache } = await import("../src/buy-gate.js");

/** A mint account as the SPL Token program lays it out (verified on mainnet 2026-10-03). */
function mintAccount(opts: { mintAuthority: boolean; freezeAuthority: boolean; length?: number; initialized?: boolean }): Uint8Array {
  const data = Buffer.alloc(opts.length ?? 82);
  data.writeUInt32LE(opts.mintAuthority ? 1 : 0, 0);
  data.writeUInt32LE(opts.freezeAuthority ? 1 : 0, 46);
  data[45] = opts.initialized === false ? 0 : 1;
  return data;
}

test("parseMintAuthorities reads both authority tags, also on longer Token-2022 accounts", () => {
  assert.deepEqual(parseMintAuthorities(mintAccount({ mintAuthority: false, freezeAuthority: false })), {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
  });
  assert.deepEqual(parseMintAuthorities(mintAccount({ mintAuthority: true, freezeAuthority: false, length: 390 })), {
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: true,
  });
  assert.equal(parseMintAuthorities(mintAccount({ mintAuthority: false, freezeAuthority: true }))?.freezeAuthorityDisabled, false);
});

test("parseMintAuthorities rejects short or uninitialised accounts", () => {
  assert.equal(parseMintAuthorities(new Uint8Array(40)), undefined);
  assert.equal(parseMintAuthorities(mintAccount({ mintAuthority: false, freezeAuthority: false, initialized: false })), undefined);
});

const OK = { mintAuthorityDisabled: true, freezeAuthorityDisabled: true };

test("evaluateHardBuyGate: liquidity floor, then unreadable, then each authority", () => {
  assert.equal(evaluateHardBuyGate(3000, OK, 3000).ok, true, "exactly the floor passes");
  assert.match(evaluateHardBuyGate(2999, OK, 3000).reason ?? "", /liquidity \$2999 below/);
  assert.match(evaluateHardBuyGate(Number.NaN, OK, 3000).reason ?? "", /liquidity/);
  assert.match(evaluateHardBuyGate(9000, undefined, 3000).reason ?? "", /failing closed/);
  assert.match(evaluateHardBuyGate(9000, { ...OK, mintAuthorityDisabled: false }, 3000).reason ?? "", /mint authority/);
  assert.match(evaluateHardBuyGate(9000, { ...OK, freezeAuthorityDisabled: false }, 3000).reason ?? "", /freeze authority/);
});

test("checkHardBuyGate skips the chain read when liquidity already fails, and caches a revoked result", async () => {
  clearRevokedCache();
  let reads = 0;
  const read = async () => {
    reads += 1;
    return OK;
  };
  assert.equal((await checkHardBuyGate({ address: "A", liquidityUsd: 100 }, read)).ok, false);
  assert.equal(reads, 0);
  assert.equal((await checkHardBuyGate({ address: "A", liquidityUsd: 9000 }, read)).ok, true);
  assert.equal((await checkHardBuyGate({ address: "A", liquidityUsd: 9000 }, read)).ok, true);
  assert.equal(reads, 1, "revoked authorities are cached");
});

test("checkHardBuyGate fails closed on an unreadable mint and never caches an enabled authority", async () => {
  clearRevokedCache();
  let calls = 0;
  const read = async () => (++calls === 1 ? undefined : { mintAuthorityDisabled: false, freezeAuthorityDisabled: true });
  assert.match((await checkHardBuyGate({ address: "B", liquidityUsd: 9000 }, read)).reason ?? "", /failing closed/);
  assert.match((await checkHardBuyGate({ address: "B", liquidityUsd: 9000 }, read)).reason ?? "", /mint authority/);
  assert.equal(calls, 2, "re-read every time while an authority is enabled");
});
