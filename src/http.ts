import axios, { AxiosRequestConfig } from "axios";
import { CONFIG } from "./config.js";

function isRetryableError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (!status) return true;
  return status === 429 || status >= 500;
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
