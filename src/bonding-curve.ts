/**
 * pump.fun bonding-curve state, read straight from the chain.
 *
 * A coin that is seconds old has no DexScreener pair and a null reserve on
 * GeckoTerminal, but its BondingCurve account already holds the live price
 * inputs. Layout (verified on live mainnet accounts, 2026-10-03), all u64 LE
 * after the 8-byte discriminator:
 *   8 virtualTokenReserves, 16 virtualSolReserves, 24 realTokenReserves,
 *   32 realSolReserves, 40 tokenTotalSupply, 48 complete (bool).
 * A graduated curve (complete = 1) has its reserves zeroed.
 */
import { bondingCurveAddress, fetchAccountBytes } from "./dev-reputation.js";

const DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
const MIN_LENGTH = 49;
const LAMPORTS = 1e9;
const TOKEN_DECIMALS = 1e6;

export interface CurveState {
  virtualSol: number;
  virtualTokens: number;
  /** SOL actually deposited by buyers: the real liquidity behind the curve. */
  realSol: number;
  supply: number;
  complete: boolean;
  /** Implied market cap in SOL; null once graduated (the curve no longer prices the coin). */
  marketCapSol: number | null;
}

/** Pure: curve state from raw account bytes; undefined for anything that is not a BondingCurve. */
export function parseCurveState(data: Uint8Array): CurveState | undefined {
  if (data.length < MIN_LENGTH || DISCRIMINATOR.some((byte, i) => data[i] !== byte)) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (offset: number): number => Number(view.getBigUint64(offset, true));
  const virtualTokens = u64(8);
  const virtualSol = u64(16);
  const supply = u64(40);
  const complete = data[48] === 1;
  const marketCapSol =
    !complete && virtualTokens > 0 ? (virtualSol / LAMPORTS / (virtualTokens / TOKEN_DECIMALS)) * (supply / TOKEN_DECIMALS) : null;
  return { virtualSol: virtualSol / LAMPORTS, virtualTokens: virtualTokens / TOKEN_DECIMALS, realSol: u64(32) / LAMPORTS, supply: supply / TOKEN_DECIMALS, complete, marketCapSol };
}

export async function fetchCurveState(mint: string, timeoutMs = 5000): Promise<CurveState | undefined> {
  const curve = bondingCurveAddress(mint);
  if (!curve) return undefined;
  const bytes = await fetchAccountBytes(curve, timeoutMs);
  return bytes ? parseCurveState(bytes) : undefined;
}
