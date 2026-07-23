import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { SERVER_CONFIG } from "../env.js";

function safeEqual(a: string, b: string): boolean {
  // Compare byte lengths first so a mismatch short-circuits without allocating
  // buffers, and so the length check matches what timingSafeEqual compares.
  if (Buffer.byteLength(a) !== Buffer.byteLength(b)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractKey(req: Request): string | null {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

/**
 * Authenticates machine-to-machine requests from the trading bot using the
 * shared DASHBOARD_INGEST_KEY. Separate from the session/JWT auth used by the
 * browser so the bot never needs a dashboard login.
 */
export function requireIngestKey(req: Request, res: Response, next: NextFunction): void {
  const configured = SERVER_CONFIG.ingestApiKey;
  if (!configured) {
    res.status(503).json({ error: "Trade ingestion is not configured. Set DASHBOARD_INGEST_KEY." });
    return;
  }
  const provided = extractKey(req);
  if (!provided || !safeEqual(provided, configured)) {
    res.status(401).json({ error: "Invalid or missing ingest API key." });
    return;
  }
  next();
}
