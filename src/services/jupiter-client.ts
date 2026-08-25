import { PublicKey } from "@solana/web3.js";
import { CONFIG } from "../config.js";
import { httpGet, httpPost } from "../http.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** Auth header for an authenticated Jupiter API key, or none on the free tier. */
function jupiterAuthHeaders(): Record<string, string> | undefined {
  return CONFIG.jupiterApiKey ? { "x-api-key": CONFIG.jupiterApiKey } : undefined;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
}

interface JupiterSwapResponse {
  swapTransaction?: string;
}

export function isValidSolanaMint(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: string | number,
  slippageBps = 500
): Promise<JupiterQuoteResponse | null> {
  if (!isValidSolanaMint(inputMint) || !isValidSolanaMint(outputMint)) {
    return null;
  }
  const amountValue = String(amount);
  const data = await httpGet<JupiterQuoteResponse | null>(`${CONFIG.jupiterApiBaseUrl}/quote`, {
    params: {
      inputMint,
      outputMint,
      amount: amountValue,
      slippageBps,
    },
    headers: jupiterAuthHeaders(),
  });

  if (!data || !data.outAmount || Number(data.outAmount) <= 0) {
    return null;
  }
  return data;
}

export async function buildJupiterSwapTx(quoteResponse: JupiterQuoteResponse, userPublicKey: string): Promise<string | null> {
  const data = await httpPost<JupiterSwapResponse>(
    `${CONFIG.jupiterApiBaseUrl}/swap`,
    {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    },
    { headers: jupiterAuthHeaders() }
  );

  return data.swapTransaction || null;
}
