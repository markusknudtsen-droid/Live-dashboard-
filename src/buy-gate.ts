/**
 * The last check before ANY buy (executeBuy is the one place every buy path
 * passes through): enough liquidity, and the mint and freeze authorities both
 * revoked, read from the chain itself rather than from a third-party report.
 *
 * Fails closed: if the mint account cannot be read, the buy does not happen.
 * A revoked authority cannot be re-enabled, so a "revoked" answer is cached for
 * good; an "enabled" answer is re-read every time (the creator may revoke it).
 */
import { CONFIG } from "./config.js";
import { fetchAccountBytes } from "./dev-reputation.js";

export interface MintAuthorities {
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

const MINT_BASE_LENGTH = 82;
const MINT_AUTHORITY_TAG_OFFSET = 0;
const MINT_IS_INITIALIZED_OFFSET = 45;
const FREEZE_AUTHORITY_TAG_OFFSET = 46;

/**
 * Pure: authorities from raw mint-account bytes. SPL Token and Token-2022 share
 * this 82-byte base layout (Token-2022 appends extensions after it); each
 * authority is a COption<Pubkey> whose u32 tag is 0 when it is revoked.
 */
export function parseMintAuthorities(data: Uint8Array): MintAuthorities | undefined {
  if (data.length < MINT_BASE_LENGTH || data[MINT_IS_INITIALIZED_OFFSET] !== 1) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mintAuthorityDisabled: view.getUint32(MINT_AUTHORITY_TAG_OFFSET, true) === 0,
    freezeAuthorityDisabled: view.getUint32(FREEZE_AUTHORITY_TAG_OFFSET, true) === 0,
  };
}

/** Pure: the verdict. Liquidity is judged first because it needs no network. */
export function evaluateHardBuyGate(
  liquidityUsd: number,
  authorities: MintAuthorities | undefined,
  minLiquidityUsd: number
): GateResult {
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < minLiquidityUsd) {
    return { ok: false, reason: `liquidity $${Math.round(liquidityUsd || 0)} below the $${minLiquidityUsd} minimum` };
  }
  if (!authorities) return { ok: false, reason: "mint/freeze authorities could not be read from the chain (failing closed)" };
  if (!authorities.mintAuthorityDisabled) return { ok: false, reason: "mint authority is still enabled" };
  if (!authorities.freezeAuthorityDisabled) return { ok: false, reason: "freeze authority is still enabled" };
  return { ok: true };
}

const revoked = new Set<string>();

export function clearRevokedCache(): void {
  revoked.clear();
}

type AuthorityReader = (mint: string) => Promise<MintAuthorities | undefined>;

const readFromChain: AuthorityReader = async (mint) => {
  // One retry: a single dropped RPC call should not cost a trade.
  for (let attempt = 0; attempt < 2; attempt++) {
    const bytes = await fetchAccountBytes(mint, 4000);
    const parsed = bytes ? parseMintAuthorities(bytes) : undefined;
    if (parsed) return parsed;
  }
  return undefined;
};

export async function checkHardBuyGate(
  token: { address: string; liquidityUsd: number },
  read: AuthorityReader = readFromChain
): Promise<GateResult> {
  const min = CONFIG.buyMinLiquidityUsd;
  const early = evaluateHardBuyGate(token.liquidityUsd, { mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, min);
  if (!early.ok) return early;
  if (revoked.has(token.address)) return { ok: true };

  const authorities = await read(token.address);
  const verdict = evaluateHardBuyGate(token.liquidityUsd, authorities, min);
  if (verdict.ok) revoked.add(token.address);
  return verdict;
}
