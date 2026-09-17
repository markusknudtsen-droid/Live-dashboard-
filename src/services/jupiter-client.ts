import { PublicKey } from "@solana/web3.js";
import { CONFIG } from "../config.js";
import { httpGet, httpPost } from "../http.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Auth header for an authenticated Jupiter API key, or keyless access when unset. */
function jupiterAuthHeaders(): Record<string, string> | undefined {
  return CONFIG.jupiterApiKey ? { "x-api-key": CONFIG.jupiterApiKey } : undefined;
}

export interface JupiterOrderResponse {
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  transaction?: string | null;
  requestId?: string;
  router?: string;
  mode?: string;
  lastValidBlockHeight?: number;
  expireAt?: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface JupiterExecuteResponse {
  status?: "Success" | "Failed" | string;
  signature?: string;
  code?: number;
  totalInputAmount?: string;
  totalOutputAmount?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  error?: string;
}

export function isValidSolanaMint(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a Jupiter Swap V2 Meta-Aggregator order. The taker is required so
 * Jupiter returns an assembled transaction that can be signed locally.
 */
export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: string | number,
  taker: string
): Promise<JupiterOrderResponse | null> {
  if (!isValidSolanaMint(inputMint) || !isValidSolanaMint(outputMint) || !isValidSolanaMint(taker)) {
    return null;
  }

  const data = await httpGet<JupiterOrderResponse | null>(`${CONFIG.jupiterApiBaseUrl}/order`, {
    params: {
      inputMint,
      outputMint,
      amount: String(amount),
      taker,
    },
    headers: jupiterAuthHeaders(),
  });

  if (
    !data ||
    data.inputMint !== inputMint ||
    data.outputMint !== outputMint ||
    !data.inAmount ||
    data.inAmount !== String(amount) ||
    !data.outAmount ||
    BigInt(data.outAmount) <= 0n ||
    !data.transaction ||
    !data.requestId
  ) {
    return null;
  }
  return data;
}

/** Execute a locally signed Swap V2 order through Jupiter's managed landing. */
export async function executeJupiterSwap(
  order: JupiterOrderResponse,
  signedTransaction: string
): Promise<JupiterExecuteResponse | null> {
  if (!order.requestId || !order.transaction || !signedTransaction) return null;

  const data = await httpPost<JupiterExecuteResponse | null>(
    `${CONFIG.jupiterApiBaseUrl}/execute`,
    {
      signedTransaction,
      requestId: order.requestId,
      ...(order.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: order.lastValidBlockHeight }
        : {}),
    },
    { headers: jupiterAuthHeaders() }
  );

  if (!data || data.status !== "Success" || !data.signature) return data;
  return data;
}
