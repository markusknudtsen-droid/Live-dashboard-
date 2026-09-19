import axios, { AxiosRequestConfig } from "axios";
import { CONFIG } from "./config.js";

// Exported so callers that catch an error AFTER requestWithRetry has already
// exhausted its retries (e.g. model-preflight.ts) can still tell a
// deterministic client-side failure (a genuine 4xx) apart from a transient
// one (no response at all, or a status that indicates timing/load rather
// than a broken request) — the same distinction this makes for deciding
// whether to retry in the first place. 408 (Request Timeout) and 425 (Too
// Early) are both < 500 and not 429, but neither means "this request is
// fundamentally wrong" the way 400/401/403/404 do — both are explicitly
// about timing and are expected to succeed on a plain retry per their RFCs.
export function isRetryableError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (!status) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry<T>(config: AxiosRequestConfig): Promise<T> {
  const maxRetries = CONFIG.httpMaxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await axios.request<T>({
        timeout: CONFIG.httpTimeoutMs,
        ...config,
      });
      return response.data;
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }
      const backoffMs = 300 * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      await sleep(backoffMs);
    }
  }

  throw new Error("HTTP request retries exhausted.");
}

export async function httpGet<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
  return requestWithRetry<T>({ ...(config || {}), method: "GET", url });
}

export async function httpPost<T>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<T> {
  return requestWithRetry<T>({ ...(config || {}), method: "POST", url, data });
}
